import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFixtureDb } from './fixtures/build-fixture-db.js';
import { memoryDb } from './helpers.js';
import { upsertPage } from '../src/store/pages.js';
import { resolveName } from '../src/query/resolve.js';
import { bossInfo, getPage, itemStats, questSteps, search, sourcesStatus, whereIs } from '../src/query/lookups.js';
import type { Dbs } from '../src/query/dbs.js';

const dbs = (): Dbs => ({ shipped: buildFixtureDb(), local: null });

test('resolveName: exact (case-insensitive), redirect with fragment, entity, search', () => {
  const d = dbs();
  assert.equal(resolveName(d, "azur's glintstone staff")?.match, 'exact');
  const makar = resolveName(d, 'Magma Wyrm Makar')!;
  assert.deepEqual([makar.match, makar.provenance.title, makar.fragment], ['redirect', 'Red Wolf of Radagon', 'Overview']);
  assert.equal(resolveName(d, 'cuckoo church staff')?.match, 'search');
  assert.equal(resolveName(d, 'zzqx nonsense'), null);
});

test('resolveName falls back to the local cache db', () => {
  const local = memoryDb();
  upsertPage(local, { source: 'fextralife', title: 'Lusat', url: 'https://eldenring.wiki.fextralife.com/Lusat', revid: null, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext: null, markdown: '## Location\nSellia Hideaway', license: 'All rights reserved (Fextralife). Local cache only; never redistributed.' });
  const resolved = resolveName({ shipped: buildFixtureDb(), local }, 'Lusat')!;
  assert.equal(resolved.provenance.source, 'fextralife');
});

test('search returns snippets with provenance', () => {
  const { results } = search(dbs(), 'damage sorceries');
  assert.equal(results[0].title, 'Graven-School Talisman');
  assert.equal(results[0].provenance.license, 'CC BY-SA 3.0 (eldenring.fandom.com)');
  assert.ok(results[0].snippet.length > 0);
  assert.doesNotThrow(() => search(dbs(), 'weird "quote AND ( syntax'));
});

test('getPage whole and single section; not_found on miss', () => {
  const page = getPage(dbs(), "Azur's Glintstone Staff", 'acq') as any;
  assert.deepEqual(page.sections.map((s: any) => s.heading), ['Acquisition']);
  assert.equal(page.provenance.revid, 100);
  assert.deepEqual(getPage(dbs(), 'zzqx nonsense'), { not_found: true, query: 'zzqx nonsense', hint: 'No page matched in the shipped data or local cache. Try search, or pass fetch: true to cache the Fextralife page.' });
});

test('whereIs returns parsed acquisition', () => {
  const result = whereIs(dbs(), "Azur's Glintstone Staff") as any;
  assert.equal(result.acquisition.nearest_grace, 'Debate Parlor');
  assert.deepEqual(result.acquisition.prereqs, []);
  assert.equal(result.acquisition.missable, false);
});

test('questSteps returns ordered steps and warnings from Notes', () => {
  const result = questSteps(dbs(), 'Sellen') as any;
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[0].location, 'Waypoint Ruins');
  assert.deepEqual(result.warnings, ['- Killing Preceptor Seluvis early locks you out of the puppet step.']);
});

test('itemStats by name and by filter', () => {
  const byName = itemStats(dbs(), { name: "Azur's Glintstone Staff" }) as any;
  assert.equal(byName.rows[0].int_req, 52);
  assert.equal(byName.rows[0].kind, 'weapon');
  const filtered = itemStats(dbs(), { kind: 'weapon', scaling_stat: 'int', min_scaling: 'C', max_req: { int: 60 } }) as any;
  assert.equal(filtered.rows.length, 1);
  assert.equal((itemStats(dbs(), { kind: 'weapon', scaling_stat: 'int', min_scaling: 'A' }) as any).rows.length, 0);
});

test('bossInfo via redirect returns boss row and fragment section', () => {
  const result = bossInfo(dbs(), 'Magma Wyrm Makar') as any;
  assert.equal(result.boss.hp, '2,204');
  assert.deepEqual(result.sections.map((s: any) => s.heading), ['Overview']);
});

test('sourcesStatus reports sync and counts', () => {
  const status = sourcesStatus(dbs());
  assert.equal(status.shipped?.pages, 6);
  assert.equal(status.local, null);
});
