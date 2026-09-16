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

// Pages that cover several variants (Magma Wyrm, many bosses and armor sets) wrap them in Fandom's
// <tabber>. The first real build left "<tabber>" and "|-|Makar=" in the text as literal prose and
// gave the tab's content no heading of its own.
test('tabber tabs become headings instead of leaking markup', () => {
  const markdown = wikitextToMarkdown(`==Bosses==
<tabber>
|-|Magma Wyrm Makar=
Makar blocks the path from Liurnia to the Altus Plateau.
|-|Mt. Gelmir=
A Magma Wyrm is encountered in a lava pool near [[Fort Laiedd]].
</tabber>`);
  assert.doesNotMatch(markdown, /tabber|\|-\|/);
  const sections = splitSections(markdown);
  assert.deepEqual(sections.map((s) => s.heading), ['Magma Wyrm Makar', 'Mt. Gelmir']);
  assert.match(sections[0].markdown, /^Makar blocks the path/);
  assert.match(sections[1].markdown, /Fort Laiedd/);
});

test('a line starting with |-| but carrying no label is not turned into a heading', () => {
  const markdown = wikitextToMarkdown('|-| stray marker with no equals\nOrdinary prose.');
  assert.doesNotMatch(markdown, /^#/m);
  assert.match(markdown, /^\|-\| stray marker with no equals$/m);
});

// </tabber> ends the tabbed region. Prose after it belongs to the enclosing section, not to the
// last tab, or boss/search will quote unrelated text as that tab's content.
test('prose after </tabber> is not attributed to the last tab', () => {
  const sections = splitSections(wikitextToMarkdown(`==Bosses==
<tabber>
|-|Magma Wyrm Makar=
Makar blocks the path to the Altus Plateau.
|-|Mt. Gelmir=
A Magma Wyrm waits in a lava pool near Fort Laiedd.
</tabber>
All Magma Wyrms drop a Dragon Heart.`));
  const makar = sections.find((s) => s.heading === 'Magma Wyrm Makar')!;
  const gelmir = sections.find((s) => s.heading === 'Mt. Gelmir')!;
  assert.doesNotMatch(makar.markdown, /Dragon Heart/);
  assert.doesNotMatch(gelmir.markdown, /Dragon Heart/, 'trailing prose was filed under the last tab');
  assert.equal(gelmir.markdown, 'A Magma Wyrm waits in a lava pool near Fort Laiedd.');
  assert.ok(sections.some((s) => s.heading === 'Bosses' && /Dragon Heart/.test(s.markdown)), 'trailing prose should return to the enclosing section');
});

// Location pages write the same tab label across two lines, which the single-line form missed.
test('tabber tab label split across two lines still becomes a heading', () => {
  const sections = splitSections(wikitextToMarkdown(`== Sites of Grace ==
<tabber>

|-|
Artist's Shack  =

{{Infobox Location
|title = Artist's Shack
}}

Found just outside the shack.

</tabber>`));
  assert.deepEqual(sections.map((s) => s.heading), ["Artist's Shack"]);
  assert.equal(sections[0].markdown, 'Found just outside the shack.');
});
