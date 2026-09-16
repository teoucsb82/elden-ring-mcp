// Refreshes only the Shadow of the Erdtree category membership (a bounded crawl: one root category,
// a handful of subcategories) and re-runs the classifier. Use it when the snapshot predates the
// category crawl, or when the wiki's categories changed but nothing else did.
// Run: npm run sync-categories
import { openDb } from '../src/db/open.js';
import { classifyDlc } from '../src/extract/dlc.js';
import { createFandom } from '../src/sources/fandom.js';
import { DEFAULT_DB_PATH, replaceDlcCategories } from '../src/store/pages.js';
import { printDlcReport } from './report.js';

const db = openDb(process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH);
const titles = await createFandom().listDlcCategoryTitles();
replaceDlcCategories(db, titles);
console.log(`dlc category titles: ${titles.length}`);
printDlcReport(classifyDlc(db));
db.close();
