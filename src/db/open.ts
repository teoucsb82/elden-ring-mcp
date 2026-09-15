import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export type Db = Database.Database;

/** Tables whose rows are derived from a page by extractors; all keyed by page_id. */
export const DERIVED_TABLES = ['entities', 'weapons', 'spells', 'talismans', 'armor', 'bosses', 'acquisition', 'quests', 'extract_failures'] as const;

export function openDb(path: string, opts: { readonly?: boolean } = {}): Db {
  const readonly = opts.readonly ?? false;
  if (path !== ':memory:' && !readonly) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { readonly, fileMustExist: readonly });
  if (!readonly) db.exec(SCHEMA);
  return db;
}
