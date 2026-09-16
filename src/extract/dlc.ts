import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/open.js';
import type { PageRow } from './types.js';

export type DlcSignal = 'override' | 'hub_page' | 'sote_template' | 'title_suffix' | 'category';

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
const SOTE_TEMPLATE = /\{\{\s*SotE\b/gi;
const TITLE_SUFFIX = /\(Shadow of the Erdtree\)\s*$/i;

/**
 * `{{SotE}}` after a link or a line break tags the LINKED thing, not the page it sits on: the wiki
 * writes `[[Deflecting Hardtear]] {{SotE}}` inside base-game lists. Treating it as a page marker
 * labelled 167 base-game pages DLC, Flask of Crimson Tears and 33 Ash of War pages among them.
 */
const INLINE_MARKER = /(?:\]\]|<br\s*\/?>)\s*$/i;
/** First `==` heading; everything before it is the lead, where a page states what its subject is. */
const LEAD_END = /^[ \t]*==/m;
/**
 * A lead listing the products as coordinates — "in {{ER}} and {{SotE}}", "in {{ER}}, {{SotE}}, and
 * {{ERN}}" — says the subject is in BOTH, so it ships with the base game. A genuine DLC page names
 * one product: "in {{ER}}: {{SotE}}", "in {{ER}}, included in the {{SotE}} DLC", or "in {{SotE}}".
 */
const BOTH_GAMES = /\{\{\s*ER\s*\}\}(?:\s*,\s*|\s+and\s+)(?:and\s+)?(?:in\s+)?(?:the\s+)?\{\{\s*SotE\b/i;

interface SoteMentions {
  /** Any occurrence at all, inline markers included — what has_dlc_sections reports. */
  any: boolean;
  /** An occurrence that claims the page's own subject is DLC. */
  pageMarker: boolean;
}

/**
 * Separates "this page IS DLC" from "this page MENTIONS DLC". Three exclusions, each measured
 * against the shipped snapshot: inline link markers (167 pages), mentions below the lead — trivia
 * and notes such as "all bosses in {{SotE}} resist…" (40 pages) — and leads naming both products
 * (41 pages). None of them touches Verdigris Armor, Messmer, Rakshasa Armor or Scadu Altus.
 */
export function soteMentions(wikitext: string): SoteMentions {
  const leadEnd = LEAD_END.exec(wikitext)?.index ?? wikitext.length;
  const bothGames = BOTH_GAMES.test(wikitext.slice(0, leadEnd));
  const re = new RegExp(SOTE_TEMPLATE.source, 'gi');
  const result: SoteMentions = { any: false, pageMarker: false };
  for (let m = re.exec(wikitext); m; m = re.exec(wikitext)) {
    result.any = true;
    if (INLINE_MARKER.test(wikitext.slice(Math.max(0, m.index - 20), m.index))) continue;
    if (m.index >= leadEnd || bothGames) continue;
    result.pageMarker = true;
  }
  return result;
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
  const { any: mentionsDlc, pageMarker } = soteMentions(wikitext);
  const title = page.title.toLowerCase();

  const forcedDlc = lowerSet(ctx.overrides.dlc);
  const forcedBase = lowerSet(ctx.overrides.base);

  if (forcedDlc.has(title)) return { dlc: true, signals: ['override'], hasDlcSections: false };
  if (forcedBase.has(title)) return { dlc: false, signals: ['hub_page'], hasDlcSections: mentionsDlc };

  const signals: DlcSignal[] = [];
  if (pageMarker) signals.push('sote_template');
  if (TITLE_SUFFIX.test(page.title)) signals.push('title_suffix');
  if (ctx.dlcCategoryTitles.has(page.title)) signals.push('category');

  const dlc = signals.length > 0;
  // A base page may legitimately mention the DLC — an inline link marker, a trivia note. That is what
  // has_dlc_sections is for: caveat the answer, never withhold the text.
  return { dlc, signals, hasDlcSections: !dlc && mentionsDlc };
}

export const DLC_SIGNALS: DlcSignal[] = ['override', 'hub_page', 'sote_template', 'title_suffix', 'category'];

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
