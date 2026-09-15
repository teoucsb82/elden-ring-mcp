import type { RawPage } from '../types.js';
import { createHttp, type FetchLike } from './http.js';

export const USER_AGENT = 'elden-ring-mcp/0.1 (open-source MCP data sync)';
export const FANDOM_API = 'https://eldenring.fandom.com/api.php';
export const FANDOM_LICENSE = 'CC BY-SA 3.0 (eldenring.fandom.com)';

export const fandomUrl = (title: string) => `https://eldenring.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

export interface FandomOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  now?: () => Date;
}

// MediaWiki JSON is loosely typed; only the fields read below are relied on.
type Json = any;

export function createFandom(opts: FandomOptions = {}) {
  const getText = createHttp({ userAgent: USER_AGENT, fetchImpl: opts.fetchImpl, sleep: opts.sleep, minIntervalMs: opts.minIntervalMs });
  const now = opts.now ?? (() => new Date());

  async function api(params: Record<string, string>): Promise<Json> {
    const query = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
    const json = JSON.parse(await getText(`${FANDOM_API}?${query}`));
    if (json.error) throw new Error(`MediaWiki ${json.error.code}: ${json.error.info}`);
    return json;
  }

  async function* paged(params: Record<string, string>): AsyncGenerator<Json> {
    let cont: Record<string, string> = {};
    for (;;) {
      const json = await api({ ...params, ...cont });
      yield json;
      if (!json.continue) return;
      cont = json.continue;
    }
  }

  return {
    async *listRevisions(): AsyncGenerator<{ title: string; revid: number }> {
      for await (const json of paged({ action: 'query', generator: 'allpages', gapnamespace: '0', gaplimit: '500', gapfilterredir: 'nonredirects', prop: 'info' })) {
        for (const page of json.query?.pages ?? []) yield { title: page.title, revid: page.lastrevid };
      }
    },

    async *listRedirects(): AsyncGenerator<{ from: string; to: string; fragment: string | null }> {
      for await (const json of paged({ action: 'query', generator: 'allpages', gapnamespace: '0', gaplimit: '50', gapfilterredir: 'redirects', redirects: '1' })) {
        for (const r of json.query?.redirects ?? []) yield { from: r.from, to: r.to, fragment: r.tofragment ?? null };
      }
    },

    async fetchPages(titles: string[]): Promise<RawPage[]> {
      const pages: RawPage[] = [];
      for (let i = 0; i < titles.length; i += 50) {
        const json = await api({ action: 'query', prop: 'revisions', rvprop: 'ids|content', rvslots: 'main', titles: titles.slice(i, i + 50).join('|') });
        for (const page of json.query?.pages ?? []) {
          if (page.missing || !page.revisions?.length) continue;
          const revision = page.revisions[0];
          pages.push({
            source: 'fandom', title: page.title, url: fandomUrl(page.title), revid: revision.revid,
            fetchedAt: now().toISOString(), wikitext: revision.slots.main.content, markdown: null, license: FANDOM_LICENSE,
          });
        }
      }
      return pages;
    },
  };
}

export type Fandom = ReturnType<typeof createFandom>;
