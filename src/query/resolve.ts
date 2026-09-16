import type { Db } from '../db/open.js';
import { DEFAULT_DLC_MODE, dlcOf, dlcPredicate, type Dbs, type DlcMode } from './dbs.js';

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
  /** null when the page was never classified (Fextralife cache): unknown, not base game. */
  dlc: boolean | null;
  /** Always false for Fextralife rows: the classifier never runs on cached pages, wiki marker or not. */
  hasDlcSections: boolean;
  /**
   * The same title, exactly, in the db(s) this answer did not come from — empty when only one holds
   * it. Fandom and Fextralife disagree on numbers often enough that the server's own instructions
   * tell a model to show both; it can only do that if it is told the second copy exists.
   */
  alternates: Provenance[];
}

/**
 * The page exists but the caller's own dlc mode excluded it. Never a missing page.
 *
 * `match` rides along because the gate is only as good as the resolution behind it: a `search` match
 * is the FTS fallback's best guess at an unresolvable name, and gating on one without saying so
 * presents a guess as an authoritative statement about the page the caller asked for.
 */
export interface DlcFiltered {
  filtered: 'dlc';
  title: string;
  provenance: Provenance;
  match: Resolved['match'];
}

export const isDlcFiltered = (r: Resolved | DlcFiltered | null): r is DlcFiltered =>
  r !== null && 'filtered' in r;

const permits = (mode: DlcMode, dlc: boolean | null): boolean =>
  dlc === null || mode === 'all' || (mode === 'only' ? dlc : !dlc);

const PROVENANCE_COLUMNS = 'id, source, title, url, revid, fetched_at, license, dlc, has_dlc_sections';

type PageRecord = Provenance & { id: number; dlc: number; has_dlc_sections: number };

/** `alternates` is filled in by resolveName, which is the only layer that can see more than one db. */
const toResolved = (db: Db, row: PageRecord, match: Resolved['match'], fragment: string | null = null, alternates: Provenance[] = []): Resolved => {
  const { id, dlc, has_dlc_sections, ...provenance } = row;
  return { db, pageId: id, provenance, match, fragment, dlc: dlcOf(provenance.source, dlc), hasDlcSections: has_dlc_sections === 1, alternates };
};

/** Quotes each word so user text can't inject FTS5 syntax. */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}]+/gu);
  return words?.length ? words.map((word) => `"${word}"`).join(' ') : null;
}

/** Same shape both fts fallback statements share; only the WHERE clause's dlc gate differs. */
const ftsHit = (db: Db, query: string, extra: string): PageRecord | undefined =>
  db.prepare(`
    SELECT ${PROVENANCE_COLUMNS.split(', ').map((c) => `p.${c}`).join(', ')}
    FROM sections_fts f JOIN sections s ON s.id = f.rowid JOIN pages p ON p.id = s.page_id
    WHERE sections_fts MATCH ? AND ${extra} ORDER BY bm25(sections_fts, 10.0, 2.0, 1.0) LIMIT 1
  `).get(query) as PageRecord | undefined;

function resolveIn(db: Db, name: string, mode: DlcMode): Resolved | null {
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
  // A guess the caller can't use is worse than none: try the mode's own pages first, and only fall
  // back to the unfiltered top hit (still reported and then gated) when nothing permitted matches at
  // all, so a genuine "nothing here" miss still reads as a guess rather than a silent null.
  const hit = ftsHit(db, query, dlcPredicate(mode, 'p')) ?? ftsHit(db, query, dlcPredicate('all', 'p'));
  return hit ? toResolved(db, hit, 'search') : null;
}

export interface ResolveOptions {
  /**
   * Walk the local cache before the shipped snapshot. Set only when the caller passed fetch: true —
   * having just paid for a Fextralife round trip, they asked for that copy specifically (issue #9).
   * It is not the default: the shipped Fandom snapshot is the classified, licensed, citable source,
   * and a cache entry from an older visit must not quietly displace it on every other call.
   */
  preferLocal?: boolean;
}

/**
 * The mode excluded the copy that resolved first; this looks for a copy of the same title, exactly,
 * in another db that the mode permits — a cached Fextralife row always is, being unclassified.
 *
 * Without it the gate lied by omission: it reported "this page is DLC content you did not ask for"
 * while a permitted copy of that very title sat in the other db, so a caller who had already cached
 * the Fextralife page was told their own data does not cover something it does.
 *
 * Exact titles only, and never for a `search` match. The FTS fallback is a guess at what was meant;
 * letting a guess hop sources on the strength of its guessed title makes it a guess about a
 * different page again, which is the failure the gate's own `match` field exists to expose.
 */
function permittedElsewhere(order: (Db | null)[], found: Resolved, mode: DlcMode): Resolved | null {
  if (found.match === 'search') return null;
  for (const db of order) {
    if (!db || db === found.db) continue;
    const row = db.prepare(`SELECT ${PROVENANCE_COLUMNS} FROM pages WHERE title = ? COLLATE NOCASE`)
      .get(found.provenance.title) as PageRecord | undefined;
    if (!row) continue;
    const candidate = toResolved(db, row, 'exact');
    if (permits(mode, candidate.dlc)) return candidate;
  }
  return null;
}

/** The same title, exactly, in every db but the one the answer came from. */
function alternatesFor(order: (Db | null)[], found: Resolved): Provenance[] {
  const rows: Provenance[] = [];
  for (const db of order) {
    if (!db || db === found.db) continue;
    const row = db.prepare('SELECT source, title, url, revid, fetched_at, license FROM pages WHERE title = ? COLLATE NOCASE')
      .get(found.provenance.title) as Provenance | undefined;
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Shipped data first, then the local cache — or the other way round when the caller asked to fetch.
 * Within a db: exact title, redirect, entity name, full-text search.
 *
 * Exact title, redirect, and entity name resolve against every page regardless of mode, then compare
 * to it. Excluding DLC rows from the resolver's view instead would make "the snapshot does not cover
 * this" and "you did not ask for DLC" indistinguishable, which is the failure this whole feature
 * exists to avoid.
 *
 * The full-text fallback is different: it is a guess, not a resolution, so it is mode-aware from the
 * start (issue #6) — it tries the mode's own pages first and only reaches for an unfiltered top hit
 * (still gated below) when nothing permitted matches at all. Gating an unfiltered guess ignored that
 * dozens of permitted pages could have matched the same words just as well; a guess the caller can't
 * use is worse than no guess.
 */
export function resolveName(dbs: Dbs, name: string, mode: DlcMode = DEFAULT_DLC_MODE, opts: ResolveOptions = {}): Resolved | DlcFiltered | null {
  const trimmed = name.trim();
  const order = opts.preferLocal ? [dbs.local, dbs.shipped] : [dbs.shipped, dbs.local];
  let found: Resolved | null = null;

  for (const db of order) {
    if (!db) continue;
    const resolved = resolveIn(db, trimmed, mode);
    if (resolved && resolved.match !== 'search') { found = resolved; break; }
  }
  if (!found) {
    for (const db of order) {
      if (!db) continue;
      const resolved = resolveIn(db, trimmed, mode);
      if (resolved) { found = resolved; break; }
    }
  }

  if (!found) return null;
  if (permits(mode, found.dlc)) return { ...found, alternates: alternatesFor(order, found) };
  // The gate is a last resort: it is only honest once no db holds a copy of this title the caller's
  // mode actually allows. The excluded page rides along in the survivor's alternates either way.
  const permitted = permittedElsewhere(order, found, mode);
  if (permitted) return { ...permitted, alternates: alternatesFor(order, permitted) };
  return { filtered: 'dlc', title: found.provenance.title, provenance: found.provenance, match: found.match };
}
