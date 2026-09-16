import { DERIVED_TABLES, type Db } from '../db/open.js';
import type { RawPage, SourceId } from '../types.js';
import { wikitextToMarkdown } from '../wikitext/markdown.js';
import { splitSections } from '../wikitext/sections.js';

export const DEFAULT_DB_PATH = 'data/elden-ring.db';

function clearSections(db: Db, pageId: number): void {
  db.prepare('DELETE FROM sections_fts WHERE rowid IN (SELECT id FROM sections WHERE page_id = ?)').run(pageId);
  db.prepare('DELETE FROM sections WHERE page_id = ?').run(pageId);
}

export function clearDerived(db: Db, pageId: number): void {
  for (const table of DERIVED_TABLES) db.prepare(`DELETE FROM ${table} WHERE page_id = ?`).run(pageId);
}

export function upsertPage(db: Db, page: RawPage): number {
  const markdown = page.markdown ?? wikitextToMarkdown(page.wikitext ?? '');
  return db.transaction(() => {
    db.prepare(`
      INSERT INTO pages (source, title, url, revid, fetched_at, license, wikitext)
      VALUES (@source, @title, @url, @revid, @fetchedAt, @license, @wikitext)
      ON CONFLICT (source, title) DO UPDATE SET
        url = excluded.url, revid = excluded.revid, fetched_at = excluded.fetched_at,
        license = excluded.license, wikitext = excluded.wikitext
    `).run({ source: page.source, title: page.title, url: page.url, revid: page.revid, fetchedAt: page.fetchedAt, license: page.license, wikitext: page.wikitext });
    const { id } = db.prepare('SELECT id FROM pages WHERE source = ? AND title = ?').get(page.source, page.title) as { id: number };
    clearSections(db, id);
    const insertSection = db.prepare('INSERT INTO sections (page_id, ord, heading, markdown) VALUES (?, ?, ?, ?)');
    const insertFts = db.prepare('INSERT INTO sections_fts (rowid, title, heading, markdown) VALUES (?, ?, ?, ?)');
    for (const section of splitSections(markdown)) {
      const { lastInsertRowid } = insertSection.run(id, section.ord, section.heading, section.markdown);
      insertFts.run(lastInsertRowid, page.title, section.heading, section.markdown);
    }
    return id;
  })();
}

export function deletePage(db: Db, source: SourceId, title: string): void {
  const row = db.prepare('SELECT id FROM pages WHERE source = ? AND title = ?').get(source, title) as { id: number } | undefined;
  if (!row) return;
  db.transaction(() => {
    clearSections(db, row.id);
    clearDerived(db, row.id);
    db.prepare('DELETE FROM pages WHERE id = ?').run(row.id);
  })();
}

export function storedRevids(db: Db, source: SourceId): Map<string, number | null> {
  const rows = db.prepare('SELECT title, revid FROM pages WHERE source = ? ORDER BY title').all(source) as { title: string; revid: number | null }[];
  return new Map(rows.map((r) => [r.title, r.revid]));
}

export function replaceRedirects(db: Db, source: SourceId, rows: { from: string; to: string; fragment: string | null }[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM redirects WHERE source = ?').run(source);
    const insert = db.prepare('INSERT OR REPLACE INTO redirects (source, from_title, to_title, fragment) VALUES (?, ?, ?, ?)');
    for (const r of rows) insert.run(source, r.from, r.to, r.fragment);
  })();
}

/** Replaces the DLC category membership captured from the wiki. */
export function replaceDlcCategories(db: Db, titles: string[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM dlc_categories').run();
    const insert = db.prepare('INSERT OR IGNORE INTO dlc_categories (title) VALUES (?)');
    for (const title of titles) insert.run(title);
  })();
}

export function recordSync(db: Db, source: SourceId, pages: number, at = new Date()): void {
  db.prepare('INSERT INTO sync_state (source, last_run, pages) VALUES (?, ?, ?) ON CONFLICT (source) DO UPDATE SET last_run = excluded.last_run, pages = excluded.pages')
    .run(source, at.toISOString(), pages);
}
