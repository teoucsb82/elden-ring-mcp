// Sync changed Fandom pages, re-extract only those pages, and prepend a dated entry to data/CHANGELOG-data.md.
// Run: npm run build
import { readFileSync, writeFileSync } from 'node:fs';
import { diffSnapshots, formatChangelog, snapshotRows } from '../src/changelog.js';
import { openDb } from '../src/db/open.js';
import { classifyDlc } from '../src/extract/dlc.js';
import { runExtractors } from '../src/extract/run.js';
import { createFandom } from '../src/sources/fandom.js';
import { DEFAULT_DB_PATH } from '../src/store/pages.js';
import { syncFandom } from '../src/sync.js';
import { printDlcReport } from './report.js';

const CHANGELOG = 'data/CHANGELOG-data.md';
const db = openDb(process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH);

const before = snapshotRows(db);
const sync = await syncFandom(db, createFandom(), (message) => console.log(message));
const touched = [...sync.added, ...sync.changed]
  .map((title) => (db.prepare("SELECT id FROM pages WHERE source = 'fandom' AND title = ?").get(title) as { id: number } | undefined)?.id)
  .filter((id): id is number => id !== undefined);
const extract = runExtractors(db, { pageIds: touched });
const diff = diffSnapshots(before, snapshotRows(db));

const date = new Date().toISOString().slice(0, 10);
const [title, intro, ...rest] = readFileSync(CHANGELOG, 'utf8').split('\n\n');
const entry = formatChangelog(date, sync, diff, extract.failures.length).trimEnd();
writeFileSync(CHANGELOG, [title, intro, entry, ...rest].join('\n\n'));
console.log(JSON.stringify({ touched: touched.length, rows: extract.rows, failures: extract.failures.length, fieldChanges: diff.changed.length }));

printDlcReport(classifyDlc(db));

db.exec('VACUUM');
db.close();
