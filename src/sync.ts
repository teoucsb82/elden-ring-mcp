import type { Db } from './db/open.js';
import type { Fandom } from './sources/fandom.js';
import { deletePage, recordSync, replaceDlcCategories, replaceRedirects, storedRevids, upsertPage } from './store/pages.js';

export interface SyncReport {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: number;
}

/** Brings the db in line with Fandom: fetches only new/changed revisions, drops deleted pages, refreshes redirects. */
export async function syncFandom(
  db: Db,
  fandom: Pick<Fandom, 'listRevisions' | 'listRedirects' | 'fetchPages' | 'listDlcCategoryTitles'>,
  log: (message: string) => void = () => {},
): Promise<SyncReport> {
  const stored = storedRevids(db, 'fandom');
  const seen = new Set<string>();
  const added: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;

  for await (const { title, revid } of fandom.listRevisions()) {
    seen.add(title);
    const previous = stored.get(title);
    if (previous === undefined) added.push(title);
    else if (previous !== revid) changed.push(title);
    else unchanged++;
  }
  log(`revisions: ${added.length} new, ${changed.length} changed, ${unchanged} unchanged`);

  const toFetch = [...added, ...changed];
  for (let i = 0; i < toFetch.length; i += 50) {
    const pages = await fandom.fetchPages(toFetch.slice(i, i + 50));
    db.transaction(() => { for (const page of pages) upsertPage(db, page); })();
    log(`fetched ${Math.min(i + 50, toFetch.length)}/${toFetch.length}`);
  }

  const removed = [...stored.keys()].filter((title) => !seen.has(title));
  for (const title of removed) deletePage(db, 'fandom', title);

  const redirects: { from: string; to: string; fragment: string | null }[] = [];
  for await (const redirect of fandom.listRedirects()) redirects.push(redirect);
  replaceRedirects(db, 'fandom', redirects);
  log(`redirects: ${redirects.length}`);

  const dlcTitles = await fandom.listDlcCategoryTitles();
  replaceDlcCategories(db, dlcTitles);
  log(`dlc category titles: ${dlcTitles.length}`);

  recordSync(db, 'fandom', seen.size);
  return { added, changed, removed, unchanged };
}
