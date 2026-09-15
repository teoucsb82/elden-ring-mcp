import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryDb } from './helpers.js';
import { DERIVED_TABLES, openDb } from '../src/db/open.js';

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
