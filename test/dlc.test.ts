import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyPage, loadOverrides, type Overrides } from '../src/extract/dlc.js';
import type { PageRow } from '../src/extract/types.js';

const page = (title: string, wikitext: string | null): PageRow => ({ id: 1, source: 'fandom', title, wikitext });
const noOverrides: Overrides = { dlc: [], base: [] };
const ctx = (overrides = noOverrides, titles: string[] = []) => ({ overrides, dlcCategoryTitles: new Set(titles) });

test('the SotE template marks a page as dlc', () => {
  const result = classifyPage(page('Verdigris Armor', '{{Infobox Armor}}\nAdded in the {{SotE}} expansion.'), ctx());
  assert.equal(result.dlc, true);
  assert.deepEqual(result.signals, ['sote_template']);
});

test('a page with no signal is base game', () => {
  const result = classifyPage(page('Icerind Hatchet', '{{Infobox Weapon\n| type = Axe\n}}'), ctx());
  assert.equal(result.dlc, false);
  assert.deepEqual(result.signals, []);
  assert.equal(result.hasDlcSections, false);
});

test('a title suffix marks a page as dlc', () => {
  const result = classifyPage(page('Sorceries (Shadow of the Erdtree)', 'list'), ctx());
  assert.equal(result.dlc, true);
  assert.ok(result.signals.includes('title_suffix'));
});

test('dlc category membership marks a page as dlc', () => {
  const result = classifyPage(page('Scadu Altus', 'A region.'), ctx(noOverrides, ['Scadu Altus']));
  assert.equal(result.dlc, true);
  assert.ok(result.signals.includes('category'));
});

test('a hub page that lists dlc items stays base and is flagged', () => {
  const result = classifyPage(page('Weapons', 'Includes {{SotE}} armaments.'), ctx({ dlc: [], base: ['Weapons'] }));
  assert.equal(result.dlc, false);
  assert.ok(result.signals.includes('hub_page'));
  assert.equal(result.hasDlcSections, true);
});

test('an override forces dlc where no signal fires', () => {
  const result = classifyPage(page('Rellana, Twin Moon Knight', 'A boss.'), ctx({ dlc: ['Rellana, Twin Moon Knight'], base: [] }));
  assert.equal(result.dlc, true);
  assert.deepEqual(result.signals, ['override']);
});

test('a base override beats the template', () => {
  const result = classifyPage(page('Armor Sets', 'Lists {{SotE}} sets.'), ctx({ dlc: [], base: ['Armor Sets'] }));
  assert.equal(result.dlc, false);
  assert.equal(result.hasDlcSections, true);
});

test('overrides are matched case-insensitively', () => {
  const result = classifyPage(page('Rellana, Twin Moon Knight', ''), ctx({ dlc: ['rellana, twin moon knight'], base: [] }));
  assert.equal(result.dlc, true);
});

test('a null wikitext page classifies without throwing', () => {
  const result = classifyPage(page('Empty', null), ctx());
  assert.equal(result.dlc, false);
});

test('loadOverrides reads the committed file', () => {
  const overrides = loadOverrides();
  assert.ok(Array.isArray(overrides.dlc));
  assert.ok(Array.isArray(overrides.base));
  assert.ok(overrides.dlc.includes('Rellana, Twin Moon Knight'));
});

test('loadOverrides returns empty lists when the file is absent', () => {
  const overrides = loadOverrides('/nonexistent/dlc-overrides.json');
  assert.deepEqual(overrides, { dlc: [], base: [] });
});

test('loadOverrides resolves a path with a space, the way an npm install path can', () => {
  // Mirrors how DEFAULT_OVERRIDES_PATH is built: a file:// URL (which percent-encodes the
  // space) converted back with fileURLToPath. .pathname would leave a literal %20 and ENOENT.
  const dir = mkdtempSync(path.join(tmpdir(), 'dlc overrides '));
  const file = path.join(dir, 'dlc-overrides.json');
  writeFileSync(file, JSON.stringify({ dlc: ['Spaced Boss'], base: [] }));

  const resolved = fileURLToPath(pathToFileURL(file));
  assert.ok(!resolved.includes('%20'));
  assert.deepEqual(loadOverrides(resolved), { dlc: ['Spaced Boss'], base: [] });
});

test('loadOverrides throws on malformed JSON instead of silently reverting to empty', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dlc-bad-json-'));
  const file = path.join(dir, 'dlc-overrides.json');
  writeFileSync(file, '{ not valid json');
  assert.throws(() => loadOverrides(file), /dlc overrides file at .* is not valid JSON/);
});

test('loadOverrides throws when the file is valid JSON but not an object', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dlc-bad-shape-'));
  const file = path.join(dir, 'dlc-overrides.json');
  writeFileSync(file, '[1, 2, 3]');
  assert.throws(() => loadOverrides(file), /must contain a JSON object/);
});

test('loadOverrides tolerates a wrong-typed dlc/base key without throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dlc-bad-field-'));
  const file = path.join(dir, 'dlc-overrides.json');
  writeFileSync(file, JSON.stringify({ dlc: 'not-an-array', base: null }));
  assert.deepEqual(loadOverrides(file), { dlc: [], base: [] });
});
