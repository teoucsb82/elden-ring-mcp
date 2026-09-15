import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { upsertPage } from '../src/store/pages.js';
import { runExtractors } from '../src/extract/run.js';
import type { RawPage } from '../src/types.js';
import { AZUR_CROWN, AZUR_STAFF, COMET_AZUR, GRAVEN_SCHOOL, MALFORMED, RED_WOLF, SELLEN_QUEST } from './fixtures/wikitext.js';

const page = (title: string, wikitext: string): RawPage => ({
  source: 'fandom', title, url: `https://eldenring.fandom.com/wiki/${title}`, revid: 1, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext, markdown: null, license: 'CC BY-SA 3.0 (eldenring.fandom.com)',
});

function seeded() {
  const db = memoryDb();
  for (const [title, text] of [["Azur's Glintstone Staff", AZUR_STAFF], ['Comet Azur', COMET_AZUR], ['Graven-School Talisman', GRAVEN_SCHOOL], ["Azur's Glintstone Crown", AZUR_CROWN], ['Red Wolf of Radagon', RED_WOLF], ['Sorceress Sellen', SELLEN_QUEST], ['Broken Page', MALFORMED]] as const) {
    upsertPage(db, page(title, text));
  }
  return db;
}

test('weapon row with requirements and scaling', () => {
  const db = seeded();
  runExtractors(db);
  assert.deepEqual(db.prepare('SELECT name, weapon_type, weight, str_req, int_req, int_scale, str_scale, dex_scale, sorcery_scaling, skill FROM weapons').get(), {
    name: "Azur's Glintstone Staff", weapon_type: 'Glintstone Staff', weight: 4, str_req: 10, int_req: 52, int_scale: 'B', str_scale: 'D', dex_scale: null, sorcery_scaling: 151, skill: 'No Skill',
  });
});

test('spell, talisman, armor, boss rows', () => {
  const db = seeded();
  runExtractors(db);
  assert.deepEqual(db.prepare('SELECT name, spell_type, sub_type, fp_cost, stamina_cost, slots_used, int_req FROM spells').get(), { name: 'Comet Azur', spell_type: 'Sorcery', sub_type: 'Primeval', fp_cost: '40 (10)', stamina_cost: 34, slots_used: 3, int_req: 60 });
  const talisman = db.prepare('SELECT name, weight, effect, summary FROM talismans').get() as Record<string, unknown>;
  assert.equal(talisman.effect, 'Raises potency of sorceries');
  assert.match(String(talisman.summary), /Increases damage from sorceries by 8%/);
  assert.deepEqual(db.prepare('SELECT name, slot, weight, poise, effects FROM armor').get(), { name: "Azur's Glintstone Crown", slot: 'head', weight: 3.6, poise: 4, effects: 'Boosts the potency of Comet Azur by 15%. Increases FP consumption by 15%.' });
  assert.deepEqual(db.prepare('SELECT name, location, hp, runes, drops FROM bosses').get(), { name: 'Red Wolf of Radagon', location: 'Academy of Raya Lucaria', hp: '2,204', runes: '14,000', drops: 'Memory Stone' });
});

test('entities registered per typed row', () => {
  const db = seeded();
  runExtractors(db);
  const types = (db.prepare('SELECT type FROM entities ORDER BY type').all() as { type: string }[]).map((r) => r.type);
  assert.deepEqual(types, ['armor', 'boss', 'spell', 'talisman', 'weapon']);
});

test('non-matching and malformed pages produce no rows and no crash', () => {
  const db = seeded();
  const report = runExtractors(db);
  assert.equal(report.pages, 7);
  assert.equal((db.prepare("SELECT count(*) AS n FROM weapons WHERE name = 'Broken Page'").get() as { n: number }).n, 0);
});

test('extractor that throws is logged to extract_failures and the run continues', () => {
  const db = seeded();
  const boom = { name: 'boom', matches: () => true, write: () => { throw new Error('bad infobox'); } };
  const report = runExtractors(db, { extractors: [boom], now: () => new Date('2026-09-15T00:00:00Z') });
  assert.equal(report.failures.length, 7);
  assert.equal((db.prepare('SELECT count(*) AS n FROM extract_failures').get() as { n: number }).n, 7);
});

test('re-running replaces rows instead of duplicating', () => {
  const db = seeded();
  runExtractors(db);
  runExtractors(db);
  assert.equal((db.prepare('SELECT count(*) AS n FROM weapons').get() as { n: number }).n, 1);
});

test('pageIds limits the run', () => {
  const db = seeded();
  const id = (db.prepare("SELECT id FROM pages WHERE title = 'Comet Azur'").get() as { id: number }).id;
  const report = runExtractors(db, { pageIds: [id] });
  assert.equal(report.pages, 1);
  assert.equal((db.prepare('SELECT count(*) AS n FROM weapons').get() as { n: number }).n, 0);
});
