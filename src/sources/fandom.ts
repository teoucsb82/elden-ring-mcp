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
    let lastContKey: string | null = null;
    for (;;) {
      const json = await api({ ...params, ...cont });
      yield json;
      if (!json.continue) return;
      const nextContKey = JSON.stringify(json.continue);
      if (nextContKey === lastContKey) throw new Error('MediaWiki pagination stalled: repeated continuation token');
      lastContKey = nextContKey;
      cont = json.continue;
    }
  }

  return {
    async *listRevisions(): AsyncGenerator<{ title: string; revid: number }> {
      for await (const json of paged({ action: 'query', generator: 'allpages', gapnamespace: '0', gaplimit: '500', gapfilterredir: 'nonredirects', prop: 'info' })) {
        for (const page of json.query?.pages ?? []) yield { title: page.title, revid: page.lastrevid };
      }
    },

    /**
     * Two passes: allpages enumerates the redirect titles, then `titles=…&redirects=1` resolves each
     * batch to its target and fragment. The live API rejects `redirects` on an allpages generator
     * ("Use gapfilterredir=nonredirects instead"), so the two calls cannot be collapsed into one.
     */
    async *listRedirects(): AsyncGenerator<{ from: string; to: string; fragment: string | null }> {
      const titles: string[] = [];
      for await (const json of paged({ action: 'query', generator: 'allpages', gapnamespace: '0', gaplimit: '500', gapfilterredir: 'redirects', prop: 'info' })) {
        for (const page of json.query?.pages ?? []) titles.push(page.title);
      }
      for (let i = 0; i < titles.length; i += 50) {
        const json = await api({ action: 'query', redirects: '1', titles: titles.slice(i, i + 50).join('|') });
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

    /**
     * Breadth-first over Category:Shadow of the Erdtree and its subcategories. Fandom's category graph
     * contains cycles (a subcategory lists its parent), so visited titles are tracked. Bounded: ~27
     * top-level members and three subcategories, not a second full sync.
     */
    async listDlcCategoryTitles(): Promise<string[]> {
      const ROOT = 'Category:Shadow of the Erdtree';
      const seen = new Set<string>([ROOT]);
      const queue = [ROOT];
      const titles: string[] = [];

      while (queue.length) {
        const category = queue.shift() as string;
        for await (const json of paged({ action: 'query', list: 'categorymembers', cmtitle: category, cmlimit: '500' })) {
          for (const member of json.query?.categorymembers ?? []) {
            if (member.ns === 14) {
              if (!seen.has(member.title)) { seen.add(member.title); queue.push(member.title); }
            } else if (member.ns === 0) {
              titles.push(member.title);
            }
          }
        }
      }
      return [...new Set(titles)];
    },
  };
}

export type Fandom = ReturnType<typeof createFandom>;
