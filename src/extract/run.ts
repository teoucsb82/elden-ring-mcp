import type { Db } from '../db/open.js';
import { clearDerived } from '../store/pages.js';
import { EXTRACTORS } from './registry.js';
import type { Extractor, PageRow } from './types.js';

export interface ExtractReport {
  pages: number;
  rows: Record<string, number>;
  failures: { title: string; extractor: string; error: string }[];
}

export function runExtractors(db: Db, opts: { pageIds?: number[]; extractors?: Extractor[]; now?: () => Date } = {}): ExtractReport {
  const extractors = opts.extractors ?? EXTRACTORS;
  const now = opts.now ?? (() => new Date());
  const pages = opts.pageIds
    ? opts.pageIds.map((id) => db.prepare('SELECT id, source, title, wikitext FROM pages WHERE id = ?').get(id) as PageRow | undefined).filter((p): p is PageRow => !!p)
    : (db.prepare('SELECT id, source, title, wikitext FROM pages ORDER BY id').all() as PageRow[]);
  const report: ExtractReport = { pages: pages.length, rows: {}, failures: [] };
  const logFailure = db.prepare('INSERT INTO extract_failures (page_id, extractor, error, at) VALUES (?, ?, ?, ?)');

  for (const page of pages) {
    db.transaction(() => {
      clearDerived(db, page.id);
      for (const extractor of extractors) {
        try {
          if (!extractor.matches(page)) continue;
          db.transaction(() => extractor.write(db, page))();
          report.rows[extractor.name] = (report.rows[extractor.name] ?? 0) + 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logFailure.run(page.id, extractor.name, message, now().toISOString());
          report.failures.push({ title: page.title, extractor: extractor.name, error: message });
        }
      }
    })();
  }
  return report;
}
