import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { openDb } from '../src/db/open.js';
import { whereIs } from '../src/query/lookups.js';

const DB_PATH = 'data/elden-ring.db';
const hasDb = existsSync(DB_PATH);

/**
 * A bound in both directions. The old floor-only assertion could catch under-labelling alone, while
 * over-labelling is what the classifier actually did: {{SotE}} read as a page marker labelled 857
 * pages, 239 of them base-game. Measured on the 2026-09-16 snapshot after the predicate-form rules
 * landed: 756 dlc (661 sote_template, 69 sote_link, 22 title_suffix, 123 category, 7 override) and
 * 273 has_dlc_sections. The jump from 622 is the two spellings the template rule could not see,
 * {{in|se}} and the plain ''[[Elden Ring: Shadow of the Erdtree]]'' link.
 * A change that moves either materially should have to say so here.
 */
test('the shipped db classifies a plausible share of pages as dlc', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  const dlc = (db.prepare('SELECT count(*) AS n FROM pages WHERE dlc = 1').get() as { n: number }).n;
  const total = (db.prepare('SELECT count(*) AS n FROM pages').get() as { n: number }).n;
  assert.ok(dlc >= 716, `expected at least 716 dlc pages, got ${dlc} of ${total} - a marker spelling has probably stopped being read`);
  assert.ok(dlc <= 796, `expected at most 796 dlc pages, got ${dlc} of ${total} - the predicate-form requirement has probably regressed`);
  db.close();
});

/**
 * has_dlc_sections can only be true once a base page is allowed to contain {{SotE}} at all. While the
 * template was read as a page marker the flag was unreachable outside the override branch, so a
 * count in the hundreds is the load-bearing evidence that the classifier separates "is dlc" from
 * "mentions dlc".
 */
test('base pages that mention the dlc are flagged, not relabelled', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  const flagged = (db.prepare('SELECT count(*) AS n FROM pages WHERE has_dlc_sections = 1').get() as { n: number }).n;
  assert.ok(flagged >= 200, `expected 200+ base pages flagged as mentioning dlc, got ${flagged}`);
  // The flag is about base-game pages; a dlc page is dlc, it does not "mention" itself.
  const contradictory = (db.prepare('SELECT count(*) AS n FROM pages WHERE has_dlc_sections = 1 AND dlc = 1').get() as { n: number }).n;
  assert.equal(contradictory, 0, 'has_dlc_sections must never be set on a page already labelled dlc');
  for (const title of ['Flask of Crimson Tears', 'Arcane', 'Ash of War: Quickstep']) {
    const row = db.prepare('SELECT has_dlc_sections FROM pages WHERE title = ?').get(title) as { has_dlc_sections: number };
    assert.equal(row.has_dlc_sections, 1, `${title} mentions the dlc and must say so`);
  }
  db.close();
});

test('known hub pages are never classified as dlc', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  const hubs = ['Weapons', 'Armor Sets', 'Talismans', 'Bosses'];
  for (const title of hubs) {
    const row = db.prepare('SELECT dlc FROM pages WHERE title = ?').get(title) as { dlc: number } | undefined;
    if (row) assert.equal(row.dlc, 0, `${title} must stay base game`);
  }
  db.close();
});

/**
 * The live consequence, end to end on the real snapshot rather than a fixture: the default mode must
 * answer about a base-game flask, and must still gate a DLC armor set. This is the assertion that
 * fails the moment the classifier over-labels again.
 */
test('the default mode answers about base-game pages and still gates dlc pages', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const shipped = openDb(DB_PATH, { readonly: true });
  const dbs = { shipped, local: null };

  const flask = whereIs(dbs, 'Flask of Crimson Tears') as { not_found?: true; provenance?: { title: string }; dlc?: boolean };
  assert.equal(flask.not_found, undefined, 'base mode must answer about the Flask of Crimson Tears');
  assert.equal(flask.provenance?.title, 'Flask of Crimson Tears');
  assert.equal(flask.dlc, false);

  const armor = whereIs(dbs, 'Verdigris Armor') as { reason?: string; page?: string; match?: string };
  assert.equal(armor.reason, 'dlc_filtered');
  assert.equal(armor.page, 'Verdigris Armor');
  assert.equal(armor.match, 'exact', 'an exact-title gate must say it resolved the name exactly');

  shipped.close();
});

/**
 * One pin per marker spelling the classifier has to read, so a rule that silently stops seeing one
 * fails here by name rather than as a drift in the bounds test: {{in|se}} (Beast Claw (weapon)), the
 * plain link (Great Katana) and the italicised link (Milady, Putrescent Knight). Cocoon of the
 * Empyrean and Moangrave are DLC-only pages whose leads say "in {{ER}} and {{SotE}}" — no rule can
 * tell that from a genuine both-products claim, so they are corrected in the override file.
 * Realm of Shadow is the same story: its lead reads "the setting of the DLC expansion for {{ER}},
 * {{SotE}}", a coordinate product TITLE, and it too lives in the override file.
 */
test('known dlc pages are classified as dlc', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  for (const title of ['Verdigris Armor', 'Messmer the Impaler', 'Scadu Altus', 'Rellana, Twin Moon Knight', 'Realm of Shadow',
    'Milady', 'Great Katana', 'Putrescent Knight', 'Backhand Blade', 'Midra, Lord of Frenzied Flame', 'Beast Claw (weapon)',
    'Cocoon of the Empyrean', 'Moangrave']) {
    const row = db.prepare('SELECT dlc FROM pages WHERE title = ?').get(title) as { dlc: number } | undefined;
    assert.ok(row, `${title} must exist in the snapshot`);
    assert.equal(row.dlc, 1, `${title} must be classified as dlc`);
  }
  db.close();
});

/**
 * Every title here was labelled dlc by a shipped classifier at some point, and each is a different
 * shape of the same mistake: a {{SotE}} tagging a linked DLC item inside a base-game list (Flask of
 * Crimson Tears, Ash of War: Quickstep, Arcane), a lead naming both products (Statues, Bell Bearings;
 * Starscourge Radahn corrected through the override file), a lead that negates ("not implemented in
 * {{ER}} or {{SotE}}" — Unused Content), one that lists the products as coordinates (Godslayer
 * Incantations, Death Sorcery, Paintings) and a patch note (Game Version/1.15). Under the old
 * classifier where_is("Flask of Crimson Tears") answered "is Shadow of the Erdtree content" with no
 * opt-in, and six base-game pages were hidden outright in the default mode.
 */
test('base-game pages that merely link dlc items are not classified as dlc', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  for (const title of ['Flask of Crimson Tears', 'Ash of War: Quickstep', 'Ash of War: Lion\'s Claw', 'Arcane', 'Ammunition', 'Katanas', 'Greataxes', 'Curved Sword Talisman', 'Bloodrose', 'Albinaurics', 'Sorcerers', 'Statues', 'Starscourge Radahn', 'Bell Bearings', 'Claw Talisman',
    'Godslayer Incantations', 'Death Sorcery', 'Game Version/1.15', 'Paintings', 'Unused Content', 'Works and Adaptations']) {
    const row = db.prepare('SELECT dlc FROM pages WHERE title = ?').get(title) as { dlc: number } | undefined;
    assert.ok(row, `${title} must exist in the snapshot`);
    assert.equal(row.dlc, 0, `${title} is base-game content and must not be dlc-gated by default`);
  }
  db.close();
});

test('known base pages are not classified as dlc', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  for (const title of ['Icerind Hatchet', 'Godrick the Grafted', 'Stormveil Castle']) {
    const row = db.prepare('SELECT dlc FROM pages WHERE title = ?').get(title) as { dlc: number } | undefined;
    assert.ok(row, `${title} must exist in the snapshot`);
    assert.equal(row.dlc, 0, `${title} must stay base game`);
  }
  db.close();
});

// dlc_categories was empty in the first shipped snapshot (synced two hours before the crawl
// landed), so the category signal had only ever fired in synthetic unit tests.
test('the shipped db carries category membership and the category signal fired', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  const titles = (db.prepare('SELECT count(*) AS n FROM dlc_categories').get() as { n: number }).n;
  assert.ok(titles >= 60, `expected 60+ dlc category titles (Locations alone has 64 live), got ${titles}`);
  const hits = (db.prepare("SELECT hits FROM dlc_report WHERE signal = 'category'").get() as { hits: number }).hits;
  assert.ok(hits >= 50, `expected the category signal to fire on 50+ pages, got ${hits}`);
  db.close();
});
