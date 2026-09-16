// Re-runs all extractors over every page in the db (use after changing an extractor).
// Run: npm run extract
import { openDb } from '../src/db/open.js';
import { classifyDlc } from '../src/extract/dlc.js';
import { runExtractors } from '../src/extract/run.js';
import { DEFAULT_DB_PATH } from '../src/store/pages.js';
import { printDlcReport } from './report.js';

const db = openDb(process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH);
const report = runExtractors(db);
console.log(JSON.stringify({ pages: report.pages, rows: report.rows, failures: report.failures.length }, null, 2));
for (const failure of report.failures.slice(0, 50)) console.log(`FAIL ${failure.extractor} ${failure.title}: ${failure.error}`);

printDlcReport(classifyDlc(db));
db.close();
