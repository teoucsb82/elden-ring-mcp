import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../db/open.js';
import { buildExtractor } from '../extract/build.js';
import { runExtractors } from '../extract/run.js';
import { fetchFextralife } from '../sources/fextralife.js';
import { upsertPage } from './pages.js';

export function localDbPath(): string {
  return join(process.env.ELDEN_RING_MCP_CACHE ?? join(homedir(), '.cache', 'elden-ring-mcp'), 'local.db');
}

export const openLocalDb = (path = localDbPath()): Db => openDb(path);

/** Fetches one Fextralife page into the user's local cache db. Never touches data/. */
export async function cacheFextralife(localDb: Db, title: string, opts: Parameters<typeof fetchFextralife>[1] = {}): Promise<number | null> {
  const page = await fetchFextralife(title, opts);
  if (!page) return null;
  const id = upsertPage(localDb, page);
  // A build page fetched on demand is parsed straight away, so the build tool sees it too.
  runExtractors(localDb, { pageIds: [id], extractors: [buildExtractor] });
  return id;
}
