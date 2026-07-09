// Migración única de datos: data/obstresla.db (SQLite) → PostgreSQL.
// Uso: npx tsx scripts/migrate-sqlite-to-pg.ts
// Idempotente a nivel grueso: si Postgres ya tiene datos, aborta.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { pool, initSchema } from '../server/db.ts';

const sqlitePath = path.join(process.cwd(), 'data', 'obstresla.db');

// Tablas en orden de dependencias (FK). id = true → identidad que hay que preservar
const TABLES: { name: string; columns: string[]; hasId: boolean }[] = [
  { name: 'users', columns: ['id', 'username', 'password_hash', 'created_at'], hasId: true },
  { name: 'sessions', columns: ['token', 'user_id', 'created_at'], hasId: false },
  { name: 'boards', columns: ['id', 'name', 'created_at'], hasId: true },
  { name: 'lists', columns: ['id', 'board_id', 'name', 'position'], hasId: true },
  { name: 'cards', columns: ['id', 'list_id', 'title', 'description', 'labels', 'position', 'created_at', 'due_date', 'completed'], hasId: true },
  { name: 'notes', columns: ['id', 'title', 'content', 'updated_at'], hasId: true },
  { name: 'channels', columns: ['id', 'name', 'created_at'], hasId: true },
  { name: 'messages', columns: ['id', 'channel_id', 'user_id', 'content', 'created_at', 'parent_id', 'edited_at', 'pinned'], hasId: true },
  { name: 'links', columns: ['id', 'source_type', 'source_id', 'target_type', 'target_id', 'kind'], hasId: true },
  { name: 'checklist_items', columns: ['id', 'card_id', 'text', 'done', 'position'], hasId: true },
  { name: 'card_members', columns: ['card_id', 'user_id'], hasId: false },
  { name: 'board_rules', columns: ['id', 'board_id', 'list_id', 'action', 'param'], hasId: true },
  { name: 'note_versions', columns: ['id', 'note_id', 'title', 'content', 'created_at'], hasId: true },
  { name: 'note_tags', columns: ['note_id', 'tag'], hasId: false },
  { name: 'templates', columns: ['id', 'name', 'content'], hasId: true },
  { name: 'reactions', columns: ['message_id', 'user_id', 'emoji'], hasId: false },
  { name: 'scheduled_messages', columns: ['id', 'channel_id', 'user_id', 'content', 'send_at'], hasId: true },
];

async function main() {
  if (!fs.existsSync(sqlitePath)) {
    console.log('No hay base SQLite en data/obstresla.db — nada que migrar.');
    process.exit(0);
  }

  await initSchema();

  const existing = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (existing.rows[0].n > 0) {
    console.log('PostgreSQL ya tiene datos (users no está vacía) — abortando para no duplicar.');
    process.exit(1);
  }

  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  let total = 0;

  for (const table of TABLES) {
    const rows = sqlite.prepare(`SELECT ${table.columns.join(', ')} FROM ${table.name}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const placeholders = table.columns.map((_, i) => `$${i + 1}`).join(', ');
      const overriding = table.hasId ? 'OVERRIDING SYSTEM VALUE' : '';
      await pool.query(
        `INSERT INTO ${table.name} (${table.columns.join(', ')}) ${overriding} VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        table.columns.map((c) => row[c] ?? null)
      );
    }
    // Realinear la secuencia de identidad con el máximo id migrado
    if (table.hasId && rows.length > 0) {
      await pool.query(`SELECT setval(pg_get_serial_sequence('${table.name}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${table.name}))`);
    }
    console.log(`${table.name}: ${rows.length} filas`);
    total += rows.length;
  }

  console.log(`\nMigración completada: ${total} filas copiadas a PostgreSQL.`);
  await pool.end();
}

main().catch((err) => { console.error('Error en la migración:', err); process.exit(1); });
