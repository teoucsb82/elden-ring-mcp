import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { upsertPage } from '../src/store/pages.js';
import { runExtractors } from '../src/extract/run.js';
import { missingData } from '../src/extract/common.js';
import { isPlaceholder } from '../src/extract/acquisition.js';
import { itemStats, whereIs } from '../src/query/lookups.js';
import type { Dbs } from '../src/query/dbs.js';
import { COMET_AZUR, DIVINE_BIRD_GAUNTLETS, GRAVEN_SCHOOL, LIONS_CLAW, OPALINE_HARDTEAR, RELLANA_ARMOR, ROCK_HEART } from './fixtures/wikitext.js';

const PAGES: [string, string][] = [
  ['Rock Heart', ROCK_HEART], ["Ash of War: Lion's Claw", LIONS_CLAW], ['Opaline Hardtear', OPALINE_HARDTEAR],
  ["Rellana's Armor", RELLANA_ARMOR], ['Divine Bird Warrior Gauntlets', DIVINE_BIRD_GAUNTLETS],
  ['Comet Azur', COMET_AZUR], ['Graven-School Talisman', GRAVEN_SCHOOL],
];

function dbs(): Dbs {
  const db = memoryDb();
  for (const [title, wikitext] of PAGES) {
    upsertPage(db, { source: 'fandom', title, url: `https://x/${title}`, revid: 1, fetchedAt: '2026-10-20T00:00:00.000Z', wikitext, markdown: null, license: 'CC BY-SA 3.0' });
  }
  runExtractors(db);
  // The mode under test here is resolution and extraction, not the dlc gate.
  return { shipped: db, local: null };
}

test('missingData reads the {{missing data|...}} template and ignores {{stub|missing data}}', () => {
  assert.deepEqual(missingData(RELLANA_ARMOR), ['stats', 'location']);
  assert.deepEqual(missingData('{{Missing Data|stats}}'), ['stats']);
  assert.deepEqual(missingData('{{missing data}}'), ['data']);
  assert.deepEqual(missingData(COMET_AZUR), []);
  assert.deepEqual(missingData(null), []);
});

test('isPlaceholder spots acquisition text that says nothing', () => {
  for (const text of ['-', '**Location**:', '**Location**: ?', '**Location**: -', '  ']) assert.equal(isPlaceholder(text), true, text);
  for (const text of ['Drops from Patches.', '- Craftable', '**Location**: [Stormhill](x)']) assert.equal(isPlaceholder(text), false, text);
});

test('item_stats by name refuses a full-text guess instead of returning another item', () => {
  const result = itemStats(dbs(), { name: 'Horned Warrior Gauntlets' }, 'all') as any;
  assert.equal(result.not_found, true);
  assert.equal(result.reason, 'guess_only');
  assert.equal(result.closest, 'Divine Bird Warrior Gauntlets');
  assert.equal(result.rows, undefined);
});

test('item_stats flags Fandom missing data instead of reporting blanks', () => {
  const result = itemStats(dbs(), { name: "Rellana's Armor" }, 'all') as any;
  assert.equal(result.rows[0].weight, null);
  assert.equal(result.rows[0].poise, null);
  assert.deepEqual(result.missing, ['stats', 'location']);
  assert.match(result.missing_hint, /wiki/i);
  const complete = itemStats(dbs(), { name: 'Graven-School Talisman' }, 'all') as any;
  assert.equal(complete.missing, undefined);
});

test('where_is drops a placeholder acquisition and says the location is missing', () => {
  const result = whereIs(dbs(), "Rellana's Armor", 'all') as any;
  assert.equal(result.acquisition, null);
  assert.deepEqual(result.missing, ['stats', 'location']);
});

test('where_is reports an untagged placeholder location as missing', () => {
  const d = dbs();
  upsertPage(d.shipped!, { source: 'fandom', title: 'Fire Knight Armor', url: 'https://x/fk', revid: 1, fetchedAt: '2026-10-20T00:00:00.000Z', license: 'CC BY-SA 3.0', markdown: null,
    wikitext: "{{missing data|stats}}{{Infobox Armor\n| type = Chest\n| title = Fire Knight Armor\n}}\n==Acquisition==\n'''Location''': -\n" });
  runExtractors(d.shipped!);
  const result = whereIs(d, 'Fire Knight Armor', 'all') as any;
  assert.equal(result.acquisition, null);
  assert.deepEqual(result.missing, ['stats', 'location']);
});

test('item_stats covers tools, Ashes of War and crystal tears', () => {
  const rock = itemStats(dbs(), { name: 'Rock Heart' }, 'all') as any;
  assert.equal(rock.rows[0].kind, 'item');
  assert.equal(rock.rows[0].item_type, 'Tool');
  assert.equal(rock.rows[0].obtained, 'Jagged Peak');
  const claw = itemStats(dbs(), { name: "Ash of War: Lion's Claw" }, 'all') as any;
  assert.equal(claw.rows[0].item_type, 'Ash of War');
  assert.equal(claw.rows[0].affinity, 'Heavy');
  assert.equal(claw.rows[0].fp_cost, '20');
  const tear = itemStats(dbs(), { name: 'Opaline Hardtear' }, 'all') as any;
  assert.equal(tear.rows[0].sub_type, 'Crystal Tear');
  const tools = itemStats(dbs(), { kind: 'item' }, 'all') as any;
  assert.deepEqual(tools.rows.map((r: any) => r.name).sort(), ["Ash of War: Lion's Claw", 'Opaline Hardtear', 'Rock Heart']);
});

test('spells and talismans stay in their own tables, not items', () => {
  const comet = itemStats(dbs(), { name: 'Comet Azur' }, 'all') as any;
  assert.deepEqual(comet.rows.map((r: any) => r.kind), ['spell']);
  const graven = itemStats(dbs(), { name: 'Graven-School Talisman' }, 'all') as any;
  assert.deepEqual(graven.rows.map((r: any) => r.kind), ['talisman']);
});
