import { resolve } from 'node:path';
import type { Db } from '../db/open.js';
import { buildExtractor, buildLinks } from '../extract/build.js';
import { runExtractors } from '../extract/run.js';
import { fetchWith, fextralifeUrl } from '../sources/fextralife.js';
import { HttpError } from '../sources/http.js';
import { upsertPage } from './pages.js';

/** Index pages read for build titles. 'SOTE Builds' membership is the DLC signal for a build. */
export const BUILD_LISTS = ['Builds', 'SOTE Builds'] as const;

export interface IngestReport {
  listed: number;
  skipped: number;
  fetched: string[];
  empty: string[];
  /** Set when the run stopped early: a block or rate limit is a signal to stop, not to retry harder. */
  stopped?: string;
}

/**
 * The shipped snapshot lives under the repo's data/ and is redistributed; Fextralife pages must
 * never land there. Refuse any target db under that directory, whatever the env says.
 */
export function assertLocalTarget(dbPath: string, repoDataDir = resolve('data')): void {
  if (dbPath === ':memory:') return;
  if (resolve(dbPath).startsWith(repoDataDir + '/') || resolve(dbPath) === repoDataDir) {
    throw new Error(`Refusing to write Fextralife pages into ${dbPath}: that is the shipped snapshot directory. Builds go only into the local cache (ELDEN_RING_MCP_CACHE).`);
  }
}

const isCached = (db: Db, title: string): boolean =>
  db.prepare("SELECT 1 FROM pages p JOIN page_html h ON h.page_id = p.id WHERE p.source = 'fextralife' AND p.title = ?").get(title) !== undefined;

/**
 * One polite pass: read the index pages, then fetch each build not already cached, through the
 * caller's (slow) client. Resumable by construction, since a cached page is skipped. Stops at the
 * first 403/429 or non-article response rather than retrying around a block.
 */
export async function ingestBuilds(db: Db, getText: (url: string) => Promise<string>, opts: { limit?: number; log?: (line: string) => void; now?: () => Date } = {}): Promise<IngestReport> {
  const log = opts.log ?? (() => {});
  const titles: string[] = [];
  for (const list of BUILD_LISTS) {
    const listed = buildLinks(await getText(fextralifeUrl(list)));
    db.transaction(() => {
      db.prepare('DELETE FROM build_lists WHERE list = ?').run(list);
      const insert = db.prepare('INSERT OR IGNORE INTO build_lists (list, title) VALUES (?, ?)');
      for (const title of listed) insert.run(list, title);
    })();
    log(`${list}: ${listed.length} builds listed`);
    for (const title of listed) if (!titles.includes(title)) titles.push(title);
  }

  const report: IngestReport = { listed: titles.length, skipped: 0, fetched: [], empty: [] };
  for (const title of titles) {
    if (isCached(db, title)) { report.skipped++; continue; }
    if (opts.limit !== undefined && report.fetched.length + report.empty.length >= opts.limit) break;
    let page;
    try {
      page = await fetchWith(getText, title, opts.now);
    } catch (error) {
      if (error instanceof HttpError && (error.status === 403 || error.status === 429)) {
        report.stopped = `${error.message}: stopped so the site is not hit again. Re-run later; cached pages are skipped.`;
        log(report.stopped);
        return report;
      }
      throw error;
    }
    if (!page) {
      report.empty.push(title);
      log(`no article body: ${title}`);
      continue;
    }
    const id = upsertPage(db, page);
    runExtractors(db, { pageIds: [id], extractors: [buildExtractor] });
    report.fetched.push(title);
    log(`cached ${report.fetched.length}: ${title}`);
  }
  return report;
}

/** Re-parses every cached build page from its stored HTML. No network. */
export function reparseBuilds(db: Db) {
  const ids = (db.prepare("SELECT id FROM pages WHERE source = 'fextralife' AND title LIKE '% Build'").all() as { id: number }[]).map((r) => r.id);
  return runExtractors(db, { pageIds: ids, extractors: [buildExtractor] });
}
