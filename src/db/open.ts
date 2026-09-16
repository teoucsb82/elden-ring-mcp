import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export type Db = Database.Database;

/** Tables whose rows are derived from a page by extractors; all keyed by page_id. */
export const DERIVED_TABLES = ['entities', 'weapons', 'spells', 'talismans', 'armor', 'bosses', 'acquisition', 'quests', 'extract_failures'] as const;

/** Columns added after the initial schema. CREATE TABLE IF NOT EXISTS will not add them to an existing table. */
const PAGE_MIGRATIONS: { column: string; ddl: string }[] = [
  { column: 'dlc', ddl: 'ALTER TABLE pages ADD COLUMN dlc INTEGER NOT NULL DEFAULT 0' },
  { column: 'dlc_signals', ddl: 'ALTER TABLE pages ADD COLUMN dlc_signals TEXT' },
  { column: 'has_dlc_sections', ddl: 'ALTER TABLE pages ADD COLUMN has_dlc_sections INTEGER NOT NULL DEFAULT 0' },
];

function migrate(db: Db): void {
  const existing = new Set((db.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).map((c) => c.name));
  for (const { column, ddl } of PAGE_MIGRATIONS) if (!existing.has(column)) db.exec(ddl);
  db.exec('CREATE INDEX IF NOT EXISTS pages_dlc ON pages (dlc)');
}

export function openDb(path: string, opts: { readonly?: boolean } = {}): Db {
  const readonly = opts.readonly ?? false;
  if (path !== ':memory:' && !readonly) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { readonly, fileMustExist: readonly });
  if (!readonly) {
    db.exec(SCHEMA);
    migrate(db);
  }
  return db;
}
