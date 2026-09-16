// Downloads data/elden-ring.db from the newest GitHub release tagged data-*.
// Run: npm run fetch-data   (set ELDEN_RING_MCP_REPO=owner/name if not the default remote)
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
const releases = await (await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers: { Accept: 'application/vnd.github+json' } })).json() as { tag_name: string; assets: { name: string; browser_download_url: string }[] }[];
const release = releases.find((r) => r.tag_name.startsWith('data-'));
const asset = release?.assets.find((a) => a.name === 'elden-ring.db');
if (!release || !asset) { console.error(`No data-* release with elden-ring.db in ${repo}`); process.exit(1); }
const bytes = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
mkdirSync('data', { recursive: true });
writeFileSync(DEFAULT_DB_PATH, bytes);
console.log(`downloaded ${release.tag_name} (${(bytes.length / 1e6).toFixed(1)} MB) to ${DEFAULT_DB_PATH}`);
