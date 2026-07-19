import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { all, get, run, insert, transaction, initSchema, seedIfEmpty } from './db.ts';
import { APP_URL, inviteHtml, resetPasswordHtml, sendMail, verifyEmailHtml } from './mailer.ts';

const app = express();
app.set('trust proxy', 1); // nginx delante: req.ip sale de X-Forwarded-For
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://oauth2.googleapis.com; frame-src https://accounts.google.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(express.json({ limit: '256kb' }));

type AuthedRequest = express.Request & { userId?: number };

// Envuelve handlers async para que los errores lleguen al middleware de Express 4
type Handler = (req: AuthedRequest, res: express.Response) => Promise<unknown>;
const h = (fn: Handler): express.RequestHandler => (req, res, next) => {
  fn(req as AuthedRequest, res).catch(next);
};

// ---------- WebSockets (tiempo real) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set<WebSocket>();
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Presencia ("quién está viendo esto ahora mismo"): efímera, solo en
// memoria, un cliente pertenece a un único "room" (tablero/nota/canal) a la
// vez. Se valida acceso antes de sumar a alguien a un room para no filtrar
// quién más está mirando un recurso al que ese usuario no tiene acceso.
const wsUser = new Map<WebSocket, { userId: number; username: string; room: string | null }>();
const presenceRooms = new Map<string, Set<WebSocket>>();

function presenceRoomKey(resourceType: string, resourceId: number): string {
  return `${resourceType}:${resourceId}`;
}

function broadcastPresence(room: string) {
  const sockets = presenceRooms.get(room);
  const viewers = sockets
    ? [...sockets].map((s) => wsUser.get(s)).filter((u): u is NonNullable<typeof u> => !!u)
      .map((u) => ({ userId: u.userId, username: u.username }))
    : [];
  const [resourceType, resourceIdStr] = room.split(':');
  broadcast({ type: 'presence:update', resourceType, resourceId: Number(resourceIdStr), viewers });
}

function leavePresenceRoom(socket: WebSocket) {
  const info = wsUser.get(socket);
  if (!info?.room) return;
  presenceRooms.get(info.room)?.delete(socket);
  const room = info.room;
  info.room = null;
  broadcastPresence(room);
}

wss.on('connection', async (socket, req) => {
  const token = cookieValue(req.headers.cookie, 'qhq_session') ?? '';
  const session = await get<{ user_id: number }>('SELECT user_id FROM sessions WHERE token = $1 AND (expires_at IS NULL OR expires_at >= $2)', [token, new Date().toISOString()]);
  if (!session) { socket.close(); return; }
  const account = await get<{ username: string }>('SELECT username FROM users WHERE id = $1', [session.user_id]);
  wsClients.add(socket);
  wsUser.set(socket, { userId: session.user_id, username: account?.username ?? '', room: null });

  socket.on('message', async (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.type === 'presence:leave') { leavePresenceRoom(socket); return; }
    if (msg?.type === 'presence:join' && ['board', 'note', 'channel'].includes(msg.resourceType) && Number.isFinite(Number(msg.resourceId))) {
      const resourceId = Number(msg.resourceId);
      if (!(await hasResourceAccess(msg.resourceType, resourceId, session.user_id))) return;
      leavePresenceRoom(socket);
      const room = presenceRoomKey(msg.resourceType, resourceId);
      const info = wsUser.get(socket);
      if (!info) return;
      info.room = room;
      if (!presenceRooms.has(room)) presenceRooms.set(room, new Set());
      presenceRooms.get(room)!.add(socket);
      broadcastPresence(room);
    }
  });

  socket.on('close', () => {
    wsClients.delete(socket);
    leavePresenceRoom(socket);
    wsUser.delete(socket);
  });
});

function broadcast(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

// ---------- Autenticación ----------
function sessionExpiresAt(): string {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

async function createSession(userId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await run('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, userId, sessionExpiresAt()]);
  return token;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) return decodeURIComponent(rawValue.join('='));
  }
  return null;
}

function authTokenFromRequest(req: express.Request): string {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return cookieValue(req.headers.cookie, 'qhq_session') ?? '';
}

function setSessionCookie(res: express.Response, token: string) {
  res.cookie('qhq_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function clearSessionCookie(res: express.Response) {
  res.clearCookie('qhq_session', {
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}

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

// Rate limiting en memoria para los endpoints de autenticación
const attempts = new Map<string, { count: number; resetAt: number }>();
function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count++;
  return entry.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) if (entry.resetAt < now) attempts.delete(key);
}, 10 * 60 * 1000);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Deriva un username único a partir del email (misma lógica que Google Sign-In)
async function uniqueUsername(email: string): Promise<string> {
  const base = (email.split('@')[0] ?? 'usuario').toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'usuario';
  let username = base;
  for (let i = 2; await get('SELECT 1 FROM users WHERE username = $1', [username]); i++) {
    username = `${base}${i}`;
  }
  return username;
}

// Tokens de un solo uso (verificación / reseteo); se guarda solo el hash
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createAuthToken(userId: number, kind: 'verify' | 'reset', ttlMs: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await run('DELETE FROM auth_tokens WHERE user_id = $1 AND kind = $2', [userId, kind]);
  await run('INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [userId, kind, hashToken(token), new Date(Date.now() + ttlMs).toISOString()]);
  return token;
}

async function consumeAuthToken(token: string, kind: 'verify' | 'reset'): Promise<number | null> {
  const row = await get<{ id: number; user_id: number; expires_at: string }>(
    'SELECT id, user_id, expires_at FROM auth_tokens WHERE token_hash = $1 AND kind = $2', [hashToken(token), kind]);
  if (!row) return null;
  await run('DELETE FROM auth_tokens WHERE id = $1', [row.id]);
  if (row.expires_at < new Date().toISOString()) return null;
  return row.user_id;
}

const requireAuth: express.RequestHandler = (req: AuthedRequest, res, next) => {
  const token = authTokenFromRequest(req);
  const nowIso = new Date().toISOString();
  get<{ user_id: number }>('SELECT user_id FROM sessions WHERE token = $1 AND (expires_at IS NULL OR expires_at >= $2)', [token, nowIso])
    .then(async (session) => {
      if (!session) {
        await run('DELETE FROM sessions WHERE token = $1 OR (expires_at IS NOT NULL AND expires_at < $2)', [token, nowIso]);
        return res.status(401).json({ error: 'No autenticado' });
      }
      req.userId = session.user_id;
      next();
    })
    .catch(next);
};

// ---------- Planes (freemium) ----------
// El plan Free tiene límites de cantidad y las funciones exclusivas se marcan
// con requirePremium. El servidor es la fuente de verdad; el cliente solo
// refleja el plan en la UI. El upgrade es simulado: cuando haya pasarela de
// pago real (Stripe/MercadoPago), se integra en /api/billing/upgrade.
const FREE_LIMITS = { boards: 2, notes: 20, channels: 3, cardsPerBoard: 50, noteVersions: 3, channelCollaborators: 3 };
const PREMIUM_DAYS = 30;
const TEAM_EXTRA_SEATS = 4; // el plan Equipos cubre 5 cuentas: titular + 4 miembros
const PLAN_PRICES_CENTS: Record<'premium' | 'team', number> = { premium: 999, team: 1999 };

// Plan efectivo del usuario: premium propio (individual o Equipos, no vencido)
// o un asiento en el equipo activo de otro usuario.
async function userPlan(userId: number): Promise<'free' | 'premium'> {
  const nowIso = new Date().toISOString(); // premium_until es ISO-UTC: comparar como texto es correcto
  const row = await get<{ plan: string; premium_until: string | null }>(
    'SELECT plan, premium_until FROM users WHERE id = $1', [userId]);
  if (!row) return 'free';
  if (row.plan === 'premium' || row.plan === 'team') {
    if (row.premium_until && row.premium_until < nowIso) {
      await run(`UPDATE users SET plan = 'free', premium_until = NULL WHERE id = $1`, [userId]);
    } else {
      return 'premium';
    }
  }
  const seat = await get(`
    SELECT 1 FROM team_seats
    JOIN users owner ON owner.id = team_seats.owner_id
    WHERE team_seats.user_id = $1 AND owner.plan = 'team'
      AND (owner.premium_until IS NULL OR owner.premium_until >= $2)
    LIMIT 1
  `, [userId, nowIso]);
  return seat ? 'premium' : 'free';
}

const requirePremium: express.RequestHandler = (req: AuthedRequest, res, next) => {
  userPlan(req.userId!)
    .then((plan) => {
      if (plan !== 'premium') {
        return res.status(403).json({ error: 'Esta función es exclusiva del plan Premium', code: 'premium_required' });
      }
      next();
    })
    .catch(next);
};

// Si ADMIN_HOST está definido (producción: admin.quarryhq.pro), los endpoints
// de administración solo existen en esa URL: desde la app principal dan 404.
const ADMIN_HOST = process.env.ADMIN_HOST ?? '';

const requireAdmin: express.RequestHandler = (req: AuthedRequest, res, next) => {
  if (ADMIN_HOST && req.hostname !== ADMIN_HOST) {
    return res.status(404).json({ error: 'No encontrado' });
  }
  get<{ is_admin: number }>('SELECT is_admin FROM users WHERE id = $1', [req.userId!])
    .then((row) => {
      if (!row?.is_admin) return res.status(403).json({ error: 'Solo administradores' });
      next();
    })
    .catch(next);
};

// ---------- Códigos de invitación ----------
// Regalan días de Premium. Cada usuario puede canjear un solo código.
function generateInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return `QHQ-${s.slice(0, 4)}-${s.slice(4)}`;
}

async function redeemInvite(userId: number, rawCode: string): Promise<{ ok: true; days: number } | { ok: false; error: string }> {
  const code = rawCode.trim().toUpperCase();
  return transaction(async (client) => {
    const inviteRes = await client.query<{ id: number; trial_days: number; max_uses: number; used_count: number }>(
      'SELECT id, trial_days, max_uses, used_count FROM invite_codes WHERE code = $1 FOR UPDATE', [code]);
    const invite = inviteRes.rows[0];
    if (!invite || invite.used_count >= invite.max_uses) {
      return { ok: false, error: 'Código de invitación inválido o agotado' };
    }

    const prior = await client.query('SELECT 1 FROM invite_redemptions WHERE user_id = $1', [userId]);
    if (prior.rowCount) return { ok: false, error: 'Ya canjeaste un código de invitación' };

    await client.query('INSERT INTO invite_redemptions (code_id, user_id) VALUES ($1, $2)', [invite.id, userId]);
    await client.query('UPDATE invite_codes SET used_count = used_count + 1 WHERE id = $1', [invite.id]);

    const userRes = await client.query<{ plan: string; premium_until: string | null }>(
      'SELECT plan, premium_until FROM users WHERE id = $1', [userId]);
    const row = userRes.rows[0];
    const nowIso = new Date().toISOString();
    const from = row?.premium_until && row.premium_until > nowIso ? new Date(row.premium_until) : new Date();
    const until = new Date(from.getTime() + invite.trial_days * 24 * 60 * 60 * 1000).toISOString();
    const tier = row?.plan === 'team' ? 'team' : 'premium';
    await client.query('UPDATE users SET plan = $1, premium_until = $2 WHERE id = $3', [tier, until, userId]);
    return { ok: true, days: invite.trial_days };
  });
}


// true = puede crear; false = ya respondió 403 por límite del plan Free.
// planUserId es de quién se evalúa el plan: normalmente quien crea el recurso,
// pero para límites de un recurso ya existente y compartido (tarjetas por
// tablero) es el dueño del recurso, no quien está actuando.
async function withinLimit(planUserId: number, res: express.Response,
  countSql: string, params: unknown[], limit: number, what: string): Promise<boolean> {
  if ((await userPlan(planUserId)) === 'premium') return true;
  const row = await get<{ n: number }>(countSql, params);
  if ((row?.n ?? 0) >= limit) {
    res.status(403).json({
      error: `El plan Free permite hasta ${limit} ${what}. Pasa a Premium para seguir creando.`,
      code: 'limit_reached',
    });
    return false;
  }
  return true;
}

// ---------- Recursos compartidos ----------
// Un colaborador tiene los mismos permisos que el dueño sobre el CONTENIDO de
// un tablero/nota/canal (crear/editar/borrar listas, tarjetas, mensajes...),
// pero solo el dueño puede borrar el recurso en sí o gestionar quién lo
// comparte (ver registerShareRoutes más abajo).
type ShareType = 'board' | 'note' | 'channel';
const SHARE_TABLE: Record<ShareType, string> = { board: 'boards', note: 'notes', channel: 'channels' };

// SHARE_TABLE[type] solo puede ser uno de los 3 valores fijos de arriba
// (type nunca viene directo de req), así que interpolarlo en el SQL es seguro.
async function hasResourceAccess(type: ShareType, id: number, userId: number): Promise<boolean> {
  const row = await get(`SELECT 1 FROM ${SHARE_TABLE[type]} WHERE id = $1 AND (owner_id = $2
    OR EXISTS (SELECT 1 FROM resource_shares WHERE resource_type = $3 AND resource_id = $1 AND user_id = $2))`,
    [id, userId, type]);
  return !!row;
}

// A diferencia de hasResourceAccess (lectura), exige rol 'editor' si es
// colaborador — un 'viewer' pasa hasResourceAccess pero no esto.
async function hasWriteAccess(type: ShareType, id: number, userId: number): Promise<boolean> {
  const row = await get(`SELECT 1 FROM ${SHARE_TABLE[type]} WHERE id = $1 AND (owner_id = $2
    OR EXISTS (SELECT 1 FROM resource_shares WHERE resource_type = $3 AND resource_id = $1 AND user_id = $2 AND role = 'editor'))`,
    [id, userId, type]);
  return !!row;
}

async function isResourceOwner(type: ShareType, id: number, userId: number): Promise<boolean> {
  const row = await get(`SELECT 1 FROM ${SHARE_TABLE[type]} WHERE id = $1 AND owner_id = $2`, [id, userId]);
  return !!row;
}

async function resourceOwnerId(type: ShareType, id: number): Promise<number | null> {
  const row = await get<{ owner_id: number }>(`SELECT owner_id FROM ${SHARE_TABLE[type]} WHERE id = $1`, [id]);
  return row?.owner_id ?? null;
}

// Rol efectivo del usuario sobre un recurso, para que el cliente pueda
// ocultar controles de edición a un 'viewer' (el servidor igual lo exige en
// cada endpoint de escritura — esto es solo para la UI).
async function myRoleFor(type: ShareType, id: number, userId: number): Promise<'owner' | 'editor' | 'viewer' | null> {
  const row = await get<{ owner_id: number }>(`SELECT owner_id FROM ${SHARE_TABLE[type]} WHERE id = $1`, [id]);
  if (!row) return null;
  if (row.owner_id === userId) return 'owner';
  const share = await get<{ role: string }>(
    `SELECT role FROM resource_shares WHERE resource_type = $1 AND resource_id = $2 AND user_id = $3`, [type, id, userId]);
  return share ? (share.role === 'editor' ? 'editor' : 'viewer') : null;
}

async function boardIdForList(listId: number, userId: number, requireWrite = false): Promise<number | null> {
  const row = await get<{ board_id: number }>(
    'SELECT board_id FROM lists WHERE id = $1', [listId]);
  if (!row) return null;
  const ok = requireWrite ? await hasWriteAccess('board', row.board_id, userId) : await hasResourceAccess('board', row.board_id, userId);
  if (!ok) return null;
  return row.board_id;
}

async function cardBoardIdForUser(cardId: number, userId: number, requireWrite = false): Promise<number | null> {
  const row = await get<{ board_id: number }>(
    'SELECT lists.board_id FROM cards JOIN lists ON lists.id = cards.list_id WHERE cards.id = $1', [cardId]);
  if (!row) return null;
  const ok = requireWrite ? await hasWriteAccess('board', row.board_id, userId) : await hasResourceAccess('board', row.board_id, userId);
  if (!ok) return null;
  return row.board_id;
}

async function ownsEntity(type: string, id: number, userId: number, requireWrite = false): Promise<boolean> {
  const check = requireWrite ? hasWriteAccess : hasResourceAccess;
  if (type === 'note') return check('note', id, userId);
  if (type === 'channel') return check('channel', id, userId);
  if (type === 'message') {
    const row = await get<{ channel_id: number }>('SELECT channel_id FROM messages WHERE id = $1', [id]);
    return !!row && check('channel', row.channel_id, userId);
  }
  if (type === 'card') return !!(await cardBoardIdForUser(id, userId, requireWrite));
  return false;
}

app.post('/api/register', h(async (req, res) => {
  if (rateLimited(`reg:${req.ip}`, 5, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiados registros desde esta dirección. Intenta más tarde.' });
  }
  const email = (req.body?.email ?? '').trim().toLowerCase();
  const { password } = req.body ?? {};
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email inválido' });
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  const existing = await get('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
  if (existing) return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });

  // Código de invitación opcional: se valida antes de crear la cuenta para
  // que un código mal escrito no deje al colega registrado sin su prueba
  const inviteCode = (req.body?.invite_code ?? '').trim();
  if (inviteCode) {
    const invite = await get<{ max_uses: number; used_count: number }>(
      'SELECT max_uses, used_count FROM invite_codes WHERE code = $1', [inviteCode.toUpperCase()]);
    if (!invite || invite.used_count >= invite.max_uses) {
      return res.status(400).json({ error: 'Código de invitación inválido o agotado' });
    }
  }

  const username = await uniqueUsername(email);
  const userId = await insert('INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)',
    [username, email, hashPassword(password)]);
  let plan: 'free' | 'premium' = 'free';
  if (inviteCode) {
    const redeemed = await redeemInvite(userId, inviteCode);
    if (redeemed.ok) plan = 'premium';
  }

  const verifyToken = await createAuthToken(userId, 'verify', 7 * 24 * 60 * 60 * 1000);
  sendMail(email, 'Confirma tu correo en QuarryHQ', verifyEmailHtml(verifyToken))
    .catch((err) => console.error('Error enviando verificación:', err));

  const token = await createSession(userId);
  setSessionCookie(res, token);
  res.json({ token, user: { id: userId, username, email, plan } });
}));

app.post('/api/login', h(async (req, res) => {
  // Acepta email o username (compatibilidad con cuentas anteriores al registro con email)
  const identifier = (req.body?.username ?? req.body?.email ?? '').trim();
  const { password } = req.body ?? {};
  if (rateLimited(`login:${req.ip}:${identifier.toLowerCase()}`, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  }
  const user = await get<{ id: number; username: string; password_hash: string }>(
    'SELECT id, username, password_hash FROM users WHERE username = $1 OR LOWER(email) = LOWER($1)', [identifier]);
  if (!user || !user.password_hash || !verifyPassword(password ?? '', user.password_hash)) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  const token = await createSession(user.id);
  setSessionCookie(res, token);
  res.json({ token, user: { id: user.id, username: user.username, plan: await userPlan(user.id) } });
}));

// ---------- Verificación de email y reseteo de contraseña ----------
app.get('/api/auth/verify', h(async (req, res) => {
  const userId = await consumeAuthToken(String(req.query.token ?? ''), 'verify');
  if (userId) await run('UPDATE users SET email_verified = 1 WHERE id = $1', [userId]);
  // Vuelve a la app con el resultado en el hash
  res.redirect(`${APP_URL}/#/${userId ? 'verificado' : 'verificacion-fallida'}`);
}));

app.post('/api/auth/forgot', h(async (req, res) => {
  if (rateLimited(`forgot:${req.ip}`, 3, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiados pedidos. Espera 15 minutos.' });
  }
  const email = (req.body?.email ?? '').trim().toLowerCase();
  // Respuesta idéntica exista o no la cuenta: no revelar emails registrados
  const user = await get<{ id: number }>('SELECT id FROM users WHERE LOWER(email) = $1 AND password_hash IS NOT NULL', [email]);
  if (user) {
    const token = await createAuthToken(user.id, 'reset', 60 * 60 * 1000);
    sendMail(email, 'Restablece tu contraseña de QuarryHQ', resetPasswordHtml(token))
      .catch((err) => console.error('Error enviando reseteo:', err));
  }
  res.json({ ok: true });
}));

app.post('/api/auth/reset', h(async (req, res) => {
  const { token, password } = req.body ?? {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  const userId = await consumeAuthToken(String(token ?? ''), 'reset');
  if (!userId) return res.status(400).json({ error: 'El enlace es inválido o venció. Pide uno nuevo.' });
  await run('UPDATE users SET password_hash = $1, email_verified = 1 WHERE id = $2', [hashPassword(password), userId]);
  await run('DELETE FROM sessions WHERE user_id = $1', [userId]); // cierra todas las sesiones
  const user = await get<{ id: number; username: string }>('SELECT id, username FROM users WHERE id = $1', [userId]);
  const session = await createSession(userId);
  setSessionCookie(res, session);
  res.json({ token: session, user: { ...user, plan: await userPlan(userId) } });
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

  const token = await createSession(user.id);
  setSessionCookie(res, token);
  res.json({ token, user: { ...user, plan: await userPlan(user.id) } });
}));

app.get('/api/me', requireAuth, h(async (req: AuthedRequest, res) => {
  const plan = await userPlan(req.userId!); // primero: degrada suscripciones vencidas
  const row = await get('SELECT id, username, name, picture, plan, premium_until, is_admin, email, email_verified, theme_preset, theme_accent, theme_bg FROM users WHERE id = $1', [req.userId!]);

  // Información de equipo: titular ve sus miembros; un miembro ve a su titular
  let team: unknown = null;
  if (row.plan === 'team') {
    const members = await all(`
      SELECT users.id, users.username FROM team_seats
      JOIN users ON users.id = team_seats.user_id
      WHERE team_seats.owner_id = $1 ORDER BY users.username
    `, [req.userId!]);
    team = { role: 'owner', members, max_members: TEAM_EXTRA_SEATS };
  } else {
    const seat = await get<{ username: string }>(`
      SELECT owner.username FROM team_seats
      JOIN users owner ON owner.id = team_seats.owner_id
      WHERE team_seats.user_id = $1 AND owner.plan = 'team'
        AND (owner.premium_until IS NULL OR owner.premium_until >= $2)
      LIMIT 1
    `, [req.userId!, new Date().toISOString()]);
    if (seat) team = { role: 'member', owner: seat.username };
  }

  const [boards, notes, channels] = await Promise.all([
    get<{ n: number }>('SELECT COUNT(*)::int AS n FROM boards WHERE owner_id = $1', [req.userId!]),
    get<{ n: number }>('SELECT COUNT(*)::int AS n FROM notes WHERE owner_id = $1', [req.userId!]),
    get<{ n: number }>('SELECT COUNT(*)::int AS n FROM channels WHERE owner_id = $1', [req.userId!]),
  ]);
  res.json({
    // user.plan es el plan EFECTIVO (lo que desbloquea la UI); subscription es
    // lo contratado por este usuario ('none' | 'premium' | 'team')
    user: { ...row, plan, subscription: row.plan === 'free' ? 'none' : row.plan },
    team,
    limits: plan === 'free' ? FREE_LIMITS : null,
    usage: { boards: boards?.n ?? 0, notes: notes?.n ?? 0, channels: channels?.n ?? 0 },
  });
}));

// ---------- Estética del escritorio (exclusivo Premium) ----------
// Se valida contra listas fijas + un formato de color/URL estricto: nada de
// lo que llega en el body se interpola directo en HTML/CSS sin chequear.
const THEME_PRESETS = ['default', 'ocean', 'sunset', 'forest', 'rose', 'custom'];
const BG_PRESETS = ['default', 'mono', 'mountains', 'forest', 'aurora', 'nebula', 'earth'];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

app.patch('/api/me/theme', requireAuth, requirePremium, h(async (req: AuthedRequest, res) => {
  const preset = THEME_PRESETS.includes(req.body?.preset) ? req.body.preset : 'default';
  const accent = preset === 'custom' && HEX_COLOR_RE.test(req.body?.accent ?? '') ? req.body.accent : null;
  const rawBg = String(req.body?.bg ?? 'default').trim();
  const bg = rawBg.startsWith('https://') && rawBg.length <= 600 ? rawBg
    : (BG_PRESETS.includes(rawBg) ? rawBg : 'default');
  await run('UPDATE users SET theme_preset = $1, theme_accent = $2, theme_bg = $3 WHERE id = $4',
    [preset, accent, bg, req.userId!]);
  res.json({ ok: true, theme_preset: preset, theme_accent: accent, theme_bg: bg });
}));

// ---------- Facturación (simulada) ----------
app.post('/api/billing/upgrade', requireAuth, h(async (req: AuthedRequest, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_FAKE_BILLING !== '1') {
    return res.status(501).json({ error: 'La activación de planes requiere una pasarela de pago configurada' });
  }
  // Simulación local: extiende 30 días desde ahora, o desde el vencimiento si aún queda saldo.
  const tier = req.body?.plan === 'team' ? 'team' : 'premium';
  const row = await get<{ premium_until: string | null }>('SELECT premium_until FROM users WHERE id = $1', [req.userId!]);
  const nowIso = new Date().toISOString();
  const from = row?.premium_until && row.premium_until > nowIso ? new Date(row.premium_until) : new Date();
  const until = new Date(from.getTime() + PREMIUM_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await run(`UPDATE users SET plan = $1, premium_until = $2 WHERE id = $3`, [tier, until, req.userId!]);
  // Registro del cobro (la pasarela real reemplaza el método 'simulado')
  await insert('INSERT INTO payments (user_id, plan, amount_cents, days) VALUES ($1, $2, $3, $4)',
    [req.userId!, tier, PLAN_PRICES_CENTS[tier], PREMIUM_DAYS]);
  res.json({ plan: tier, premium_until: until });
}));

app.post('/api/billing/cancel', requireAuth, h(async (req: AuthedRequest, res) => {
  await run(`UPDATE users SET plan = 'free', premium_until = NULL WHERE id = $1`, [req.userId!]);
  res.json({ plan: 'free', premium_until: null });
}));

// ---------- Códigos de invitación: canje y administración ----------
app.post('/api/invites/redeem', requireAuth, h(async (req: AuthedRequest, res) => {
  const code = (req.body?.code ?? '').trim();
  if (!code) return res.status(400).json({ error: 'Código requerido' });
  const result = await redeemInvite(req.userId!, code);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, days: result.days });
}));

// Estadísticas del SaaS para el backend de administración
app.get('/api/admin/stats', requireAuth, requireAdmin, h(async (_req, res) => {
  const nowIso = new Date().toISOString();
  const [users, premium, team, verified, redemptions, revenue] = await Promise.all([
    get<{ n: number }>('SELECT COUNT(*)::int AS n FROM users'),
    get<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE plan = 'premium' AND (premium_until IS NULL OR premium_until >= $1)`, [nowIso]),
    get<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE plan = 'team' AND (premium_until IS NULL OR premium_until >= $1)`, [nowIso]),
    get<{ n: number }>('SELECT COUNT(*)::int AS n FROM users WHERE email_verified = 1'),
    get<{ n: number }>('SELECT COUNT(*)::int AS n FROM invite_redemptions'),
    get<{ n: number }>('SELECT COALESCE(SUM(amount_cents), 0)::int AS n FROM payments'),
  ]);
  res.json({
    users: users?.n ?? 0,
    premium_subs: premium?.n ?? 0,
    team_subs: team?.n ?? 0,
    verified: verified?.n ?? 0,
    invite_redemptions: redemptions?.n ?? 0,
    revenue_cents: revenue?.n ?? 0,
  });
}));

// ---------- Administración: usuarios ----------
app.get('/api/admin/users', requireAuth, requireAdmin, h(async (_req, res) => {
  const users = await all(`
    SELECT users.id, users.username, users.email, users.name, users.plan, users.premium_until,
      users.is_admin, users.email_verified, users.created_at,
      (users.google_sub IS NOT NULL)::int AS has_google,
      (SELECT owner.username FROM team_seats JOIN users owner ON owner.id = team_seats.owner_id
        WHERE team_seats.user_id = users.id LIMIT 1) AS team_owner
    FROM users ORDER BY users.id DESC
  `);
  res.json({ users });
}));

// Premium de cortesía: extiende N días sin registrar pago
app.post('/api/admin/users/:id/premium', requireAuth, requireAdmin, h(async (req: AuthedRequest, res) => {
  const userId = Number(req.params.id);
  const days = Math.min(365, Math.max(1, Number(req.body?.days) || 30));
  const row = await get<{ plan: string; premium_until: string | null }>(
    'SELECT plan, premium_until FROM users WHERE id = $1', [userId]);
  if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
  const nowIso = new Date().toISOString();
  const from = row.premium_until && row.premium_until > nowIso ? new Date(row.premium_until) : new Date();
  const until = new Date(from.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  const tier = row.plan === 'team' ? 'team' : 'premium';
  await run('UPDATE users SET plan = $1, premium_until = $2 WHERE id = $3', [tier, until, userId]);
  res.json({ ok: true, premium_until: until });
}));

app.delete('/api/admin/users/:id/premium', requireAuth, requireAdmin, h(async (req, res) => {
  await run(`UPDATE users SET plan = 'free', premium_until = NULL WHERE id = $1`, [Number(req.params.id)]);
  res.json({ ok: true });
}));

app.post('/api/admin/users/:id/toggle-admin', requireAuth, requireAdmin, h(async (req: AuthedRequest, res) => {
  const userId = Number(req.params.id);
  if (userId === req.userId) return res.status(400).json({ error: 'No puedes cambiar tu propio rol de administrador' });
  const row = await get<{ is_admin: number }>('SELECT is_admin FROM users WHERE id = $1', [userId]);
  if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
  await run('UPDATE users SET is_admin = $1 WHERE id = $2', [row.is_admin ? 0 : 1, userId]);
  res.json({ ok: true, is_admin: row.is_admin ? 0 : 1 });
}));

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, h(async (req: AuthedRequest, res) => {
  const userId = Number(req.params.id);
  if (userId === req.userId) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
  const deleted = await run('DELETE FROM users WHERE id = $1', [userId]);
  if (!deleted) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ ok: true });
}));

// ---------- Administración: pagos ----------
app.get('/api/admin/payments', requireAuth, requireAdmin, h(async (_req, res) => {
  const payments = await all(`
    SELECT payments.*, users.username, users.email
    FROM payments JOIN users ON users.id = payments.user_id
    ORDER BY payments.id DESC LIMIT 500
  `);
  const total = await get<{ n: number }>('SELECT COALESCE(SUM(amount_cents), 0)::int AS n FROM payments');
  res.json({ payments, total_cents: total?.n ?? 0 });
}));

app.get('/api/invites', requireAuth, requireAdmin, h(async (_req, res) => {
  const invites = await all(`
    SELECT invite_codes.*,
      (SELECT string_agg(users.username, ', ' ORDER BY users.username)
       FROM invite_redemptions JOIN users ON users.id = invite_redemptions.user_id
       WHERE invite_redemptions.code_id = invite_codes.id) AS redeemed_by
    FROM invite_codes ORDER BY invite_codes.id DESC
  `);
  res.json({ invites });
}));

app.post('/api/invites', requireAuth, requireAdmin, h(async (req: AuthedRequest, res) => {
  const trialDays = Math.min(365, Math.max(1, Number(req.body?.trial_days) || 14));
  const maxUses = Math.min(100, Math.max(1, Number(req.body?.max_uses) || 1));
  let code = generateInviteCode();
  while (await get('SELECT 1 FROM invite_codes WHERE code = $1', [code])) code = generateInviteCode();
  await insert('INSERT INTO invite_codes (code, created_by, trial_days, max_uses) VALUES ($1, $2, $3, $4)',
    [code, req.userId!, trialDays, maxUses]);
  res.json({ code, trial_days: trialDays, max_uses: maxUses });
}));

app.delete('/api/invites/:id', requireAuth, requireAdmin, h(async (req, res) => {
  await run('DELETE FROM invite_codes WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ---------- Equipo (plan Equipos: titular + 4 miembros) ----------
app.post('/api/team/members', requireAuth, h(async (req: AuthedRequest, res) => {
  const me = await get<{ plan: string; premium_until: string | null }>(
    'SELECT plan, premium_until FROM users WHERE id = $1', [req.userId!]);
  const nowIso = new Date().toISOString();
  if (!me || me.plan !== 'team' || (me.premium_until && me.premium_until < nowIso)) {
    return res.status(403).json({ error: 'Necesitas el plan Equipos activo para invitar miembros', code: 'premium_required' });
  }
  const username = (req.body?.username ?? '').trim();
  if (!username) return res.status(400).json({ error: 'Usuario requerido' });
  const target = await get<{ id: number }>('SELECT id FROM users WHERE username = $1', [username]);
  if (!target) return res.status(404).json({ error: `No existe el usuario "${username}"` });
  if (target.id === req.userId) return res.status(400).json({ error: 'Tú ya eres el titular del equipo' });
  const seats = await get<{ n: number }>('SELECT COUNT(*)::int AS n FROM team_seats WHERE owner_id = $1', [req.userId!]);
  if ((seats?.n ?? 0) >= TEAM_EXTRA_SEATS) {
    return res.status(400).json({ error: `El plan Equipos cubre ${TEAM_EXTRA_SEATS + 1} cuentas: tú y ${TEAM_EXTRA_SEATS} miembros` });
  }
  await run('INSERT INTO team_seats (owner_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId!, target.id]);
  res.json({ ok: true });
}));

app.delete('/api/team/members/:userId', requireAuth, h(async (req: AuthedRequest, res) => {
  await run('DELETE FROM team_seats WHERE owner_id = $1 AND user_id = $2', [req.userId!, Number(req.params.userId)]);
  res.json({ ok: true });
}));

app.post('/api/logout', requireAuth, h(async (req: AuthedRequest, res) => {
  const token = authTokenFromRequest(req);
  if (token) await run('DELETE FROM sessions WHERE token = $1', [token]);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

// ---------- Wikilinks: [[Título]] crea vínculos hacia notas ----------
function extractWikilinks(text: string): string[] {
  return [...text.matchAll(/\[\[([^\[\]]+)\]\]/g)].map((m) => m[1].trim()).filter(Boolean);
}

async function syncWikilinks(sourceType: string, sourceId: number, text: string, kind: string, ownerId: number) {
  await run('DELETE FROM links WHERE source_type = $1 AND source_id = $2 AND kind = $3', [sourceType, sourceId, kind]);
  for (const title of extractWikilinks(text)) {
    const note = await get<{ id: number }>('SELECT id FROM notes WHERE owner_id = $1 AND LOWER(title) = LOWER($2)', [ownerId, title]);
    if (note) {
      await run(`INSERT INTO links (source_type, source_id, target_type, target_id, kind)
                 VALUES ($1, $2, 'note', $3, $4) ON CONFLICT DO NOTHING`, [sourceType, sourceId, note.id, kind]);
    }
  }
}

// ---------- @menciones: notifican, no dan acceso ----------
function extractMentions(text: string): string[] {
  // Exige borde de palabra antes del @ para no confundir "foo@example.com" con una mención
  const matches = [...text.matchAll(/(?:^|\s)@([a-zA-Z0-9._-]{2,32})/g)].map((m) => m[1]);
  return [...new Set(matches)];
}

// Solo notifica menciones NUEVAS (diff contra el contenido anterior), para
// no re-avisar en cada autoguardado mientras la mención sigue en el texto.
// Un @mención no da acceso a nada: si el mencionado no puede ver el
// recurso, no se genera notificación (no hay forma de "adivinar" contenido
// privado mencionando a alguien).
async function notifyMentions(resourceType: 'note' | 'channel', resourceId: number, actorId: number,
  newContent: string, oldContent: string, messageId: number | null = null) {
  const oldMentions = new Set(extractMentions(oldContent));
  const newMentions = extractMentions(newContent).filter((u) => !oldMentions.has(u));
  if (newMentions.length === 0) return;
  const excerpt = newContent.replace(/\s+/g, ' ').trim().slice(0, 140);
  for (const username of newMentions) {
    const target = await get<{ id: number }>('SELECT id FROM users WHERE username = $1', [username]);
    if (!target || target.id === actorId) continue;
    if (!(await hasResourceAccess(resourceType, resourceId, target.id))) continue;
    await insert(`INSERT INTO notifications (user_id, kind, resource_type, resource_id, actor_id, excerpt, message_id)
                  VALUES ($1, 'mention', $2, $3, $4, $5, $6)`,
      [target.id, resourceType, resourceId, actorId, excerpt, messageId]);
    broadcast({ type: 'notifications:changed', userId: target.id });
  }
}

// ---------- Feed de actividad por tablero ----------
// Solo cambios estructurales/de estado (crear/mover/completar/borrar), no
// cada edición de texto — si no, es puro ruido.
async function logActivity(boardId: number, actorId: number, action: string,
  opts: { cardTitle?: string | null; listName?: string | null; detail?: string | null } = {}) {
  await insert('INSERT INTO board_activity (board_id, actor_id, action, card_title, list_name, detail) VALUES ($1, $2, $3, $4, $5, $6)',
    [boardId, actorId, action, opts.cardTitle ?? null, opts.listName ?? null, opts.detail ?? null]);
}

// ---------- Tableros (Trello) ----------
app.get('/api/boards', requireAuth, h(async (req: AuthedRequest, res) => {
  const boards = await all(`
    SELECT boards.*, (boards.owner_id != $1) AS shared, owner.username AS owner_username
    FROM boards LEFT JOIN users owner ON owner.id = boards.owner_id AND boards.owner_id != $1
    WHERE boards.owner_id = $1
       OR EXISTS (SELECT 1 FROM resource_shares WHERE resource_type = 'board' AND resource_id = boards.id AND user_id = $1)
    ORDER BY boards.id
  `, [req.userId!]);
  res.json({ boards });
}));

app.post('/api/boards', requireAuth, h(async (req: AuthedRequest, res) => {
  const name = (req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  if (!(await withinLimit(req.userId!, res, 'SELECT COUNT(*)::int AS n FROM boards WHERE owner_id = $1', [req.userId!], FREE_LIMITS.boards, 'tableros'))) return;
  const boardId = await insert('INSERT INTO boards (owner_id, name) VALUES ($1, $2)', [req.userId!, name]);
  broadcast({ type: 'boards:changed' });
  res.json({ board: await get('SELECT * FROM boards WHERE id = $1 AND owner_id = $2', [boardId, req.userId!]) });
}));

app.delete('/api/boards/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  await run('DELETE FROM boards WHERE id = $1 AND owner_id = $2', [Number(req.params.id), req.userId!]);
  broadcast({ type: 'boards:changed' });
  res.json({ ok: true });
}));

app.get('/api/boards/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const boardId = Number(req.params.id);
  const board = await get(`
    SELECT boards.*, (boards.owner_id != $2) AS shared, owner.username AS owner_username
    FROM boards LEFT JOIN users owner ON owner.id = boards.owner_id
    WHERE boards.id = $1
  `, [boardId, req.userId!]);
  if (!board || !(await hasResourceAccess('board', boardId, req.userId!))) return res.status(404).json({ error: 'Tablero no encontrado' });
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
  res.json({ board, lists, myRole: await myRoleFor('board', boardId, req.userId!) });
}));

app.post('/api/lists', requireAuth, h(async (req: AuthedRequest, res) => {
  const { board_id, name } = req.body ?? {};
  if (!board_id || !name?.trim()) return res.status(400).json({ error: 'Datos incompletos' });
  if (!(await hasWriteAccess('board', Number(board_id), req.userId!))) return res.status(404).json({ error: 'Tablero no encontrado' });
  const max = await get<{ p: number }>('SELECT COALESCE(MAX(position), -1) AS p FROM lists WHERE board_id = $1', [board_id]);
  const listId = await insert('INSERT INTO lists (board_id, name, position) VALUES ($1, $2, $3)', [board_id, name.trim(), (max?.p ?? -1) + 1]);
  await logActivity(board_id, req.userId!, 'list_created', { listName: name.trim() });
  broadcast({ type: 'board:changed', boardId: board_id });
  res.json({ list: await get('SELECT * FROM lists WHERE id = $1', [listId]) });
}));

app.patch('/api/lists/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const list = await get('SELECT * FROM lists WHERE id = $1', [Number(req.params.id)]);
  if (!list || !(await hasWriteAccess('board', list.board_id, req.userId!))) return res.status(404).json({ error: 'Lista no encontrada' });
  const name = req.body?.name?.trim() || list.name;
  await run('UPDATE lists SET name = $1 WHERE id = $2', [name, list.id]);
  broadcast({ type: 'board:changed', boardId: list.board_id });
  res.json({ ok: true });
}));

app.delete('/api/lists/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const list = await get('SELECT * FROM lists WHERE id = $1', [Number(req.params.id)]);
  if (!list || !(await hasWriteAccess('board', list.board_id, req.userId!))) return res.status(404).json({ error: 'Lista no encontrada' });
  await run('DELETE FROM lists WHERE id = $1', [list.id]);
  await logActivity(list.board_id, req.userId!, 'list_deleted', { listName: list.name });
  broadcast({ type: 'board:changed', boardId: list.board_id });
  res.json({ ok: true });
}));

app.post('/api/cards', requireAuth, h(async (req: AuthedRequest, res) => {
  const { list_id, title } = req.body ?? {};
  if (!list_id || !title?.trim()) return res.status(400).json({ error: 'Datos incompletos' });
  const boardId = await boardIdForList(list_id, req.userId!, true);
  if (!boardId) return res.status(404).json({ error: 'Lista no encontrada' });
  // El cupo de tarjetas por tablero es una propiedad del tablero: se cuenta
  // sobre el tablero entero (no solo lo creado por quien actúa) y se evalúa
  // contra el plan de su dueño, no el de un colaborador que esté editando.
  const boardOwnerId = (await resourceOwnerId('board', boardId))!;
  if (!(await withinLimit(boardOwnerId, res,
    'SELECT COUNT(*)::int AS n FROM cards JOIN lists ON lists.id = cards.list_id WHERE lists.board_id = $1',
    [boardId], FREE_LIMITS.cardsPerBoard, 'tarjetas por tablero'))) return;
  const max = await get<{ p: number }>('SELECT COALESCE(MAX(position), -1) AS p FROM cards WHERE list_id = $1', [list_id]);
  const cardId = await insert('INSERT INTO cards (list_id, title, position) VALUES ($1, $2, $3)', [list_id, title.trim(), (max?.p ?? -1) + 1]);
  const listName = (await get<{ name: string }>('SELECT name FROM lists WHERE id = $1', [list_id]))?.name;
  await logActivity(boardId, req.userId!, 'card_created', { cardTitle: title.trim(), listName });
  broadcast({ type: 'board:changed', boardId });
  res.json({ card: await get('SELECT cards.* FROM cards WHERE id = $1', [cardId]) });
}));

app.get('/api/cards/:id', requireAuth, h(async (req, res) => {
  const cardId = Number(req.params.id);
  const card = await get(`
    SELECT cards.*, lists.name AS list_name, lists.board_id, editor.username AS updated_by_username
    FROM cards
    JOIN lists ON lists.id = cards.list_id
    LEFT JOIN users editor ON editor.id = cards.updated_by
    WHERE cards.id = $1
  `, [cardId]);
  if (!card || !(await hasResourceAccess('board', card.board_id, req.userId!))) return res.status(404).json({ error: 'Tarjeta no encontrada' });

  // Solo se muestran notas/discusión que el usuario actual puede acceder
  // (dueño o colaborador), aunque las haya vinculado otro colaborador.
  const linkedNotesAll = await all(`
    SELECT notes.id, notes.title, links.id AS link_id, links.kind
    FROM links JOIN notes ON notes.id = links.target_id
    WHERE links.source_type = 'card' AND links.source_id = $1 AND links.target_type = 'note'
  `, [cardId]);
  const linkedNotes = [];
  for (const n of linkedNotesAll) if (await hasResourceAccess('note', n.id, req.userId!)) linkedNotes.push(n);

  const discussionCandidate = await get(`
    SELECT channels.id, channels.name
    FROM links JOIN channels ON channels.id = links.target_id
    WHERE links.source_type = 'card' AND links.source_id = $1 AND links.target_type = 'channel' AND links.kind = 'discussion'
  `, [cardId]);
  const discussion = discussionCandidate && (await hasResourceAccess('channel', discussionCandidate.id, req.userId!)) ? discussionCandidate : null;

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
  if (!card || !(await hasWriteAccess('board', card.board_id, req.userId!))) return res.status(404).json({ error: 'Tarjeta no encontrada' });
  const title = req.body?.title?.trim() || card.title;
  const description = req.body?.description ?? card.description;
  const labels = req.body?.labels !== undefined ? JSON.stringify(req.body.labels) : card.labels;
  const dueDate = req.body?.due_date !== undefined ? (req.body.due_date || null) : card.due_date;
  const completed = req.body?.completed !== undefined ? (req.body.completed ? 1 : 0) : card.completed;
  await run(`UPDATE cards SET title = $1, description = $2, labels = $3, due_date = $4, completed = $5, updated_by = $6 WHERE id = $7`,
    [title, description, labels, dueDate, completed, req.userId!, card.id]);
  await syncWikilinks('card', card.id, description, 'wikilink', (await resourceOwnerId('board', card.board_id))!);
  if (req.body?.completed !== undefined && completed !== card.completed) {
    await logActivity(card.board_id, req.userId!, completed ? 'card_completed' : 'card_uncompleted', { cardTitle: title });
  }
  broadcast({ type: 'board:changed', boardId: card.board_id });
  res.json({ card: await get('SELECT * FROM cards WHERE id = $1', [card.id]) });
}));

app.post('/api/cards/:id/move', requireAuth, h(async (req, res) => {
  const cardId = Number(req.params.id);
  const { list_id, index } = req.body ?? {};
  const card = await get('SELECT cards.*, lists.board_id FROM cards JOIN lists ON lists.id = cards.list_id WHERE cards.id = $1', [cardId]);
  const target = await get('SELECT * FROM lists WHERE id = $1', [list_id]);
  if (!card || !target
      || !(await hasWriteAccess('board', card.board_id, req.userId!))
      || !(await hasWriteAccess('board', target.board_id, req.userId!))) {
    return res.status(404).json({ error: 'Tarjeta o lista no encontrada' });
  }

  const siblings = (await all<{ id: number }>('SELECT id FROM cards WHERE list_id = $1 AND id != $2 ORDER BY position', [list_id, cardId])).map((r) => r.id);
  const at = Math.max(0, Math.min(Number(index) || 0, siblings.length));
  siblings.splice(at, 0, cardId);
  for (let i = 0; i < siblings.length; i++) {
    await run('UPDATE cards SET list_id = $1, position = $2 WHERE id = $3', [list_id, i, siblings[i]]);
  }

  // Automatizaciones: aplicar reglas de la lista destino si la tarjeta cambió de lista
  if (card.list_id !== list_id) {
    await applyRules(cardId, list_id);
    await logActivity(target.board_id, req.userId!, 'card_moved', { cardTitle: card.title, listName: target.name });
  }

  broadcast({ type: 'board:changed', boardId: card.board_id });
  if (target.board_id !== card.board_id) broadcast({ type: 'board:changed', boardId: target.board_id });
  res.json({ ok: true });
}));

app.delete('/api/cards/:id', requireAuth, h(async (req, res) => {
  const card = await get('SELECT cards.*, lists.board_id FROM cards JOIN lists ON lists.id = cards.list_id WHERE cards.id = $1', [Number(req.params.id)]);
  if (!card || !(await hasWriteAccess('board', card.board_id, req.userId!))) return res.status(404).json({ error: 'Tarjeta no encontrada' });
  await run('DELETE FROM cards WHERE id = $1', [card.id]);
  await run("DELETE FROM links WHERE (source_type = 'card' AND source_id = $1) OR (target_type = 'card' AND target_id = $1)", [card.id]);
  await logActivity(card.board_id, req.userId!, 'card_deleted', { cardTitle: card.title });
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

app.get('/api/boards/:id/activity', requireAuth, h(async (req: AuthedRequest, res) => {
  const boardId = Number(req.params.id);
  if (!(await hasResourceAccess('board', boardId, req.userId!))) return res.status(404).json({ error: 'Tablero no encontrado' });
  const activity = await all(`
    SELECT board_activity.id, board_activity.action, board_activity.card_title, board_activity.list_name,
      board_activity.detail, board_activity.created_at, actor.username AS actor_username
    FROM board_activity LEFT JOIN users actor ON actor.id = board_activity.actor_id
    WHERE board_activity.board_id = $1 ORDER BY board_activity.id DESC LIMIT 100
  `, [boardId]);
  res.json({ activity });
}));

app.get('/api/boards/:id/rules', requireAuth, h(async (req: AuthedRequest, res) => {
  const boardId = Number(req.params.id);
  if (!(await hasResourceAccess('board', boardId, req.userId!))) return res.status(404).json({ error: 'Tablero no encontrado' });
  const rules = await all(`
    SELECT board_rules.*, lists.name AS list_name FROM board_rules
    JOIN lists ON lists.id = board_rules.list_id
    WHERE board_rules.board_id = $1 ORDER BY board_rules.id
  `, [boardId]);
  res.json({ rules });
}));

app.post('/api/boards/:id/rules', requireAuth, requirePremium, h(async (req: AuthedRequest, res) => {
  const boardId = Number(req.params.id);
  const { list_id, action, param } = req.body ?? {};
  const validActions = ['complete', 'uncomplete', 'label', 'due_today', 'clear_due'];
  const listBoardId = list_id ? await boardIdForList(Number(list_id), req.userId!, true) : null;
  if (!list_id || !validActions.includes(action) || listBoardId !== boardId) return res.status(400).json({ error: 'Regla inválida' });
  await insert('INSERT INTO board_rules (board_id, list_id, action, param) VALUES ($1, $2, $3, $4)',
    [boardId, list_id, action, param ?? '']);
  broadcast({ type: 'board:changed', boardId });
  res.json({ ok: true });
}));

app.delete('/api/rules/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const rule = await get<{ board_id: number }>('SELECT board_id FROM board_rules WHERE id = $1', [Number(req.params.id)]);
  if (!rule || !(await hasWriteAccess('board', rule.board_id, req.userId!))) return res.status(404).json({ error: 'Regla no encontrada' });
  await run('DELETE FROM board_rules WHERE id = $1', [Number(req.params.id)]);
  broadcast({ type: 'board:changed', boardId: rule.board_id });
  res.json({ ok: true });
}));

// ---------- Checklists ----------
async function cardBoardId(cardId: number): Promise<number | null> {
  const row = await get<{ board_id: number }>('SELECT lists.board_id FROM cards JOIN lists ON lists.id = cards.list_id WHERE cards.id = $1', [cardId]);
  return row?.board_id ?? null;
}

app.post('/api/cards/:id/checklist', requireAuth, h(async (req: AuthedRequest, res) => {
  const cardId = Number(req.params.id);
  const boardId = await cardBoardIdForUser(cardId, req.userId!, true);
  if (!boardId) return res.status(404).json({ error: 'Tarjeta no encontrada' });
  const text = (req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Texto requerido' });
  const max = await get<{ p: number }>('SELECT COALESCE(MAX(position), -1) AS p FROM checklist_items WHERE card_id = $1', [cardId]);
  await insert('INSERT INTO checklist_items (card_id, text, position) VALUES ($1, $2, $3)', [cardId, text, (max?.p ?? -1) + 1]);
  broadcast({ type: 'board:changed', boardId });
  res.json({ ok: true });
}));

app.patch('/api/checklist/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const item = await get('SELECT checklist_items.* FROM checklist_items JOIN cards ON cards.id = checklist_items.card_id WHERE checklist_items.id = $1', [Number(req.params.id)]);
  const boardId = item ? await cardBoardId(item.card_id) : null;
  if (!item || !boardId || !(await hasWriteAccess('board', boardId, req.userId!))) return res.status(404).json({ error: 'Elemento no encontrado' });
  const text = req.body?.text?.trim() || item.text;
  const done = req.body?.done !== undefined ? (req.body.done ? 1 : 0) : item.done;
  await run('UPDATE checklist_items SET text = $1, done = $2 WHERE id = $3', [text, done, item.id]);
  broadcast({ type: 'board:changed', boardId });
  res.json({ ok: true });
}));

app.delete('/api/checklist/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const item = await get<{ card_id: number }>('SELECT card_id FROM checklist_items WHERE id = $1', [Number(req.params.id)]);
  const boardId = item ? await cardBoardId(item.card_id) : null;
  if (!item || !boardId || !(await hasWriteAccess('board', boardId, req.userId!))) return res.status(404).json({ error: 'Elemento no encontrado' });
  await run('DELETE FROM checklist_items WHERE id = $1', [Number(req.params.id)]);
  broadcast({ type: 'board:changed', boardId });
  res.json({ ok: true });
}));

// ---------- Miembros de tarjeta ----------
app.get('/api/users', requireAuth, h(async (_req, res) => {
  res.json({ users: await all('SELECT id, username FROM users ORDER BY username') });
}));

// Solo gente con acceso real al tablero (dueño + colaboradores aceptados),
// para asignar como miembro de una tarjeta — antes se ofrecía CUALQUIER
// usuario de la plataforma, lo cual no tenía sentido y exponía el
// directorio completo de usuarios a cualquiera con sesión iniciada.
app.get('/api/boards/:id/collaborators', requireAuth, h(async (req: AuthedRequest, res) => {
  const boardId = Number(req.params.id);
  if (!(await hasResourceAccess('board', boardId, req.userId!))) return res.status(404).json({ error: 'Tablero no encontrado' });
  const users = await all(`
    SELECT users.id, users.username FROM users WHERE users.id = (SELECT owner_id FROM boards WHERE id = $1)
    UNION
    SELECT users.id, users.username FROM resource_shares
    JOIN users ON users.id = resource_shares.user_id
    WHERE resource_shares.resource_type = 'board' AND resource_shares.resource_id = $1
    ORDER BY username
  `, [boardId]);
  res.json({ users });
}));

app.post('/api/cards/:id/members', requireAuth, h(async (req: AuthedRequest, res) => {
  const cardId = Number(req.params.id);
  const boardId = await cardBoardIdForUser(cardId, req.userId!, true);
  if (!boardId) return res.status(404).json({ error: 'Tarjeta no encontrada' });
  const userId = Number(req.body?.user_id);
  if (!userId) return res.status(400).json({ error: 'Usuario requerido' });
  await run('INSERT INTO card_members (card_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [cardId, userId]);
  broadcast({ type: 'board:changed', boardId });
  res.json({ ok: true });
}));

app.delete('/api/cards/:id/members/:userId', requireAuth, h(async (req: AuthedRequest, res) => {
  const cardId = Number(req.params.id);
  const boardId = await cardBoardIdForUser(cardId, req.userId!, true);
  if (!boardId) return res.status(404).json({ error: 'Tarjeta no encontrada' });
  await run('DELETE FROM card_members WHERE card_id = $1 AND user_id = $2', [cardId, Number(req.params.userId)]);
  broadcast({ type: 'board:changed', boardId });
  res.json({ ok: true });
}));

// Crea (o devuelve) el canal de discusión vinculado a una tarjeta
// El canal de discusión de una tarjeta debe ser visible para todo el que
// tenga acceso al tablero (dueño + colaboradores), no solo para quien lo
// creó — si no, un colaborador del tablero no puede ver ni sus mensajes.
// channelOwnerId es el DUEÑO real del canal (channels.owner_id), no quien
// está pidiendo abrirlo ahora — si no, un colaborador que reabre un canal
// que creó otro quedaría excluido de sus propios grantees por error.
async function shareWithBoardCollaborators(channelId: number, channelOwnerId: number, boardId: number) {
  const boardOwnerId = (await resourceOwnerId('board', boardId))!;
  const boardCollaborators = await all<{ user_id: number }>(
    'SELECT user_id FROM resource_shares WHERE resource_type = $1 AND resource_id = $2', ['board', boardId]);
  const grantees = new Set([boardOwnerId, ...boardCollaborators.map((c) => c.user_id)]);
  grantees.delete(channelOwnerId); // ya tiene acceso por ser dueño del canal
  for (const userId of grantees) {
    await run('INSERT INTO resource_shares (resource_type, resource_id, owner_id, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      ['channel', channelId, channelOwnerId, userId]);
  }
}

app.post('/api/cards/:id/discussion', requireAuth, h(async (req, res) => {
  const cardId = Number(req.params.id);
  const card = await get<{ title: string; board_id: number }>('SELECT cards.title, lists.board_id FROM cards JOIN lists ON lists.id = cards.list_id WHERE cards.id = $1', [cardId]);
  if (!card || !(await hasResourceAccess('board', card.board_id, req.userId!))) return res.status(404).json({ error: 'Tarjeta no encontrada' });

  // Sin filtrar por dueño: solo puede existir un canal de discusión por
  // tarjeta, sin importar qué colaborador lo haya creado.
  const existing = await get<{ id: number; name: string; owner_id: number }>(`
    SELECT channels.id, channels.name, channels.owner_id FROM links
    JOIN channels ON channels.id = links.target_id
    WHERE links.source_type = 'card' AND links.source_id = $1 AND links.target_type = 'channel' AND links.kind = 'discussion'
  `, [cardId]);
  if (existing) {
    // Puede haber colaboradores nuevos en el tablero desde que se creó el
    // canal: se re-sincroniza el acceso en cada apertura (es barato e idempotente).
    await shareWithBoardCollaborators(existing.id, existing.owner_id, card.board_id);
    return res.json({ channel: { id: existing.id, name: existing.name } });
  }
  // Crear el canal (a diferencia de solo abrir uno que ya existe) es una
  // acción de escritura: un viewer puede leer la discusión, no crearla.
  if (!(await hasWriteAccess('board', card.board_id, req.userId!))) return res.status(403).json({ error: 'No podés crear la discusión de esta tarjeta' });
  if (!(await withinLimit(req.userId!, res, 'SELECT COUNT(*)::int AS n FROM channels WHERE owner_id = $1', [req.userId!], FREE_LIMITS.channels, 'canales'))) return;

  const slugBase = 'tarjeta-' + card.title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  let slug = slugBase || `tarjeta-${cardId}`;
  let suffix = 1;
  while (await get('SELECT id FROM channels WHERE owner_id = $1 AND name = $2', [req.userId!, slug])) slug = `${slugBase}-${++suffix}`;

  const channelId = await insert('INSERT INTO channels (owner_id, name) VALUES ($1, $2)', [req.userId!, slug]);
  await run(`INSERT INTO links (source_type, source_id, target_type, target_id, kind)
             VALUES ('card', $1, 'channel', $2, 'discussion') ON CONFLICT DO NOTHING`, [cardId, channelId]);
  await shareWithBoardCollaborators(channelId, req.userId!, card.board_id);
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

const NOTE_ACCESS_SQL = `(notes.owner_id = $1
  OR EXISTS (SELECT 1 FROM resource_shares WHERE resource_type = 'note' AND resource_id = notes.id AND user_id = $1))`;

app.get('/api/notes', requireAuth, h(async (req: AuthedRequest, res) => {
  const tag = String(req.query.tag ?? '').trim().toLowerCase();
  const notes = tag
    ? await all(`
        SELECT notes.id, notes.title, notes.updated_at, (notes.owner_id != $1) AS shared, owner.username AS owner_username
        FROM notes
        JOIN note_tags ON note_tags.note_id = notes.id
        LEFT JOIN users owner ON owner.id = notes.owner_id AND notes.owner_id != $1
        WHERE ${NOTE_ACCESS_SQL} AND note_tags.tag = $2 ORDER BY notes.updated_at DESC
      `, [req.userId!, tag])
    : await all(`
        SELECT notes.id, notes.title, notes.updated_at, (notes.owner_id != $1) AS shared, owner.username AS owner_username
        FROM notes LEFT JOIN users owner ON owner.id = notes.owner_id AND notes.owner_id != $1
        WHERE ${NOTE_ACCESS_SQL} ORDER BY notes.updated_at DESC
      `, [req.userId!]);
  res.json({ notes });
}));

app.get('/api/tags', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json({ tags: await all(`
    SELECT tag, COUNT(*) AS count FROM note_tags JOIN notes ON notes.id = note_tags.note_id
    WHERE ${NOTE_ACCESS_SQL} GROUP BY tag ORDER BY count DESC, tag
  `, [req.userId!]) });
}));

function fillTemplate(content: string, title: string): string {
  return content
    .replaceAll('{{titulo}}', title)
    .replaceAll('{{fecha}}', new Date().toISOString().slice(0, 10));
}

app.post('/api/notes', requireAuth, h(async (req: AuthedRequest, res) => {
  const title = (req.body?.title ?? '').trim();
  if (!title) return res.status(400).json({ error: 'Título requerido' });
  const existing = await get('SELECT * FROM notes WHERE owner_id = $1 AND LOWER(title) = LOWER($2)', [req.userId!, title]);
  if (existing) return res.json({ note: existing, existed: true });
  if (!(await withinLimit(req.userId!, res, 'SELECT COUNT(*)::int AS n FROM notes WHERE owner_id = $1', [req.userId!], FREE_LIMITS.notes, 'notas'))) return;
  let content = `# ${title}\n\n`;
  if (req.body?.template_id) {
    const template = await get<{ content: string }>('SELECT content FROM templates WHERE id = $1 AND (owner_id = $2 OR owner_id IS NULL)', [Number(req.body.template_id), req.userId!]);
    if (template) content = fillTemplate(template.content, title);
  }
  const noteId = await insert('INSERT INTO notes (owner_id, title, content) VALUES ($1, $2, $3)', [req.userId!, title, content]);
  await syncTags(noteId, content);
  await syncWikilinks('note', noteId, content, 'wikilink', req.userId!);
  broadcast({ type: 'notes:changed', noteId });
  res.json({ note: await get('SELECT * FROM notes WHERE id = $1 AND owner_id = $2', [noteId, req.userId!]) });
}));

// ---------- Plantillas ----------
app.get('/api/templates', requireAuth, h(async (req: AuthedRequest, res) => {
  res.json({ templates: await all('SELECT * FROM templates WHERE owner_id = $1 OR owner_id IS NULL ORDER BY owner_id NULLS FIRST, name', [req.userId!]) });
}));

app.post('/api/templates', requireAuth, requirePremium, h(async (req, res) => {
  const name = (req.body?.name ?? '').trim();
  const content = req.body?.content ?? '';
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const existing = await get('SELECT id FROM templates WHERE owner_id = $1 AND name = $2', [req.userId!, name]);
  if (existing) return res.status(409).json({ error: 'Ya existe una plantilla con ese nombre' });
  await insert('INSERT INTO templates (owner_id, name, content) VALUES ($1, $2, $3)', [req.userId!, name, content]);
  res.json({ ok: true });
}));

app.delete('/api/templates/:id', requireAuth, requirePremium, h(async (req, res) => {
  await run('DELETE FROM templates WHERE id = $1 AND owner_id = $2', [Number(req.params.id), req.userId!]);
  res.json({ ok: true });
}));

app.get('/api/notes/:id', requireAuth, h(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await get(`
    SELECT notes.*, editor.username AS updated_by_username, (notes.owner_id != $2) AS shared, owner.username AS owner_username
    FROM notes
    LEFT JOIN users editor ON editor.id = notes.updated_by
    LEFT JOIN users owner ON owner.id = notes.owner_id
    WHERE notes.id = $1
  `, [noteId, req.userId!]);
  if (!note || !(await hasResourceAccess('note', noteId, req.userId!))) return res.status(404).json({ error: 'Nota no encontrada' });

  const backlinksAll = await all(`
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
  // Solo se muestran vínculos entrantes de recursos que el usuario puede ver
  const backlinks = [];
  for (const b of backlinksAll) if (await ownsEntity(b.source_type, b.source_id, req.userId!)) backlinks.push(b);

  const outgoingAll = await all(`
    SELECT notes.id, notes.title FROM links
    JOIN notes ON notes.id = links.target_id
    WHERE links.source_type = 'note' AND links.source_id = $1 AND links.target_type = 'note'
  `, [noteId]);
  const outgoing = [];
  for (const n of outgoingAll) if (await hasResourceAccess('note', n.id, req.userId!)) outgoing.push(n);

  res.json({ note, backlinks, outgoing, myRole: await myRoleFor('note', noteId, req.userId!) });
}));

app.patch('/api/notes/:id', requireAuth, h(async (req, res) => {
  const note = await get('SELECT * FROM notes WHERE id = $1', [Number(req.params.id)]);
  if (!note || !(await hasWriteAccess('note', note.id, req.userId!))) return res.status(404).json({ error: 'Nota no encontrada' });
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

  await run(`UPDATE notes SET title = $1, content = $2, updated_by = $3, updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = $4`,
    [title, content, req.userId!, note.id]);
  // Los wikilinks/tags resuelven contra el dueño real de la nota, no contra
  // quien esté editando (puede ser un colaborador distinto).
  await syncWikilinks('note', note.id, content, 'wikilink', note.owner_id);
  await syncTags(note.id, content);
  await notifyMentions('note', note.id, req.userId!, content, note.content);
  broadcast({ type: 'notes:changed', noteId: note.id });
  res.json({ note: await get('SELECT * FROM notes WHERE id = $1', [note.id]) });
}));

app.get('/api/notes/:id/versions', requireAuth, h(async (req: AuthedRequest, res) => {
  const noteId = Number(req.params.id);
  if (!(await hasResourceAccess('note', noteId, req.userId!))) return res.status(404).json({ error: 'Nota no encontrada' });
  // Free ve solo las últimas versiones; el historial completo es Premium.
  // El límite depende del plan del dueño de la nota, no de quien la mira.
  const ownerId = (await resourceOwnerId('note', noteId))!;
  const plan = await userPlan(ownerId);
  const versions = await all(`
    SELECT id, title, created_at, length(content) AS size
    FROM note_versions WHERE note_id = $1 ORDER BY id DESC
    ${plan === 'free' ? `LIMIT ${FREE_LIMITS.noteVersions}` : ''}
  `, [noteId]);
  res.json({ versions });
}));

app.get('/api/versions/:id', requireAuth, h(async (req, res) => {
  const version = await get('SELECT note_versions.* FROM note_versions WHERE note_versions.id = $1', [Number(req.params.id)]);
  if (!version || !(await hasResourceAccess('note', version.note_id, req.userId!))) return res.status(404).json({ error: 'Versión no encontrada' });
  res.json({ version });
}));

app.post('/api/notes/:id/restore', requireAuth, requirePremium, h(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await get('SELECT * FROM notes WHERE id = $1', [noteId]);
  const version = await get('SELECT * FROM note_versions WHERE id = $1 AND note_id = $2', [Number(req.body?.version_id), noteId]);
  if (!note || !version || !(await hasWriteAccess('note', noteId, req.userId!))) return res.status(404).json({ error: 'Nota o versión no encontrada' });
  // El estado actual pasa al historial antes de restaurar
  await insert('INSERT INTO note_versions (note_id, title, content) VALUES ($1, $2, $3)', [noteId, note.title, note.content]);
  await run(`UPDATE notes SET title = $1, content = $2, updated_by = $3, updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = $4`,
    [version.title, version.content, req.userId!, noteId]);
  await syncWikilinks('note', noteId, version.content, 'wikilink', note.owner_id);
  await syncTags(noteId, version.content);
  broadcast({ type: 'notes:changed', noteId });
  res.json({ note: await get('SELECT * FROM notes WHERE id = $1', [noteId]) });
}));

app.delete('/api/notes/:id', requireAuth, h(async (req, res) => {
  const noteId = Number(req.params.id);
  await run('DELETE FROM notes WHERE id = $1 AND owner_id = $2', [noteId, req.userId!]);
  await run("DELETE FROM links WHERE (source_type = 'note' AND source_id = $1) OR (target_type = 'note' AND target_id = $1)", [noteId]);
  broadcast({ type: 'notes:changed', noteId, deleted: true });
  res.json({ ok: true });
}));

// Resuelve un título de wikilink a una nota (creándola si no existe)
app.post('/api/notes/resolve', requireAuth, h(async (req, res) => {
  const title = (req.body?.title ?? '').trim();
  if (!title) return res.status(400).json({ error: 'Título requerido' });
  let note = await get('SELECT * FROM notes WHERE owner_id = $1 AND LOWER(title) = LOWER($2)', [req.userId!, title]);
  if (!note) {
    if (!(await withinLimit(req.userId!, res, 'SELECT COUNT(*)::int AS n FROM notes WHERE owner_id = $1', [req.userId!], FREE_LIMITS.notes, 'notas'))) return;
    const noteId = await insert('INSERT INTO notes (owner_id, title, content) VALUES ($1, $2, $3)', [req.userId!, title, `# ${title}\n\n`]);
    note = await get('SELECT * FROM notes WHERE id = $1 AND owner_id = $2', [noteId, req.userId!]);
    broadcast({ type: 'notes:changed', noteId });
  }
  res.json({ note });
}));

// ---------- Canales y mensajes (Slack) ----------
app.get('/api/channels', requireAuth, h(async (req: AuthedRequest, res) => {
  const channels = await all(`
    SELECT channels.*,
      (SELECT links.source_id FROM links WHERE links.target_type = 'channel' AND links.target_id = channels.id AND links.kind = 'discussion' AND links.source_type = 'card') AS card_id,
      (channels.owner_id != $1) AS shared, owner.username AS owner_username
    FROM channels LEFT JOIN users owner ON owner.id = channels.owner_id AND channels.owner_id != $1
    WHERE channels.owner_id = $1
       OR EXISTS (SELECT 1 FROM resource_shares WHERE resource_type = 'channel' AND resource_id = channels.id AND user_id = $1)
    ORDER BY channels.name
  `, [req.userId!]);
  res.json({ channels });
}));

app.post('/api/channels', requireAuth, h(async (req: AuthedRequest, res) => {
  const name = (req.body?.name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const existing = await get('SELECT * FROM channels WHERE owner_id = $1 AND name = $2', [req.userId!, name]);
  if (existing) return res.status(409).json({ error: 'Ese canal ya existe' });
  if (!(await withinLimit(req.userId!, res, 'SELECT COUNT(*)::int AS n FROM channels WHERE owner_id = $1', [req.userId!], FREE_LIMITS.channels, 'canales'))) return;
  const channelId = await insert('INSERT INTO channels (owner_id, name) VALUES ($1, $2)', [req.userId!, name]);
  broadcast({ type: 'channels:changed' });
  res.json({ channel: await get('SELECT * FROM channels WHERE id = $1 AND owner_id = $2', [channelId, req.userId!]) });
}));

app.get('/api/channels/:id/messages', requireAuth, h(async (req: AuthedRequest, res) => {
  const channelId = Number(req.params.id);
  const channel = await get(`
    SELECT channels.*,
      (SELECT links.source_id FROM links WHERE links.target_type = 'channel' AND links.target_id = channels.id AND links.kind = 'discussion' AND links.source_type = 'card') AS card_id,
      (channels.owner_id != $2) AS shared, owner.username AS owner_username
    FROM channels LEFT JOIN users owner ON owner.id = channels.owner_id
    WHERE channels.id = $1
  `, [channelId, req.userId!]);
  if (!channel || !(await hasResourceAccess('channel', channelId, req.userId!))) return res.status(404).json({ error: 'Canal no encontrado' });
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

  res.json({ channel: { ...channel, card_title: cardTitle }, messages, reactions, pinned, myRole: await myRoleFor('channel', channelId, req.userId!) });
}));

app.get('/api/messages/:id/thread', requireAuth, h(async (req: AuthedRequest, res) => {
  const messageId = Number(req.params.id);
  const parent = await get(`
    SELECT messages.*, users.username FROM messages
    JOIN users ON users.id = messages.user_id
    WHERE messages.id = $1
  `, [messageId]);
  if (!parent || !(await hasResourceAccess('channel', parent.channel_id, req.userId!))) return res.status(404).json({ error: 'Mensaje no encontrado' });
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
  if (!(await hasWriteAccess('channel', channelId, req.userId!))) return res.status(404).json({ error: 'Canal no encontrado' });
  if (parentId) {
    const parent = await get('SELECT id FROM messages WHERE id = $1 AND channel_id = $2 AND parent_id IS NULL', [parentId, channelId]);
    if (!parent) return res.status(400).json({ error: 'Hilo inválido' });
  }

  const messageId = await insert('INSERT INTO messages (channel_id, user_id, content, parent_id) VALUES ($1, $2, $3, $4)',
    [channelId, req.userId!, content, parentId]);
  await syncWikilinks('message', messageId, content, 'mention', (await resourceOwnerId('channel', channelId))!);
  await notifyMentions('channel', channelId, req.userId!, content, '', messageId);

  const message = await get(`
    SELECT messages.*, users.username FROM messages
    JOIN users ON users.id = messages.user_id WHERE messages.id = $1
  `, [messageId]);
  broadcast({ type: 'message:new', channelId, message });
  res.json({ message });
}));

app.patch('/api/messages/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const message = await get('SELECT * FROM messages WHERE id = $1', [Number(req.params.id)]);
  if (!message || !(await hasWriteAccess('channel', message.channel_id, req.userId!))) return res.status(404).json({ error: 'Mensaje no encontrado' });
  if (message.user_id !== req.userId) return res.status(403).json({ error: 'Solo puedes editar tus mensajes' });
  const content = (req.body?.content ?? '').trim();
  if (!content) return res.status(400).json({ error: 'Mensaje vacío' });
  await run(`UPDATE messages SET content = $1, edited_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2`,
    [content, message.id]);
  await syncWikilinks('message', message.id, content, 'mention', (await resourceOwnerId('channel', message.channel_id))!);
  await notifyMentions('channel', message.channel_id, req.userId!, content, message.content, message.id);
  broadcast({ type: 'chat:changed', channelId: message.channel_id });
  res.json({ ok: true });
}));

app.delete('/api/messages/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const message = await get('SELECT * FROM messages WHERE id = $1', [Number(req.params.id)]);
  if (!message || !(await hasWriteAccess('channel', message.channel_id, req.userId!))) return res.status(404).json({ error: 'Mensaje no encontrado' });
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
  if (!message || !(await hasWriteAccess('channel', message.channel_id, req.userId!))) return res.status(404).json({ error: 'Mensaje no encontrado' });
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
  if (!message || !(await hasWriteAccess('channel', message.channel_id, req.userId!))) return res.status(404).json({ error: 'Mensaje no encontrado' });
  await run('UPDATE messages SET pinned = $1 WHERE id = $2', [message.pinned ? 0 : 1, Number(req.params.id)]);
  broadcast({ type: 'chat:changed', channelId: message.channel_id });
  res.json({ ok: true });
}));

// ---------- Mensajes programados ----------
app.post('/api/channels/:id/schedule', requireAuth, requirePremium, h(async (req: AuthedRequest, res) => {
  const channelId = Number(req.params.id);
  const content = (req.body?.content ?? '').trim();
  const sendAt = req.body?.send_at; // "YYYY-MM-DDTHH:mm" en hora local del servidor
  if (!content || !sendAt) return res.status(400).json({ error: 'Contenido y fecha requeridos' });
  if (!(await hasWriteAccess('channel', channelId, req.userId!))) return res.status(404).json({ error: 'Canal no encontrado' });
  const timestamp = new Date(sendAt).getTime();
  if (!Number.isFinite(timestamp) || timestamp < Date.now()) return res.status(400).json({ error: 'La fecha debe ser futura' });
  await insert('INSERT INTO scheduled_messages (channel_id, user_id, content, send_at) VALUES ($1, $2, $3, $4)',
    [channelId, req.userId!, content, new Date(timestamp).toISOString()]);
  res.json({ ok: true });
}));

app.get('/api/channels/:id/scheduled', requireAuth, h(async (req: AuthedRequest, res) => {
  // Cada usuario ve (y cancela) solo sus propios mensajes programados,
  // aunque el canal sea compartido.
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
      await syncWikilinks('message', messageId, item.content, 'mention', item.user_id);
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
app.post('/api/links', requireAuth, h(async (req: AuthedRequest, res) => {
  const { source_type, source_id, target_type, target_id } = req.body ?? {};
  const valid = ['card', 'note', 'message', 'channel'];
  const sourceId = Number(source_id);
  const targetId = Number(target_id);
  if (!valid.includes(source_type) || !valid.includes(target_type) || !sourceId || !targetId ||
      !(await ownsEntity(source_type, sourceId, req.userId!, true)) || !(await ownsEntity(target_type, targetId, req.userId!, true))) {
    return res.status(400).json({ error: 'Vínculo inválido' });
  }
  await run(`INSERT INTO links (source_type, source_id, target_type, target_id, kind)
             VALUES ($1, $2, $3, $4, 'manual') ON CONFLICT DO NOTHING`,
    [source_type, sourceId, target_type, targetId]);
  broadcast({ type: 'links:changed' });
  res.json({ ok: true });
}));

app.delete('/api/links/:id', requireAuth, h(async (req: AuthedRequest, res) => {
  const link = await get<{ source_type: string; source_id: number; target_type: string; target_id: number }>('SELECT * FROM links WHERE id = $1', [Number(req.params.id)]);
  if (!link || !(await ownsEntity(link.source_type, link.source_id, req.userId!, true)) || !(await ownsEntity(link.target_type, link.target_id, req.userId!, true))) {
    return res.status(404).json({ error: 'Vínculo no encontrado' });
  }
  await run('DELETE FROM links WHERE id = $1', [Number(req.params.id)]);
  broadcast({ type: 'links:changed' });
  res.json({ ok: true });
}));

// Fragmento reutilizable: dueño o colaborador con acceso al recurso.
// paramIdx es el número del placeholder ($1, $2...) que trae el userId.
const sharedOr = (type: ShareType, paramIdx = 1) =>
  `(owner_id = $${paramIdx} OR EXISTS (SELECT 1 FROM resource_shares WHERE resource_type = '${type}' AND resource_id = id AND user_id = $${paramIdx}))`;

// ---------- Grafo de conocimiento ----------
app.get('/api/graph', requireAuth, h(async (req: AuthedRequest, res) => {
  const notes = await all(`SELECT id, title FROM notes WHERE ${sharedOr('note')}`, [req.userId!]);
  const cards = await all(`
    SELECT cards.id, cards.title FROM cards JOIN lists ON lists.id = cards.list_id JOIN boards ON boards.id = lists.board_id
    WHERE boards.owner_id = $1 OR EXISTS (SELECT 1 FROM resource_shares WHERE resource_type = 'board' AND resource_id = boards.id AND user_id = $1)
  `, [req.userId!]);
  const channels = await all(`SELECT id, name FROM channels WHERE ${sharedOr('channel')}`, [req.userId!]);
  const nodes = [
    ...notes.map((n) => ({ key: `note:${n.id}`, type: 'note', id: n.id, label: n.title })),
    ...cards.map((c) => ({ key: `card:${c.id}`, type: 'card', id: c.id, label: c.title })),
    ...channels.map((c) => ({ key: `channel:${c.id}`, type: 'channel', id: c.id, label: '#' + c.name })),
  ];
  const nodeKeys = new Set(nodes.map((n) => n.key));
  const links = await all("SELECT * FROM links WHERE source_type != 'message'");
  // Las menciones [[nota]] en mensajes se elevan al canal que las contiene:
  // una arista canal→nota por par (DISTINCT), sin el ruido de cada mensaje.
  const mentionLinks = await all(`
    SELECT DISTINCT messages.channel_id, links.target_type, links.target_id
    FROM links JOIN messages ON messages.id = links.source_id
    WHERE links.source_type = 'message'
  `);
  const edges = [
    ...links.map((l) => ({ source: `${l.source_type}:${l.source_id}`, target: `${l.target_type}:${l.target_id}`, kind: l.kind })),
    ...mentionLinks.map((l) => ({ source: `channel:${l.channel_id}`, target: `${l.target_type}:${l.target_id}`, kind: 'mention' })),
  ].filter((e) => nodeKeys.has(e.source) && nodeKeys.has(e.target));
  res.json({ nodes, edges });
}));

// ---------- Búsqueda unificada ----------
app.get('/api/search', requireAuth, h(async (req: AuthedRequest, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json({ cards: [], notes: [], messages: [], channels: [] });
  const like = `%${q}%`;
  const [cards, notes, messages, channels] = await Promise.all([
    all(`
      SELECT cards.id, cards.title, lists.board_id FROM cards
      JOIN lists ON lists.id = cards.list_id
      JOIN boards ON boards.id = lists.board_id
      WHERE (boards.owner_id = $2 OR EXISTS (SELECT 1 FROM resource_shares WHERE resource_type = 'board' AND resource_id = boards.id AND user_id = $2))
        AND (cards.title ILIKE $1 OR cards.description ILIKE $1) LIMIT 10
    `, [like, req.userId!]),
    all(`SELECT id, title FROM notes WHERE ${sharedOr('note', 2)} AND (title ILIKE $1 OR content ILIKE $1) LIMIT 10`, [like, req.userId!]),
    all(`
      SELECT messages.id, substr(messages.content, 1, 120) AS content, messages.channel_id, channels.name AS channel_name, users.username
      FROM messages JOIN channels ON channels.id = messages.channel_id JOIN users ON users.id = messages.user_id
      WHERE (channels.owner_id = $2 OR EXISTS (SELECT 1 FROM resource_shares WHERE resource_type = 'channel' AND resource_id = channels.id AND user_id = $2))
        AND messages.content ILIKE $1 ORDER BY messages.id DESC LIMIT 10
    `, [like, req.userId!]),
    all(`SELECT id, name FROM channels WHERE ${sharedOr('channel', 2)} AND name ILIKE $1 LIMIT 10`, [like, req.userId!]),
  ]);
  res.json({ cards, notes, messages, channels });
}));

// ---------- Gestión de colaboradores (compartir tableros/notas/canales) ----------
// Invitar (solo el dueño) manda un correo y crea una fila pendiente en
// resource_invites; el invitado recién pasa a resource_shares (acceso real)
// cuando acepta desde /api/invites/:id/accept. Un colaborador puede quitarse
// a sí mismo ("salir"), y el dueño puede cancelar invitaciones pendientes.
const SHARE_LABEL: Record<ShareType, string> = { board: 'Tablero', note: 'Nota', channel: 'Canal' };
const SHARE_LABEL_LOWER: Record<ShareType, string> = { board: 'tablero', note: 'nota', channel: 'canal' };

// Nombre visible del recurso para el correo de invitación (título/nombre)
async function resourceDisplayName(type: ShareType, id: number): Promise<string> {
  const col = type === 'note' ? 'title' : 'name';
  const row = await get<Record<string, string>>(`SELECT ${col} AS name FROM ${SHARE_TABLE[type]} WHERE id = $1`, [id]);
  return row?.name ?? SHARE_LABEL_LOWER[type];
}

// El broadcast "${table}:changed" (sin id) solo refresca listados de
// sidebar. BoardView/NotesView/ChatView escuchan el evento puntual del
// recurso abierto (boardId/noteId/channelId) — sin esto, alguien mirando el
// recurso justo cuando lo comparten/quitan/invitan no se entera en vivo.
function broadcastResourceChanged(type: ShareType, id: number) {
  if (type === 'board') broadcast({ type: 'board:changed', boardId: id });
  else if (type === 'note') broadcast({ type: 'notes:changed', noteId: id });
  else broadcast({ type: 'chat:changed', channelId: id });
}

type InviteResult = { ok: true; inviteId: number } | { ok: false; reason: string; code?: string };

// Núcleo de "invitar a colaborar": lo usan tanto el endpoint por-recurso
// como el de compartir todo con una conexión. No responde HTTP directamente
// (a diferencia de withinLimit) para que el llamador decida qué hacer con
// un fallo puntual — abortar (un solo recurso) o solo contarlo y seguir
// (compartir todo).
async function createResourceInvite(type: ShareType, id: number, ownerId: number,
  target: { id: number; email: string | null; username: string }, role: 'editor' | 'viewer' = 'editor'): Promise<InviteResult> {
  if (target.id === ownerId) return { ok: false, reason: 'Ya eres el dueño de este recurso' };
  if (!target.email) return { ok: false, reason: `@${target.username} no tiene un email configurado, no se le puede invitar` };

  const alreadyShared = await get('SELECT 1 FROM resource_shares WHERE resource_type = $1 AND resource_id = $2 AND user_id = $3', [type, id, target.id]);
  if (alreadyShared) return { ok: false, reason: `@${target.username} ya es colaborador` };

  // Cupo Free de colaboradores por canal (cuenta aceptados + pendientes,
  // así no se lo puede saltear mandando invitaciones de más)
  const alreadyInvited = await get('SELECT 1 FROM resource_invites WHERE resource_type = $1 AND resource_id = $2 AND invited_user_id = $3', [type, id, target.id]);
  if (!alreadyInvited && type === 'channel' && (await userPlan(ownerId)) !== 'premium') {
    const countRow = await get<{ n: number }>(`SELECT (
      (SELECT COUNT(*)::int FROM resource_shares WHERE resource_type = $1 AND resource_id = $2) +
      (SELECT COUNT(*)::int FROM resource_invites WHERE resource_type = $1 AND resource_id = $2)
    ) AS n`, [type, id]);
    if ((countRow?.n ?? 0) >= FREE_LIMITS.channelCollaborators) {
      return {
        ok: false, code: 'limit_reached',
        reason: `El plan Free permite hasta ${FREE_LIMITS.channelCollaborators} colaboradores por canal. Pasa a Premium para seguir creando.`,
      };
    }
  }

  const invite = await get<{ id: number }>(`
    INSERT INTO resource_invites (resource_type, resource_id, owner_id, invited_user_id, role) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (resource_type, resource_id, invited_user_id)
    DO UPDATE SET created_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'), role = $5
    RETURNING id
  `, [type, id, ownerId, target.id, role]);

  const [inviter, resourceName] = await Promise.all([
    get<{ username: string }>('SELECT username FROM users WHERE id = $1', [ownerId]),
    resourceDisplayName(type, id),
  ]);
  sendMail(target.email, `@${inviter!.username} te invitó a colaborar en QuarryHQ`, inviteHtml(invite!.id, inviter!.username, type, resourceName))
    .catch((err) => console.error('Error enviando invitación:', err));

  broadcast({ type: 'invites:changed', userId: target.id });
  broadcastResourceChanged(type, id); // por si el dueño tiene el modal Compartir abierto
  return { ok: true, inviteId: invite!.id };
}

function registerShareRoutes(type: ShareType, table: string) {
  app.get(`/api/${table}/:id/shares`, requireAuth, h(async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!(await hasResourceAccess(type, id, req.userId!))) return res.status(404).json({ error: `${SHARE_LABEL[type]} no encontrado` });
    const shares = await all(`
      SELECT users.id, users.username, resource_shares.role FROM resource_shares
      JOIN users ON users.id = resource_shares.user_id
      WHERE resource_shares.resource_type = $1 AND resource_shares.resource_id = $2 ORDER BY users.username
    `, [type, id]);
    const pending = await all(`
      SELECT users.id, users.username, resource_invites.role FROM resource_invites
      JOIN users ON users.id = resource_invites.invited_user_id
      WHERE resource_invites.resource_type = $1 AND resource_invites.resource_id = $2 ORDER BY users.username
    `, [type, id]);
    res.json({ shares, pending, ownerId: await resourceOwnerId(type, id) });
  }));

  app.post(`/api/${table}/:id/shares`, requireAuth, h(async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!(await isResourceOwner(type, id, req.userId!))) return res.status(404).json({ error: `${SHARE_LABEL[type]} no encontrado` });
    const username = (req.body?.username ?? '').trim();
    if (!username) return res.status(400).json({ error: 'Usuario requerido' });
    const role = req.body?.role === 'viewer' ? 'viewer' : 'editor';
    const target = await get<{ id: number; email: string | null; username: string }>('SELECT id, email, username FROM users WHERE username = $1', [username]);
    if (!target) return res.status(404).json({ error: `No existe el usuario "${username}"` });

    const result = await createResourceInvite(type, id, req.userId!, target, role);
    if (!result.ok) return res.status(result.code === 'limit_reached' ? 403 : 400).json({ error: result.reason, code: result.code });
    res.json({ ok: true, pending: true });
  }));

  // Cambia el rol de un colaborador ya aceptado (editor <-> viewer). Solo el dueño.
  app.patch(`/api/${table}/:id/shares/:userId`, requireAuth, h(async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    const targetUserId = Number(req.params.userId);
    if (!(await isResourceOwner(type, id, req.userId!))) return res.status(404).json({ error: `${SHARE_LABEL[type]} no encontrado` });
    const role = req.body?.role === 'viewer' ? 'viewer' : 'editor';
    await run('UPDATE resource_shares SET role = $1 WHERE resource_type = $2 AND resource_id = $3 AND user_id = $4', [role, type, id, targetUserId]);
    broadcastResourceChanged(type, id);
    res.json({ ok: true });
  }));

  app.delete(`/api/${table}/:id/shares/:userId`, requireAuth, h(async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    const targetUserId = Number(req.params.userId);
    const isOwner = await isResourceOwner(type, id, req.userId!);
    if (!isOwner && targetUserId !== req.userId) return res.status(404).json({ error: `${SHARE_LABEL[type]} no encontrado` });
    await run('DELETE FROM resource_shares WHERE resource_type = $1 AND resource_id = $2 AND user_id = $3', [type, id, targetUserId]);
    await run('DELETE FROM resource_invites WHERE resource_type = $1 AND resource_id = $2 AND invited_user_id = $3', [type, id, targetUserId]);
    if (type === 'board') {
      // Los canales de discusión de las tarjetas de este tablero se
      // compartieron automáticamente con este colaborador: al sacarlo del
      // tablero, se le saca también de esos canales (si no, se quedaría
      // leyendo/escribiendo ahí después de perder el resto del acceso).
      await run(`
        DELETE FROM resource_shares WHERE resource_type = 'channel' AND user_id = $1 AND resource_id IN (
          SELECT links.target_id FROM links
          JOIN cards ON cards.id = links.source_id AND links.source_type = 'card'
          JOIN lists ON lists.id = cards.list_id
          WHERE lists.board_id = $2 AND links.target_type = 'channel' AND links.kind = 'discussion'
        )
      `, [targetUserId, id]);
    }
    broadcast({ type: `${table}:changed` });
    broadcast({ type: 'invites:changed', userId: targetUserId });
    broadcastResourceChanged(type, id);
    res.json({ ok: true });
  }));
}
registerShareRoutes('board', 'boards');
registerShareRoutes('note', 'notes');
registerShareRoutes('channel', 'channels');

// ---------- Invitaciones pendientes: bandeja del invitado ----------
app.get('/api/invites/mine', requireAuth, h(async (req: AuthedRequest, res) => {
  const invites = await all(`
    SELECT resource_invites.id, resource_invites.resource_type, resource_invites.resource_id,
      owner.username AS owner_username, resource_invites.created_at, resource_invites.role,
      COALESCE(boards.name, notes.title, channels.name) AS resource_name
    FROM resource_invites
    JOIN users owner ON owner.id = resource_invites.owner_id
    LEFT JOIN boards ON resource_invites.resource_type = 'board' AND boards.id = resource_invites.resource_id
    LEFT JOIN notes ON resource_invites.resource_type = 'note' AND notes.id = resource_invites.resource_id
    LEFT JOIN channels ON resource_invites.resource_type = 'channel' AND channels.id = resource_invites.resource_id
    WHERE resource_invites.invited_user_id = $1
    ORDER BY resource_invites.created_at DESC
  `, [req.userId!]);
  res.json({ invites });
}));

app.post('/api/invites/:id/accept', requireAuth, h(async (req: AuthedRequest, res) => {
  const invite = await get<{ id: number; resource_type: ShareType; resource_id: number; owner_id: number; invited_user_id: number; role: string }>(
    'SELECT * FROM resource_invites WHERE id = $1', [Number(req.params.id)]);
  if (!invite || invite.invited_user_id !== req.userId) return res.status(404).json({ error: 'Invitación no encontrada' });
  await run('INSERT INTO resource_shares (resource_type, resource_id, owner_id, user_id, role) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
    [invite.resource_type, invite.resource_id, invite.owner_id, req.userId!, invite.role]);
  await run('DELETE FROM resource_invites WHERE id = $1', [invite.id]);
  broadcast({ type: `${SHARE_TABLE[invite.resource_type]}:changed` });
  broadcast({ type: 'invites:changed', userId: req.userId! });
  broadcastResourceChanged(invite.resource_type, invite.resource_id);
  res.json({ ok: true, resource_type: invite.resource_type, resource_id: invite.resource_id });
}));

app.post('/api/invites/:id/decline', requireAuth, h(async (req: AuthedRequest, res) => {
  const invite = await get<{ invited_user_id: number }>('SELECT invited_user_id FROM resource_invites WHERE id = $1', [Number(req.params.id)]);
  if (!invite || invite.invited_user_id !== req.userId) return res.status(404).json({ error: 'Invitación no encontrada' });
  await run('DELETE FROM resource_invites WHERE id = $1', [Number(req.params.id)]);
  broadcast({ type: 'invites:changed', userId: req.userId! });
  res.json({ ok: true });
}));

// ---------- Notificaciones (hoy solo @menciones) ----------
app.get('/api/notifications/mine', requireAuth, h(async (req: AuthedRequest, res) => {
  const notifications = await all(`
    SELECT notifications.id, notifications.kind, notifications.resource_type, notifications.resource_id,
      notifications.excerpt, notifications.message_id, notifications.read, notifications.created_at,
      actor.username AS actor_username,
      COALESCE(boards.name, notes.title, channels.name) AS resource_name
    FROM notifications
    JOIN users actor ON actor.id = notifications.actor_id
    LEFT JOIN boards ON notifications.resource_type = 'board' AND boards.id = notifications.resource_id
    LEFT JOIN notes ON notifications.resource_type = 'note' AND notes.id = notifications.resource_id
    LEFT JOIN channels ON notifications.resource_type = 'channel' AND channels.id = notifications.resource_id
    WHERE notifications.user_id = $1 ORDER BY notifications.id DESC LIMIT 50
  `, [req.userId!]);
  res.json({ notifications });
}));

app.post('/api/notifications/:id/read', requireAuth, h(async (req: AuthedRequest, res) => {
  await run('UPDATE notifications SET read = 1 WHERE id = $1 AND user_id = $2', [Number(req.params.id), req.userId!]);
  res.json({ ok: true });
}));

app.post('/api/notifications/read-all', requireAuth, h(async (req: AuthedRequest, res) => {
  await run('UPDATE notifications SET read = 1 WHERE user_id = $1 AND read = 0', [req.userId!]);
  res.json({ ok: true });
}));

// ---------- Conexiones: agenda personal para compartir más rápido ----------
// Agregar una conexión no da acceso a nada por sí sola — solo agiliza
// compartir (todo o de a uno) reutilizando createResourceInvite de arriba.
app.get('/api/connections', requireAuth, h(async (req: AuthedRequest, res) => {
  const connections = await all(`
    SELECT users.id, users.username FROM user_connections
    JOIN users ON users.id = user_connections.connected_user_id
    WHERE user_connections.owner_id = $1 ORDER BY users.username
  `, [req.userId!]);
  res.json({ connections });
}));

app.post('/api/connections', requireAuth, h(async (req: AuthedRequest, res) => {
  const username = (req.body?.username ?? '').trim();
  if (!username) return res.status(400).json({ error: 'Usuario requerido' });
  const target = await get<{ id: number }>('SELECT id FROM users WHERE username = $1', [username]);
  if (!target) return res.status(404).json({ error: `No existe el usuario "${username}"` });
  if (target.id === req.userId) return res.status(400).json({ error: 'No podés conectarte con vos mismo' });
  await run('INSERT INTO user_connections (owner_id, connected_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId!, target.id]);
  res.json({ ok: true });
}));

app.delete('/api/connections/:userId', requireAuth, h(async (req: AuthedRequest, res) => {
  await run('DELETE FROM user_connections WHERE owner_id = $1 AND connected_user_id = $2', [req.userId!, Number(req.params.userId)]);
  res.json({ ok: true });
}));

// Comparte TODOS los tableros/notas/canales propios con una conexión de una
// sola vez; cada uno igual queda pendiente hasta que la conexión lo acepte
// (mismo flujo y mismos límites que compartir de a uno).
app.post('/api/connections/:userId/share-all', requireAuth, h(async (req: AuthedRequest, res) => {
  const target = await get<{ id: number; email: string | null; username: string }>('SELECT id, email, username FROM users WHERE id = $1', [Number(req.params.userId)]);
  if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
  const role = req.body?.role === 'viewer' ? 'viewer' : 'editor';

  const [boards, notes, channels] = await Promise.all([
    all<{ id: number }>('SELECT id FROM boards WHERE owner_id = $1', [req.userId!]),
    all<{ id: number }>('SELECT id FROM notes WHERE owner_id = $1', [req.userId!]),
    all<{ id: number }>('SELECT id FROM channels WHERE owner_id = $1', [req.userId!]),
  ]);
  const jobs: { type: ShareType; id: number }[] = [
    ...boards.map((b) => ({ type: 'board' as ShareType, id: b.id })),
    ...notes.map((n) => ({ type: 'note' as ShareType, id: n.id })),
    ...channels.map((c) => ({ type: 'channel' as ShareType, id: c.id })),
  ];

  let invited = 0;
  const skipped: string[] = [];
  for (const job of jobs) {
    const result = await createResourceInvite(job.type, job.id, req.userId!, target, role);
    if (result.ok) invited++; else skipped.push(result.reason);
  }
  res.json({ ok: true, invited, total: jobs.length, skipped });
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
  server.listen(PORT, () => console.log(`QuarryHQ API (PostgreSQL) escuchando en http://localhost:${PORT}`));
}

main().catch((err) => {
  console.error('No se pudo iniciar el servidor:', err);
  process.exit(1);
});
