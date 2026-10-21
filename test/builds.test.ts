import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { upsertPage } from '../src/store/pages.js';
import { runExtractors } from '../src/extract/run.js';
import { buildExtractor, buildLinks, parseBuild } from '../src/extract/build.js';
import { BUILD_HTML, BUILDS_INDEX_HTML, THIN_BUILD_HTML } from './fixtures/fextralife.js';
import { OPALINE_HARDTEAR, RELLANA_ARMOR } from './fixtures/wikitext.js';
import type { Dbs } from '../src/query/dbs.js';

test('parseBuild reads the infobox, requirements and summary', () => {
  const b = parseBuild(BUILD_HTML, 'Test Paladin Build');
  assert.equal(b.name, 'Test Paladin');
  assert.equal(b.class, 'Vagabond');
  assert.equal(b.level, 150);
  assert.equal(b.journey, 'NG+');
  assert.deepEqual(b.focus, ['Faith']);
  assert.equal(b.playstyle, 'Melee');
  assert.deepEqual(b.primary_stats, ['Faith', 'Strength']);
  assert.deepEqual(b.secondary_stats, ['Vigor', 'Mind']);
  assert.equal(b.flask, 'Even split');
  assert.deepEqual(b.min_stats, { fai: 40, str: 11, dex: 15 });
  assert.match(b.summary!, /made-up faith build/);
});

test('parseBuild lists every linked item with the section it was listed under', () => {
  const b = parseBuild(BUILD_HTML, 'Test Paladin Build');
  const by = (name: string) => b.items.find((i) => i.name === name);
  assert.deepEqual(by('Uchigatana'), { listed_as: 'weapon', name: 'Uchigatana', alternate: false, affinity: 'Keen' });
  assert.equal(by('Golden Order Seal')!.listed_as, 'weapon');
  assert.equal(by('Ash of War: Sacred Blade')!.listed_as, 'skill');
  assert.equal(by("Rellana's Armor")!.listed_as, 'armor');
  assert.equal(by('Horned Warrior Gauntlets')!.listed_as, 'armor');
  assert.equal(by('Godfrey Icon')!.listed_as, 'talisman');
  assert.deepEqual(by('Shard of Alexander'), { listed_as: 'talisman', name: 'Shard of Alexander', alternate: true, affinity: null });
  // Misfiled on the page: Flamberge is a weapon listed under spells. The parser records what the page says.
  assert.equal(by('Flamberge')!.listed_as, 'spell');
  assert.equal(by('Opaline Hardtear')!.listed_as, 'crystal_tear');
  assert.equal(by('Crimsonburst Crystal Tear')!.alternate, true);
  assert.equal(by("Godrick's Great Rune")!.listed_as, 'great_rune');
  // Stat links and the class are not gear; each item appears once even when listed twice.
  for (const stat of ['Faith', 'Strength', 'Vigor', 'Mind', 'Vagabond']) assert.equal(by(stat), undefined, stat);
  assert.equal(b.items.filter((i) => i.name === 'Golden Order Seal').length, 1);
  assert.equal(b.items.filter((i) => i.name === 'Uchigatana').length, 1);
});

test('parseBuild keeps the free text a row carries beyond its links', () => {
  const b = parseBuild(BUILD_HTML, 'Test Paladin Build');
  assert.match(b.notes.Armor!, /any helm/);
  assert.equal(b.notes.Weapon, undefined, 'affinity and "with" are not a note');
});

test('parseBuild ignores the related-builds footer and handles a thin page', () => {
  const b = parseBuild(BUILD_HTML, 'Test Paladin Build');
  assert.equal(b.items.find((i) => i.name === 'Other Build'), undefined);
  const thin = parseBuild(THIN_BUILD_HTML, 'Thin Build');
  assert.equal(thin.level, null);
  assert.deepEqual(thin.items.map((i) => i.name), ['Uchigatana', 'Longbow']);
  assert.deepEqual(thin.min_stats, {});
});

test('buildLinks collects each *_Build page once and skips category pages', () => {
  assert.deepEqual(buildLinks(BUILDS_INDEX_HTML), ['Samurai Build', 'Blood Dancer Build', 'Star-Lined Samurai Build']);
});

test('buildExtractor writes builds and build_items for a cached Fextralife build page only', () => {
  const db = memoryDb();
  const id = upsertPage(db, { source: 'fextralife', title: 'Test Paladin Build', url: 'https://x/Test_Paladin_Build', revid: null, fetchedAt: '2026-10-20T00:00:00.000Z', wikitext: null, markdown: 'x', html: BUILD_HTML, license: 'All rights reserved (Fextralife).' });
  upsertPage(db, { source: 'fextralife', title: 'Uchigatana', url: 'https://x/Uchigatana', revid: null, fetchedAt: '2026-10-20T00:00:00.000Z', wikitext: null, markdown: 'x', html: '<html></html>', license: 'x' });
  runExtractors(db, { extractors: [buildExtractor] });
  const row = db.prepare('SELECT name, level, focus FROM builds WHERE page_id = ?').get(id) as Record<string, unknown>;
  assert.deepEqual(row, { name: 'Test Paladin', level: 150, focus: '["Faith"]' });
  assert.equal((db.prepare('SELECT count(*) AS n FROM builds').get() as { n: number }).n, 1);
  const items = db.prepare('SELECT name FROM build_items WHERE page_id = ? ORDER BY ord').all(id) as { name: string }[];
  assert.equal(items[0].name, 'Uchigatana');
  runExtractors(db, { extractors: [buildExtractor] });
  assert.equal((db.prepare('SELECT count(*) AS n FROM build_items WHERE page_id = ?').get(id) as { n: number }).n, items.length, 're-run replaces, never duplicates');
});

test('ingestBuilds caches each listed build once, records list membership and resumes', async () => {
  const { ingestBuilds } = await import('../src/store/builds-ingest.js');
  const db = memoryDb();
  const requested: string[] = [];
  const getText = async (url: string) => {
    requested.push(url);
    if (url.endsWith('/Builds')) return BUILDS_INDEX_HTML;
    if (url.endsWith('/SOTE_Builds')) return BUILD_HTML.replace('Test Paladin Build', 'x'); // links Other/Another Build in its footer
    return BUILD_HTML;
  };
  const first = await ingestBuilds(db, getText, { limit: 2 });
  assert.equal(first.fetched.length, 2);
  const second = await ingestBuilds(db, getText);
  assert.equal(second.skipped, 2, 'cached pages are not fetched again');
  assert.equal(second.fetched.length, first.listed - 2);
  assert.equal(requested.filter((u) => u.endsWith('/Samurai_Build')).length, 1);
  const sote = db.prepare("SELECT title FROM build_lists WHERE list = 'SOTE Builds' ORDER BY title").all() as { title: string }[];
  assert.deepEqual(sote.map((r) => r.title), ['Another Build', 'Other Build']);
  assert.equal((db.prepare('SELECT count(*) AS n FROM builds').get() as { n: number }).n, first.listed);
});

test('ingestBuilds stops at the first 403 instead of retrying around a block', async () => {
  const { ingestBuilds } = await import('../src/store/builds-ingest.js');
  const { HttpError } = await import('../src/sources/http.js');
  const db = memoryDb();
  let builds = 0;
  const getText = async (url: string) => {
    if (url.endsWith('/Builds') || url.endsWith('/SOTE_Builds')) return BUILDS_INDEX_HTML;
    builds++;
    throw new HttpError(403, url);
  };
  const report = await ingestBuilds(db, getText);
  assert.equal(builds, 1);
  assert.match(report.stopped!, /403/);
});

test('assertLocalTarget refuses the shipped data directory', async () => {
  const { assertLocalTarget } = await import('../src/store/builds-ingest.js');
  assert.throws(() => assertLocalTarget('data/elden-ring.db'), /shipped snapshot/);
  assert.throws(() => assertLocalTarget('data/local.db'), /shipped snapshot/);
  assert.doesNotThrow(() => assertLocalTarget('/tmp/er-cache/local.db'));
});

async function buildDbs(): Promise<Dbs> {
  const { buildFixtureDb } = await import('./fixtures/build-fixture-db.js');
  const shipped = buildFixtureDb();
  const fandom = (title: string, wikitext: string) => upsertPage(shipped, { source: 'fandom', title, url: `https://eldenring.fandom.com/wiki/${title}`, revid: 1, fetchedAt: '2026-10-20T00:00:00.000Z', wikitext, markdown: null, license: 'CC BY-SA 3.0' });
  fandom('Flamberge', '{{Infobox Weapon\n| title = Flamberge\n| type = Greatsword\n}}\n');
  fandom("Rellana's Armor", RELLANA_ARMOR);
  fandom('Opaline Hardtear', OPALINE_HARDTEAR);
  fandom('Godfrey Icon', '{{Infobox Item\n| title = Godfrey Icon\n| type = Talisman\n}}\n');
  fandom("Assassin's Cerulean Dagger", "{{Infobox Item\n| title = Assassin's Cerulean Dagger\n| type = Talisman\n}}\n");
  runExtractors(shipped);
  shipped.prepare("UPDATE pages SET dlc = 1 WHERE title = 'Rellana''s Armor'").run();
  const local = memoryDb();
  for (const [title, html] of [['Test Paladin Build', BUILD_HTML], ['Thin Build', THIN_BUILD_HTML]] as const) {
    upsertPage(local, { source: 'fextralife', title, url: `https://eldenring.wiki.fextralife.com/${title.replace(/ /g, '_')}`, revid: null, fetchedAt: '2026-10-20T00:00:00.000Z', wikitext: null, markdown: 'x', html, license: 'All rights reserved (Fextralife). Local cache only; never redistributed.' });
  }
  runExtractors(local, { extractors: [buildExtractor] });
  local.prepare("INSERT INTO build_lists (list, title) VALUES ('Builds', 'Test Paladin Build'), ('Builds', 'Thin Build')").run();
  return { shipped, local };
}

test('build by name resolves each item to its type, flags misfiled and unresolved items, cites Fextralife', async () => {
  const { buildInfo } = await import('../src/query/builds.js');
  const result = buildInfo(await buildDbs(), { name: 'Test Paladin' }, 'all') as any;
  assert.equal(result.match, 'exact');
  const b = result.build;
  const item = (name: string) => b.items.find((i: any) => i.name === name);
  assert.equal(item('Uchigatana').display, 'Uchigatana (Katana)');
  assert.equal(item('Uchigatana').affinity, 'Keen');
  assert.equal(item("Rellana's Armor").display, "Rellana's Armor (Chest Armor)");
  assert.equal(item('Opaline Hardtear').display, 'Opaline Hardtear (Crystal Tear)');
  assert.equal(item('Comet Azur').display, 'Comet Azur (Sorcery)');
  assert.deepEqual([item('Flamberge').slot, item('Flamberge').listed_as], ['weapon', 'spell']);
  assert.equal(item('Godfrey Icon').listed_as, undefined, 'a correctly filed item carries no listed_as');
  assert.equal(item('Horned Warrior Gauntlets').resolved, false);
  assert.equal(item('Horned Warrior Gauntlets').display, 'Horned Warrior Gauntlets (unresolved)');
  assert.equal(b.provenance.source, 'fextralife');
  assert.match(b.provenance.url, /Test_Paladin_Build$/);
  assert.deepEqual([b.dlc, b.dlc_basis], [true, "uses DLC item Rellana's Armor"]);
});

test('build filters: item, weapon, stat and dlc mode', async () => {
  const { buildInfo } = await import('../src/query/builds.js');
  const d = await buildDbs();
  const godfrey = buildInfo(d, { item: 'godfrey icon' }, 'all') as any;
  assert.deepEqual(godfrey.rows.map((r: any) => r.name), ['Test Paladin']);
  assert.equal(godfrey.rows[0].matched[0].display, 'Godfrey Icon (Talisman)');
  assert.deepEqual((buildInfo(d, { weapon: 'Uchigatana' }, 'all') as any).rows.map((r: any) => r.name), ['Test Paladin', 'Thin']);
  assert.equal((buildInfo(d, { weapon: 'Godfrey Icon' }, 'all') as any).not_found, true, 'a talisman is not a weapon');
  assert.deepEqual((buildInfo(d, { stat: 'dex' }, 'all') as any).rows.map((r: any) => r.name), ['Thin']);
  assert.deepEqual((buildInfo(d, { stat: 'Faith' }, 'all') as any).rows.map((r: any) => r.name), ['Test Paladin']);
  assert.deepEqual((buildInfo(d, {}, 'base') as any).rows.map((r: any) => r.name), ['Thin']);
  assert.deepEqual((buildInfo(d, {}, 'only') as any).rows.map((r: any) => r.name), ['Test Paladin']);
});

test('build answers not_found with a fetch hint when nothing is cached', async () => {
  const { buildInfo } = await import('../src/query/builds.js');
  const result = buildInfo({ shipped: null, local: memoryDb() }, { name: 'Samurai' }) as any;
  assert.equal(result.not_found, true);
  assert.match(result.hint, /fetch-builds/);
});

test('resolveItem tries fixed Fextralife spellings, never a search', async () => {
  const { resolveItem } = await import('../src/query/builds.js');
  const { shipped } = await buildDbs();
  const fandom = (title: string, wikitext: string) => upsertPage(shipped!, { source: 'fandom', title, url: `https://x/${title}`, revid: 1, fetchedAt: '2026-10-20T00:00:00.000Z', wikitext, markdown: null, license: 'CC BY-SA 3.0' });
  fandom('Flame, Grant Me Strength', '{{Infobox Item\n| title = Flame, Grant Me Strength\n| type = Incantation\n}}\n');
  fandom("Ash of War: Royal Knight's Resolve", "{{Infobox Item\n| title = Ash of War: Royal Knight's Resolve\n| type = Ash of War\n}}\n");
  fandom('Dragoncrest Shield Talisman +1', '{{Infobox Item\n| title = Dragoncrest Shield Talisman +1\n| type = Talisman\n}}\n');
  runExtractors(shipped!);
  assert.equal(resolveItem(shipped, 'Flame Grant me Strength').display, 'Flame Grant me Strength (Incantation)');
  assert.equal(resolveItem(shipped, 'Flame Grant me Strength').as, 'Flame, Grant Me Strength');
  assert.equal(resolveItem(shipped, "Royal Knight's Resolve").display, "Royal Knight's Resolve (Ash of War)");
  assert.equal(resolveItem(shipped, 'Dragoncrest Shield Talisman 1').as, 'Dragoncrest Shield Talisman +1');
  assert.equal(resolveItem(shipped, 'Graven‐School Talisman').resolved, true, 'curly or odd punctuation squashes to the real title');
  assert.equal(resolveItem(shipped, 'Uchigatana').as, undefined);
  fandom("Skill: Lion's Claw", "'''Lion's Claw''' is a skill.\n");
  const { replaceRedirects } = await import('../src/store/pages.js');
  replaceRedirects(shipped!, 'fandom', [{ from: "Lion's Claw", to: "Skill: Lion's Claw", fragment: null }]);
  fandom("Ash of War: Lion's Claw", "{{Infobox Item\n| title = Ash of War: Lion's Claw\n| type = Ash of War\n}}\n");
  runExtractors(shipped!);
  assert.equal(resolveItem(shipped, "Lion's Claw").display, "Lion's Claw (Ash of War)");
  assert.equal(resolveItem(shipped, "Lion's Claw").slot, 'skill');
  assert.equal(resolveItem(shipped, 'Opaline Hardtear').slot, 'crystal_tear');
  fandom('Golden Vow', '{{Infobox Item\n| title = Golden Vow\n| type = Incantation\n}}\n');
  fandom('Ash of War: Golden Vow', '{{Infobox Item\n| title = Ash of War: Golden Vow\n| type = Ash of War\n}}\n');
  runExtractors(shipped!);
  assert.equal(resolveItem(shipped, 'Golden Vow', 'skill').display, 'Golden Vow (Ash of War)');
  assert.equal(resolveItem(shipped, 'Golden Vow', 'spell').display, 'Golden Vow (Incantation)');
  assert.equal(resolveItem(shipped, "Lion's Claw", 'skill').display, "Lion's Claw (Ash of War)", 'the typed Ash of War page beats the Skill page');
  assert.equal(resolveItem(shipped, 'Horned Warrior Gauntlets').resolved, false);
});

test('a skill that shares its weapon\'s name is a unique skill, not a misfiled weapon', async () => {
  const { buildInfo } = await import('../src/query/builds.js');
  const d = await buildDbs();
  const id = (d.local!.prepare("SELECT id FROM pages WHERE title = 'Thin Build'").get() as { id: number }).id;
  d.local!.prepare("INSERT INTO build_items (page_id, ord, listed_as, name, alternate) VALUES (?, 99, 'skill', 'Uchigatana', 0)").run(id);
  d.local!.prepare("UPDATE build_items SET name = 'Uchigatana (dup)' WHERE page_id = ? AND ord = 0").run(id);
  const item = (buildInfo(d, { name: 'Thin' }, 'all') as any).build.items.find((i: any) => i.name === 'Uchigatana');
  assert.deepEqual([item.slot, item.listed_as, item.display], ['skill', undefined, 'Uchigatana (Unique Skill of Uchigatana)']);
});
