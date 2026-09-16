import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureDb } from './fixtures/build-fixture-db.js';
import { memoryDb } from './helpers.js';
import { replaceRedirects, upsertPage } from '../src/store/pages.js';
import { isDlcFiltered, resolveName } from '../src/query/resolve.js';
import { bossInfo, getPage, itemStats, questSteps, search, sourcesStatus, whereIs } from '../src/query/lookups.js';
import { dlcPredicate, openDbs, STALE_DETAIL } from '../src/query/dbs.js';
import type { Dbs } from '../src/query/dbs.js';

const dbs = (): Dbs => ({ shipped: buildFixtureDb(), local: null });

/**
 * resolveName can now answer with the dlc-filtered shape, which carries no `match` or `fragment`.
 * Every fixture these pre-dlc tests use is base game, so narrowing here keeps their assertions as
 * they were rather than restating the resolver's contract in each one.
 */
const resolveBase = (d: Dbs, name: string) => {
  const r = resolveName(d, name);
  return isDlcFiltered(r) ? null : r;
};

type Fixture = {
  title: string; wikitext: string; dlc: number; hasDlcSections?: number;
  /** An extracted weapon row for this page. itemStats' filterless branch reads the item tables, not pages. */
  weapon?: { name: string; strReq?: number };
};

/** A dlc-aware fixture db: one page per entry, with its single section indexed for search. */
function fixtureDbs(fixtures: Fixture[]): Dbs {
  const db = memoryDb();
  const insertPage = db.prepare(
    'INSERT INTO pages (source, title, url, revid, fetched_at, license, wikitext, dlc, has_dlc_sections) VALUES (?,?,?,?,?,?,?,?,?)');
  const insertSection = db.prepare('INSERT INTO sections (page_id, ord, heading, markdown) VALUES (?,?,?,?)');
  const insertFts = db.prepare('INSERT INTO sections_fts (rowid, title, heading, markdown) VALUES (?,?,?,?)');
  const insertWeapon = db.prepare('INSERT INTO weapons (page_id, name, str_req) VALUES (?,?,?)');
  for (const f of fixtures) {
    const { lastInsertRowid } = insertPage.run(
      'fandom', f.title, `https://x/${f.title}`, 1, '2026-09-15', 'CC BY-SA 3.0', f.wikitext, f.dlc, f.hasDlcSections ?? 0);
    const pageId = Number(lastInsertRowid);
    const section = insertSection.run(pageId, 0, 'Acquisition', f.wikitext);
    insertFts.run(Number(section.lastInsertRowid), f.title, 'Acquisition', f.wikitext);
    if (f.weapon) insertWeapon.run(pageId, f.weapon.name, f.weapon.strReq ?? null);
  }
  return { shipped: db, local: null };
}

test('resolveName: exact (case-insensitive), redirect with fragment, entity, search', () => {
  const d = dbs();
  assert.equal(resolveBase(d, "azur's glintstone staff")?.match, 'exact');
  const makar = resolveBase(d, 'Magma Wyrm Makar')!;
  assert.deepEqual([makar.match, makar.provenance.title, makar.fragment], ['redirect', 'Red Wolf of Radagon', 'Overview']);
  assert.equal(resolveBase(d, 'cuckoo church staff')?.match, 'search');
  assert.equal(resolveBase(d, 'zzqx nonsense'), null);
});

test('resolveName falls back to the local cache db', () => {
  const local = memoryDb();
  upsertPage(local, { source: 'fextralife', title: 'Lusat', url: 'https://eldenring.wiki.fextralife.com/Lusat', revid: null, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext: null, markdown: '## Location\nSellia Hideaway', license: 'All rights reserved (Fextralife). Local cache only; never redistributed.' });
  const resolved = resolveBase({ shipped: buildFixtureDb(), local }, 'Lusat')!;
  assert.equal(resolved.provenance.source, 'fextralife');
});

test('search returns snippets with provenance', () => {
  const { results } = search(dbs(), 'damage sorceries') as { results: any[] };
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

// The default call: no section argument and no redirect fragment. This is the common path and it is
// what a shared fragment helper is most likely to break, so pin it explicitly.
test('getPage with no section and no fragment returns the whole page', () => {
  const page = getPage(dbs(), "Azur's Glintstone Staff") as any;
  assert.equal(page.not_found, undefined);
  assert.equal(page.match, 'exact');
  assert.ok(page.sections.length > 0, 'expected the whole page, got no sections');
  assert.equal(page.sections[0].heading, 'Summary', 'the lead section should come first');
  assert.deepEqual(page.sections.map((s: any) => s.heading), ['Summary', 'Acquisition']);
  // No fragment was involved, so the fragment fields have nothing to report.
  assert.equal(page.fragment, undefined);
  assert.equal(page.fragment_matched, undefined);
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
  // Three weapons are in the fixture; a filter that returns all of them is a no-op, so name them.
  const filtered = itemStats(dbs(), { kind: 'weapon', scaling_stat: 'int', min_scaling: 'C', max_req: { int: 60 } }) as any;
  assert.deepEqual(filtered.rows.map((r: any) => r.name), ["Azur's Glintstone Staff"]);
  assert.equal((itemStats(dbs(), { kind: 'weapon', scaling_stat: 'int', min_scaling: 'A' }) as any).not_found, true);
});

// Celebrant's Skull and Unarmed have no parsed requirements in the real build. coalesce(str_req, 0)
// made them answer "usable at 0 STR", which is a confidently wrong build-planning answer.
test('max_req excludes items whose requirement is unknown instead of treating it as zero', () => {
  const atZero = itemStats(dbs(), { kind: 'weapon', max_req: { str: 0 } }) as any;
  assert.equal(atZero.not_found, true, 'no fixture weapon has a known 0 STR requirement');
  const atEleven = itemStats(dbs(), { kind: 'weapon', max_req: { str: 11 } }) as any;
  assert.deepEqual(atEleven.rows.map((r: any) => r.name), ["Azur's Glintstone Staff", 'Uchigatana']);
  const atTen = itemStats(dbs(), { kind: 'weapon', max_req: { str: 10 } }) as any;
  assert.deepEqual(atTen.rows.map((r: any) => r.name), ["Azur's Glintstone Staff"]);
});

test('itemStats rejects a name whose item is not the requested kind', () => {
  const mismatch = itemStats(dbs(), { name: 'Comet Azur', kind: 'weapon' }) as any;
  assert.equal(mismatch.error, 'kind_mismatch');
  assert.match(mismatch.detail, /Comet Azur/);
  assert.match(mismatch.detail, /spell/);
  const agreeing = itemStats(dbs(), { name: 'Comet Azur', kind: 'spell' }) as any;
  assert.deepEqual(agreeing.rows.map((r: any) => r.kind), ['spell']);
});

test('scaling_stat without min_scaling means "scales with this stat at all", not unfiltered', () => {
  const scaled = itemStats(dbs(), { kind: 'weapon', scaling_stat: 'int' }) as any;
  assert.deepEqual(scaled.rows.map((r: any) => r.name), ["Azur's Glintstone Staff"]);
  const dexScaled = itemStats(dbs(), { kind: 'weapon', scaling_stat: 'dex' }) as any;
  assert.deepEqual(dexScaled.rows.map((r: any) => r.name), ["Celebrant's Skull", 'Uchigatana']);
});

test('itemStats rejects min_scaling with no scaling_stat rather than dropping it', () => {
  const result = itemStats(dbs(), { kind: 'weapon', min_scaling: 'A' }) as any;
  assert.equal(result.error, 'invalid_filter');
  assert.match(result.detail, /scaling_stat/);
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

test('getPage returns only the fragment section when the redirect fragment does match', () => {
  const page = getPage(dbs(), 'Magma Wyrm Makar') as any;
  assert.equal(page.match, 'redirect');
  assert.equal(page.fragment, 'Overview');
  assert.equal(page.fragment_matched, true);
  assert.deepEqual(page.sections.map((s: any) => s.heading), ['Overview']);
});

// Saying "no page matched" when the page did match makes a model report that the item does not
// exist. The page was found; only the section was not, and the real headings say what to ask for.
test('getPage distinguishes a missing section on a real page from a missing page', () => {
  const result = getPage(dbs(), "Azur's Glintstone Staff", 'Nonexistent Section') as any;
  assert.equal(result.not_found, undefined, 'the page exists, so this is not a page miss');
  assert.equal(result.section_not_found, true);
  assert.equal(result.page, "Azur's Glintstone Staff");
  assert.equal(result.section, 'Nonexistent Section');
  assert.deepEqual(result.headings, ['Summary', 'Acquisition']);
  assert.equal(result.provenance.revid, 100);
});

test('sourcesStatus reports sync and counts', () => {
  const status = sourcesStatus(dbs());
  assert.equal(status.shipped?.pages, 9);
  assert.equal(status.local, null);
});

const HINT = 'No page matched in the shipped data or local cache. Try search, or pass fetch: true to cache the Fextralife page.';

test('itemStats skips kinds whose table cannot express the filter', () => {
  const scaled = itemStats(dbs(), { scaling_stat: 'int', min_scaling: 'C' }) as any;
  assert.deepEqual(scaled.rows.map((r: any) => r.kind), ['weapon']);
  const byStrReq = itemStats(dbs(), { max_req: { str: 60 } }) as any;
  assert.deepEqual(byStrReq.rows.map((r: any) => [r.kind, r.name]), [['weapon', "Azur's Glintstone Staff"], ['weapon', 'Uchigatana']]);
  const byIntReq = itemStats(dbs(), { max_req: { int: 60 } }) as any;
  assert.deepEqual(byIntReq.rows.map((r: any) => r.kind), ['weapon', 'spell']);
});

test('itemStats ignores stat keys outside the allow-list and rejects an unknown scaling stat', () => {
  const injected = { int: 60, 'x_req, 0) OR 1=1 --': 1 } as unknown as Partial<Record<'int', number>>;
  const byName = itemStats(dbs(), { kind: 'weapon', max_req: injected }) as any;
  assert.deepEqual(byName.rows.map((r: any) => r.name), ["Azur's Glintstone Staff"]);
  // A stat name that is not in the allow-list can never reach SQL, and must not quietly become
  // "no scaling filter at all" either.
  const badStat = itemStats(dbs(), { kind: 'weapon', scaling_stat: 'hp' as any, min_scaling: 'C' }) as any;
  assert.equal(badStat.error, 'invalid_filter');
  assert.equal(badStat.rows, undefined);
});

// An unparseable grade must not invert the filter, and must not drop it either: it falls back to the
// weakest grade, which still means "scales with this stat".
test('itemStats treats an out-of-range min_scaling as E instead of inverting or dropping it', () => {
  const rows = (itemStats(dbs(), { kind: 'weapon', scaling_stat: 'int', min_scaling: 'Z' }) as any).rows;
  assert.deepEqual(rows.map((r: any) => r.name), ["Azur's Glintstone Staff"]);
});

test('getPage names the page and its headings when the requested section matches nothing', () => {
  const result = getPage(dbs(), "Azur's Glintstone Staff", 'no such section') as any;
  assert.equal(result.section_not_found, true);
  assert.ok(!('hint' in result) || !result.hint.includes('No page matched'), 'must not claim the page is missing');
  assert.deepEqual(result.headings, ['Summary', 'Acquisition']);
  // A page that really is missing still reports a page miss.
  assert.deepEqual(getPage(dbs(), 'zzqx nonsense', 'Acquisition'), { not_found: true, query: 'zzqx nonsense', hint: HINT });
});

// Fourteen real pages (Gravebird Helm, Flamespitter, Catapult…) are emptied by template and table
// stripping. Returning provenance and nothing else looks like an answer but carries no text.
test('getPage reports a miss with a reason when the page resolves but holds no sections', () => {
  const result = getPage(dbs(), 'Flamespitter') as any;
  assert.equal(result.not_found, true);
  assert.equal(result.reason, 'no_sections');
  assert.equal(result.page, 'Flamespitter');
  assert.equal(result.provenance.title, 'Flamespitter', 'the page is still citable');
  assert.match(result.hint, /fetch: true/);
});

// A zero-match search used to compact down to a bare {}, which reads as a malformed answer.
test('search and item_stats report an explicit miss, never an empty object', () => {
  const zero = search(dbs(), 'zzqx nonsense') as any;
  assert.equal(zero.not_found, true);
  assert.equal(zero.query, 'zzqx nonsense');
  assert.equal((search(dbs(), '!!!') as any).not_found, true);
  const noRows = itemStats(dbs(), { kind: 'talisman', max_req: { str: 10 } }) as any;
  assert.equal(noRows.not_found, true);
});

test('a strong local match beats a weak full-text hit in shipped data', () => {
  const local = memoryDb();
  upsertPage(local, { source: 'fextralife', title: 'Cuckoo', url: 'https://eldenring.wiki.fextralife.com/Cuckoo', revid: null, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext: null, markdown: '## Location\nLiurnia of the Lakes', license: 'All rights reserved (Fextralife). Local cache only; never redistributed.' });
  const shipped = buildFixtureDb();
  assert.equal(resolveBase({ shipped, local: null }, 'Cuckoo')?.match, 'search');
  const resolved = resolveBase({ shipped, local }, 'Cuckoo')!;
  assert.equal(resolved.match, 'exact');
  assert.equal(resolved.provenance.source, 'fextralife');
});

test('dlcPredicate produces constant SQL per mode', () => {
  assert.equal(dlcPredicate('base'), "(pages.dlc = 0 OR pages.source = 'fextralife')");
  assert.equal(dlcPredicate('only'), "(pages.dlc = 1 OR pages.source = 'fextralife')");
  assert.equal(dlcPredicate('all'), '1=1');
});

test('dlcPredicate honours a table alias', () => {
  assert.equal(dlcPredicate('base', 'p'), "(p.dlc = 0 OR p.source = 'fextralife')");
  assert.equal(dlcPredicate('all', 'p'), '1=1');
});

// A cached Fextralife page has no wikitext, so the classifier never reads it and its dlc column holds
// the column default. Both filtering modes must let it through: "never classified" is not "base game".
test('dlcPredicate exempts unclassified cache pages from every mode', () => {
  for (const mode of ['base', 'only'] as const) {
    assert.match(dlcPredicate(mode), /source = 'fextralife'/, `${mode} mode must not assert a dlc status it never measured`);
  }
});

// The only published data release (data-2026.09.16) predates the dlc columns. Opening it read-only
// skips the migration, so every query died with "no such column: dlc" and nothing said why.
test('openDbs reports a pre-dlc shipped db as stale instead of opening it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-stale-'));
  const path = join(dir, 'old.db');
  const old = new Database(path);
  old.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
    revid INTEGER, fetched_at TEXT NOT NULL, license TEXT NOT NULL, patch TEXT, wikitext TEXT, UNIQUE (source, title));`);
  old.close();
  // Restored in the finally: every later test in this file opens its own db, but openDbs() reads
  // these two env vars, and a leaked ELDEN_RING_MCP_DB would point the whole process at a stale file.
  const priorDb = process.env.ELDEN_RING_MCP_DB;
  const priorCache = process.env.ELDEN_RING_MCP_CACHE;
  process.env.ELDEN_RING_MCP_DB = path;
  process.env.ELDEN_RING_MCP_CACHE = join(dir, 'cache');
  try {
    const dbs = openDbs();
    assert.equal(dbs.shipped, null);
    assert.equal(dbs.stale?.path, path);
    assert.equal(dbs.stale?.detail, STALE_DETAIL);
    assert.match(STALE_DETAIL, /npm run extract/);
    dbs.local?.close();
  } finally {
    if (priorDb === undefined) delete process.env.ELDEN_RING_MCP_DB; else process.env.ELDEN_RING_MCP_DB = priorDb;
    if (priorCache === undefined) delete process.env.ELDEN_RING_MCP_CACHE; else process.env.ELDEN_RING_MCP_CACHE = priorCache;
  }
});

test('resolveName returns the page when the mode permits it', () => {
  const dbs = fixtureDbs([{ title: 'Icerind Hatchet', wikitext: 'axe', dlc: 0 }]);
  const r = resolveName(dbs, 'Icerind Hatchet', 'base');
  assert.ok(r && !isDlcFiltered(r));
  assert.equal(r.dlc, false);
});

test('resolveName reports a dlc page as filtered in base mode', () => {
  const dbs = fixtureDbs([{ title: 'Verdigris Armor', wikitext: 'armor', dlc: 1 }]);
  const r = resolveName(dbs, 'Verdigris Armor', 'base');
  assert.ok(r && isDlcFiltered(r));
  assert.equal(r.title, 'Verdigris Armor');
  assert.equal(r.provenance.title, 'Verdigris Armor');
});

test('resolveName returns a dlc page in all mode', () => {
  const dbs = fixtureDbs([{ title: 'Verdigris Armor', wikitext: 'armor', dlc: 1 }]);
  const r = resolveName(dbs, 'Verdigris Armor', 'all');
  assert.ok(r && !isDlcFiltered(r));
  assert.equal(r.dlc, true);
});

test('resolveName filters a base page in only mode', () => {
  const dbs = fixtureDbs([{ title: 'Icerind Hatchet', wikitext: 'axe', dlc: 0 }]);
  const r = resolveName(dbs, 'Icerind Hatchet', 'only');
  assert.ok(r && isDlcFiltered(r));
});

test('a page that does not exist is still a plain miss', () => {
  const dbs = fixtureDbs([{ title: 'Icerind Hatchet', wikitext: 'axe', dlc: 0 }]);
  assert.equal(resolveName(dbs, 'Nonexistent Sword of Nothing', 'base'), null);
});

test('resolveName defaults to base mode', () => {
  const dbs = fixtureDbs([{ title: 'Verdigris Armor', wikitext: 'armor', dlc: 1 }]);
  const r = resolveName(dbs, 'Verdigris Armor');
  assert.ok(r && isDlcFiltered(r));
});

// "Knight Arm" in base mode gated on Death Knight Gauntlets (dlc) while 39 base pages matched.
// Vagabond's wikitext carries extra filler so its section is longer than Death's: FTS5's bm25 length
// normalization then ranks Death first unfiltered, proven by the raw top hit in the task report.
test('the search fallback prefers a page the mode permits', () => {
  const dbs = fixtureDbs([
    { title: 'Death Knight Gauntlets', wikitext: 'Death Knight Gauntlets knight gauntlets knight gauntlets', dlc: 1 },
    { title: 'Vagabond Knight Gauntlets', wikitext: 'knight gauntlets are a plain reused vagabond set piece with no unique lore or special detail worth noting here at all', dlc: 0 },
  ]);
  const base = resolveName(dbs, 'knight gauntlet', 'base');
  assert.ok(base && !('filtered' in base));
  assert.equal(base.provenance.title, 'Vagabond Knight Gauntlets');
  assert.equal(base.match, 'search');
  const only = resolveName(dbs, 'knight gauntlet', 'only');
  assert.ok(only && !('filtered' in only));
  assert.equal(only.provenance.title, 'Death Knight Gauntlets');
});

test('the search fallback still gates when nothing the mode permits matches', () => {
  const dbs = fixtureDbs([{ title: 'Death Knight Gauntlets', wikitext: 'knight gauntlets', dlc: 1 }]);
  const r = resolveName(dbs, 'knight gauntlet', 'base');
  assert.ok(r && 'filtered' in r);
  assert.equal(r.match, 'search');
});

test('whereIs on a dlc item in base mode explains the filter', () => {
  const dbs = fixtureDbs([{ title: 'Verdigris Armor', wikitext: 'armor', dlc: 1 }]);
  const result = whereIs(dbs, 'Verdigris Armor', 'base') as { not_found: true; reason: string; page: string; hint: string };
  assert.equal(result.not_found, true);
  assert.equal(result.reason, 'dlc_filtered');
  assert.equal(result.page, 'Verdigris Armor');
  assert.match(result.hint, /Shadow of the Erdtree/);
  assert.match(result.hint, /dlc/);
});

test('whereIs on a dlc item in all mode answers', () => {
  const dbs = fixtureDbs([{ title: 'Verdigris Armor', wikitext: 'armor', dlc: 1 }]);
  const result = whereIs(dbs, 'Verdigris Armor', 'all') as { provenance: { title: string }; dlc: boolean };
  assert.equal(result.provenance.title, 'Verdigris Armor');
  assert.equal(result.dlc, true);
});

test('whereIs on a base-game item in only mode names base-game content, not DLC', () => {
  const dbs = fixtureDbs([{ title: 'Icerind Hatchet', wikitext: 'axe', dlc: 0 }]);
  const result = whereIs(dbs, 'Icerind Hatchet', 'only') as { not_found: true; reason: string; page: string; hint: string };
  assert.equal(result.not_found, true);
  assert.equal(result.reason, 'dlc_filtered');
  assert.equal(result.page, 'Icerind Hatchet');
  // The item is base game and this call asked for DLC only — the hint must say that, not its
  // opposite: a hardcoded base-mode wording would call a base-game item "Shadow of the Erdtree
  // content" and claim the call "asked for base-game results", both false here.
  assert.match(result.hint, /base.game/i);
  assert.doesNotMatch(result.hint, /Shadow of the Erdtree/);
  assert.doesNotMatch(result.hint, /asked for base-game results/);
});

test('a genuinely missing page is not reported as dlc_filtered', () => {
  const dbs = fixtureDbs([{ title: 'Icerind Hatchet', wikitext: 'axe', dlc: 0 }]);
  const result = whereIs(dbs, 'Sword Of Nothing At All', 'base') as { not_found: true; reason?: string };
  assert.equal(result.not_found, true);
  assert.equal(result.reason, undefined);
});

test('search excludes dlc results in base mode', () => {
  const dbs = fixtureDbs([
    { title: 'Verdigris Armor', wikitext: 'verdigris plate', dlc: 1 },
    { title: 'Icerind Hatchet', wikitext: 'frost axe', dlc: 0 },
  ]);
  const base = search(dbs, 'verdigris', 10, 'base') as { not_found?: true };
  assert.equal(base.not_found, true);

  const all = search(dbs, 'verdigris', 10, 'all') as { results: { title: string; dlc: boolean }[] };
  assert.equal(all.results.length, 1);
  assert.equal(all.results[0].dlc, true);
});

test('search in only mode returns dlc results alone', () => {
  const dbs = fixtureDbs([
    { title: 'Verdigris Armor', wikitext: 'plate armor', dlc: 1 },
    { title: 'Icerind Hatchet', wikitext: 'plate axe', dlc: 0 },
  ]);
  const result = search(dbs, 'plate', 10, 'only') as { results: { title: string }[] };
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Verdigris Armor');
});

test('getPage carries has_dlc_sections on a base page that mentions dlc', () => {
  const dbs = fixtureDbs([{ title: 'Great Runes', wikitext: 'lore', dlc: 0, hasDlcSections: 1 }]);
  const result = getPage(dbs, 'Great Runes', undefined, 'base') as { has_dlc_sections: boolean };
  assert.equal(result.has_dlc_sections, true);
});

// Asymmetric on purpose: with one page of each, base_pages and dlc_pages are both 1 and a count that
// reads the wrong column still passes.
test('sourcesStatus reports base and dlc counts', () => {
  const dbs = fixtureDbs([
    { title: 'Verdigris Armor', wikitext: 'a', dlc: 1 },
    { title: 'Icerind Hatchet', wikitext: 'b', dlc: 0 },
    { title: 'Uchigatana', wikitext: 'c', dlc: 0 },
  ]);
  const status = sourcesStatus(dbs) as { shipped: { pages: number; dlc_pages: number; base_pages: number } };
  assert.equal(status.shipped.pages, 3);
  assert.equal(status.shipped.dlc_pages, 1);
  assert.equal(status.shipped.base_pages, 2);
});

// The filterless branch of itemStats is the one query the dlc predicate reaches through a JOIN, and
// nothing else in the suite inserts item rows, so without these the predicate could be deleted
// outright and the suite would stay green.
test('itemStats excludes dlc items from a filterless query in base mode', () => {
  const dbs = fixtureDbs([
    { title: 'Verdigris Greatsword', wikitext: 'dlc sword', dlc: 1, weapon: { name: 'Verdigris Greatsword', strReq: 20 } },
    { title: 'Icerind Hatchet', wikitext: 'base axe', dlc: 0, weapon: { name: 'Icerind Hatchet', strReq: 10 } },
  ]);
  const base = itemStats(dbs, { kind: 'weapon' }, 'base') as any;
  assert.deepEqual(base.rows.map((r: any) => r.name), ['Icerind Hatchet']);
  assert.equal(base.rows[0].dlc, false);

  const only = itemStats(dbs, { kind: 'weapon' }, 'only') as any;
  assert.deepEqual(only.rows.map((r: any) => r.name), ['Verdigris Greatsword']);
  assert.equal(only.rows[0].dlc, true);

  const all = itemStats(dbs, { kind: 'weapon' }, 'all') as any;
  assert.deepEqual(all.rows.map((r: any) => r.name), ['Icerind Hatchet', 'Verdigris Greatsword']);
});

// The dlc predicate is composed alongside the caller's own where clauses, so exercise both at once:
// a str_req filter both items satisfy must still hide the dlc one.
test('itemStats applies the dlc filter alongside a max_req filter', () => {
  const dbs = fixtureDbs([
    { title: 'Verdigris Greatsword', wikitext: 'dlc sword', dlc: 1, weapon: { name: 'Verdigris Greatsword', strReq: 12 } },
    { title: 'Icerind Hatchet', wikitext: 'base axe', dlc: 0, weapon: { name: 'Icerind Hatchet', strReq: 10 } },
  ]);
  const base = itemStats(dbs, { kind: 'weapon', max_req: { str: 20 } }, 'base') as any;
  assert.deepEqual(base.rows.map((r: any) => r.name), ['Icerind Hatchet']);
  const all = itemStats(dbs, { kind: 'weapon', max_req: { str: 20 } }, 'all') as any;
  assert.deepEqual(all.rows.map((r: any) => r.name), ['Icerind Hatchet', 'Verdigris Greatsword']);
});

// mcp-server's instructions tell a model that not_found means the data does not cover it. A search
// whose only hits were filtered out by the caller's own mode must not make that claim.
test('search reports dlc_filtered rather than claiming the snapshot has nothing', () => {
  const dbs = fixtureDbs([
    { title: 'Verdigris Armor', wikitext: 'verdigris plate', dlc: 1 },
    { title: 'Icerind Hatchet', wikitext: 'frost axe', dlc: 0 },
  ]);
  const result = search(dbs, 'verdigris', 10, 'base') as { not_found: true; reason: string; hidden_matches: number; hint: string };
  assert.equal(result.not_found, true);
  assert.equal(result.reason, 'dlc_filtered');
  assert.equal(result.hidden_matches, 1);
  assert.match(result.hint, /Shadow of the Erdtree/);
  assert.match(result.hint, /dlc: "all"/);
});

test('search in only mode says the hits it hid were base game', () => {
  const dbs = fixtureDbs([{ title: 'Icerind Hatchet', wikitext: 'frost axe', dlc: 0 }]);
  const result = search(dbs, 'frost', 10, 'only') as { not_found: true; reason: string; hidden_matches: number; hint: string };
  assert.equal(result.reason, 'dlc_filtered');
  assert.equal(result.hidden_matches, 1);
  assert.match(result.hint, /base-game/);
  assert.match(result.hint, /dlc: "all"/);
});

test('a search that matches nothing in either mode stays a plain miss', () => {
  const dbs = fixtureDbs([
    { title: 'Verdigris Armor', wikitext: 'verdigris plate', dlc: 1 },
    { title: 'Icerind Hatchet', wikitext: 'frost axe', dlc: 0 },
  ]);
  const result = search(dbs, 'zzqx nonsense', 10, 'base') as { not_found: true; reason?: string; hint: string };
  assert.equal(result.not_found, true);
  assert.equal(result.reason, undefined);
  assert.match(result.hint, /Nothing in the shipped data/);
});

test('a base-mode search that does find base rows is unaffected', () => {
  const dbs = fixtureDbs([
    { title: 'Verdigris Armor', wikitext: 'verdigris plate', dlc: 1 },
    { title: 'Icerind Hatchet', wikitext: 'frost plate', dlc: 0 },
  ]);
  const result = search(dbs, 'plate', 10, 'base') as { results: { title: string }[]; reason?: string };
  assert.equal(result.reason, undefined);
  assert.deepEqual(result.results.map((r) => r.title), ['Icerind Hatchet']);
});

/**
 * The gate is only as good as the resolution behind it. "Verdigris Greatsword" is not a page: the FTS
 * fallback lands on Enir-Ilim, which IS dlc, and the caller used to be told their own name was DLC
 * content. Re-running with dlc: "all" then returns a page about something else entirely.
 */
test('a dlc gate reached by full-text fallback is reported as a guess', () => {
  const dbs = fixtureDbs([{ title: 'Enir-Ilim', wikitext: 'the verdigris greatsword rests here', dlc: 1 }]);
  const result = itemStats(dbs, { name: 'Verdigris Greatsword' }, 'base') as
    { reason?: string; page?: string; match?: string; hint: string };
  assert.equal(result.reason, 'dlc_filtered');
  assert.equal(result.page, 'Enir-Ilim');
  assert.equal(result.match, 'search', 'the gate must carry the match that produced it');
  assert.match(result.hint, /Nothing is named "Verdigris Greatsword"/);
  assert.match(result.hint, /guess/, 'a fuzzy match must not read as an authoritative statement');
});

test('a dlc gate on an exactly resolved name is not hedged as a guess', () => {
  const dbs = fixtureDbs([{ title: 'Verdigris Armor', wikitext: 'armor', dlc: 1 }]);
  const result = whereIs(dbs, 'Verdigris Armor', 'base') as { match?: string; hint: string };
  assert.equal(result.match, 'exact');
  assert.doesNotMatch(result.hint, /guess/);
  assert.match(result.hint, /"Verdigris Armor" is Shadow of the Erdtree content/);
});

/** A cached Fextralife page carries markdown and no wikitext, so the classifier never labels it. */
const cachedPage = (title: string, markdown: string) => {
  const local = memoryDb();
  upsertPage(local, {
    source: 'fextralife', title, url: `https://eldenring.wiki.fextralife.com/${title}`, revid: null,
    fetchedAt: '2026-09-16T00:00:00.000Z', wikitext: null, markdown,
    license: 'All rights reserved (Fextralife). Local cache only; never redistributed.',
  });
  return { shipped: null, local } satisfies Dbs;
};

/**
 * INSTRUCTIONS tell a model to retry with fetch: true after a miss, so this is a normal path. The
 * cached page's dlc column is a default nobody measured; answering "base-game content" about a DLC
 * boss is a claim the data cannot support, so an unclassified page is exempt from every mode and
 * reports no dlc field at all.
 */
test('a cached Fextralife page is never dlc-filtered and asserts no dlc status', () => {
  const dbs = cachedPage('Messmer the Impaler', '## Location\nShadow Keep, Church District');
  for (const mode of ['base', 'only', 'all'] as const) {
    const result = getPage(dbs, 'Messmer the Impaler', undefined, mode) as
      { reason?: string; dlc?: boolean | null; provenance?: { source: string } };
    assert.equal(result.reason, undefined, `${mode} mode must not gate a page nobody classified`);
    assert.equal(result.provenance?.source, 'fextralife');
    assert.equal(result.dlc, null, `${mode} mode must report unknown, not false`);
  }
});

test('search reaches cached Fextralife rows in dlc-only mode', () => {
  const dbs = cachedPage('Messmer the Impaler', '## Location\nShadow Keep, Church District');
  const result = search(dbs, 'Shadow Keep', 10, 'only') as { results?: { title: string; dlc: boolean | null }[] };
  assert.deepEqual(result.results?.map((r) => r.title), ['Messmer the Impaler']);
  assert.equal(result.results?.[0].dlc, null);
});
