import type { Db } from '../db/open.js';

export interface PageRow {
  id: number;
  source: string;
  title: string;
  wikitext: string | null;
}

export interface Extractor {
  name: string;
  matches(page: PageRow): boolean;
  /** Writes this extractor's rows for the page; prior derived rows are already cleared. Throws on unparseable input. */
  write(db: Db, page: PageRow): void;
}
