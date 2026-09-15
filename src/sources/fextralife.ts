import { parse } from 'node-html-parser';
import TurndownService from 'turndown';
import type { RawPage } from '../types.js';
import { USER_AGENT } from './fandom.js';
import { createHttp, HttpError, type FetchLike } from './http.js';

export const FEXTRALIFE_LICENSE = 'All rights reserved (Fextralife). Local cache only; never redistributed.';

export const fextralifeUrl = (title: string) =>
  `https://eldenring.wiki.fextralife.com/${title.trim().split(/\s+/).map(encodeURIComponent).join('+')}`;

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });

export function htmlToWikiMarkdown(html: string): string | null {
  const block = parse(html).querySelector('#wiki-content-block');
  if (!block) return null;
  for (const junk of block.querySelectorAll('script, style, iframe, noscript')) junk.remove();
  return turndown.turndown(block.innerHTML).replace(/\n{3,}/g, '\n\n').trim();
}

export async function fetchFextralife(
  title: string,
  opts: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; minIntervalMs?: number; now?: () => Date } = {},
): Promise<RawPage | null> {
  const url = fextralifeUrl(title);
  const getText = createHttp({ userAgent: USER_AGENT, fetchImpl: opts.fetchImpl, sleep: opts.sleep, minIntervalMs: opts.minIntervalMs });
  let html: string;
  try {
    html = await getText(url);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
  const markdown = htmlToWikiMarkdown(html);
  if (!markdown) return null;
  return {
    source: 'fextralife', title, url, revid: null, fetchedAt: (opts.now ?? (() => new Date()))().toISOString(),
    wikitext: null, markdown, license: FEXTRALIFE_LICENSE,
  };
}
