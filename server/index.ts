import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { all, get, run, insert, initSchema, seedIfEmpty } from './db.ts';

const app = express();
app.use(express.json());

// Envuelve handlers async para que los errores lleguen al middleware de Express 4
type Handler = (req: express.Request, res: express.Response) => Promise<unknown>;
const h = (fn: Handler): express.RequestHandler => (req, res, next) => {
  fn(req, res).catch(next);
};

// ---------- WebSockets (tiempo real) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set<WebSocket>();

wss.on('connection', async (socket, req) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const token = url.searchParams.get('token') ?? '';
  const session = await get('SELECT user_id FROM sessions WHERE token = $1', [token]);
  if (!session) { socket.close(); return; }
  wsClients.add(socket);
  socket.on('close', () => wsClients.delete(socket));
});

function broadcast(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

// ---------- Autenticación ----------
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

type AuthedRequest = express.Request & { userId?: number };

const requireAuth: express.RequestHandler = (req: AuthedRequest, res, next) => {
  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  get<{ user_id: number }>('SELECT user_id FROM sessions WHERE token = $1', [token])
    .then((session) => {
      if (!session) return res.status(401).json({ error: 'No autenticado' });
      req.userId = session.user_id;
      next();
    })
    .catch(next);
};

app.post('/api/register', h(async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username?.trim() || !password || password.length < 4) {
    return res.status(400).json({ error: 'Usuario y contraseña (mín. 4 caracteres) requeridos' });
  }
  const existing = await get('SELECT id FROM users WHERE username = $1', [username.trim()]);
  if (existing) return res.status(409).json({ error: 'Ese usuario ya existe' });
  const userId = await insert('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username.trim(), hashPassword(password)]);
  const token = crypto.randomBytes(32).toString('hex');
  await run('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
  res.json({ token, user: { id: userId, username: username.trim() } });
}));

app.post('/api/login', h(async (req, res) => {
  const { username, password } = req.body ?? {};
  const user = await get<{ id: number; username: string; password_hash: string }>(
    'SELECT id, username, password_hash FROM users WHERE username = $1', [username?.trim() ?? '']);
  if (!user || !user.password_hash || !verifyPassword(password ?? '', user.password_hash)) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  await run('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);
  res.json({ token, user: { id: user.id, username: user.username } });
}));

// ---------- Google Sign-In ----------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';

// El cliente pregunta si el botón de Google debe mostrarse y con qué client id
app.get('/api/auth/config', (_req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null });
});

app.post('/api/auth/google', h(async (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(501).json({ error: 'Google Sign-In no está configurado (falta GOOGLE_CLIENT_ID)' });
  }
  const { credential } = req.body ?? {};
  if (typeof credential !== 'string' || !credential) {
    return res.status(400).json({ error: 'Falta la credencial de Google' });
  }

  // Google valida firma y expiración del ID token en tokeninfo
  const check = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!check.ok) return res.status(401).json({ error: 'Token de Google inválido' });
  const info = (await check.json()) as { aud?: string; sub?: string; email?: string; name?: string; picture?: string };
  if (info.aud !== GOOGLE_CLIENT_ID || !info.sub) {
    return res.status(401).json({ error: 'Token de Google inválido' });
  }

  let user = await get<{ id: number; username: string; name: string | null; picture: string | null }>(
    'SELECT id, username, name, picture FROM users WHERE google_sub = $1', [info.sub]);

  if (user) {
    // Refresca el perfil por si cambió en Google
    await run('UPDATE users SET email = $1, name = $2, picture = $3 WHERE id = $4',
      [info.email ?? null, info.name ?? null, info.picture ?? null, user.id]);
    user = { ...user, name: info.name ?? user.name, picture: info.picture ?? user.picture };
  } else {
    // Username único derivado del email (parte local + sufijo numérico si hace falta)
    const base = (info.email?.split('@')[0] ?? 'google').toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'google';
    let username = base;
    for (let i = 2; await get('SELECT 1 FROM users WHERE username = $1', [username]); i++) {
      username = `${base}${i}`;
    }
    const userId = await insert(
      'INSERT INTO users (username, google_sub, email, name, picture) VALUES ($1, $2, $3, $4, $5)',
      [username, info.sub, info.email ?? null, info.name ?? null, info.picture ?? null]);
    user = { id: userId, username, name: info.name ?? null, picture: info.picture ?? null };
  }

  const token = crypto.randomBytes(32).toString('hex');
  await run('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);
  res.json({ token, user });
}));

app.get('/api/me', requireAuth, h(async (req: AuthedRequest, res) => {
  const user = await get('SELECT id, username, name, picture FROM users WHERE id = $1', [req.userId!]);
  res.json({ user });
}));

app.post('/api/logout', requireAuth, h(async (req: AuthedRequest, res) => {
  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  await run('DELETE FROM sessions WHERE token = $1', [token]);
  res.json({ ok: true });
}));

// ---------- Wikilinks: [[Título]] crea vínculos hacia notas ----------
function extractWikilinks(text: string): string[] {
  return [...text.matchAll(/\[\[([^\[\]]+)\]\]/g)].map((m) => m[1].trim()).filter(Boolean);
}

async function syncWikilinks(sourceType: string, sourceId: number, text: string, kind: string) {
  await run('DELETE FROM links WHERE source_type = $1 AND source_id = $2 AND kind = $3', [sourceType, sourceId, kind]);
  for (const title of extractWikilinks(text)) {
    const note = await get<{ id: number }>('SELECT id FROM notes WHERE LOWER(title) = LOWER($1)', [title]);
    if (note) {
      await run(`INSERT INTO links (source_type, source_id, target_type, target_id, kind)
                 VALUES ($1, $2, 'note', $3, $4) ON CONFLICT DO NOTHING`, [sourceType, sourceId, note.id, kind]);
    }
  }
}

// ---------- Tableros (Trello) ----------
app.get('/api/boards', requireAuth, h(async (_req, res) => {
  res.json({ boards: await all('SELECT * FROM boards ORDER BY id') });
}));

app.post('/api/boards', requireAuth, h(async (req, res) => {
  const name = (req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const boardId = await insert('INSERT INTO boards (name) VALUES ($1)', [name]);
  broadcast({ type: 'boards:changed' });
  res.json({ board: await get('SELECT * FROM boards WHERE id = $1', [boardId]) });
}));

app.delete('/api/boards/:id', requireAuth, h(async (req, res) => {
  await run('DELETE FROM boards WHERE id = $1', [Number(req.params.id)]);
  broadcast({ type: 'boards:changed' });
  res.json({ ok: true });
}));

app.get('/api/boards/:id', requireAuth, h(async (req, res) => {
  const boardId = Number(req.params.id);
  const board = await get('SELECT * FROM boards WHERE id = $1', [boardId]);
  if (!board) return res.status(404).json({ error: 'Tablero no encontrado' });
  const lists = await all('SELECT * FROM lists WHERE board_id = $1 ORDER BY position', [boardId]);
  for (const list of lists) {
    list.cards = await all(`
      SELECT cards.*,
        (SELECT COUNT(*) FROM checklist_items WHERE card_id = cards.id) AS checklist_total,
        (SELECT COUNT(*) FROM checklist_items WHERE card_id = cards.id AND done = 1) AS checklist_done,
        (SELECT string_agg(users.username, ',') FROM card_members JOIN users ON users.id = card_members.user_id
          WHERE card_members.card_id = cards.id) AS member_names
      FROM cards WHERE list_id = $1 ORDER BY position
    `, [list.id]);
  }
  res.json({ board, lists });
}));

app.post('/api/lists', requireAuth, h(async (req, res) => {
  const { board_id, name } = req.body ?? {};
  if (!board_id || !name?.trim()) return res.status(400).json({ error: 'Datos incompletos' });
  const max = await get<{ p: number }>('SELECT COALESCE(MAX(position), -1) AS p FROM lists WHERE board_id = $1', [board_id]);
  const listId = await insert('INSERT INTO lists (board_id, name, position) VALUES ($1, $2, $3)', [board_id, name.trim(), (max?.p ?? -1) + 1]);
  broadcast({ type: 'board:changed', boardId: board_id });
  res.json({ list: await get('SELECT * FROM lists WHERE id = $1', [listId]) });
}));

app.patch('/api/lists/:id', requireAuth, h(async (req, res) => {
  const list = await get('SELECT * FROM lists WHERE id = $1', [Number(req.params.id)]);
  if (!list) return res.status(404).json({ error: 'Lista no encontrada' });
  const name = req.body?.name?.trim() || list.name;
  await run('UPDATE lists SET name = $1 WHERE id = $2', [name, list.id]);
  broadcast({ type: 'board:changed', boardId: list.board_id });
  res.json({ ok: true });
}));

app.delete('/api/lists/:id', requireAuth, h(async (req, res) => {
  const list = await get('SELECT * FROM lists WHERE id = $1', [Number(req.params.id)]);
  if (!list) return res.status(404).json({ error: 'Lista no encontrada' });
  await run('DELETE FROM lists WHERE id = $1', [list.id]);
  broadcast({ type: 'board:changed', boardId: list.board_id });
  res.json({ ok: true });
}));

app.post('/api/cards', requireAuth, h(async (req, res) => {
  const { list_id, title } = req.body ?? {};
  if (!list_id || !title?.trim()) return res.status(400).json({ error: 'Datos incompletos' });
  const list = await get<{ board_id: number }>('SELECT board_id FROM lists WHERE id = $1', [list_id]);
  if (!list) return res.status(404).json({ error: 'Lista no encontrada' });
  const max = await get<{ p: number }>('SELECT COALESCE(MAX(position), -1) AS p FROM cards WHERE list_id = $1', [list_id]);
  const cardId = await insert('INSERT INTO cards (list_id, title, position) VALUES ($1, $2, $3)', [list_id, title.trim(), (max?.p ?? -1) + 1]);
  broadcast({ type: 'board:changed', boardId: list.board_id });
  res.json({ card: await get('SELECT * FROM cards WHERE id = $1', [cardId]) });
}));

app.get('/api/cards/:id', requireAuth, h(async (req, res) => {
  const cardId = Number(req.params.id);
  const card = await get(`
    SELECT cards.*, lists.name AS list_name, lists.board_id
    FROM cards JOIN lists ON lists.id = cards.list_id WHERE cards.id = $1
  `, [cardId]);
  if (!card) return res.status(404).json({ error: 'Tarjeta no encontrada' });

  const linkedNotes = await all(`
    SELECT notes.id, notes.title, links.id AS link_id, links.kind
    FROM links JOIN notes ON notes.id = links.target_id
    WHERE links.source_type = 'card' AND links.source_id = $1 AND links.target_type = 'note'
  `, [cardId]);

  const discussion = await get(`
    SELECT channels.id, channels.name
    FROM links JOIN channels ON channels.id = links.target_id
    WHERE links.source_type = 'card' AND links.source_id = $1 AND links.target_type = 'channel' AND links.kind = 'discussion'
  `, [cardId]) ?? null;

  const mentions = await all(`
    SELECT links.source_type, links.source_id,
      CASE links.source_type
        WHEN 'message' THEN (SELECT substr(content, 1, 120) FROM messages WHERE id = links.source_id)
        WHEN 'note' THEN (SELECT title FROM notes WHERE id = links.source_id)
      END AS label,
      CASE links.source_type
        WHEN 'message' THEN (SELECT channel_id FROM messages WHERE id = links.source_id)
      END AS channel_id
    FROM links
    WHERE links.target_type = 'card' AND links.target_id = $1
  `, [cardId]);

  const checklist = await all('SELECT * FROM checklist_items WHERE card_id = $1 ORDER BY position', [cardId]);
  const members = await all(`
    SELECT users.id, users.username FROM card_members
    JOIN users ON users.id = card_members.user_id WHERE card_members.card_id = $1
  `, [cardId]);

  res.json({ card, linkedNotes, discussion, mentions, checklist, members });
}));

app.patch('/api/cards/:id', requireAuth, h(async (req, res) => {
  const card = await get('SELECT cards.*, lists.board_id FROM cards JOIN lists ON lists.id = cards.list_id WHERE cards.id = $1', [Number(req.params.id)]);
  if (!card) return res.status(404).json({ error: 'Tarjeta no encontrada' });
  const title = req.body?.title?.trim() || card.title;
  const description = req.body?.description ?? card.description;
  const labels = req.body?.labels !== undefined ? JSON.stringify(req.body.labels) : card.labels;
  const dueDate = req.body?.due_date !== undefined ? (req.body.due_date || null) : card.due_date;
  const completed = req.body?.completed !== undefined ? (req.body.completed ? 1 : 0) : card.completed;
  await run('UPDATE cards SET title = $1, description = $2, labels = $3, due_date = $4, completed = $5 WHERE id = $6',
    [title, description, labels, dueDate, completed, card.id]);
  await syncWikilinks('card', card.id, description, 'wikilink');
  broadcast({ type: 'board:changed', boardId: card.board_id });
  res.json({ card: await get('SELECT * FROM cards WHERE id = $1', [card.id]) });
}));

app.post('/api/cards/:id/move', requireAuth, h(async (req, res) => {
  const cardId = Number(req.params.id);
  const { list_id, index } = req.body ?? {};
  const card = await get('SELECT cards.*, lists.board_id FROM cards JOIN lists ON lists.id = cards.list_id WHERE cards.id = $1', [cardId]);
  const target = await get('SELECT * FROM lists WHERE id = $1', [list_id]);
  if (!card || !target) return res.status(404).json({ error: 'Tarjeta o lista no encontrada' });

  const siblings = (await all<{ id: number }>('SELECT id FROM cards WHERE list_id = $1 AND id != $2 ORDER BY position', [list_id, cardId])).map((r) => r.id);
  const at = Math.max(0, Math.min(Number(index) || 0, siblings.length));
  siblings.splice(at, 0, cardId);
  for (let i = 0; i < siblings.length; i++) {
    await run('UPDATE cards SET list_id = $1, position = $2 WHERE id = $3', [list_id, i, siblings[i]]);
  }

  // Automatizaciones: aplicar reglas de la lista destino si la tarjeta cambió de lista
  if (card.list_id !== list_id) await applyRules(cardId, list_id);

  broadcast({ type: 'board:changed', boardId: card.board_id });
  if (target.board_id !== card.board_id) broadcast({ type: 'board:changed', boardId: target.board_id });
  res.json({ ok: true });
}));

app.delete('/api/cards/:id', requireAuth, h(async (req, res) => {
  const card = await get('SELECT cards.*, lists.board_id FROM cards JOIN lists ON lists.id = cards.list_id WHERE cards.id = $1', [Number(req.params.id)]);
  if (!card) return res.status(404).json({ error: 'Tarjeta no encontrada' });
  await run('DELETE FROM cards WHERE id = $1', [card.id]);
  await run("DELETE FROM links WHERE (source_type = 'card' AND source_id = $1) OR (target_type = 'card' AND target_id = $1)", [card.id]);
  broadcast({ type: 'board:changed', boardId: card.board_id });
  res.json({ ok: true });
}));

// ---------- Automatizaciones (estilo Butler) ----------
async function applyRules(cardId: number, listId: number) {
  const rules = await all('SELECT * FROM board_rules WHERE list_id = $1', [listId]);
  for (const rule of rules) {
    if (rule.action === 'complete') {
      await run('UPDATE cards SET completed = 1 WHERE id = $1', [cardId]);
    } else if (rule.action === 'uncomplete') {
      await run('UPDATE cards SET completed = 0 WHERE id = $1', [cardId]);
    } else if (rule.action === 'label') {
      const card = await get<{ labels: string }>('SELECT labels FROM cards WHERE id = $1', [cardId]);
      const labels: string[] = JSON.parse(card?.labels || '[]');
      if (!labels.includes(rule.param)) labels.push(rule.param);
      await run('UPDATE cards SET labels = $1 WHERE id = $2', [JSON.stringify(labels), cardId]);
    } else if (rule.action === 'due_today') {
      await run(`UPDATE cards SET due_date = to_char(now() at time zone 'utc', 'YYYY-MM-DD') WHERE id = $1`, [cardId]);
    } else if (rule.action === 'clear_due') {
      await run('UPDATE cards SET due_date = NULL WHERE id = $1', [cardId]);
    }
  }
}

app.get('/api/boards/:id/rules', requireAuth, h(async (req, res) => {
  const rules = await all(`
    SELECT board_rules.*, lists.name AS list_name FROM board_rules
    JOIN lists ON lists.id = board_rules.list_id
    WHERE board_rules.board_id = $1 ORDER BY board_rules.id
  `, [Number(req.params.id)]);
  res.json({ rules });
}));

app.post('/api/boards/:id/rules', requireAuth, h(async (req, res) => {
  const boardId = Number(req.params.id);
  const { list_id, action, param } = req.body ?? {};
  const validActions = ['complete', 'uncomplete', 'label', 'due_today', 'clear_due'];
  if (!list_id || !validActions.includes(action)) return res.status(400).json({ error: 'Regla inválida' });
  await insert('INSERT INTO board_rules (board_id, list_id, action, param) VALUES ($1, $2, $3, $4)',
    [boardId, list_id, action, param ?? '']);
  broadcast({ type: 'board:changed', boardId });
  res.json({ ok: true });
}));

app.delete('/api/rules/:id', requireAuth, h(async (req, res) => {
  const rule = await get<{ board_id: number }>('SELECT board_id FROM board_rules WHERE id = $1', [Number(req.params.id)]);
  await run('DELETE FROM board_rules WHERE id = $1', [Number(req.params.id)]);
  if (rule) broadcast({ type: 'board:changed', boardId: rule.board_id });
  res.json({ ok: true });
}));

// ---------- Checklists ----------
async function cardBoardId(cardId: number): Promise<number | null> {
  const row = await get<{ board_id: number }>('SELECT lists.board_id FROM cards JOIN lists ON lists.id = cards.list_id WHERE cards.id = $1', [cardId]);
  return row?.board_id ?? null;
}

app.post('/api/cards/:id/checklist', requireAuth, h(async (req, res) => {
  const cardId = Number(req.params.id);
  const text = (req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Texto requerido' });
  const max = await get<{ p: number }>('SELECT COALESCE(MAX(position), -1) AS p FROM checklist_items WHERE card_id = $1', [cardId]);
  await insert('INSERT INTO checklist_items (card_id, text, position) VALUES ($1, $2, $3)', [cardId, text, (max?.p ?? -1) + 1]);
  broadcast({ type: 'board:changed', boardId: await cardBoardId(cardId) });
  res.json({ ok: true });
}));

app.patch('/api/checklist/:id', requireAuth, h(async (req, res) => {
  const item = await get('SELECT * FROM checklist_items WHERE id = $1', [Number(req.params.id)]);
  if (!item) return res.status(404).json({ error: 'Elemento no encontrado' });
  const text = req.body?.text?.trim() || item.text;
  const done = req.body?.done !== undefined ? (req.body.done ? 1 : 0) : item.done;
  await run('UPDATE checklist_items SET text = $1, done = $2 WHERE id = $3', [text, done, item.id]);
  broadcast({ type: 'board:changed', boardId: await cardBoardId(item.card_id) });
  res.json({ ok: true });
}));

app.delete('/api/checklist/:id', requireAuth, h(async (req, res) => {
  const item = await get<{ card_id: number }>('SELECT card_id FROM checklist_items WHERE id = $1', [Number(req.params.id)]);
  await run('DELETE FROM checklist_items WHERE id = $1', [Number(req.params.id)]);
  if (item) broadcast({ type: 'board:changed', boardId: await cardBoardId(item.card_id) });
  res.json({ ok: true });
}));

// ---------- Miembros de tarjeta ----------
app.get('/api/users', requireAuth, h(async (_req, res) => {
  res.json({ users: await all('SELECT id, username FROM users ORDER BY username') });
}));

app.post('/api/cards/:id/members', requireAuth, h(async (req, res) => {
  const cardId = Number(req.params.id);
  const userId = Number(req.body?.user_id);
  if (!userId) return res.status(400).json({ error: 'Usuario requerido' });
  await run('INSERT INTO card_members (card_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [cardId, userId]);
  broadcast({ type: 'board:changed', boardId: await cardBoardId(cardId) });
  res.json({ ok: true });
}));

app.delete('/api/cards/:id/members/:userId', requireAuth, h(async (req, res) => {
  const cardId = Number(req.params.id);
  await run('DELETE FROM card_members WHERE card_id = $1 AND user_id = $2', [cardId, Number(req.params.userId)]);
  broadcast({ type: 'board:changed', boardId: await cardBoardId(cardId) });
  res.json({ ok: true });
}));

// Crea (o devuelve) el canal de discusión vinculado a una tarjeta
app.post('/api/cards/:id/discussion', requireAuth, h(async (req, res) => {
  const cardId = Number(req.params.id);
  const card = await get<{ title: string }>('SELECT * FROM cards WHERE id = $1', [cardId]);
  if (!card) return res.status(404).json({ error: 'Tarjeta no encontrada' });

  const existing = await get(`
    SELECT channels.id, channels.name FROM links
    JOIN channels ON channels.id = links.target_id
    WHERE links.source_type = 'card' AND links.source_id = $1 AND links.target_type = 'channel' AND links.kind = 'discussion'
  `, [cardId]);
  if (existing) return res.json({ channel: existing });

  const slugBase = 'tarjeta-' + card.title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  let slug = slugBase || `tarjeta-${cardId}`;
  let suffix = 1;
  while (await get('SELECT id FROM channels WHERE name = $1', [slug])) slug = `${slugBase}-${++suffix}`;

  const channelId = await insert('INSERT INTO channels (name) VALUES ($1)', [slug]);
  await run(`INSERT INTO links (source_type, source_id, target_type, target_id, kind)
             VALUES ('card', $1, 'channel', $2, 'discussion') ON CONFLICT DO NOTHING`, [cardId, channelId]);
  broadcast({ type: 'channels:changed' });
  res.json({ channel: { id: channelId, name: slug } });
}));

// ---------- Notas (Obsidian) ----------
// Sincroniza los #tags del contenido con la tabla note_tags
async function syncTags(noteId: number, content: string) {
  await run('DELETE FROM note_tags WHERE note_id = $1', [noteId]);
  for (const match of content.matchAll(/(^|\s)#([\p{L}\p{N}_-]+)/gu)) {
    await run('INSERT INTO note_tags (note_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING', [noteId, match[2].toLowerCase()]);
  }
}

app.get('/api/notes', requireAuth, h(async (req, res) => {
  const tag = String(req.query.tag ?? '').trim().toLowerCase();
  const notes = tag
    ? await all(`
        SELECT notes.id, notes.title, notes.updated_at FROM notes
        JOIN note_tags ON note_tags.note_id = notes.id
        WHERE note_tags.tag = $1 ORDER BY notes.updated_at DESC
      `, [tag])
    : await all('SELECT id, title, updated_at FROM notes ORDER BY updated_at DESC');
  res.json({ notes });
}));

app.get('/api/tags', requireAuth, h(async (_req, res) => {
  res.json({ tags: await all('SELECT tag, COUNT(*) AS count FROM note_tags GROUP BY tag ORDER BY count DESC, tag') });
}));

function fillTemplate(content: string, title: string): string {
  return content
    .replaceAll('{{titulo}}', title)
    .replaceAll('{{fecha}}', new Date().toISOString().slice(0, 10));
}

app.post('/api/notes', requireAuth, h(async (req, res) => {
  const title = (req.body?.title ?? '').trim();
  if (!title) return res.status(400).json({ error: 'Título requerido' });
  const existing = await get('SELECT * FROM notes WHERE LOWER(title) = LOWER($1)', [title]);
  if (existing) return res.json({ note: existing, existed: true });
  let content = `# ${title}\n\n`;
  if (req.body?.template_id) {
    const template = await get<{ content: string }>('SELECT content FROM templates WHERE id = $1', [Number(req.body.template_id)]);
    if (template) content = fillTemplate(template.content, title);
  }
  const noteId = await insert('INSERT INTO notes (title, content) VALUES ($1, $2)', [title, content]);
  await syncTags(noteId, content);
  await syncWikilinks('note', noteId, content, 'wikilink');
  broadcast({ type: 'notes:changed' });
  res.json({ note: await get('SELECT * FROM notes WHERE id = $1', [noteId]) });
}));

// ---------- Plantillas ----------
app.get('/api/templates', requireAuth, h(async (_req, res) => {
  res.json({ templates: await all('SELECT * FROM templates ORDER BY name') });
}));

app.post('/api/templates', requireAuth, h(async (req, res) => {
  const name = (req.body?.name ?? '').trim();
  const content = req.body?.content ?? '';
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const existing = await get('SELECT id FROM templates WHERE name = $1', [name]);
  if (existing) return res.status(409).json({ error: 'Ya existe una plantilla con ese nombre' });
  await insert('INSERT INTO templates (name, content) VALUES ($1, $2)', [name, content]);
  res.json({ ok: true });
}));

app.delete('/api/templates/:id', requireAuth, h(async (req, res) => {
  await run('DELETE FROM templates WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

app.get('/api/notes/:id', requireAuth, h(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await get('SELECT * FROM notes WHERE id = $1', [noteId]);
  if (!note) return res.status(404).json({ error: 'Nota no encontrada' });

  const backlinks = await all(`
    SELECT links.source_type, links.source_id, links.kind,
      CASE links.source_type
        WHEN 'note' THEN (SELECT title FROM notes WHERE id = links.source_id)
        WHEN 'card' THEN (SELECT title FROM cards WHERE id = links.source_id)
        WHEN 'message' THEN (SELECT substr(content, 1, 120) FROM messages WHERE id = links.source_id)
      END AS label,
      CASE links.source_type
        WHEN 'message' THEN (SELECT channel_id FROM messages WHERE id = links.source_id)
      END AS channel_id
    FROM links
    WHERE links.target_type = 'note' AND links.target_id = $1
  `, [noteId]);

  const outgoing = await all(`
    SELECT notes.id, notes.title FROM links
    JOIN notes ON notes.id = links.target_id
    WHERE links.source_type = 'note' AND links.source_id = $1 AND links.target_type = 'note'
  `, [noteId]);

  res.json({ note, backlinks, outgoing });
}));

app.patch('/api/notes/:id', requireAuth, h(async (req, res) => {
  const note = await get('SELECT * FROM notes WHERE id = $1', [Number(req.params.id)]);
  if (!note) return res.status(404).json({ error: 'Nota no encontrada' });
  const title = req.body?.title?.trim() || note.title;
  const content = req.body?.content ?? note.content;

  // Historial de versiones: snapshot del estado anterior. Para no llenar el
  // historial con el autoguardado, se fusionan versiones de menos de 2 minutos.
  if (content !== note.content || title !== note.title) {
    const last = await get<{ id: number; age: number }>(`
      SELECT id, EXTRACT(EPOCH FROM (now() at time zone 'utc' - created_at::timestamp))::int AS age
      FROM note_versions WHERE note_id = $1 ORDER BY id DESC LIMIT 1
    `, [note.id]);
    if (last && last.age < 120) await run('DELETE FROM note_versions WHERE id = $1', [last.id]);
    await insert('INSERT INTO note_versions (note_id, title, content) VALUES ($1, $2, $3)', [note.id, note.title, note.content]);
    await run(`
      DELETE FROM note_versions WHERE note_id = $1 AND id NOT IN
      (SELECT id FROM note_versions WHERE note_id = $1 ORDER BY id DESC LIMIT 30)
    `, [note.id]);
  }

  await run(`UPDATE notes SET title = $1, content = $2, updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = $3`,
    [title, content, note.id]);
  await syncWikilinks('note', note.id, content, 'wikilink');
  await syncTags(note.id, content);
  broadcast({ type: 'notes:changed' });
  res.json({ note: await get('SELECT * FROM notes WHERE id = $1', [note.id]) });
}));

app.get('/api/notes/:id/versions', requireAuth, h(async (req, res) => {
  const versions = await all(`
    SELECT id, title, created_at, length(content) AS size
    FROM note_versions WHERE note_id = $1 ORDER BY id DESC
  `, [Number(req.params.id)]);
  res.json({ versions });
}));

app.get('/api/versions/:id', requireAuth, h(async (req, res) => {
  const version = await get('SELECT * FROM note_versions WHERE id = $1', [Number(req.params.id)]);
  if (!version) return res.status(404).json({ error: 'Versión no encontrada' });
  res.json({ version });
}));

app.post('/api/notes/:id/restore', requireAuth, h(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await get('SELECT * FROM notes WHERE id = $1', [noteId]);
  const version = await get('SELECT * FROM note_versions WHERE id = $1 AND note_id = $2', [Number(req.body?.version_id), noteId]);
  if (!note || !version) return res.status(404).json({ error: 'Nota o versión no encontrada' });
  // El estado actual pasa al historial antes de restaurar
  await insert('INSERT INTO note_versions (note_id, title, content) VALUES ($1, $2, $3)', [noteId, note.title, note.content]);
  await run(`UPDATE notes SET title = $1, content = $2, updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = $3`,
    [version.title, version.content, noteId]);
  await syncWikilinks('note', noteId, version.content, 'wikilink');
  await syncTags(noteId, version.content);
  broadcast({ type: 'notes:changed' });
  res.json({ note: await get('SELECT * FROM notes WHERE id = $1', [noteId]) });
}));

app.delete('/api/notes/:id', requireAuth, h(async (req, res) => {
  const noteId = Number(req.params.id);
  await run('DELETE FROM notes WHERE id = $1', [noteId]);
  await run("DELETE FROM links WHERE (source_type = 'note' AND source_id = $1) OR (target_type = 'note' AND target_id = $1)", [noteId]);
  broadcast({ type: 'notes:changed' });
  res.json({ ok: true });
}));

// Resuelve un título de wikilink a una nota (creándola si no existe)
app.post('/api/notes/resolve', requireAuth, h(async (req, res) => {
  const title = (req.body?.title ?? '').trim();
  if (!title) return res.status(400).json({ error: 'Título requerido' });
  let note = await get('SELECT * FROM notes WHERE LOWER(title) = LOWER($1)', [title]);
  if (!note) {
    const noteId = await insert('INSERT INTO notes (title, content) VALUES ($1, $2)', [title, `# ${title}\n\n`]);
    note = await get('SELECT * FROM notes WHERE id = $1', [noteId]);
    broadcast({ type: 'notes:changed' });
  }
  res.json({ note });
}));

// ---------- Canales y mensajes (Slack) ----------
app.get('/api/channels', requireAuth, h(async (_req, res) => {
  const channels = await all(`
    SELECT channels.*,
      (SELECT links.source_id FROM links WHERE links.target_type = 'channel' AND links.target_id = channels.id AND links.kind = 'discussion' AND links.source_type = 'card') AS card_id
    FROM channels ORDER BY channels.name
  `);
  res.json({ channels });
}));

app.post('/api/channels', requireAuth, h(async (req, res) => {
  const name = (req.body?.name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const existing = await get('SELECT * FROM channels WHERE name = $1', [name]);
  if (existing) return res.status(409).json({ error: 'Ese canal ya existe' });
  const channelId = await insert('INSERT INTO channels (name) VALUES ($1)', [name]);
  broadcast({ type: 'channels:changed' });
  res.json({ channel: await get('SELECT * FROM channels WHERE id = $1', [channelId]) });
}));

app.get('/api/channels/:id/messages', requireAuth, h(async (req: AuthedRequest, res) => {
  const channelId = Number(req.params.id);
  const channel = await get(`
    SELECT channels.*,
      (SELECT links.source_id FROM links WHERE links.target_type = 'channel' AND links.target_id = channels.id AND links.kind = 'discussion' AND links.source_type = 'card') AS card_id
    FROM channels WHERE channels.id = $1
  `, [channelId]);
  if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
  const cardTitle = channel.card_id
    ? (await get<{ title: string }>('SELECT title FROM cards WHERE id = $1', [channel.card_id]))?.title ?? null
    : null;

  // Solo mensajes de primer nivel; las respuestas viven en su hilo
  const messages = await all(`
    SELECT messages.*, users.username,
      (SELECT COUNT(*) FROM messages r WHERE r.parent_id = messages.id) AS reply_count
    FROM messages JOIN users ON users.id = messages.user_id
    WHERE channel_id = $1 AND parent_id IS NULL ORDER BY messages.id LIMIT 500
  `, [channelId]);

  const reactions = await all(`
    SELECT r.message_id, r.emoji, COUNT(*) AS count,
      MAX(CASE WHEN r.user_id = $1 THEN 1 ELSE 0 END) AS mine
    FROM reactions r JOIN messages m ON m.id = r.message_id
    WHERE m.channel_id = $2
    GROUP BY r.message_id, r.emoji
  `, [req.userId!, channelId]);

  const pinned = await all(`
    SELECT messages.id, substr(messages.content, 1, 120) AS content, users.username
    FROM messages JOIN users ON users.id = messages.user_id
    WHERE channel_id = $1 AND pinned = 1 ORDER BY messages.id
  `, [channelId]);

  res.json({ channel: { ...channel, card_title: cardTitle }, messages, reactions, pinned });
}));

app.get('/api/messages/:id/thread', requireAuth, h(async (req, res) => {
  const messageId = Number(req.params.id);
  const parent = await get(`
    SELECT messages.*, users.username FROM messages
    JOIN users ON users.id = messages.user_id WHERE messages.id = $1
  `, [messageId]);
  if (!parent) return res.status(404).json({ error: 'Mensaje no encontrado' });
  const replies = await all(`
    SELECT messages.*, users.username FROM messages
    JOIN users ON users.id = messages.user_id
    WHERE parent_id = $1 ORDER BY messages.id
  `, [messageId]);
  res.json({ parent, replies });
}));

app.post('/api/channels/:id/messages', requireAuth, h(async (req: AuthedRequest, res) => {
  const channelId = Number(req.params.id);
  const content = (req.body?.content ?? '').trim();
  const parentId = req.body?.parent_id ? Number(req.body.parent_id) : null;
  if (!content) return res.status(400).json({ error: 'Mensaje vacío' });
  const channel = await get('SELECT id FROM channels WHERE id = $1', [channelId]);
  if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
  if (parentId) {
    const parent = await get('SELECT id FROM messages WHERE id = $1 AND channel_id = $2 AND parent_id IS NULL', [parentId, channelId]);
    if (!parent) return res.status(400).json({ error: 'Hilo inválido' });
  }

  const messageId = await insert('INSERT INTO messages (channel_id, user_id, content, parent_id) VALUES ($1, $2, $3, $4)',
    [channelId, req.userId!, content, parentId]);
  await syncWikilinks('message', messageId, content, 'mention');

  const message = await get(`
    SELECT messages.*, users.username FROM messages
    JOIN users ON users.id = messages.user_id WHERE messages.id = $1
  `, [messageId]);
  broadcast({ type: 'message:new', channelId, message });
  res.json({ message });
}));

app.patch('/api/messages/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const message = await get('SELECT * FROM messages WHERE id = $1', [Number(req.params.id)]);
  if (!message) return res.status(404).json({ error: 'Mensaje no encontrado' });
  if (message.user_id !== req.userId) return res.status(403).json({ error: 'Solo puedes editar tus mensajes' });
  const content = (req.body?.content ?? '').trim();
  if (!content) return res.status(400).json({ error: 'Mensaje vacío' });
  await run(`UPDATE messages SET content = $1, edited_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2`,
    [content, message.id]);
  await syncWikilinks('message', message.id, content, 'mention');
  broadcast({ type: 'chat:changed', channelId: message.channel_id });
  res.json({ ok: true });
}));

app.delete('/api/messages/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const message = await get('SELECT * FROM messages WHERE id = $1', [Number(req.params.id)]);
  if (!message) return res.status(404).json({ error: 'Mensaje no encontrado' });
  if (message.user_id !== req.userId) return res.status(403).json({ error: 'Solo puedes eliminar tus mensajes' });
  const replyIds = (await all<{ id: number }>('SELECT id FROM messages WHERE parent_id = $1', [message.id])).map((r) => r.id);
  for (const id of [message.id, ...replyIds]) {
    await run('DELETE FROM messages WHERE id = $1', [id]);
    await run("DELETE FROM links WHERE source_type = 'message' AND source_id = $1", [id]);
  }
  broadcast({ type: 'chat:changed', channelId: message.channel_id });
  res.json({ ok: true });
}));

app.post('/api/messages/:id/react', requireAuth, h(async (req: AuthedRequest, res) => {
  const message = await get<{ channel_id: number }>('SELECT channel_id FROM messages WHERE id = $1', [Number(req.params.id)]);
  if (!message) return res.status(404).json({ error: 'Mensaje no encontrado' });
  const emoji = (req.body?.emoji ?? '').trim();
  if (!emoji || emoji.length > 8) return res.status(400).json({ error: 'Emoji inválido' });
  const existing = await get('SELECT 1 FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
    [Number(req.params.id), req.userId!, emoji]);
  if (existing) {
    await run('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [Number(req.params.id), req.userId!, emoji]);
  } else {
    await run('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
      [Number(req.params.id), req.userId!, emoji]);
  }
  broadcast({ type: 'chat:changed', channelId: message.channel_id });
  res.json({ ok: true });
}));

app.post('/api/messages/:id/pin', requireAuth, h(async (req, res) => {
  const message = await get<{ channel_id: number; pinned: number }>('SELECT channel_id, pinned FROM messages WHERE id = $1', [Number(req.params.id)]);
  if (!message) return res.status(404).json({ error: 'Mensaje no encontrado' });
  await run('UPDATE messages SET pinned = $1 WHERE id = $2', [message.pinned ? 0 : 1, Number(req.params.id)]);
  broadcast({ type: 'chat:changed', channelId: message.channel_id });
  res.json({ ok: true });
}));

// ---------- Mensajes programados ----------
app.post('/api/channels/:id/schedule', requireAuth, h(async (req: AuthedRequest, res) => {
  const channelId = Number(req.params.id);
  const content = (req.body?.content ?? '').trim();
  const sendAt = req.body?.send_at; // "YYYY-MM-DDTHH:mm" en hora local del servidor
  if (!content || !sendAt) return res.status(400).json({ error: 'Contenido y fecha requeridos' });
  const channel = await get('SELECT id FROM channels WHERE id = $1', [channelId]);
  if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
  const timestamp = new Date(sendAt).getTime();
  if (!Number.isFinite(timestamp) || timestamp < Date.now()) return res.status(400).json({ error: 'La fecha debe ser futura' });
  await insert('INSERT INTO scheduled_messages (channel_id, user_id, content, send_at) VALUES ($1, $2, $3, $4)',
    [channelId, req.userId!, content, new Date(timestamp).toISOString()]);
  res.json({ ok: true });
}));

app.get('/api/channels/:id/scheduled', requireAuth, h(async (req: AuthedRequest, res) => {
  const scheduled = await all(`
    SELECT id, content, send_at FROM scheduled_messages
    WHERE channel_id = $1 AND user_id = $2 ORDER BY send_at
  `, [Number(req.params.id), req.userId!]);
  res.json({ scheduled });
}));

app.delete('/api/scheduled/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  await run('DELETE FROM scheduled_messages WHERE id = $1 AND user_id = $2', [Number(req.params.id), req.userId!]);
  res.json({ ok: true });
}));

// Entrega de mensajes programados cada 15 segundos
setInterval(async () => {
  try {
    const due = await all('SELECT * FROM scheduled_messages WHERE send_at <= $1', [new Date().toISOString()]);
    for (const item of due) {
      await run('DELETE FROM scheduled_messages WHERE id = $1', [item.id]);
      const channel = await get('SELECT id FROM channels WHERE id = $1', [item.channel_id]);
      if (!channel) continue;
      const messageId = await insert('INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, $3)',
        [item.channel_id, item.user_id, item.content]);
      await syncWikilinks('message', messageId, item.content, 'mention');
      const message = await get(`
        SELECT messages.*, users.username FROM messages
        JOIN users ON users.id = messages.user_id WHERE messages.id = $1
      `, [messageId]);
      broadcast({ type: 'message:new', channelId: item.channel_id, message });
    }
  } catch (err) {
    console.error('Error entregando mensajes programados:', err);
  }
}, 15000);

// ---------- Vínculos manuales ----------
app.post('/api/links', requireAuth, h(async (req, res) => {
  const { source_type, source_id, target_type, target_id } = req.body ?? {};
  const valid = ['card', 'note', 'message', 'channel'];
  if (!valid.includes(source_type) || !valid.includes(target_type) || !source_id || !target_id) {
    return res.status(400).json({ error: 'Vínculo inválido' });
  }
  await run(`INSERT INTO links (source_type, source_id, target_type, target_id, kind)
             VALUES ($1, $2, $3, $4, 'manual') ON CONFLICT DO NOTHING`,
    [source_type, source_id, target_type, target_id]);
  broadcast({ type: 'links:changed' });
  res.json({ ok: true });
}));

app.delete('/api/links/:id', requireAuth, h(async (req, res) => {
  await run('DELETE FROM links WHERE id = $1', [Number(req.params.id)]);
  broadcast({ type: 'links:changed' });
  res.json({ ok: true });
}));

// ---------- Grafo de conocimiento ----------
app.get('/api/graph', requireAuth, h(async (_req, res) => {
  const notes = await all('SELECT id, title FROM notes');
  const cards = await all('SELECT id, title FROM cards');
  const channels = await all('SELECT id, name FROM channels');
  const nodes = [
    ...notes.map((n) => ({ key: `note:${n.id}`, type: 'note', id: n.id, label: n.title })),
    ...cards.map((c) => ({ key: `card:${c.id}`, type: 'card', id: c.id, label: c.title })),
    ...channels.map((c) => ({ key: `channel:${c.id}`, type: 'channel', id: c.id, label: '#' + c.name })),
  ];
  const nodeKeys = new Set(nodes.map((n) => n.key));
  const links = await all("SELECT * FROM links WHERE source_type != 'message'");
  const edges = links
    .map((l) => ({ source: `${l.source_type}:${l.source_id}`, target: `${l.target_type}:${l.target_id}`, kind: l.kind }))
    .filter((e) => nodeKeys.has(e.source) && nodeKeys.has(e.target));
  res.json({ nodes, edges });
}));

// ---------- Búsqueda unificada ----------
app.get('/api/search', requireAuth, h(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json({ cards: [], notes: [], messages: [], channels: [] });
  const like = `%${q}%`;
  const [cards, notes, messages, channels] = await Promise.all([
    all(`
      SELECT cards.id, cards.title, lists.board_id FROM cards
      JOIN lists ON lists.id = cards.list_id
      WHERE cards.title ILIKE $1 OR cards.description ILIKE $1 LIMIT 10
    `, [like]),
    all('SELECT id, title FROM notes WHERE title ILIKE $1 OR content ILIKE $1 LIMIT 10', [like]),
    all(`
      SELECT messages.id, substr(messages.content, 1, 120) AS content, messages.channel_id, channels.name AS channel_name, users.username
      FROM messages JOIN channels ON channels.id = messages.channel_id JOIN users ON users.id = messages.user_id
      WHERE messages.content ILIKE $1 ORDER BY messages.id DESC LIMIT 10
    `, [like]),
    all('SELECT id, name FROM channels WHERE name ILIKE $1 LIMIT 10', [like]),
  ]);
  res.json({ cards, notes, messages, channels });
}));

// Health check para balanceadores y monitoreo; confirma que la base responde.
// Debe registrarse antes del catch-all de estáticos.
app.get('/api/health', h(async (_req, res) => {
  await get('SELECT 1');
  res.json({ ok: true });
}));

// ---------- Estáticos en producción ----------
if (process.env.NODE_ENV === 'production') {
  const dist = path.join(process.cwd(), 'client', 'dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Manejador de errores: los rechazos de los handlers async terminan aquí
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Error no controlado:', err);
  if (!res.headersSent) res.status(500).json({ error: 'Error interno del servidor' });
});

// PORT lo inyectan las plataformas de contenedores (solo cuenta en producción:
// en dev PORT es el puerto de Vite); API_PORT es el override local de la API
const platformPort = process.env.NODE_ENV === 'production' ? process.env.PORT : undefined;
const PORT = Number(platformPort ?? process.env.API_PORT) || 3001;

async function main() {
  await initSchema();
  await seedIfEmpty();
  server.listen(PORT, () => console.log(`Obstresla API (PostgreSQL) escuchando en http://localhost:${PORT}`));
}

main().catch((err) => {
  console.error('No se pudo iniciar el servidor:', err);
  process.exit(1);
});
