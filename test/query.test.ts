import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFixtureDb } from './fixtures/build-fixture-db.js';
import { memoryDb } from './helpers.js';
import { replaceRedirects, upsertPage } from '../src/store/pages.js';
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

// On the real wiki, "Magma Wyrm Makar" redirects to Magma Wyrm#Bosses, and that heading holds only a
// <tabber> whose per-boss prose lives under deeper headings, so the fragment section itself is empty
// and dropped. The fragment must then fall back, not leave the answer with no text at all.
test('bossInfo falls back to the usual sections when the redirect fragment names no section', () => {
  const db = buildFixtureDb();
  replaceRedirects(db, 'fandom', [{ from: 'Magma Wyrm Makar', to: 'Red Wolf of Radagon', fragment: 'Bosses' }]);
  const result = bossInfo({ shipped: db, local: null }, 'Magma Wyrm Makar') as any;
  assert.equal(result.match, 'redirect');
  assert.equal(result.boss.hp, '2,204');
  assert.ok(result.sections.length > 0, 'expected a fallback section, got none');
  assert.deepEqual(result.sections.map((s: any) => s.heading), ['Overview']);
  assert.equal(result.fragment, 'Bosses');
  assert.equal(result.fragment_matched, false);
});

test('bossInfo reports a fragment that did match', () => {
  const result = bossInfo(dbs(), 'Magma Wyrm Makar') as any;
  assert.equal(result.fragment, 'Overview');
  assert.equal(result.fragment_matched, true);
});

// getPage had the same hole as bossInfo: on the ~371 tabber pages a redirect fragment can name a
// heading that now carries no text, which returned an OK-looking answer with no sections at all.
test('getPage falls back to the whole page when the redirect fragment names no section', () => {
  const db = buildFixtureDb();
  replaceRedirects(db, 'fandom', [{ from: 'Magma Wyrm Makar', to: 'Red Wolf of Radagon', fragment: 'Bosses' }]);
  const result = getPage({ shipped: db, local: null }, 'Magma Wyrm Makar') as any;
  assert.equal(result.match, 'redirect');
  assert.ok(result.sections.length > 0, 'expected the page sections, got none');
  assert.equal(result.fragment, 'Bosses');
  assert.equal(result.fragment_matched, false);
});

test('getPage still reports not_found for an explicitly requested section that does not exist', () => {
  const result = getPage(dbs(), "Azur's Glintstone Staff", 'Nonexistent Section') as any;
  assert.equal(result.not_found, true);
});

test('sourcesStatus reports sync and counts', () => {
  const status = sourcesStatus(dbs());
  assert.equal(status.shipped?.pages, 6);
  assert.equal(status.local, null);
});

const HINT = 'No page matched in the shipped data or local cache. Try search, or pass fetch: true to cache the Fextralife page.';

test('itemStats skips kinds whose table cannot express the filter', () => {
  const scaled = itemStats(dbs(), { scaling_stat: 'int', min_scaling: 'C' }) as any;
  assert.deepEqual(scaled.rows.map((r: any) => r.kind), ['weapon']);
  const byStrReq = itemStats(dbs(), { max_req: { str: 60 } }) as any;
  assert.deepEqual(byStrReq.rows.map((r: any) => r.kind), ['weapon']);
  const byIntReq = itemStats(dbs(), { max_req: { int: 60 } }) as any;
  assert.deepEqual(byIntReq.rows.map((r: any) => r.kind), ['weapon', 'spell']);
});

test('itemStats ignores stat keys and scaling stats outside the allow-list', () => {
  const injected = { int: 60, 'x_req, 0) OR 1=1 --': 1 } as unknown as Partial<Record<'int', number>>;
  const byName = itemStats(dbs(), { kind: 'weapon', max_req: injected }) as any;
  assert.deepEqual(byName.rows.map((r: any) => r.name), ["Azur's Glintstone Staff"]);
  const badStat = itemStats(dbs(), { kind: 'weapon', scaling_stat: 'hp' as any, min_scaling: 'C' }) as any;
  assert.deepEqual(badStat.rows.map((r: any) => r.name), ["Azur's Glintstone Staff"]);
});

test('itemStats ignores an out-of-range min_scaling instead of inverting it', () => {
  const rows = (itemStats(dbs(), { kind: 'weapon', scaling_stat: 'int', min_scaling: 'Z' }) as any).rows;
  assert.deepEqual(rows.map((r: any) => r.name), ["Azur's Glintstone Staff"]);
});

test('getPage returns not_found when the requested section matches nothing', () => {
  assert.deepEqual(getPage(dbs(), "Azur's Glintstone Staff", 'no such section'), { not_found: true, query: "Azur's Glintstone Staff", hint: HINT });
});

test('a strong local match beats a weak full-text hit in shipped data', () => {
  const local = memoryDb();
  upsertPage(local, { source: 'fextralife', title: 'Cuckoo', url: 'https://eldenring.wiki.fextralife.com/Cuckoo', revid: null, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext: null, markdown: '## Location\nLiurnia of the Lakes', license: 'All rights reserved (Fextralife). Local cache only; never redistributed.' });
  const shipped = buildFixtureDb();
  assert.equal(resolveName({ shipped, local: null }, 'Cuckoo')?.match, 'search');
  const resolved = resolveName({ shipped, local }, 'Cuckoo')!;
  assert.equal(resolved.match, 'exact');
  assert.equal(resolved.provenance.source, 'fextralife');
});
