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
 * Returns a constant SQL fragment — never caller text — so composing it into a query cannot inject.
 * `alias` names the pages table in queries that join it under a short name.
 */
export function dlcPredicate(mode: DlcMode, alias = 'pages'): string {
  switch (mode) {
    case 'only': return `${alias}.dlc = 1`;
    case 'all': return '1=1';
    case 'base':
    default: return `${alias}.dlc = 0`;
  }
}
