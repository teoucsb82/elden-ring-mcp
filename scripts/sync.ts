// Pulls new/changed Fandom pages into data/elden-ring.db. Safe to re-run; unchanged pages are not fetched.
// Run: npm run sync
import { openDb } from '../src/db/open.js';
import { classifyDlc } from '../src/extract/dlc.js';
import { createFandom } from '../src/sources/fandom.js';
import { DEFAULT_DB_PATH } from '../src/store/pages.js';
import { syncFandom } from '../src/sync.js';
import { printDlcReport } from './report.js';

const db = openDb(process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH);
const report = await syncFandom(db, createFandom(), (message) => console.log(message));
console.log(JSON.stringify({ added: report.added.length, changed: report.changed.length, removed: report.removed.length, unchanged: report.unchanged }));

printDlcReport(classifyDlc(db));
db.close();
