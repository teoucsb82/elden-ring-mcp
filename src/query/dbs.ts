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
