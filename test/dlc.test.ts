import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyDlc, classifyPage, loadOverrides, type Overrides } from '../src/extract/dlc.js';
import { runExtractors } from '../src/extract/run.js';
import type { PageRow } from '../src/extract/types.js';
import { memoryDb } from './helpers.js';

const insert = (db: ReturnType<typeof memoryDb>, title: string, wikitext: string) =>
  db.prepare('INSERT INTO pages (source, title, url, fetched_at, license, wikitext) VALUES (?,?,?,?,?,?)')
    .run('fandom', title, `https://x/${title}`, 'now', 'CC BY-SA 3.0', wikitext);

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

test('classifyDlc labels every page and reports the signals', () => {
  const db = memoryDb();
  insert(db, 'Verdigris Armor', 'Added in the {{SotE}} expansion.');
  insert(db, 'Icerind Hatchet', '{{Infobox Weapon}}');
  insert(db, 'Weapons', 'Includes {{SotE}} armaments.');
  db.prepare('INSERT INTO dlc_categories (title) VALUES (?)').run('Scadu Altus');
  insert(db, 'Scadu Altus', 'A region.');

  const report = classifyDlc(db, { overrides: { dlc: ['Rellana, Twin Moon Knight'], base: ['Weapons'] } });

  assert.equal(report.pages, 4);
  assert.equal(report.dlc, 2);
  assert.equal(report.hasDlcSections, 1);
  assert.equal(report.bySignal.sote_template, 1);
  assert.equal(report.bySignal.category, 1);

  const row = (title: string) => db.prepare('SELECT dlc, has_dlc_sections, dlc_signals FROM pages WHERE title = ?').get(title) as
    { dlc: number; has_dlc_sections: number; dlc_signals: string | null };
  assert.equal(row('Verdigris Armor').dlc, 1);
  assert.deepEqual(JSON.parse(row('Verdigris Armor').dlc_signals ?? '[]'), ['sote_template']);
  assert.equal(row('Icerind Hatchet').dlc, 0);
  assert.equal(row('Weapons').dlc, 0);
  assert.equal(row('Weapons').has_dlc_sections, 1);
  assert.equal(row('Scadu Altus').dlc, 1);
});

test('classifyDlc records ambiguous pages without marking them dlc', () => {
  const db = memoryDb();
  insert(db, 'Armor Sets', 'Lists {{SotE}} sets.');
  const report = classifyDlc(db, { overrides: { dlc: [], base: ['Armor Sets'] } });
  assert.deepEqual(report.ambiguous, ['Armor Sets']);
  assert.equal((db.prepare('SELECT dlc FROM pages WHERE title = ?').get('Armor Sets') as { dlc: number }).dlc, 0);
});

test('classifyDlc writes a dlc_report row per signal', () => {
  const db = memoryDb();
  insert(db, 'Verdigris Armor', '{{SotE}}');
  classifyDlc(db, { overrides: { dlc: [], base: [] }, now: () => new Date('2026-09-15T00:00:00.000Z') });
  const rows = db.prepare('SELECT signal, hits, at FROM dlc_report ORDER BY signal').all() as { signal: string; hits: number; at: string }[];
  assert.ok(rows.some((r) => r.signal === 'sote_template' && r.hits === 1));
  assert.ok(rows.every((r) => r.at === '2026-09-15T00:00:00.000Z'));
});

test('classifyDlc is idempotent', () => {
  const db = memoryDb();
  insert(db, 'Verdigris Armor', '{{SotE}}');
  const first = classifyDlc(db, { overrides: { dlc: [], base: [] } });
  const second = classifyDlc(db, { overrides: { dlc: [], base: [] } });
  assert.deepEqual(first.bySignal, second.bySignal);
  assert.equal((db.prepare('SELECT count(*) AS n FROM dlc_report').get() as { n: number }).n, second.pages > 0 ? 5 : 0);
});

test('classification survives a re-extract', () => {
  const db = memoryDb();
  insert(db, 'Verdigris Armor', 'Added in the {{SotE}} expansion.');
  classifyDlc(db, { overrides: { dlc: [], base: [] } });
  assert.equal((db.prepare('SELECT dlc FROM pages WHERE title = ?').get('Verdigris Armor') as { dlc: number }).dlc, 1);

  // runExtractors clears derived tables per page; pages.dlc is not one of them and must survive.
  runExtractors(db);
  assert.equal((db.prepare('SELECT dlc FROM pages WHERE title = ?').get('Verdigris Armor') as { dlc: number }).dlc, 1);
});
