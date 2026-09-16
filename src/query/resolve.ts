import type { Db } from '../db/open.js';
import { DEFAULT_DLC_MODE, type Dbs, type DlcMode } from './dbs.js';

export interface Provenance {
  source: string;
  title: string;
  url: string;
  revid: number | null;
  fetched_at: string;
  license: string;
}

export interface Resolved {
  db: Db;
  pageId: number;
  provenance: Provenance;
  match: 'exact' | 'redirect' | 'entity' | 'search';
  fragment: string | null;
  dlc: boolean;
}

/** The page exists but the caller's own dlc mode excluded it. Never a missing page. */
export interface DlcFiltered {
  filtered: 'dlc';
  title: string;
  provenance: Provenance;
}

export const isDlcFiltered = (r: Resolved | DlcFiltered | null): r is DlcFiltered =>
  r !== null && 'filtered' in r;

const permits = (mode: DlcMode, dlc: boolean): boolean =>
  mode === 'all' || (mode === 'only' ? dlc : !dlc);

const PROVENANCE_COLUMNS = 'id, source, title, url, revid, fetched_at, license, dlc';

type PageRecord = Provenance & { id: number; dlc: number };

const toResolved = (db: Db, row: PageRecord, match: Resolved['match'], fragment: string | null = null): Resolved => {
  const { id, dlc, ...provenance } = row;
  return { db, pageId: id, provenance, match, fragment, dlc: dlc === 1 };
};

/** Quotes each word so user text can't inject FTS5 syntax. */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}]+/gu);
  return words?.length ? words.map((word) => `"${word}"`).join(' ') : null;
}

function resolveIn(db: Db, name: string): Resolved | null {
  const exact = db.prepare(`SELECT ${PROVENANCE_COLUMNS} FROM pages WHERE title = ? COLLATE NOCASE`).get(name) as PageRecord | undefined;
  if (exact) return toResolved(db, exact, 'exact');

  const redirect = db.prepare('SELECT to_title, fragment FROM redirects WHERE from_title = ? COLLATE NOCASE').get(name) as { to_title: string; fragment: string | null } | undefined;
  if (redirect) {
    const target = db.prepare(`SELECT ${PROVENANCE_COLUMNS} FROM pages WHERE title = ? COLLATE NOCASE`).get(redirect.to_title) as PageRecord | undefined;
    if (target) return toResolved(db, target, 'redirect', redirect.fragment);
  }

  const entity = db.prepare(`SELECT ${PROVENANCE_COLUMNS.split(', ').map((c) => `p.${c}`).join(', ')} FROM entities e JOIN pages p ON p.id = e.page_id WHERE e.name = ? COLLATE NOCASE`).get(name) as PageRecord | undefined;
  if (entity) return toResolved(db, entity, 'entity');

  const query = ftsQuery(name);
  if (!query) return null;
  const hit = db.prepare(`
    SELECT ${PROVENANCE_COLUMNS.split(', ').map((c) => `p.${c}`).join(', ')}
    FROM sections_fts f JOIN sections s ON s.id = f.rowid JOIN pages p ON p.id = s.page_id
    WHERE sections_fts MATCH ? ORDER BY bm25(sections_fts, 10.0, 2.0, 1.0) LIMIT 1
  `).get(query) as PageRecord | undefined;
  return hit ? toResolved(db, hit, 'search') : null;
}

/**
 * Shipped data first, then the local cache. Within a db: exact title, redirect, entity name, full-text
 * search.
 *
 * Resolves against every page regardless of mode, then compares. Excluding DLC rows from the
 * resolver's view instead would make "the snapshot does not cover this" and "you did not ask for
 * DLC" indistinguishable, which is the failure this whole feature exists to avoid.
 */
export function resolveName(dbs: Dbs, name: string, mode: DlcMode = DEFAULT_DLC_MODE): Resolved | DlcFiltered | null {
  const trimmed = name.trim();
  let found: Resolved | null = null;

  for (const db of [dbs.shipped, dbs.local]) {
    if (!db) continue;
    const resolved = resolveIn(db, trimmed);
    if (resolved && resolved.match !== 'search') { found = resolved; break; }
  }
  if (!found) {
    for (const db of [dbs.shipped, dbs.local]) {
      if (!db) continue;
      const resolved = resolveIn(db, trimmed);
      if (resolved) { found = resolved; break; }
    }
  }

  if (!found) return null;
  if (permits(mode, found.dlc)) return found;
  return { filtered: 'dlc', title: found.provenance.title, provenance: found.provenance };
}
