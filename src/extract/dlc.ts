import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/open.js';
import type { PageRow } from './types.js';

export type DlcSignal = 'override' | 'hub_page' | 'sote_template' | 'sote_link' | 'title_suffix' | 'category';

export interface Classification {
  dlc: boolean;
  signals: DlcSignal[];
  hasDlcSections: boolean;
}

export interface Overrides {
  dlc: string[];
  base: string[];
}

// fileURLToPath (not .pathname) decodes percent-escapes, so an install path with a space still resolves.
const DEFAULT_OVERRIDES_PATH = fileURLToPath(new URL('../../data/dlc-overrides.json', import.meta.url));

/**
 * A missing file is legitimate — overrides are optional — and yields empty lists. Malformed JSON, or
 * JSON that isn't an object, is not: this file is where human judgment lands, and the only place it
 * lands, so a typo here must fail the sync loudly instead of silently reverting every correction.
 */
export function loadOverrides(path: string = DEFAULT_OVERRIDES_PATH): Overrides {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { dlc: [], base: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`dlc overrides file at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`dlc overrides file at ${path} must contain a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  return { dlc: list(obj.dlc), base: list(obj.base) };
}

const lowerSet = (titles: string[]): Set<string> => new Set(titles.map((t) => t.toLowerCase()));

/** The wiki's own DLC marker template, e.g. "added in the {{SotE}} expansion". */
const SOTE = String.raw`\{\{\s*SotE\b`;
/** The wiki's other marker template: `{{in|se}}` and `{{in|sote}}` are written only as a predicate. */
const IN_SE = String.raw`\{\{\s*in\s*\|\s*(?:se|sote)\s*(?:\||\}\})`;
/** Any spelling, anywhere — template, {{in|se}}, or the plain article link: what has_dlc_sections reports. */
const SOTE_ANY = new RegExp(`${SOTE}|${IN_SE}|\\[\\[Elden Ring: Shadow of the Erdtree(?:\\|[^\\]]*)?\\]\\]`, 'gi');
const TITLE_SUFFIX = /\(Shadow of the Erdtree\)\s*$/i;

/** First `==` heading; everything before it is the lead, where a page states what its subject is. */
const LEAD_END = /^[ \t]*==/m;
/**
 * A page IS DLC when its lead says so in predicate form — "is a Light Greatsword {{in|se}}",
 * "in {{ER}}: {{SotE}}", "a boss in {{SotE}}", "in {{ER}}, included in the {{SotE}} DLC".
 *
 * Requiring the predicate is what excludes every other lead mention, without a list of exclusions:
 * an inline tag on a linked item ("[[Deflecting Hardtear]] {{SotE}}", 167 base pages including
 * Flask of Crimson Tears and 33 Ash of War pages), a coordinate list of both products ("in {{ER}}
 * and {{SotE}}" — Godslayer Incantations, Paintings), a negation ("not implemented in {{ER}} or
 * {{SotE}}" — Unused Content) and a patch note ("it also patched {{SotE}}" — Game Version/1.15).
 * Mentions below the lead are excluded by position: they are notes about the DLC, not claims about
 * this page's subject.
 */
const LEAD_MARKERS: RegExp[] = [
  new RegExp(IN_SE, 'i'),
  new RegExp(String.raw`\bin\s+\{\{\s*ER\s*\}\}\s*(?:<i>)?\s*:\s*(?:</i>)?\s*${SOTE}`, 'i'),   // in {{ER}}: {{SotE}}
  new RegExp(String.raw`\bin\s+(?:the\s+)?${SOTE}`, 'i'),                                       // in {{SotE}} / in the {{SotE}} expansion
  new RegExp(String.raw`\bincluded\s+in\s+(?:the\s+)?${SOTE}`, 'i'),                            // in {{ER}}, included in the {{SotE}} DLC
];
/**
 * The same predicate form with the plain article link instead of a template, the spelling no template
 * rule could ever see. The optional `''`/`<i>` is not cosmetic: the wiki italicises a product title,
 * so Milady, Putrescent Knight and Needle Knight Leda all read "in ''[[Elden Ring: Shadow of the
 * Erdtree]]''" and a rule without it misses every page of that shape. A distinct signal so its reach
 * can be measured on its own.
 */
const LEAD_LINK = /\bin\s+(?:the\s+)?(?:'{2,5}|<i>)?\s*\[\[Elden Ring: Shadow of the Erdtree(?:\|[^\]]*)?\]\]/i;

interface SoteMentions {
  /** Any occurrence at all, in any spelling and anywhere on the page — what has_dlc_sections reports. */
  any: boolean;
  /** A template marker in the lead, in predicate form: the page claims its own subject is DLC. */
  pageMarker: boolean;
  /** The same claim written with a plain link to the expansion's article. */
  linkMarker: boolean;
}

/**
 * Separates "this page IS DLC" from "this page MENTIONS DLC". The separation is grammatical, not a
 * list of exclusions: only a lead that predicates the DLC of its own subject counts as a claim.
 */
export function soteMentions(wikitext: string): SoteMentions {
  const lead = wikitext.slice(0, LEAD_END.exec(wikitext)?.index ?? wikitext.length);
  // SOTE_ANY is global, so lastIndex survives a .test() and would make every other call miss.
  SOTE_ANY.lastIndex = 0;
  return {
    any: SOTE_ANY.test(wikitext),
    pageMarker: LEAD_MARKERS.some((re) => re.test(lead)),
    linkMarker: LEAD_LINK.test(lead),
  };
}

export interface ClassifyContext {
  overrides: Overrides;
  /** Titles reachable from Category:Shadow of the Erdtree and its subcategories. */
  dlcCategoryTitles: Set<string>;
}

/**
 * Page-level only, never section-level: stripping sections on a heuristic would silently delete text
 * from an answer. A base page that discusses DLC events keeps its text and sets hasDlcSections.
 *
 * Precedence: override, then hub exclusion, then the automatic signals. The first two are decisions a
 * human made; the rest are guesses.
 */
export function classifyPage(page: PageRow, ctx: ClassifyContext): Classification {
  const wikitext = page.wikitext ?? '';
  const { any: mentionsDlc, pageMarker, linkMarker } = soteMentions(wikitext);
  const title = page.title.toLowerCase();

  const forcedDlc = lowerSet(ctx.overrides.dlc);
  const forcedBase = lowerSet(ctx.overrides.base);

  if (forcedDlc.has(title)) return { dlc: true, signals: ['override'], hasDlcSections: false };
  if (forcedBase.has(title)) return { dlc: false, signals: ['hub_page'], hasDlcSections: mentionsDlc };

  const signals: DlcSignal[] = [];
  if (pageMarker) signals.push('sote_template');
  if (linkMarker) signals.push('sote_link');
  if (TITLE_SUFFIX.test(page.title)) signals.push('title_suffix');
  if (ctx.dlcCategoryTitles.has(page.title)) signals.push('category');

  const dlc = signals.length > 0;
  // A base page may legitimately mention the DLC — an inline tag on a linked item, a trivia note.
  // That is what has_dlc_sections is for: caveat the answer, never withhold the text.
  return { dlc, signals, hasDlcSections: !dlc && mentionsDlc };
}

export const DLC_SIGNALS: DlcSignal[] = ['override', 'hub_page', 'sote_template', 'sote_link', 'title_suffix', 'category'];

export interface DlcReport {
  pages: number;
  dlc: number;
  hasDlcSections: number;
  bySignal: Record<DlcSignal, number>;
  /** Base-game pages that nonetheless mention DLC content: the queue for the override file. */
  ambiguous: string[];
}

/**
 * Labels every page in the db. Runs after runExtractors rather than inside it: extractors write rows
 * keyed by page_id into tables clearDerived truncates, and this writes a column on pages itself.
 */
export function classifyDlc(db: Db, opts: { overrides?: Overrides; now?: () => Date } = {}): DlcReport {
  const overrides = opts.overrides ?? loadOverrides();
  const now = opts.now ?? (() => new Date());
  const dlcCategoryTitles = new Set((db.prepare('SELECT title FROM dlc_categories').all() as { title: string }[]).map((r) => r.title));
  const ctx: ClassifyContext = { overrides, dlcCategoryTitles };

  const pages = db.prepare('SELECT id, source, title, wikitext FROM pages ORDER BY id').all() as PageRow[];
  const bySignal = Object.fromEntries(DLC_SIGNALS.map((s) => [s, 0])) as Record<DlcSignal, number>;
  const report: DlcReport = { pages: pages.length, dlc: 0, hasDlcSections: 0, bySignal, ambiguous: [] };

  const update = db.prepare('UPDATE pages SET dlc = ?, dlc_signals = ?, has_dlc_sections = ? WHERE id = ?');
  db.transaction(() => {
    for (const page of pages) {
      const result = classifyPage(page, ctx);
      update.run(result.dlc ? 1 : 0, result.signals.length ? JSON.stringify(result.signals) : null, result.hasDlcSections ? 1 : 0, page.id);
      if (result.dlc) report.dlc++;
      if (result.hasDlcSections) {
        report.hasDlcSections++;
        report.ambiguous.push(page.title);
      }
      for (const signal of result.signals) bySignal[signal]++;
    }

    const at = now().toISOString();
    db.prepare('DELETE FROM dlc_report').run();
    const insertReport = db.prepare('INSERT INTO dlc_report (signal, hits, at) VALUES (?, ?, ?)');
    for (const signal of DLC_SIGNALS) insertReport.run(signal, bySignal[signal], at);
  })();

  return report;
}
