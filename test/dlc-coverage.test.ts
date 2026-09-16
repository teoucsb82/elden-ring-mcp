import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { openDb } from '../src/db/open.js';

const DB_PATH = 'data/elden-ring.db';
const hasDb = existsSync(DB_PATH);

test('the shipped db classifies a plausible share of pages as dlc', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  const dlc = (db.prepare('SELECT count(*) AS n FROM pages WHERE dlc = 1').get() as { n: number }).n;
  const total = (db.prepare('SELECT count(*) AS n FROM pages').get() as { n: number }).n;
  assert.ok(dlc >= 800, `expected at least 800 dlc pages, got ${dlc} of ${total}`);
  assert.ok(dlc < total / 2, `dlc share implausible: ${dlc} of ${total}`);
  db.close();
});

test('known hub pages are never classified as dlc', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  const hubs = ['Weapons', 'Armor Sets', 'Talismans', 'Bosses'];
  for (const title of hubs) {
    const row = db.prepare('SELECT dlc FROM pages WHERE title = ?').get(title) as { dlc: number } | undefined;
    if (row) assert.equal(row.dlc, 0, `${title} must stay base game`);
  }
  db.close();
});

test('known dlc pages are classified as dlc', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  for (const title of ['Verdigris Armor', 'Messmer the Impaler', 'Scadu Altus', 'Rellana, Twin Moon Knight']) {
    const row = db.prepare('SELECT dlc FROM pages WHERE title = ?').get(title) as { dlc: number } | undefined;
    assert.ok(row, `${title} must exist in the snapshot`);
    assert.equal(row.dlc, 1, `${title} must be classified as dlc`);
  }
  db.close();
});

test('known base pages are not classified as dlc', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  for (const title of ['Icerind Hatchet', 'Godrick the Grafted', 'Stormveil Castle']) {
    const row = db.prepare('SELECT dlc FROM pages WHERE title = ?').get(title) as { dlc: number } | undefined;
    assert.ok(row, `${title} must exist in the snapshot`);
    assert.equal(row.dlc, 0, `${title} must stay base game`);
  }
  db.close();
});
