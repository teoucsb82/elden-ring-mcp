import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { upsertPage } from '../src/store/pages.js';
import { runExtractors } from '../src/extract/run.js';
import { parseAcquisition } from '../src/extract/acquisition.js';
import { parseQuestSteps } from '../src/extract/quest.js';
import { wikitextToMarkdown } from '../src/wikitext/markdown.js';
import { splitSections } from '../src/wikitext/sections.js';
import { AZUR_CROWN, AZUR_STAFF, ELEONORA_QUEST, LEDA_FLAT_QUEST, PATCHES_QUEST, RED_WOLF, SELLEN_QUEST, STUB_THEN_STEPS, YMIR_QUEST } from './fixtures/wikitext.js';

const section = (wikitext: string, heading: string) => splitSections(wikitextToMarkdown(wikitext)).find((s) => s.heading === heading)!.markdown;

test('acquisition: ground pickup with nearest grace', () => {
  const a = parseAcquisition(section(AZUR_STAFF, 'Acquisition'));
  assert.equal(a.method, 'ground');
  assert.equal(a.nearest_grace, 'Debate Parlor');
  assert.equal(a.missable, false);
});

test('acquisition: quest prerequisite sentence captured', () => {
  const a = parseAcquisition(section(AZUR_CROWN, 'Acquisition'));
  assert.equal(a.method, 'quest');
  assert.deepEqual(a.prereqs, ["- Obtained upon completing Sorceress Sellen's questline, then returning to the spot where Azur was found."]);
});

test('acquisition: missable and drop detection', () => {
  const a = parseAcquisition('Dropped by the boss. This item is missable after the capital burns.');
  assert.equal(a.method, 'drop');
  assert.equal(a.missable, true);
});

test('quest steps: numbered locations with nested actions and quest breakers', () => {
  const steps = parseQuestSteps(section(SELLEN_QUEST, 'Questline progression'));
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0], { step_ord: 1, location: 'Waypoint Ruins', action: 'Sellen can be found in the cellar after defeating the Mad Pumpkin Head. Select "I wish to learn glintstone sorceries".', breaks_quest: null });
  assert.equal(steps[2].location, 'Witchbane Ruins');
  assert.match(steps[2].action, /speak to the shackled Sellen/);
  assert.equal(steps[2].breaks_quest, 'Attacking Sellen here will fail the questline.');
});

test('benign "permanently" does not mark an item missable', () => {
  const a = parseAcquisition('Found on a corpse in the cellar. This talisman permanently increases stamina.');
  assert.equal(a.missable, false);
  assert.equal(a.method, 'ground');
});

test('"interacting with" is a ground pickup, not a quest', () => {
  assert.equal(parseAcquisition('Obtained by interacting with the corpse on the balcony.').method, 'ground');
});

test('a generic "nearest site of grace" phrase yields no grace name', () => {
  assert.equal(parseAcquisition('Warp to Uhl Palace Ruins, then head to the nearest site of grace.').nearest_grace, null);
});

test('benign "permanently" in a quest bullet stays an action, not a quest-breaker', () => {
  const steps = parseQuestSteps('1. Roundtable Hold\n  - Talk to him; the gift permanently increases your rune gain.');
  assert.equal(steps[0].breaks_quest, null);
  assert.match(steps[0].action, /permanently increases/);
});

test('extractors write acquisition and quest rows', () => {
  const db = memoryDb();
  for (const [title, text] of [["Azur's Glintstone Staff", AZUR_STAFF], ['Sorceress Sellen', SELLEN_QUEST]] as const) {
    upsertPage(db, { source: 'fandom', title, url: 'u', revid: 1, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext: text, markdown: null, license: 'CC BY-SA 3.0 (eldenring.fandom.com)' });
  }
  runExtractors(db);
  assert.deepEqual(db.prepare('SELECT method, nearest_grace, missable FROM acquisition').get(), { method: 'ground', nearest_grace: 'Debate Parlor', missable: 0 });
  assert.equal((db.prepare("SELECT count(*) AS n FROM quests WHERE npc = 'Sorceress Sellen'").get() as { n: number }).n, 3);
});

// --- shapes found in the first real build (see NOTES.md 2026-09-15) ---

test('quest steps: a flat numbered list has no nested bullets, so each item is its own action', () => {
  const steps = parseQuestSteps(section(LEDA_FLAT_QUEST, 'Questline Progression'));
  assert.equal(steps.length, 3);
  assert.equal(steps[0].location, null);
  assert.match(steps[0].action, /^Defeat both Starscourge Radahn and Mohg/);
  assert.equal(steps[1].step_ord, 2);
  // A flat step that is only a quest-breaker still has to say what to do, so it keeps the sentence
  // in both fields rather than reading as an empty action.
  assert.match(steps[2].action, /will fail the questline/);
  assert.match(String(steps[2].breaks_quest), /will fail the questline/);
});

test('quest steps: step_ord is contiguous after unparsed items are dropped', () => {
  // The first item is empty, so it is dropped; the survivors must still be numbered 1, 2.
  const steps = parseQuestSteps('1. \n1. Liurnia\n  - Speak to her.\n1. Altus Plateau\n  - Hand over the ring.');
  assert.deepEqual(steps.map((s) => s.location), ['Liurnia', 'Altus Plateau']);
  assert.deepEqual(steps.map((s) => s.step_ord), [1, 2]);
});

test('quest steps: a flat item does not swallow the structured item that follows it', () => {
  const steps = parseQuestSteps('1. Speak to him at the Roundtable Hold.\n1. Limgrave\n  - Hand over the letter.');
  assert.deepEqual(steps.map((s) => [s.location, s.action]), [
    [null, 'Speak to him at the Roundtable Hold.'],
    ['Limgrave', 'Hand over the letter.'],
  ]);
});

test('quest extractor accepts "Questline steps" and "<NPC>\'s Quest" headings but not "Quest items"', () => {
  const db = memoryDb();
  upsertPage(db, { source: 'fandom', title: 'Count Ymir', url: 'u', revid: 1, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext: YMIR_QUEST, markdown: null, license: 'l' });
  runExtractors(db);
  const rows = db.prepare('SELECT location, action FROM quests WHERE npc = ? ORDER BY step_ord').all('Count Ymir') as { location: string; action: string }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].location, 'Cathedral of Manus Metyr');
  assert.match(rows[1].action, /Ring the bell/);
  // "Quest items" is an item list, not steps: it must not be picked as the questline section.
  assert.ok(!rows.some((r) => /Hole-Laden Necklace/.test(r.location ?? '')));
});

test('a bare "Quests" stub does not outrank the section holding the real steps', () => {
  const db = memoryDb();
  upsertPage(db, { source: 'fandom', title: 'Jolán, Swordhand of Night', url: 'u', revid: 1, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext: STUB_THEN_STEPS, markdown: null, license: 'l' });
  runExtractors(db);
  const rows = db.prepare('SELECT location, action FROM quests WHERE npc = ? ORDER BY step_ord').all('Jolán, Swordhand of Night') as { location: string; action: string }[];
  assert.equal(rows.length, 3, 'expected the three real steps, not the one-line stub');
  assert.deepEqual(rows.map((r) => r.location), ['Cathedral of Manus Metyr', 'Finger Ruins of Rhia', "Taylew's Ruined Forge"]);
  assert.ok(!rows.some((r) => /questline$/.test(r.action)), 'the stub link was taken as a step');
});

test('quest extractor covers NPCs whose page uses Infobox Boss or Infobox Enemy', () => {
  const db = memoryDb();
  for (const [title, text] of [['Patches', PATCHES_QUEST], ['Eleonora, Violet Bloody Finger', ELEONORA_QUEST]] as const) {
    upsertPage(db, { source: 'fandom', title, url: 'u', revid: 1, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext: text, markdown: null, license: 'l' });
  }
  runExtractors(db);
  const patches = db.prepare('SELECT location, action, breaks_quest FROM quests WHERE npc = ? ORDER BY step_ord').all('Patches') as { location: string; action: string; breaks_quest: string | null }[];
  assert.equal(patches.length, 2);
  assert.equal(patches[0].location, 'Murkwater Cave');
  assert.match(String(patches[0].breaks_quest), /fail the questline/);
  assert.equal(patches[1].location, 'Scenic Isle');
  // Patches is still a boss row; the quest extractor adds to that page, it does not replace it.
  assert.equal((db.prepare("SELECT count(*) AS n FROM bosses WHERE name = 'Patches'").get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT count(*) AS n FROM quests WHERE npc = ?').get('Eleonora, Violet Bloody Finger') as { n: number }).n, 1);
});

test('a boss page with no questline section writes no quest rows', () => {
  const db = memoryDb();
  upsertPage(db, { source: 'fandom', title: 'Red Wolf of Radagon', url: 'u', revid: 1, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext: RED_WOLF, markdown: null, license: 'l' });
  runExtractors(db);
  assert.equal((db.prepare('SELECT count(*) AS n FROM quests').get() as { n: number }).n, 0);
});
