// Writes data/ATTRIBUTION.md: one line per shipped page with its URL and revision, as CC BY-SA requires.
// Run: npm run attribution
import { writeFileSync } from 'node:fs';
import { openDb } from '../src/db/open.js';
import { DEFAULT_DB_PATH } from '../src/store/pages.js';

const db = openDb(process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH, { readonly: true });
const rows = db.prepare("SELECT title, url, revid FROM pages WHERE source = 'fandom' ORDER BY title").all() as { title: string; url: string; revid: number }[];
writeFileSync('data/ATTRIBUTION.md', [
  '# Attribution',
  '',
  `Text in \`elden-ring.db\` is adapted from the Elden Ring Wiki at Fandom (https://eldenring.fandom.com), licensed CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/). Authors are listed in each page's history. Converted from wikitext to markdown and parsed into tables.`,
  '',
  ...rows.map((r) => `- [${r.title}](${r.url}) (revision ${r.revid})`),
  '',
].join('\n'));
console.log(`attributed ${rows.length} pages`);
