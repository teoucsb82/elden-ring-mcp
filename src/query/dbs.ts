import { existsSync } from 'node:fs';
import { openDb, type Db } from '../db/open.js';
import { localDbPath } from '../store/local.js';
import { DEFAULT_DB_PATH } from '../store/pages.js';

export interface Dbs {
  shipped: Db | null;
  local: Db | null;
}

/** Opens the shipped db read-only (if present) and the local cache read-write (created on demand). */
export function openDbs(): Dbs {
  const shippedPath = process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH;
  return {
    shipped: existsSync(shippedPath) ? openDb(shippedPath, { readonly: true }) : null,
    local: openDb(localDbPath()),
  };
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
