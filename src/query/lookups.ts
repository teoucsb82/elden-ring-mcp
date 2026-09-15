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

export function getPage(dbs: Dbs, title: string, section?: string) {
  const r = resolveName(dbs, title);
  if (!r) return notFound(title);
  const heading = section ? new RegExp(escapeRegex(section), 'i') : r.fragment ? new RegExp(`^${escapeRegex(r.fragment)}$`, 'i') : undefined;
  return { provenance: r.provenance, match: r.match, sections: sectionsOf(r, heading) };
}

export function whereIs(dbs: Dbs, name: string) {
  const r = resolveName(dbs, name);
  if (!r) return notFound(name);
  const row = r.db.prepare('SELECT method, location_text, nearest_grace, prereqs, missable FROM acquisition WHERE page_id = ?').get(r.pageId) as
    { method: string; location_text: string; nearest_grace: string | null; prereqs: string; missable: number } | undefined;
  return {
    provenance: r.provenance,
    match: r.match,
    acquisition: row ? { ...row, prereqs: JSON.parse(row.prereqs) as string[], missable: row.missable === 1 } : null,
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
type Stat = 'str' | 'dex' | 'int' | 'fai' | 'arc';

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
  const kinds = filter.kind ? [filter.kind] : (Object.keys(KIND_TABLE) as Kind[]);
  const rows: (Record<string, unknown> & { kind: string; provenance: Provenance })[] = [];
  for (const db of [dbs.shipped, dbs.local]) {
    if (!db) continue;
    for (const kind of kinds) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (filter.scaling_stat && filter.min_scaling && kind === 'weapon') {
        const allowed = SCALING_ORDER.slice(SCALING_ORDER.indexOf(filter.min_scaling.toUpperCase() as (typeof SCALING_ORDER)[number]));
        where.push(`${filter.scaling_stat}_scale IN (${allowed.map(() => '?').join(', ')})`);
        params.push(...allowed);
      }
      for (const [stat, max] of Object.entries(filter.max_req ?? {}) as [Stat, number][]) {
        if (kind === 'weapon' || (kind === 'spell' && ['int', 'fai', 'arc'].includes(stat))) { where.push(`coalesce(${stat}_req, 0) <= ?`); params.push(max); }
      }
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
  const heading = r.fragment ? new RegExp(`^${escapeRegex(r.fragment)}$`, 'i') : /overview|location|strateg|weakness|resist/i;
  return { provenance: r.provenance, match: r.match, boss, sections: sectionsOf(r, heading) };
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
