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
  const url = fextralifeUrl(title);
  const getText = client(opts);
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
