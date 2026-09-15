import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInfobox } from '../src/wikitext/infobox.js';
import { plainText, wikitextToMarkdown } from '../src/wikitext/markdown.js';
import { splitSections } from '../src/wikitext/sections.js';
import { AZUR_STAFF, COMET_AZUR, GRAVEN_SCHOOL, MALFORMED, RED_WOLF, SELLEN_QUEST } from './fixtures/wikitext.js';

test('findInfobox reads params with spaces/underscores in the template name', () => {
  const box = findInfobox(COMET_AZUR, ['Infobox Item']);
  assert.equal(box?.params.title, 'Comet Azur');
  assert.equal(box?.params.int_req, '60');
  assert.equal(box?.params.obtained, '[[Primeval Sorcerer Azur]]');
});

test('findInfobox keeps pipes inside links', () => {
  const box = findInfobox(AZUR_STAFF, ['Infobox Weapon']);
  assert.equal(box?.params.skills, '[[No Skill]]');
  assert.equal(box?.params.int_scale, 'B');
});

test('findInfobox returns null for missing or unclosed templates', () => {
  assert.equal(findInfobox(AZUR_STAFF, ['Infobox Boss']), null);
  assert.equal(findInfobox(MALFORMED, ['Infobox Weapon']), null);
});

test('wikitextToMarkdown strips templates, tables, categories and converts links/bold/headings/lists', () => {
  const md = wikitextToMarkdown(RED_WOLF);
  assert.ok(!md.includes('{{'));
  assert.ok(!md.includes('article-table'));
  assert.ok(!md.includes('Category'));
  assert.match(md, /## Overview/);
  const graven = wikitextToMarkdown(GRAVEN_SCHOOL);
  assert.match(graven, /\*\*Graven-School Talisman\*\* is a talisman in/);
  assert.match(graven, /- Obtained from a large pile of crystals in Raya Lucaria Academy/);
  assert.ok(!graven.includes('ru:'));
});

test('numbered lists with nested bullets', () => {
  const md = wikitextToMarkdown(SELLEN_QUEST);
  assert.match(md, /^1\. Waypoint Ruins$/m);
  assert.match(md, /^ {2}- Sellen can be found in the cellar/m);
});

test('a <br/> before a list marker still produces a list item', () => {
  const md = wikitextToMarkdown("Drops: Item A<br/>* Item B\n\n'''Bold lead''' stays bold.");
  assert.match(md, /^- Item B$/m);
  assert.match(md, /\*\*Bold lead\*\* stays bold\./);
});

test('plainText flattens inline markup', () => {
  assert.equal(plainText("Boosts [[Comet Azur]] by 15%. Increases {{stat|fp}} [[FP]] consumption"), 'Boosts Comet Azur by 15%. Increases FP consumption');
});

test('splitSections names the lead "Summary" and keeps heading order', () => {
  const sections = splitSections(wikitextToMarkdown(AZUR_STAFF));
  assert.deepEqual(sections.map((s) => s.heading), ['Summary', 'Acquisition']);
  assert.match(sections[1].markdown, /Debate Parlor site of grace/);
  assert.deepEqual(sections.map((s) => s.ord), [0, 1]);
});
