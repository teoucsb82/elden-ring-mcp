import type { Db } from '../db/open.js';
import { SCALING_ORDER } from '../extract/common.js';
import { BREAK_PATTERN, type QuestStep } from '../extract/quest.js';
import { DEFAULT_DLC_MODE, dlcOf, dlcPredicate, type Dbs, type DlcMode } from './dbs.js';
import { ftsQuery, isDlcFiltered, resolveName, type DlcFiltered, type Provenance, type Resolved } from './resolve.js';

/**
 * `reason` is declared as absent rather than omitted: without it a richer miss (dlc_filtered,
 * no_sections) is a structural subtype of NotFound, and TypeScript's return-type inference collapses
 * the union down to NotFound, hiding `reason` from every caller.
 */
export interface NotFound { not_found: true; query: string; hint: string; reason?: undefined }

const NO_PAGE_HINT = 'No page matched in the shipped data or local cache. Try search, or pass fetch: true to cache the Fextralife page.';

const notFound = (query: string): NotFound => ({ not_found: true, query, hint: NO_PAGE_HINT });

/** A miss that is not a missing page: say what was searched and why nothing came back. */
const noMatch = (query: string, hint: string): NotFound => ({ not_found: true, query, hint });

/**
 * The page exists but the caller's own mode excluded it. Distinct from not_found so an answer never
 * claims the snapshot lacks something it holds.
 */
const dlcFiltered = (query: string, r: DlcFiltered, mode: DlcMode) => {
  const side = mode === 'only'
    ? 'base-game content and this call asked for DLC only. Re-run with dlc: "all" to include the base game, or dlc: "base" for the base game alone.'
    : 'Shadow of the Erdtree content and this call asked for base-game results. Re-run with dlc: "all" to include the DLC, or dlc: "only" for DLC alone.';
  // A `search` match never resolved the name: it is the FTS fallback's nearest page, and the gate is
  // only a statement about THAT page. Saying so is what stops a guess reading as an authoritative
  // answer about the name the caller actually typed.
  const hint = r.match === 'search'
    ? `Nothing is named "${query}". The closest full-text match is the page "${r.title}", which is ${side} That page is a guess at what was meant, not a lookup of "${query}" — check it is the right subject before relying on it.`
    : `"${r.title}" is ${side}`;
  return {
    not_found: true as const, query, reason: 'dlc_filtered' as const, page: r.title,
    match: r.match, provenance: r.provenance, hint,
  };
};

type ResolveOutcome =
  | { kind: 'ok'; resolved: Resolved }
  | { kind: 'filtered'; miss: ReturnType<typeof dlcFiltered> }
  | { kind: 'missing'; miss: NotFound };

/** One entry point for every name-resolving lookup, so none of them can forget the dlc check. */
function resolveFor(dbs: Dbs, name: string, mode: DlcMode): ResolveOutcome {
  const r = resolveName(dbs, name, mode);
  if (!r) return { kind: 'missing', miss: notFound(name) };
  if (isDlcFiltered(r)) return { kind: 'filtered', miss: dlcFiltered(name, r, mode) };
  return { kind: 'ok', resolved: r };
}

type SectionOut = { heading: string; markdown: string };

function sectionsOf(r: Resolved, heading?: RegExp): SectionOut[] {
  const rows = r.db.prepare('SELECT heading, markdown FROM sections WHERE page_id = ? ORDER BY ord').all(r.pageId) as SectionOut[];
  return heading ? rows.filter((row) => heading.test(row.heading)) : rows;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const NO_SEARCH_HINT = 'Nothing in the shipped data or the local cache matches these words. Try fewer or different words, or pass fetch: true on get_page to cache the Fextralife page.';

/** The mode whose rows the caller's own mode just excluded. `all` excludes nothing, so it has none. */
const OPPOSITE_MODE: Partial<Record<DlcMode, DlcMode>> = { base: 'only', only: 'base' };

/**
 * search cannot resolve a name, so it cannot use dlcFiltered. It reaches the same answer the other
 * way round: on a zero-row miss, count what the opposite filter would have matched. The server's
 * instructions tell a model that not_found means the data does not cover it, so an unqualified miss
 * on a query the snapshot does hold makes the model assert something untrue.
 */
const searchDlcFiltered = (query: string, mode: DlcMode, hidden: number) => ({
  not_found: true as const, query, reason: 'dlc_filtered' as const, hidden_matches: hidden,
  hint: mode === 'only'
    ? `${hidden} section${hidden === 1 ? '' : 's'} in the snapshot match these words, but all of them are base-game content and this call asked for DLC only. Re-run with dlc: "all" to include the base game, or dlc: "base" for the base game alone.`
    : `${hidden} section${hidden === 1 ? '' : 's'} in the snapshot match these words, but all of them are Shadow of the Erdtree content and this call asked for base-game results. Re-run with dlc: "all" to include the DLC, or dlc: "only" for DLC alone.`,
});

/** Miss path only: one count, never run when the search already has rows to return. */
function countMatches(dbs: Dbs, fts: string, mode: DlcMode): number {
  let total = 0;
  for (const db of [dbs.shipped, dbs.local]) {
    if (!db) continue;
    total += (db.prepare(`
      SELECT count(*) AS n
      FROM sections_fts f JOIN sections s ON s.id = f.rowid JOIN pages p ON p.id = s.page_id
      WHERE sections_fts MATCH ? AND ${dlcPredicate(mode, 'p')}
    `).get(fts) as { n: number }).n;
  }
  return total;
}

export function search(dbs: Dbs, query: string, limit = 10, mode: DlcMode = DEFAULT_DLC_MODE) {
  const fts = ftsQuery(query);
  const results: { title: string; heading: string; snippet: string; dlc: boolean | null; provenance: Provenance }[] = [];
  // Zero hits is a miss, not an answer: an empty result set used to serialize as a bare {}.
  if (!fts) return noMatch(query, NO_SEARCH_HINT);
  for (const db of [dbs.shipped, dbs.local]) {
    if (!db) continue;
    const rows = db.prepare(`
      SELECT p.source, p.title, p.url, p.revid, p.fetched_at, p.license, p.dlc, s.heading,
             snippet(sections_fts, 2, '**', '**', ' … ', 24) AS snippet
      FROM sections_fts f JOIN sections s ON s.id = f.rowid JOIN pages p ON p.id = s.page_id
      WHERE sections_fts MATCH ? AND ${dlcPredicate(mode, 'p')}
      ORDER BY bm25(sections_fts, 10.0, 2.0, 1.0) LIMIT ?
    `).all(fts, limit) as (Provenance & { heading: string; snippet: string; dlc: number })[];
    for (const { heading, snippet, dlc, ...provenance } of rows) {
      results.push({ title: provenance.title, heading, snippet, dlc: dlcOf(provenance.source, dlc), provenance });
    }
  }
  if (results.length) return { results: results.slice(0, limit) };
  // A genuine miss must stay a genuine miss: only say dlc_filtered when the opposite filter really
  // does hold rows for these words.
  const opposite = OPPOSITE_MODE[mode];
  const hidden = opposite ? countMatches(dbs, fts, opposite) : 0;
  return hidden ? searchDlcFiltered(query, mode, hidden) : noMatch(query, NO_SEARCH_HINT);
}

/**
 * A redirect fragment can name a heading that carries no text of its own — on the ~371 pages whose
 * sections are Fandom <tabber> scaffolding, the fragment's section is empty and dropped. Prefer the
 * fragment, but fall back to the page rather than return an OK-looking answer with no sections, and
 * say which happened so a caller can tell fragment prose from page prose.
 */
function withFragment<T extends object>(r: Resolved, fallback: () => SectionOut[], rest: T) {
  const base = { provenance: r.provenance, match: r.match, ...rest };
  // No fragment at all is the ordinary case, and it must answer with the caller's usual sections.
  if (!r.fragment) return { ...base, sections: fallback() };
  const fragmentSections = sectionsOf(r, new RegExp(`^${escapeRegex(r.fragment)}$`, 'i'));
  const matched = fragmentSections.length > 0;
  return { ...base, fragment: r.fragment, fragment_matched: matched, sections: matched ? fragmentSections : fallback() };
}

/**
 * Fourteen shipped pages (Gravebird Helm, Flamespitter, Catapult…) are nothing but an infobox and a
 * table, so stripping leaves no sections at all. Provenance with no text reads as an answer; say it
 * is a miss and why, while still handing back the citation so the page can be linked or fetched.
 */
const emptyPage = (query: string, r: Resolved) => ({
  not_found: true as const, query, reason: 'no_sections' as const, page: r.provenance.title,
  provenance: r.provenance,
  hint: 'This page is in the snapshot but its wiki text is entirely templates and tables, so it holds no readable sections. Try search for pages that describe it, or pass fetch: true to cache the Fextralife page.',
});

/** The page was found and the section was not: naming the page's real headings says what to ask for next. */
const sectionNotFound = (r: Resolved, section: string, headings: string[]) => ({
  section_not_found: true as const, page: r.provenance.title, section, headings,
  provenance: r.provenance, match: r.match,
  hint: `The page "${r.provenance.title}" exists but has no section matching "${section}". Ask again with one of the headings listed, or omit section for the whole page. This says nothing about whether the section's subject exists.`,
});

export function getPage(dbs: Dbs, title: string, section?: string, mode: DlcMode = DEFAULT_DLC_MODE) {
  const outcome = resolveFor(dbs, title, mode);
  if (outcome.kind !== 'ok') return outcome.miss;
  const r = outcome.resolved;
  const all = sectionsOf(r);
  if (!all.length) return emptyPage(title, r);
  if (section) {
    const wanted = new RegExp(escapeRegex(section), 'i');
    const sections = all.filter((row) => wanted.test(row.heading));
    // An asked-for section that matches nothing is a section miss, never a missing page.
    return sections.length
      ? { provenance: r.provenance, match: r.match, dlc: r.dlc, has_dlc_sections: r.hasDlcSections, sections }
      : sectionNotFound(r, section, all.map((row) => row.heading));
  }
  return withFragment(r, () => all, { dlc: r.dlc, has_dlc_sections: r.hasDlcSections });
}

/** Stored prereqs are always a JSON array, but a malformed row must not take the whole answer down. */
function parsePrereqs(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function whereIs(dbs: Dbs, name: string, mode: DlcMode = DEFAULT_DLC_MODE) {
  const outcome = resolveFor(dbs, name, mode);
  if (outcome.kind !== 'ok') return outcome.miss;
  const r = outcome.resolved;
  const row = r.db.prepare('SELECT method, location_text, nearest_grace, prereqs, missable FROM acquisition WHERE page_id = ?').get(r.pageId) as
    { method: string; location_text: string; nearest_grace: string | null; prereqs: string; missable: number } | undefined;
  return {
    provenance: r.provenance,
    match: r.match,
    dlc: r.dlc,
    has_dlc_sections: r.hasDlcSections,
    acquisition: row ? { ...row, prereqs: parsePrereqs(row.prereqs), missable: row.missable === 1 } : null,
    sections: sectionsOf(r, /acquisition|location|where to find|how to get/i),
  };
}

export function questSteps(dbs: Dbs, npc: string, mode: DlcMode = DEFAULT_DLC_MODE) {
  const outcome = resolveFor(dbs, npc, mode);
  if (outcome.kind !== 'ok') return outcome.miss;
  const r = outcome.resolved;
  const steps = r.db.prepare('SELECT step_ord, location, action, breaks_quest FROM quests WHERE page_id = ? ORDER BY step_ord').all(r.pageId) as QuestStep[];
  const notes = sectionsOf(r, /^notes$/i).flatMap((s) => s.markdown.split('\n')).filter((line) => BREAK_PATTERN.test(line));
  return { provenance: r.provenance, match: r.match, dlc: r.dlc, has_dlc_sections: r.hasDlcSections, steps, warnings: notes, ...(steps.length ? {} : { sections: sectionsOf(r, /quest/i) }) };
}

const KIND_TABLE = { weapon: 'weapons', spell: 'spells', talisman: 'talismans', armor: 'armor' } as const;
type Kind = keyof typeof KIND_TABLE;
export const STATS = ['str', 'dex', 'int', 'fai', 'arc'] as const;
type Stat = (typeof STATS)[number];

/** Caller-supplied keys become column names, so nothing outside this list may reach SQL. */
const isStat = (value: string): value is Stat => (STATS as readonly string[]).includes(value);

/** Requirement columns each table actually has. A kind that cannot express a supplied filter is skipped, never returned unfiltered. */
const REQ_STATS: Record<Kind, readonly Stat[]> = { weapon: STATS, spell: ['int', 'fai', 'arc'], talisman: [], armor: [] };

function provenanceOf(db: Db, pageId: number): Provenance {
  return db.prepare('SELECT source, title, url, revid, fetched_at, license FROM pages WHERE id = ?').get(pageId) as Provenance;
}

export interface FilterError { error: 'invalid_filter' | 'kind_mismatch'; detail: string }

const invalidFilter = (detail: string): FilterError => ({ error: 'invalid_filter', detail });

export function itemStats(dbs: Dbs, filter: { name?: string; kind?: Kind; scaling_stat?: Stat; min_scaling?: string; max_req?: Partial<Record<Stat, number>>; limit?: number }, mode: DlcMode = DEFAULT_DLC_MODE) {
  const limit = filter.limit ?? 25;
  if (filter.name) {
    const outcome = resolveFor(dbs, filter.name, mode);
    if (outcome.kind !== 'ok') return outcome.miss;
    const r = outcome.resolved;
    const rows = (Object.entries(KIND_TABLE) as [Kind, string][]).flatMap(([kind, table]) =>
      (r.db.prepare(`SELECT * FROM ${table} WHERE page_id = ?`).all(r.pageId) as Record<string, unknown>[]).map((row) => ({ kind, ...row, provenance: r.provenance })));
    if (!rows.length) return notFound(filter.name);
    if (!filter.kind) return { rows, dlc: r.dlc, has_dlc_sections: r.hasDlcSections };
    // name + kind used to ignore kind, so asking for the spell "Uchigatana" handed back the katana.
    const matching = rows.filter((row) => row.kind === filter.kind);
    if (matching.length) return { rows: matching, dlc: r.dlc, has_dlc_sections: r.hasDlcSections };
    const kinds = [...new Set(rows.map((row) => row.kind))].join(', ');
    return { error: 'kind_mismatch' as const, detail: `"${r.provenance.title}" is in the data as ${kinds}, not as a ${filter.kind}. Drop kind, or ask for the kind it actually is.` };
  }
  // A filter is never dropped in silence: an unusable one is an error, and a grade that cannot be
  // read falls back to the weakest grade (still "scales with this stat"), never to "no filter".
  if (filter.scaling_stat && !isStat(filter.scaling_stat)) {
    return invalidFilter(`scaling_stat must be one of ${STATS.join(', ')}; got "${String(filter.scaling_stat)}".`);
  }
  if (filter.min_scaling && !filter.scaling_stat) {
    return invalidFilter('min_scaling needs scaling_stat: a grade on its own does not say which stat it applies to.');
  }
  const scalingStat = filter.scaling_stat && isStat(filter.scaling_stat) ? filter.scaling_stat : null;
  const gradeIndex = filter.min_scaling ? SCALING_ORDER.indexOf(filter.min_scaling.toUpperCase() as (typeof SCALING_ORDER)[number]) : -1;
  const scaling = scalingStat ? { stat: scalingStat, allowed: SCALING_ORDER.slice(Math.max(gradeIndex, 0)) } : null;
  const maxReq = Object.entries(filter.max_req ?? {}).filter((entry): entry is [Stat, number] => isStat(entry[0]) && typeof entry[1] === 'number');

  const kinds = filter.kind ? [filter.kind] : (Object.keys(KIND_TABLE) as Kind[]);
  const rows: (Record<string, unknown> & { kind: string; provenance: Provenance })[] = [];
  for (const db of [dbs.shipped, dbs.local]) {
    if (!db) continue;
    for (const kind of kinds) {
      if (scaling && kind !== 'weapon') continue;
      if (maxReq.some(([stat]) => !REQ_STATS[kind].includes(stat))) continue;
      const where: string[] = [];
      const params: (string | number)[] = [];
      // The join to pages puts a second table in scope, so every column here carries the `t.` prefix.
      // A bare column still resolves today only because pages happens to share no name with an item
      // table; adding one would silently repoint the filter rather than fail.
      if (scaling) {
        where.push(`t.${scaling.stat}_scale IN (${scaling.allowed.map(() => '?').join(', ')})`);
        params.push(...scaling.allowed);
      }
      // An unparsed requirement is unknown, not free: coalesce(…, 0) answered "usable at 0 STR" for
      // Celebrant's Skull and Unarmed. Exclude unknowns rather than assert them.
      for (const [stat, max] of maxReq) { where.push(`t.${stat}_req IS NOT NULL AND t.${stat}_req <= ?`); params.push(max); }
      // p.dlc rides along: in all mode the result set mixes base and DLC items, and a row with no
      // marker reads as base game.
      const sql = `SELECT t.*, p.dlc, p.source AS page_source FROM ${KIND_TABLE[kind]} t JOIN pages p ON p.id = t.page_id WHERE ${[...where, dlcPredicate(mode, 'p')].join(' AND ')} ORDER BY t.name LIMIT ?`;
      for (const { dlc, page_source, ...item } of db.prepare(sql).all(...params, limit) as (Record<string, unknown> & { dlc: number; page_source: string })[]) {
        rows.push({ kind, ...item, dlc: dlcOf(page_source, dlc), provenance: provenanceOf(db, item.page_id as number) });
      }
    }
  }
  if (rows.length) return { rows: rows.slice(0, limit) };
  return noMatch(JSON.stringify({ kind: filter.kind, scaling_stat: filter.scaling_stat, min_scaling: filter.min_scaling, max_req: filter.max_req }),
    'No item in the snapshot matches every filter. Loosen them (raise max_req, lower min_scaling, drop kind). Items whose requirement the wiki does not state are excluded from max_req filters rather than counted as zero.');
}

export function bossInfo(dbs: Dbs, name: string, mode: DlcMode = DEFAULT_DLC_MODE) {
  const outcome = resolveFor(dbs, name, mode);
  if (outcome.kind !== 'ok') return outcome.miss;
  const r = outcome.resolved;
  const boss = (r.db.prepare('SELECT name, location, hp, runes, drops FROM bosses WHERE page_id = ?').get(r.pageId) as Record<string, unknown> | undefined) ?? null;
  const usual = /overview|location|strateg|weakness|resist/i;
  return withFragment(r, () => sectionsOf(r, usual), { boss, dlc: r.dlc, has_dlc_sections: r.hasDlcSections });
}

export function sourcesStatus(dbs: Dbs) {
  const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;
  // A stale snapshot is a state to report, not a failure: this is the one tool that still answers
  // when the shipped db predates the dlc columns, because saying so is its whole job.
  if (dbs.stale) {
    return {
      shipped: { stale: dbs.stale.detail, path: dbs.stale.path },
      local: dbs.local ? { pages: count(dbs.local, 'SELECT count(*) AS n FROM pages') } : null,
    };
  }
  return {
    shipped: dbs.shipped
      ? {
          sync: dbs.shipped.prepare('SELECT source, last_run, pages FROM sync_state').all(),
          pages: count(dbs.shipped, 'SELECT count(*) AS n FROM pages'),
          base_pages: count(dbs.shipped, 'SELECT count(*) AS n FROM pages WHERE dlc = 0'),
          dlc_pages: count(dbs.shipped, 'SELECT count(*) AS n FROM pages WHERE dlc = 1'),
          dlc_signals: dbs.shipped.prepare('SELECT signal, hits, at FROM dlc_report ORDER BY signal').all(),
          // Zero here explains a zero on the category signal above: the crawl never ran on this snapshot.
          dlc_categories: count(dbs.shipped, 'SELECT count(*) AS n FROM dlc_categories'),
          failures: count(dbs.shipped, 'SELECT count(*) AS n FROM extract_failures'),
        }
      : null,
    local: dbs.local ? { pages: count(dbs.local, 'SELECT count(*) AS n FROM pages') } : null,
  };
}
