// Downloads data/elden-ring.db from the newest GitHub release tagged data-*.
// Run: npm run fetch-data   (set ELDEN_RING_MCP_REPO=owner/name if not the default remote)
// Exit codes: 0 downloaded, 2 no data-* release exists yet (expected before the first publish),
// 1 something went wrong (API error, bad response, failed download). Callers must treat 1 as fatal:
// swallowing it turns a transient GitHub error into a silent full re-crawl of every page.
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_DB_PATH } from '../src/store/pages.js';

function resolveRepo(): string {
  if (process.env.ELDEN_RING_MCP_REPO) return process.env.ELDEN_RING_MCP_REPO;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const repo = url.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
    if (/^[^/]+\/[^/]+$/.test(repo)) return repo;
  } catch {
    // no "origin" remote (or `git` unavailable) - fall through to the error below
  }
  console.error('Set ELDEN_RING_MCP_REPO=owner/name (no git remote "origin" found)');
  process.exit(1);
}

const repo = resolveRepo();
const listUrl = `https://api.github.com/repos/${repo}/releases?per_page=30`;
const listResponse = await fetch(listUrl, { headers: { Accept: 'application/vnd.github+json' } });
if (!listResponse.ok) { console.error(`GitHub API ${listResponse.status} for ${listUrl}`); process.exit(1); }
const body: unknown = await listResponse.json();
if (!Array.isArray(body)) { console.error(`Unexpected GitHub API response for ${listUrl}: ${JSON.stringify(body).slice(0, 200)}`); process.exit(1); }
const releases = body as { tag_name: string; assets: { name: string; browser_download_url: string }[] }[];
const release = releases.find((r) => r.tag_name.startsWith('data-'));
const asset = release?.assets.find((a) => a.name === 'elden-ring.db');
// No release yet is a normal first run; an API failure above is not, and already exited 1.
if (!release || !asset) { console.error(`No data-* release with elden-ring.db in ${repo}`); process.exit(2); }
const download = await fetch(asset.browser_download_url);
if (!download.ok) { console.error(`Download failed: HTTP ${download.status} for ${asset.browser_download_url}`); process.exit(1); }
const bytes = Buffer.from(await download.arrayBuffer());
mkdirSync('data', { recursive: true });
writeFileSync(DEFAULT_DB_PATH, bytes);
console.log(`downloaded ${release.tag_name} (${(bytes.length / 1e6).toFixed(1)} MB) to ${DEFAULT_DB_PATH}`);

// The server opens this file read-only, which skips the column migration, so a release built before
// the dlc columns leaves every tool answering data_stale. Say so here, where the fix is one command,
// rather than leaving the user to discover it at query time. Not fatal: the download itself worked.
const downloaded = new Database(DEFAULT_DB_PATH, { readonly: true });
const hasDlc = (downloaded.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).some((c) => c.name === 'dlc');
downloaded.close();
if (!hasDlc) console.error(`warning: ${release.tag_name} predates the dlc columns; run npm run extract before starting the server`);
