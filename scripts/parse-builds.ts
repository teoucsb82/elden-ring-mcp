// Re-parses cached Fextralife build pages from stored HTML (no network). Use after changing src/extract/build.ts.
// Run: npm run parse-builds
import { localDbPath, openLocalDb } from '../src/store/local.js';
import { reparseBuilds } from '../src/store/builds-ingest.js';

const db = openLocalDb(localDbPath());
const report = reparseBuilds(db);
console.log(JSON.stringify({ pages: report.pages, rows: report.rows, failures: report.failures }));
db.close();
