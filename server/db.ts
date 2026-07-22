import pg from 'pg';

// Variables locales opcionales (.env en la raíz): GOOGLE_CLIENT_ID, DATABASE_URL…
// Se carga aquí porque este módulo se importa antes de que corra index.ts.
try { process.loadEnvFile(); } catch { /* sin .env */ }

// bigint (COUNT, SUM) llega como string por defecto; lo convertimos a number
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

const connectionString = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/quarryhq';
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

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC},
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS boards (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
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
      owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
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
      owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS reactions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );

    -- Tokens de verificación de email y de reseteo de contraseña (hasheados)
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );

    -- Códigos de invitación: regalan días de Premium; los gestiona un admin
    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      trial_days INTEGER NOT NULL DEFAULT 14,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );

    CREATE TABLE IF NOT EXISTS invite_redemptions (
      code_id INTEGER NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redeemed_at TEXT NOT NULL DEFAULT ${NOW_UTC},
      PRIMARY KEY (code_id, user_id)
    );

    -- Historial de pagos (hoy simulados; la pasarela real insertará aquí)
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      days INTEGER NOT NULL,
      method TEXT NOT NULL DEFAULT 'simulado',
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );

    -- Plan Equipos: el titular (users.plan = 'team') da Premium a sus miembros
    CREATE TABLE IF NOT EXISTS team_seats (
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (owner_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      send_at TEXT NOT NULL
    );

    -- Colaboración: comparte un tablero/nota/canal con otro usuario. Sin FK a
    -- boards/notes/channels porque resource_id es polimórfico (mismo patrón
    -- que la tabla links de arriba).
    CREATE TABLE IF NOT EXISTS resource_shares (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      resource_type TEXT NOT NULL,
      resource_id INTEGER NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS resource_shares_unique_idx ON resource_shares(resource_type, resource_id, user_id);
    CREATE INDEX IF NOT EXISTS resource_shares_user_idx ON resource_shares(user_id);
    -- 'editor' (todo lo que puede hacer el dueño en el contenido) o 'viewer'
    -- (solo lectura). Default 'editor' para no cambiarle el comportamiento
    -- a los colaboradores que ya existían antes de este campo.
    ALTER TABLE resource_shares ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'editor';

    -- Invitaciones pendientes: compartir ya no agrega al instante, manda un
    -- correo y espera que el invitado acepte. No lleva token secreto porque
    -- aceptar ya exige sesión iniciada como ese usuario exacto (el chequeo
    -- de auth + invited_user_id es la barrera de seguridad, no el id).
    CREATE TABLE IF NOT EXISTS resource_invites (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      resource_type TEXT NOT NULL,
      resource_id INTEGER NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS resource_invites_unique_idx ON resource_invites(resource_type, resource_id, invited_user_id);
    CREATE INDEX IF NOT EXISTS resource_invites_invited_idx ON resource_invites(invited_user_id);
    ALTER TABLE resource_invites ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'editor';

    -- Agenda personal de colaboradores frecuentes: agregar una conexión no
    -- da acceso a nada por sí solo, solo agiliza compartir (todo o
    -- seleccionando) reutilizando el flujo de invitación de resource_invites.
    CREATE TABLE IF NOT EXISTS user_connections (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connected_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_connections_unique_idx ON user_connections(owner_id, connected_user_id);

    -- Feed de actividad por tablero: solo cambios estructurales/de estado
    -- (crear/mover/completar/borrar), no cada edición de texto — si no, es
    -- ruido. card_title/list_name quedan como snapshot porque la tarjeta o
    -- lista puede haberse borrado después.
    CREATE TABLE IF NOT EXISTS board_activity (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      card_title TEXT,
      list_name TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );
    CREATE INDEX IF NOT EXISTS board_activity_board_idx ON board_activity(board_id, id DESC);

    -- Notificaciones (hoy solo @menciones en chat/notas); mismo patrón que
    -- resource_invites: se avisa por WS con notifications:changed.
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id INTEGER NOT NULL,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      excerpt TEXT,
      message_id INTEGER,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );
    CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, id DESC);

    -- Corrección retroactiva: los canales de discusión de tarjeta creados
    -- antes de que esto se auto-compartiera quedaban invisibles para el
    -- resto de los colaboradores del tablero. Idempotente (ON CONFLICT).
    INSERT INTO resource_shares (resource_type, resource_id, owner_id, user_id)
    SELECT 'channel', links.target_id, boards.owner_id, rs.user_id
    FROM links
    JOIN cards ON cards.id = links.source_id AND links.source_type = 'card'
    JOIN lists ON lists.id = cards.list_id
    JOIN boards ON boards.id = lists.board_id
    JOIN resource_shares rs ON rs.resource_type = 'board' AND rs.resource_id = boards.id
    WHERE links.target_type = 'channel' AND links.kind = 'discussion' AND rs.user_id != boards.owner_id
    ON CONFLICT DO NOTHING;
    INSERT INTO resource_shares (resource_type, resource_id, owner_id, user_id)
    SELECT 'channel', links.target_id, boards.owner_id, boards.owner_id
    FROM links
    JOIN cards ON cards.id = links.source_id AND links.source_type = 'card'
    JOIN lists ON lists.id = cards.list_id
    JOIN boards ON boards.id = lists.board_id
    JOIN channels ON channels.id = links.target_id
    WHERE links.target_type = 'channel' AND links.kind = 'discussion' AND channels.owner_id != boards.owner_id
    ON CONFLICT DO NOTHING;

    -- Migración para bases anteriores a Google Sign-In (CREATE TABLE IF NOT
    -- EXISTS no altera tablas ya existentes)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS picture TEXT;
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
    -- Freemium: plan por usuario ('free' | 'premium' | 'team') y vencimiento
    ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TEXT;
    -- Admin: puede generar y gestionar códigos de invitación
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin INTEGER NOT NULL DEFAULT 0;
    -- Estética del escritorio (exclusivo Premium): paleta de color y fondo.
    -- Se guarda aunque el usuario baje a Free; solo se APLICA si plan = premium.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_preset TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_accent TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_bg TEXT;
    -- Trazabilidad en recursos compartidos: quién hizo la última edición
    ALTER TABLE cards ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE notes ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    -- Registro con email: verificación y unicidad (case-insensitive)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at TEXT;
    ALTER TABLE boards ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE notes ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    UPDATE boards SET owner_id = (SELECT id FROM users ORDER BY id LIMIT 1) WHERE owner_id IS NULL AND EXISTS (SELECT 1 FROM users);
    UPDATE notes SET owner_id = (SELECT id FROM users ORDER BY id LIMIT 1) WHERE owner_id IS NULL AND EXISTS (SELECT 1 FROM users);
    UPDATE channels SET owner_id = (SELECT id FROM users ORDER BY id LIMIT 1) WHERE owner_id IS NULL AND EXISTS (SELECT 1 FROM users);
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (LOWER(email)) WHERE email IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users (google_sub);
    CREATE INDEX IF NOT EXISTS boards_owner_idx ON boards(owner_id);
    CREATE INDEX IF NOT EXISTS notes_owner_idx ON notes(owner_id);
    CREATE INDEX IF NOT EXISTS channels_owner_idx ON channels(owner_id);
    ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_title_key;
    ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_name_key;
    ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_name_key;
    CREATE INDEX IF NOT EXISTS templates_owner_idx ON templates(owner_id);
    CREATE UNIQUE INDEX IF NOT EXISTS notes_owner_title_idx ON notes(owner_id, LOWER(title));
    CREATE UNIQUE INDEX IF NOT EXISTS channels_owner_name_idx ON channels(owner_id, name);
    CREATE UNIQUE INDEX IF NOT EXISTS templates_owner_name_idx ON templates(owner_id, name);

    -- ---------- v1.7: Stripe (facturación real) ----------
    -- Asociación 1:1 user_id -> Stripe Customer; se reutiliza para el Billing
    -- Portal y futuras suscripciones. customer_id es único en Stripe.
    CREATE TABLE IF NOT EXISTS stripe_customers (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );
    -- Extiende el registro de pagos (ya existente) con los datos que aporta
    -- Stripe: id de factura, URLs (PDF + portal hosted), id de suscripción,
    -- período cubierto y estado (paid | past_due | open | refunded …).
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_invoice_id TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS invoice_url TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS hosted_invoice_url TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'paid';
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_start TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_end TEXT;
    CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS payments_stripe_invoice_idx ON payments(stripe_invoice_id);
    -- Marca de renovación para distinguir el cobro inicial de las subsiguientes.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

    -- ---------- v1.7: Búsqueda full-text ----------
    -- to_tsvector('simple', …) en vez de 'spanish' para soportar correctamente
    -- @-syntax (websearch_to_tsquery). Las palabras acentuadas funcionan igual
    -- porque 'simple' no las normaliza; en compensación, el ranking con
    -- ts_rank_cd queda comparable entre todos los idiomas. Si la app crece se
    -- puede instalar un diccionario 'spanish' personalizado en el futuro.
    ALTER TABLE notes ADD COLUMN IF NOT EXISTS fts tsvector;
    ALTER TABLE cards ADD COLUMN IF NOT EXISTS fts tsvector;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS fts tsvector;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS fts tsvector;
    CREATE INDEX IF NOT EXISTS notes_fts_idx ON notes USING GIN (fts);
    CREATE INDEX IF NOT EXISTS cards_fts_idx ON cards USING GIN (fts);
    CREATE INDEX IF NOT EXISTS messages_fts_idx ON messages USING GIN (fts);
    CREATE INDEX IF NOT EXISTS channels_fts_idx ON channels USING GIN (fts);

    -- Funciones + triggers para mantener fts sincronizado en INSERT/UPDATE. La
    -- columna fts pesa el título (A) más que el contenido (B); el ranking
    -- ts_rank_cd respeta estos pesos para que el título encaje primero.
    CREATE OR REPLACE FUNCTION quarryhq_notes_fts() RETURNS trigger AS $$
    BEGIN
      NEW.fts := setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A')
             || setweight(to_tsvector('simple', coalesce(NEW.content, '')), 'B');
      RETURN NEW;
    END;
    $ LANGUAGE plpgsql;
    CREATE OR REPLACE FUNCTION quarryhq_cards_fts() RETURNS trigger AS $$
    BEGIN
      NEW.fts := setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A')
             || setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'B');
      RETURN NEW;
    END;
    $ LANGUAGE plpgsql;
    CREATE OR REPLACE FUNCTION quarryhq_messages_fts() RETURNS trigger AS $$
    BEGIN
      NEW.fts := to_tsvector('simple', coalesce(NEW.content, ''));
      RETURN NEW;
    END;
    $ LANGUAGE plpgsql;
    CREATE OR REPLACE FUNCTION quarryhq_channels_fts() RETURNS trigger AS $$
    BEGIN
      NEW.fts := setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A');
      RETURN NEW;
    END;
    $ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS notes_fts_trg ON notes;
    CREATE TRIGGER notes_fts_trg BEFORE INSERT OR UPDATE OF title, content ON notes
      FOR EACH ROW EXECUTE FUNCTION quarryhq_notes_fts();
    DROP TRIGGER IF EXISTS cards_fts_trg ON cards;
    CREATE TRIGGER cards_fts_trg BEFORE INSERT OR UPDATE OF title, description ON cards
      FOR EACH ROW EXECUTE FUNCTION quarryhq_cards_fts();
    DROP TRIGGER IF EXISTS messages_fts_trg ON messages;
    CREATE TRIGGER messages_fts_trg BEFORE INSERT OR UPDATE OF content ON messages
      FOR EACH ROW EXECUTE FUNCTION quarryhq_messages_fts();
    DROP TRIGGER IF EXISTS channels_fts_trg ON channels;
    CREATE TRIGGER channels_fts_trg BEFORE INSERT OR UPDATE OF name ON channels
      FOR EACH ROW EXECUTE FUNCTION quarryhq_channels_fts();

    -- Backfill idempotente: rellena SOLO las filas que aún no tienen fts. Corre
    -- cada arranque pero es baratísimo si ya están todas (WHERE fts IS NULL no
    -- escanea nada vía el índice parcial implícito del filtro). En escalado se
    -- quita y se vuelve a correr manualmente tras migraciones masivas.
    UPDATE notes SET fts = setweight(to_tsvector('simple', title), 'A')
                   || setweight(to_tsvector('simple', coalesce(content, '')), 'B')
     WHERE fts IS NULL;
    UPDATE cards SET fts = setweight(to_tsvector('simple', title), 'A')
                   || setweight(to_tsvector('simple', coalesce(description, '')), 'B')
     WHERE fts IS NULL;
    UPDATE messages SET fts = to_tsvector('simple', content)
     WHERE fts IS NULL;
    UPDATE channels SET fts = setweight(to_tsvector('simple', name), 'A')
     WHERE fts IS NULL;
  `);
}

export async function seedIfEmpty() {
  await seedTemplates();
}

async function seedTemplates() {
  const hasTemplates = await get<{ n: number }>('SELECT COUNT(*)::int AS n FROM templates');
  if (hasTemplates && hasTemplates.n > 0) return;
  const ins = 'INSERT INTO templates (name, content) VALUES ($1, $2)';
  await insert(ins, ['Reunión', '# {{titulo}}\n\n**Fecha:** {{fecha}}\n**Asistentes:** \n\n## Agenda\n\n- \n\n## Decisiones\n\n- \n\n## Acciones\n\n- [ ] ']);
  await insert(ins, ['Nota diaria', '# {{titulo}}\n\n#diario\n\n## Hoy\n\n- \n\n## Notas\n\n']);
  await insert(ins, ['Documento de producto', '# {{titulo}}\n\n#producto\n\n## Problema\n\n\n## Propuesta\n\n\n## Alcance\n\n- \n\n## Enlaces\n\n- \n']);
}
