import { existsSync } from 'node:fs';
import { openDb, type Db } from '../db/open.js';
import { localDbPath } from '../store/local.js';
import { DEFAULT_DB_PATH } from '../store/pages.js';

export interface Dbs {
  shipped: Db | null;
  local: Db | null;
  /** Set when the shipped db exists but predates the dlc columns; shipped is null in that case. */
  stale?: { path: string; detail: string };
}

export const STALE_DETAIL = 'The shipped snapshot predates the Shadow of the Erdtree columns (built before 2026-09-16). Run `npm run extract` to migrate and classify it, or `npm run fetch-data` once a newer data-* release exists. Results are unavailable until then; this is not missing data.';

/**
 * The shipped db is opened read-only, which skips openDb's column migration, so a snapshot built
 * before the dlc feature keeps its old pages table and every query dies with "no such column: dlc".
 * Checking once at open time turns that into one named answer instead of an opaque failure per tool.
 */
function hasDlcColumns(db: Db): boolean {
  return (db.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).some((c) => c.name === 'dlc');
}

/** Opens the shipped db read-only (if present) and the local cache read-write (created on demand). */
export function openDbs(): Dbs {
  const shippedPath = process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH;
  const local = openDb(localDbPath());
  if (!existsSync(shippedPath)) return { shipped: null, local };
  const shipped = openDb(shippedPath, { readonly: true });
  if (hasDlcColumns(shipped)) return { shipped, local };
  shipped.close();
  return { shipped: null, local, stale: { path: shippedPath, detail: STALE_DETAIL } };
}

export type DlcMode = 'base' | 'all' | 'only';

export const DEFAULT_DLC_MODE: DlcMode = 'base';

/**
 * Fextralife pages are cached as rendered markdown with no wikitext, so the classifier has no signal
 * to read and never labels them: their `dlc` column holds the column default, not a finding. Calling
 * such a page base game is a claim the data cannot support, so it reports dlc: null and no mode
 * filters it out — an unknown is exempt, never asserted either way.
 */
const UNCLASSIFIED_SOURCE = 'fextralife';

/** null means "never classified", which is not the same answer as false. */
export const dlcOf = (source: string, dlc: number): boolean | null =>
  source === UNCLASSIFIED_SOURCE ? null : dlc === 1;

/**
 * Same test, same reason: has_dlc_sections holds the column default on an unclassified row, so
 * reporting false there asserts "this page contains no DLC material" on a page nothing ever read.
 */
export const hasDlcSectionsOf = (source: string, hasDlcSections: number): boolean | null =>
  source === UNCLASSIFIED_SOURCE ? null : hasDlcSections === 1;

/**
 * Returns a constant SQL fragment — never caller text — so composing it into a query cannot inject.
 * `alias` names the pages table in queries that join it under a short name.
 */
export function dlcPredicate(mode: DlcMode, alias = 'pages'): string {
  const unclassified = `${alias}.source = '${UNCLASSIFIED_SOURCE}'`;
  switch (mode) {
    case 'only': return `(${alias}.dlc = 1 OR ${unclassified})`;
    case 'all': return '1=1';
    case 'base':
    default: return `(${alias}.dlc = 0 OR ${unclassified})`;
  }
}
