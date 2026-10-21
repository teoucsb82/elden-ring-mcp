import { parse } from 'node-html-parser';
import TurndownService from 'turndown';
import type { RawPage } from '../types.js';
import { USER_AGENT } from './fandom.js';
import { createHttp, HttpError, type FetchLike } from './http.js';

export const FEXTRALIFE_LICENSE = 'All rights reserved (Fextralife). Local cache only; never redistributed.';

/** MediaWiki form (2026-10): spaces become `_`. The old `+` form now lands on a different page or a 404. */
export const fextralifeUrl = (title: string) =>
  `https://eldenring.wiki.fextralife.com/${title.trim().split(/\s+/).map(encodeURIComponent).join('_')}`;

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });

/**
 * The article body. Fextralife moved to MediaWiki in 2026: the body is `#mw-content-text`, and the old
 * `#wiki-content-block` is gone, which made every fetch return null. The old id stays as a fallback.
 */
export function contentBlock(html: string) {
  const root = parse(html);
  const block = root.querySelector('#mw-content-text .mw-parser-output') ?? root.querySelector('#mw-content-text') ?? root.querySelector('#wiki-content-block');
  if (!block) return null;
  for (const junk of block.querySelectorAll('script, style, iframe, noscript, .hpwidget')) junk.remove();
  // "Related … Builds" and everything after it is a wall of links to other pages, not this page's content.
  const related = block.querySelectorAll('h2').find((h) => /^\s*related\b/i.test(h.text));
  if (related?.parentNode) {
    const siblings = related.parentNode.childNodes;
    for (const node of siblings.slice(siblings.indexOf(related))) node.remove();
  }
  return block;
}

export function htmlToWikiMarkdown(html: string): string | null {
  const block = contentBlock(html);
  if (!block) return null;
  return turndown.turndown(block.innerHTML).replace(/\n{3,}/g, '\n\n').trim();
}

/** Fextralife pages are cached one at a time on explicit request; this is what stops a walk of the site. */
export const FEXTRALIFE_PAGE_LIMIT = 20;

interface ClientOptions { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; minIntervalMs?: number }
export type FextralifeOptions = ClientOptions & { now?: () => Date };

// One client for the whole process: a client built per call resets its own rate limit every call,
// so N consecutive fetches would leave at once. Built lazily so tests can install their own first.
let shared: ((url: string) => Promise<string>) | null = null;
let pagesFetched = 0;

/** Test seam: install a stub client (and clear the per-process page count). No production caller. */
export function resetFextralifeSession(opts: ClientOptions = {}): void {
  shared = Object.keys(opts).length ? createHttp({ userAgent: USER_AGENT, ...opts }) : null;
  pagesFetched = 0;
}

function client(opts: ClientOptions): (url: string) => Promise<string> {
  // A caller-supplied fetch is a test double, so give it its own client rather than poisoning the shared one.
  if (opts.fetchImpl) return createHttp({ userAgent: USER_AGENT, fetchImpl: opts.fetchImpl, sleep: opts.sleep, minIntervalMs: opts.minIntervalMs });
  shared ??= createHttp({ userAgent: USER_AGENT });
  return shared;
}

export async function fetchFextralife(title: string, opts: FextralifeOptions = {}): Promise<RawPage | null> {
  if (pagesFetched >= FEXTRALIFE_PAGE_LIMIT) {
    throw new Error(`Fextralife page limit reached: ${FEXTRALIFE_PAGE_LIMIT} pages already fetched by this server process. Fextralife pages are cached one at a time on explicit request, never crawled in bulk. Restart the server if more are genuinely needed.`);
  }
  pagesFetched++;
  return fetchWith(client(opts), title, opts.now);
}

/**
 * One page through a caller-owned client, with no per-process cap. Only scripts/fetch-builds.ts
 * calls this, with its own slower client; the server goes through fetchFextralife and its cap.
 */
export async function fetchWith(getText: (url: string) => Promise<string>, title: string, now: () => Date = () => new Date()): Promise<RawPage | null> {
  const url = fextralifeUrl(title);
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
    source: 'fextralife', title, url, revid: null, fetchedAt: now().toISOString(),
    wikitext: null, markdown, html, license: FEXTRALIFE_LICENSE,
  };
}
