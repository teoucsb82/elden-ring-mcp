import { parse, type HTMLElement } from 'node-html-parser';
import { contentBlock } from '../sources/fextralife.js';
import type { Extractor } from './types.js';

/** What the page listed an item under. Pages misfile items (Flamberge under spells), so the query layer re-derives the real kind. */
export type ListedAs = 'weapon' | 'shield' | 'armor' | 'talisman' | 'skill' | 'spell' | 'spirit_ash' | 'crystal_tear' | 'great_rune' | 'ammo';

export interface BuildItem {
  listed_as: ListedAs;
  name: string;
  alternate: boolean;
  /** "Uchigatana (Keen)": the parenthesised word right after a weapon link. */
  affinity: string | null;
}

export interface ParsedBuild {
  name: string;
  tagline: string | null;
  class: string | null;
  level: number | null;
  journey: string | null;
  focus: string[];
  playstyle: string | null;
  primary_stats: string[];
  secondary_stats: string[];
  flask: string | null;
  /** "you need at least 21 Dexterity, 19 Arcane": the minimum to wield everything, not a stat spread. */
  min_stats: Partial<Record<'str' | 'dex' | 'int' | 'fai' | 'arc', number>>;
  summary: string | null;
  /** Free text a gear row carries beyond its links, by infobox label: "and any armor as long as you can med roll". */
  notes: Record<string, string>;
  items: BuildItem[];
}

/** Infobox gear rows. A label missing here (Primary Stats, Class, Focus …) never yields items. */
const GEAR_ROWS: Record<string, { listed_as: ListedAs; alternate?: boolean }> = {
  'weapon': { listed_as: 'weapon' },
  'off-hand': { listed_as: 'weapon' },
  'alternate weapon': { listed_as: 'weapon', alternate: true },
  'seal / staff': { listed_as: 'weapon' },
  'shield': { listed_as: 'shield' },
  'armor': { listed_as: 'armor' },
  'talismans': { listed_as: 'talisman' },
  'alternates': { listed_as: 'talisman', alternate: true },
  'skills': { listed_as: 'skill' },
  'spells': { listed_as: 'spell' },
  'spirit ash': { listed_as: 'spirit_ash' },
  'crystal tear': { listed_as: 'crystal_tear' },
  'alternate tear': { listed_as: 'crystal_tear', alternate: true },
  'great runes': { listed_as: 'great_rune' },
  'arrows / bolts': { listed_as: 'ammo' },
};

/** Gear tables, by their first header cell. */
const GEAR_TABLES: Record<string, ListedAs> = { weapon: 'weapon', piece: 'armor', spell: 'spell', talisman: 'talisman' };

const STAT_KEYS = { strength: 'str', dexterity: 'dex', intelligence: 'int', faith: 'fai', arcane: 'arc' } as const;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const orNull = (s: string | undefined) => (s && clean(s)) || null;
const linkTitles = (el: HTMLElement) => el.querySelectorAll('a[title]').map((a) => clean(a.getAttribute('title')!));

/** Connectors and filler left once links and affinities are taken out of a gear row. */
const FILLER = /\b(?:and|with|or|none|&amp;)\b|[,&()+/.]/gi;

export function parseBuild(html: string, title: string): ParsedBuild {
  const root = parse(html);
  const infobox = root.querySelector('.er-build-infobox');
  const body = contentBlock(html);
  // Keyed by lower-cased label; `label` keeps the page's own spelling for notes.
  const values = new Map<string, { label: string; value: HTMLElement }>();
  for (const row of infobox?.querySelectorAll('.er-build-row, .er-build-cell') ?? []) {
    const label = row.querySelector('.er-build-label');
    const value = row.querySelector('.er-build-val');
    if (label && value) values.set(clean(label.text).toLowerCase(), { label: clean(label.text), value });
  }
  const text = (label: string) => orNull(values.get(label)?.value.text);
  const links = (label: string) => { const v = values.get(label); return v ? linkTitles(v.value) : []; };

  const items: BuildItem[] = [];
  const seen = new Set<string>();
  const add = (item: BuildItem) => {
    const key = item.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  const notes: Record<string, string> = {};
  for (const [key, { label, value }] of values) {
    const gear = GEAR_ROWS[key];
    if (!gear) continue;
    let rest = value.innerHTML;
    for (const a of value.querySelectorAll('a[title]')) {
      const name = clean(a.getAttribute('title')!);
      const after = value.innerHTML.slice(value.innerHTML.indexOf(a.outerHTML) + a.outerHTML.length);
      const affinity = gear.listed_as === 'weapon' ? /^\s*\(([A-Z][a-z]+)\)/.exec(after)?.[1] ?? null : null;
      // An Ash of War is a skill wherever the page mentions it, including inside the weapon row.
      const listed_as: ListedAs = /^Ash of War:/i.test(name) ? 'skill' : gear.listed_as;
      add({ listed_as, name, alternate: gear.alternate ?? false, affinity });
      rest = rest.replace(a.outerHTML, ' ');
      if (affinity) rest = rest.replace(`(${affinity})`, ' ');
    }
    const leftover = clean(parse(rest).text);
    if (clean(leftover.replace(FILLER, ' '))) notes[label] = leftover.replace(/^[,&\s]+(?:and\s+)?/i, '');
  }

  for (const table of body?.querySelectorAll('table') ?? []) {
    const header = clean(table.querySelector('th')?.text ?? '').toLowerCase();
    const listed_as = GEAR_TABLES[header];
    if (!listed_as) continue;
    for (const tr of table.querySelectorAll('tr')) {
      const first = tr.querySelector('td');
      const name = first ? linkTitles(first)[0] : undefined;
      if (name) add({ listed_as, name, alternate: false, affinity: null });
    }
  }

  const paragraphs = body?.querySelectorAll('p').map((p) => clean(p.text)) ?? [];
  const requirement = paragraphs.find((p) => /\bat least\b/i.test(p)) ?? '';
  const min_stats: ParsedBuild['min_stats'] = {};
  for (const m of requirement.matchAll(/(\d+)\s+(Strength|Dexterity|Intelligence|Faith|Arcane)\b/gi)) {
    min_stats[STAT_KEYS[m[2].toLowerCase() as keyof typeof STAT_KEYS]] = Number(m[1]);
  }
  const level = Number.parseInt(text('level') ?? '', 10);

  return {
    name: orNull(infobox?.querySelector('.er-build-name')?.text) ?? title.replace(/ Build$/, ''),
    tagline: orNull(infobox?.querySelector('.er-build-tagline')?.text),
    class: links('class')[0] ?? text('class'),
    level: Number.isFinite(level) ? level : null,
    journey: text('journey'),
    focus: links('focus'),
    playstyle: text('playstyle'),
    primary_stats: links('primary stats'),
    secondary_stats: links('secondary stats'),
    flask: text('flask spread'),
    min_stats,
    summary: paragraphs.find((p) => /\bis a Build\b/i.test(p)) ?? null,
    notes,
    items,
  };
}

/** Every `/X_Build` link on an index page, once, in page order. `/X_Builds` category pages are not builds. */
export function buildLinks(html: string): string[] {
  const titles: string[] = [];
  for (const a of parse(html).querySelectorAll('a[href]')) {
    const m = /^\/([^/?#]+_Build)$/.exec(a.getAttribute('href')!);
    if (!m) continue;
    const title = decodeURIComponent(m[1]).replace(/_/g, ' ');
    if (!titles.includes(title)) titles.push(title);
  }
  return titles;
}

export const buildExtractor: Extractor = {
  name: 'build',
  matches: (page) => page.source === 'fextralife' && / Build$/.test(page.title),
  write(db, page) {
    const row = db.prepare('SELECT html FROM page_html WHERE page_id = ?').get(page.id) as { html: string } | undefined;
    if (!row) return;
    const b = parseBuild(row.html, page.title);
    db.prepare(`INSERT INTO builds (page_id, name, tagline, class, level, journey, focus, playstyle, primary_stats, secondary_stats, flask, min_stats, summary, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      page.id, b.name, b.tagline, b.class, b.level, b.journey, JSON.stringify(b.focus), b.playstyle,
      JSON.stringify(b.primary_stats), JSON.stringify(b.secondary_stats), b.flask, JSON.stringify(b.min_stats), b.summary, JSON.stringify(b.notes),
    );
    const insert = db.prepare('INSERT INTO build_items (page_id, ord, listed_as, name, alternate, affinity) VALUES (?, ?, ?, ?, ?, ?)');
    b.items.forEach((item, ord) => insert.run(page.id, ord, item.listed_as, item.name, item.alternate ? 1 : 0, item.affinity));
  },
};
