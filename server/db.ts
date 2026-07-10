import pg from 'pg';

// Variables locales opcionales (.env en la raíz): GOOGLE_CLIENT_ID, DATABASE_URL…
// Se carga aquí porque este módulo se importa antes de que corra index.ts.
try { process.loadEnvFile(); } catch { /* sin .env */ }

// bigint (COUNT, SUM) llega como string por defecto; lo convertimos a number
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

const connectionString = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/obstresla';
export const pool = new pg.Pool({ connectionString });

// ---------- Helpers de consulta ----------
export async function all<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

export async function get<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const result = await pool.query(sql, params);
  return result.rows[0] as T | undefined;
}

export async function run(sql: string, params: unknown[] = []): Promise<number> {
  const result = await pool.query(sql, params);
  return result.rowCount ?? 0;
}

// INSERT ... RETURNING id → devuelve el id generado
export async function insert(sql: string, params: unknown[] = []): Promise<number> {
  const result = await pool.query(sql + ' RETURNING id', params);
  return result.rows[0].id as number;
}

// Timestamps como TEXT en UTC "YYYY-MM-DD HH24:MI:SS" para mantener el
// formato que ya espera el cliente (idéntico al datetime('now') de SQLite)
const NOW_UTC = `to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')`;

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      google_sub TEXT,
      email TEXT,
      name TEXT,
      picture TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );

    CREATE TABLE IF NOT EXISTS boards (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );

    CREATE TABLE IF NOT EXISTS lists (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      labels TEXT NOT NULL DEFAULT '[]',
      position DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC},
      due_date TEXT,
      completed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      title TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC},
      parent_id INTEGER,
      edited_at TEXT,
      pinned INTEGER NOT NULL DEFAULT 0
    );

    -- Tabla universal de vinculos entre entidades (card | note | message | channel)
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'manual',
      UNIQUE(source_type, source_id, target_type, target_id, kind)
    );

    CREATE TABLE IF NOT EXISTS checklist_items (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      position DOUBLE PRECISION NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS card_members (
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (card_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS board_rules (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      param TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS note_versions (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );

    CREATE TABLE IF NOT EXISTS note_tags (
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (note_id, tag)
    );

    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS reactions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      send_at TEXT NOT NULL
    );

    -- Migración para bases anteriores a Google Sign-In (CREATE TABLE IF NOT
    -- EXISTS no altera tablas ya existentes)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS picture TEXT;
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
    -- Freemium: plan por usuario ('free' | 'premium') y vencimiento del premium
    ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users (google_sub);
  `);
}

export async function seedIfEmpty() {
  const hasBoards = await get<{ n: number }>('SELECT COUNT(*)::int AS n FROM boards');
  if (hasBoards && hasBoards.n > 0) { await seedTemplates(); return; }

  const boardId = await insert("INSERT INTO boards (name) VALUES ('Producto')");
  const todo = await insert('INSERT INTO lists (board_id, name, position) VALUES ($1, $2, $3)', [boardId, 'Por hacer', 0]);
  const doing = await insert('INSERT INTO lists (board_id, name, position) VALUES ($1, $2, $3)', [boardId, 'En curso', 1]);
  const done = await insert('INSERT INTO lists (board_id, name, position) VALUES ($1, $2, $3)', [boardId, 'Hecho', 2]);

  const insCard = 'INSERT INTO cards (list_id, title, description, labels, position) VALUES ($1, $2, $3, $4, $5)';
  const card1 = await insert(insCard, [todo, 'Diseñar la landing page', 'Ver la nota [[Ideas de diseño]] para referencias.', '["violeta"]', 0]);
  await insert(insCard, [todo, 'Configurar CI/CD', '', '["azul"]', 1]);
  const card2 = await insert(insCard, [doing, 'API de autenticación', 'Tokens de sesión + scrypt.', '["verde","rojo"]', 0]);
  await insert(insCard, [done, 'Elegir el stack', 'React + Express + PostgreSQL.', '[]', 0]);

  const insNote = 'INSERT INTO notes (title, content) VALUES ($1, $2)';
  const noteIdeas = await insert(insNote, ['Ideas de diseño', '# Ideas de diseño\n\nPaleta oscura con acento violeta.\n\nRelacionado: [[Arquitectura]] y [[Roadmap]].']);
  const noteArq = await insert(insNote, ['Arquitectura', '# Arquitectura\n\n- SPA en React\n- API REST + WebSockets\n- PostgreSQL como base de datos\n\nVer también [[Roadmap]].']);
  const noteRoad = await insert(insNote, ['Roadmap', '# Roadmap\n\n1. MVP con tableros, notas y chat\n2. Vinculación entre herramientas\n3. Grafo de conocimiento']);

  await insert('INSERT INTO channels (name) VALUES ($1)', ['general']);
  await insert('INSERT INTO channels (name) VALUES ($1)', ['desarrollo']);

  const insLink = `INSERT INTO links (source_type, source_id, target_type, target_id, kind)
                   VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`;
  await run(insLink, ['note', noteIdeas, 'note', noteArq, 'wikilink']);
  await run(insLink, ['note', noteIdeas, 'note', noteRoad, 'wikilink']);
  await run(insLink, ['note', noteArq, 'note', noteRoad, 'wikilink']);
  await run(insLink, ['card', card1, 'note', noteIdeas, 'manual']);
  await run(insLink, ['card', card2, 'note', noteArq, 'manual']);

  await seedTemplates();
}

async function seedTemplates() {
  const hasTemplates = await get<{ n: number }>('SELECT COUNT(*)::int AS n FROM templates');
  if (hasTemplates && hasTemplates.n > 0) return;
  const ins = 'INSERT INTO templates (name, content) VALUES ($1, $2)';
  await insert(ins, ['Reunión', '# {{titulo}}\n\n**Fecha:** {{fecha}}\n**Asistentes:** \n\n## Agenda\n\n- \n\n## Decisiones\n\n- \n\n## Acciones\n\n- [ ] ']);
  await insert(ins, ['Nota diaria', '# {{titulo}}\n\n#diario\n\n## Hoy\n\n- \n\n## Notas\n\n']);
  await insert(ins, ['Documento de producto', '# {{titulo}}\n\n#producto\n\n## Problema\n\n\n## Propuesta\n\n\n## Alcance\n\n- \n\n## Enlaces\n\n- [[Roadmap]]\n']);
}
