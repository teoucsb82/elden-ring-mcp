import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryDb } from './helpers.js';
import { DERIVED_TABLES, openDb } from '../src/db/open.js';
import { rerenderSections, upsertPage } from '../src/store/pages.js';

test('schema creates all tables', () => {
  const db = memoryDb();
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as { name: string }[]).map((r) => r.name);
  for (const t of ['pages', 'sections', 'sections_fts', 'redirects', 'sync_state', ...DERIVED_TABLES]) assert.ok(names.includes(t), t);
});

test('fts5 matches stemmed words', () => {
  const db = memoryDb();
  db.prepare('INSERT INTO sections_fts (rowid, title, heading, markdown) VALUES (1, ?, ?, ?)').run('Terra Magica', 'Summary', 'Raises magic damage while standing in the sigil');
  const hit = db.prepare("SELECT rowid FROM sections_fts WHERE sections_fts MATCH 'raise'").get();
  assert.deepEqual(hit, { rowid: 1 });
});

test('openDb twice on the same file does not throw', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'erdb-')), 'x.db');
  openDb(path).close();
  assert.doesNotThrow(() => openDb(path).close());
});

test('pages carries dlc columns', () => {
  const db = memoryDb();
  const cols = (db.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('dlc'));
  assert.ok(cols.includes('dlc_signals'));
  assert.ok(cols.includes('has_dlc_sections'));
});

test('dlc columns default to not-dlc', () => {
  const db = memoryDb();
  db.prepare("INSERT INTO pages (source, title, url, fetched_at, license) VALUES ('fandom','X','u','now','l')").run();
  const row = db.prepare('SELECT dlc, has_dlc_sections, dlc_signals FROM pages WHERE title = ?').get('X') as
    { dlc: number; has_dlc_sections: number; dlc_signals: string | null };
  assert.equal(row.dlc, 0);
  assert.equal(row.has_dlc_sections, 0);
  assert.equal(row.dlc_signals, null);
});

test('a pre-dlc database gains the columns on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-migrate-'));
  const path = join(dir, 'old.db');
  const old = new Database(path);
  old.exec(`CREATE TABLE pages (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
    revid INTEGER, fetched_at TEXT NOT NULL, license TEXT NOT NULL, patch TEXT, wikitext TEXT,
    UNIQUE (source, title));`);
  old.prepare("INSERT INTO pages (source, title, url, fetched_at, license) VALUES ('fandom','Old','u','now','l')").run();
  old.close();

  const db = openDb(path);
  const cols = (db.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('dlc'));
  assert.equal((db.prepare('SELECT dlc FROM pages WHERE title = ?').get('Old') as { dlc: number }).dlc, 0);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Sections are only built at upsert time, so a renderer fix never reaches an existing snapshot.
// `npm run extract` re-renders them from the stored wikitext before the extractors read them.
test('rerenderSections rebuilds sections from stored wikitext', () => {
  const db = memoryDb();
  const id = upsertPage(db, { source: 'fandom', title: 'Arrow', url: 'u', revid: 1, fetchedAt: 'now', wikitext: "'''{{PAGENAME}}''' is an arrow in {{ER}}.", markdown: null, license: 'l' });
  db.prepare("UPDATE sections SET markdown = 'stale' WHERE page_id = ?").run(id);
  assert.equal(rerenderSections(db), 1);
  const row = db.prepare('SELECT markdown FROM sections WHERE page_id = ? ORDER BY ord').get(id) as { markdown: string };
  assert.equal(row.markdown, '**Arrow** is an arrow in Elden Ring.');
  assert.equal((db.prepare("SELECT count(*) AS n FROM sections_fts WHERE sections_fts MATCH 'stale'").get() as { n: number }).n, 0);
});
