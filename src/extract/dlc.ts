import { readFileSync } from 'node:fs';
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

const DEFAULT_OVERRIDES_PATH = new URL('../../data/dlc-overrides.json', import.meta.url).pathname;

/** Missing or malformed overrides must not take a sync down; an empty list is the safe default. */
export function loadOverrides(path: string = DEFAULT_OVERRIDES_PATH): Overrides {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { dlc: [], base: [] };
    const raw = parsed as Record<string, unknown>;
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
    return { dlc: list(raw.dlc), base: list(raw.base) };
  } catch {
    return { dlc: [], base: [] };
  }
}

const lowerSet = (titles: string[]): Set<string> => new Set(titles.map((t) => t.toLowerCase()));

/** The wiki's own DLC marker template, e.g. "added in the {{SotE}} expansion". */
const SOTE_TEMPLATE = /\{\{\s*SotE\b/i;
const TITLE_SUFFIX = /\(Shadow of the Erdtree\)\s*$/i;

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
  const mentionsDlc = SOTE_TEMPLATE.test(wikitext);
  const title = page.title.toLowerCase();

  const forcedDlc = lowerSet(ctx.overrides.dlc);
  const forcedBase = lowerSet(ctx.overrides.base);

  if (forcedDlc.has(title)) return { dlc: true, signals: ['override'], hasDlcSections: false };
  if (forcedBase.has(title)) return { dlc: false, signals: ['hub_page'], hasDlcSections: mentionsDlc };

  const signals: DlcSignal[] = [];
  if (mentionsDlc) signals.push('sote_template');
  if (TITLE_SUFFIX.test(page.title)) signals.push('title_suffix');
  if (ctx.dlcCategoryTitles.has(page.title)) signals.push('category');

  return { dlc: signals.length > 0, signals, hasDlcSections: false };
}
