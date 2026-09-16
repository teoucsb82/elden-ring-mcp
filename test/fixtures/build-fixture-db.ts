import { openDb, type Db } from '../../src/db/open.js';
import { runExtractors } from '../../src/extract/run.js';
import { recordSync, replaceRedirects, upsertPage } from '../../src/store/pages.js';
import { AZUR_CROWN, AZUR_STAFF, COMET_AZUR, GRAVEN_SCHOOL, NO_REQ_WEAPON, NO_SECTIONS, RED_WOLF, SELLEN_QUEST, UCHIGATANA } from './wikitext.js';

export const FIXTURE_PAGES: [string, string][] = [
  ["Azur's Glintstone Staff", AZUR_STAFF], ['Comet Azur', COMET_AZUR], ['Graven-School Talisman', GRAVEN_SCHOOL],
  ["Azur's Glintstone Crown", AZUR_CROWN], ['Red Wolf of Radagon', RED_WOLF], ['Sorceress Sellen', SELLEN_QUEST],
  ['Uchigatana', UCHIGATANA], ["Celebrant's Skull", NO_REQ_WEAPON], ['Flamespitter', NO_SECTIONS],
];

/** Small shipped-style db used by query tests and the MCP smoke test. The Makar redirect reuses Red Wolf content to exercise fragments. */
export function buildFixtureDb(path = ':memory:'): Db {
  const db = openDb(path);
  for (const [title, wikitext] of FIXTURE_PAGES) {
    upsertPage(db, { source: 'fandom', title, url: `https://eldenring.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`, revid: 100, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext, markdown: null, license: 'CC BY-SA 3.0 (eldenring.fandom.com)' });
  }
  replaceRedirects(db, 'fandom', [{ from: 'Magma Wyrm Makar', to: 'Red Wolf of Radagon', fragment: 'Overview' }]);
  runExtractors(db);
  recordSync(db, 'fandom', FIXTURE_PAGES.length, new Date('2026-09-15T00:00:00Z'));
  return db;
}
