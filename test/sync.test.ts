import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { upsertPage, storedRevids, deletePage } from '../src/store/pages.js';
import { syncFandom } from '../src/sync.js';
import type { RawPage } from '../src/types.js';
import { AZUR_STAFF, GRAVEN_SCHOOL } from './fixtures/wikitext.js';

const page = (title: string, revid: number, wikitext: string): RawPage => ({
  source: 'fandom', title, url: `https://eldenring.fandom.com/wiki/${title}`, revid, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext, markdown: null, license: 'CC BY-SA 3.0 (eldenring.fandom.com)',
});

function fakeFandom(wiki: Map<string, { revid: number; text: string }>) {
  const fetched: string[] = [];
  return {
    fetched,
    async *listRevisions() { for (const [title, p] of wiki) yield { title, revid: p.revid }; },
    async *listRedirects() { yield { from: 'Azur Staff', to: "Azur's Glintstone Staff", fragment: null }; },
    async fetchPages(titles: string[]) { fetched.push(...titles); return titles.map((t) => page(t, wiki.get(t)!.revid, wiki.get(t)!.text)); },
    listDlcCategoryTitles: async () => [],
  };
}

test('upsertPage writes sections and FTS, and re-upsert replaces them', () => {
  const db = memoryDb();
  const id = upsertPage(db, page("Azur's Glintstone Staff", 1, AZUR_STAFF));
  const headings = (db.prepare('SELECT heading FROM sections WHERE page_id=? ORDER BY ord').all(id) as { heading: string }[]).map((r) => r.heading);
  assert.deepEqual(headings, ['Summary', 'Acquisition']);
  upsertPage(db, page("Azur's Glintstone Staff", 2, AZUR_STAFF));
  assert.equal((db.prepare('SELECT count(*) AS n FROM sections').get() as { n: number }).n, 2);
  assert.equal((db.prepare('SELECT count(*) AS n FROM sections_fts').get() as { n: number }).n, 2);
  const hit = db.prepare("SELECT title FROM sections_fts WHERE sections_fts MATCH 'cuckoo'").get();
  assert.deepEqual(hit, { title: "Azur's Glintstone Staff" });
});

test('deletePage removes page, sections, fts and derived rows', () => {
  const db = memoryDb();
  const id = upsertPage(db, page('X', 1, GRAVEN_SCHOOL));
  db.prepare("INSERT INTO entities (page_id, type, name) VALUES (?, 'talisman', 'X')").run(id);
  deletePage(db, 'fandom', 'X');
  for (const table of ['pages', 'sections', 'sections_fts', 'entities']) {
    assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  }
});

test('sync fetches new and changed pages only, removes vanished, stores redirects', async () => {
  const db = memoryDb();
  const wiki = new Map([["Azur's Glintstone Staff", { revid: 1, text: AZUR_STAFF }], ['Graven-School Talisman', { revid: 5, text: GRAVEN_SCHOOL }]]);
  const first = fakeFandom(wiki);
  const r1 = await syncFandom(db, first);
  assert.equal(r1.added.length, 2);
  assert.equal(first.fetched.length, 2);

  const second = fakeFandom(wiki);
  const r2 = await syncFandom(db, second);
  assert.deepEqual([r2.added, r2.changed, r2.removed, r2.unchanged], [[], [], [], 2]);
  assert.equal(second.fetched.length, 0);

  wiki.set('Graven-School Talisman', { revid: 6, text: GRAVEN_SCHOOL });
  wiki.delete("Azur's Glintstone Staff");
  const third = fakeFandom(wiki);
  const r3 = await syncFandom(db, third);
  assert.deepEqual(r3.changed, ['Graven-School Talisman']);
  assert.deepEqual(r3.removed, ["Azur's Glintstone Staff"]);
  assert.deepEqual([...storedRevids(db, 'fandom')], [['Graven-School Talisman', 6]]);
  assert.deepEqual(db.prepare('SELECT from_title, to_title FROM redirects').all(), [{ from_title: 'Azur Staff', to_title: "Azur's Glintstone Staff" }]);
  assert.equal((db.prepare("SELECT pages FROM sync_state WHERE source='fandom'").get() as { pages: number }).pages, 1);
});

test('syncFandom stores dlc category titles', async () => {
  const db = memoryDb();
  const fandom = {
    listRevisions: async function* () { yield { title: 'Scadu Altus', revid: 1 }; },
    listRedirects: async function* () {},
    fetchPages: async (titles: string[]): Promise<RawPage[]> => titles.map((title) => ({
      source: 'fandom', title, url: `https://x/${title}`, revid: 1,
      fetchedAt: 'now', wikitext: 'A region.', markdown: null, license: 'CC BY-SA 3.0',
    })),
    listDlcCategoryTitles: async () => ['Scadu Altus'],
  };
  await syncFandom(db, fandom);
  const stored = db.prepare('SELECT title FROM dlc_categories').all() as { title: string }[];
  assert.deepEqual(stored, [{ title: 'Scadu Altus' }]);
});
