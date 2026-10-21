// Caches every Fextralife build page into the LOCAL cache (never data/), then parses it.
// One request every 3s, cached pages skipped, so it is safe to stop and re-run.
// Run: npm run fetch-builds [-- --limit N]
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHttp } from '../src/sources/http.js';
import { USER_AGENT } from '../src/sources/fandom.js';
import { localDbPath, openLocalDb } from '../src/store/local.js';
import { assertLocalTarget, ingestBuilds } from '../src/store/builds-ingest.js';

const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : undefined;
const path = localDbPath();
assertLocalTarget(path);
const logFile = join(dirname(path), 'fetch-builds.log');
const db = openLocalDb(path);
const getText = createHttp({ userAgent: USER_AGENT, minIntervalMs: 3000 });
const report = await ingestBuilds(db, getText, {
  limit,
  log: (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`),
});
console.log(JSON.stringify({ db: path, log: logFile, listed: report.listed, skipped: report.skipped, fetched: report.fetched.length, empty: report.empty, stopped: report.stopped ?? null }));
db.close();
