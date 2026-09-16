import type { Db } from '../db/open.js';
import { SCALING_ORDER } from '../extract/common.js';
import { BREAK_PATTERN, type QuestStep } from '../extract/quest.js';
import type { Dbs } from './dbs.js';
import { ftsQuery, resolveName, type Provenance, type Resolved } from './resolve.js';

export interface NotFound { not_found: true; query: string; hint: string }

const notFound = (query: string): NotFound => ({
  not_found: true, query,
  hint: 'No page matched in the shipped data or local cache. Try search, or pass fetch: true to cache the Fextralife page.',
});

type SectionOut = { heading: string; markdown: string };

function sectionsOf(r: Resolved, heading?: RegExp): SectionOut[] {
  const rows = r.db.prepare('SELECT heading, markdown FROM sections WHERE page_id = ? ORDER BY ord').all(r.pageId) as SectionOut[];
  return heading ? rows.filter((row) => heading.test(row.heading)) : rows;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function search(dbs: Dbs, query: string, limit = 10) {
  const fts = ftsQuery(query);
  const results: { title: string; heading: string; snippet: string; provenance: Provenance }[] = [];
  if (!fts) return { results };
  for (const db of [dbs.shipped, dbs.local]) {
    if (!db) continue;
    const rows = db.prepare(`
      SELECT p.source, p.title, p.url, p.revid, p.fetched_at, p.license, s.heading,
             snippet(sections_fts, 2, '**', '**', ' … ', 24) AS snippet
      FROM sections_fts f JOIN sections s ON s.id = f.rowid JOIN pages p ON p.id = s.page_id
      WHERE sections_fts MATCH ? ORDER BY bm25(sections_fts, 10.0, 2.0, 1.0) LIMIT ?
    `).all(fts, limit) as (Provenance & { heading: string; snippet: string })[];
    for (const { heading, snippet, ...provenance } of rows) results.push({ title: provenance.title, heading, snippet, provenance });
  }
  return { results: results.slice(0, limit) };
}

/**
 * A redirect fragment can name a heading that carries no text of its own — on the ~371 pages whose
 * sections are Fandom <tabber> scaffolding, the fragment's section is empty and dropped. Prefer the
 * fragment, but fall back to the page rather than return an OK-looking answer with no sections, and
 * say which happened so a caller can tell fragment prose from page prose.
 */
function withFragment<T extends object>(r: Resolved, fragmentSections: SectionOut[], fallback: () => SectionOut[], rest: T) {
  if (!r.fragment) return { provenance: r.provenance, match: r.match, ...rest, sections: fragmentSections };
  const matched = fragmentSections.length > 0;
  return {
    provenance: r.provenance, match: r.match, ...rest,
    fragment: r.fragment, fragment_matched: matched,
    sections: matched ? fragmentSections : fallback(),
  };
}

export function getPage(dbs: Dbs, title: string, section?: string) {
  const r = resolveName(dbs, title);
  if (!r) return notFound(title);
  if (section) {
    const sections = sectionsOf(r, new RegExp(escapeRegex(section), 'i'));
    // An asked-for section that matches nothing is a miss, not an empty page.
    return sections.length ? { provenance: r.provenance, match: r.match, sections } : notFound(title);
  }
  const fragmentSections = r.fragment ? sectionsOf(r, new RegExp(`^${escapeRegex(r.fragment)}$`, 'i')) : [];
  return withFragment(r, fragmentSections, () => sectionsOf(r), {});
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

export function whereIs(dbs: Dbs, name: string) {
  const r = resolveName(dbs, name);
  if (!r) return notFound(name);
  const row = r.db.prepare('SELECT method, location_text, nearest_grace, prereqs, missable FROM acquisition WHERE page_id = ?').get(r.pageId) as
    { method: string; location_text: string; nearest_grace: string | null; prereqs: string; missable: number } | undefined;
  return {
    provenance: r.provenance,
    match: r.match,
    acquisition: row ? { ...row, prereqs: parsePrereqs(row.prereqs), missable: row.missable === 1 } : null,
    sections: sectionsOf(r, /acquisition|location|where to find|how to get/i),
  };
}

export function questSteps(dbs: Dbs, npc: string) {
  const r = resolveName(dbs, npc);
  if (!r) return notFound(npc);
  const steps = r.db.prepare('SELECT step_ord, location, action, breaks_quest FROM quests WHERE page_id = ? ORDER BY step_ord').all(r.pageId) as QuestStep[];
  const notes = sectionsOf(r, /^notes$/i).flatMap((s) => s.markdown.split('\n')).filter((line) => BREAK_PATTERN.test(line));
  return { provenance: r.provenance, match: r.match, steps, warnings: notes, ...(steps.length ? {} : { sections: sectionsOf(r, /quest/i) }) };
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

export function itemStats(dbs: Dbs, filter: { name?: string; kind?: Kind; scaling_stat?: Stat; min_scaling?: string; max_req?: Partial<Record<Stat, number>>; limit?: number }) {
  const limit = filter.limit ?? 25;
  if (filter.name) {
    const r = resolveName(dbs, filter.name);
    if (!r) return notFound(filter.name);
    const rows = (Object.entries(KIND_TABLE) as [Kind, string][]).flatMap(([kind, table]) =>
      (r.db.prepare(`SELECT * FROM ${table} WHERE page_id = ?`).all(r.pageId) as Record<string, unknown>[]).map((row) => ({ kind, ...row, provenance: r.provenance })));
    return rows.length ? { rows } : notFound(filter.name);
  }
  // Both filters are dropped unless every part of them is valid: a bad stat name or grade must never
  // silently become a different (or inverted) filter.
  const scalingStat = filter.scaling_stat && isStat(filter.scaling_stat) ? filter.scaling_stat : null;
  const gradeIndex = filter.min_scaling ? SCALING_ORDER.indexOf(filter.min_scaling.toUpperCase() as (typeof SCALING_ORDER)[number]) : -1;
  const scaling = scalingStat && gradeIndex >= 0 ? { stat: scalingStat, allowed: SCALING_ORDER.slice(gradeIndex) } : null;
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
      if (scaling) {
        where.push(`${scaling.stat}_scale IN (${scaling.allowed.map(() => '?').join(', ')})`);
        params.push(...scaling.allowed);
      }
      for (const [stat, max] of maxReq) { where.push(`coalesce(${stat}_req, 0) <= ?`); params.push(max); }
      const sql = `SELECT * FROM ${KIND_TABLE[kind]}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name LIMIT ?`;
      for (const row of db.prepare(sql).all(...params, limit) as Record<string, unknown>[]) rows.push({ kind, ...row, provenance: provenanceOf(db, row.page_id as number) });
    }
  }
  return { rows: rows.slice(0, limit) };
}

export function bossInfo(dbs: Dbs, name: string) {
  const r = resolveName(dbs, name);
  if (!r) return notFound(name);
  const boss = (r.db.prepare('SELECT name, location, hp, runes, drops FROM bosses WHERE page_id = ?').get(r.pageId) as Record<string, unknown> | undefined) ?? null;
  const usual = /overview|location|strateg|weakness|resist/i;
  const fragmentSections = r.fragment ? sectionsOf(r, new RegExp(`^${escapeRegex(r.fragment)}$`, 'i')) : sectionsOf(r, usual);
  return withFragment(r, fragmentSections, () => sectionsOf(r, usual), { boss });
}

export function sourcesStatus(dbs: Dbs) {
  const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    shipped: dbs.shipped
      ? { sync: dbs.shipped.prepare('SELECT source, last_run, pages FROM sync_state').all(), pages: count(dbs.shipped, 'SELECT count(*) AS n FROM pages'), failures: count(dbs.shipped, 'SELECT count(*) AS n FROM extract_failures') }
      : null,
    local: dbs.local ? { pages: count(dbs.local, 'SELECT count(*) AS n FROM pages') } : null,
  };
}
