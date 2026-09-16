import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FEXTRALIFE_PAGE_LIMIT, fetchFextralife, fextralifeUrl, htmlToWikiMarkdown, resetFextralifeSession } from '../src/sources/fextralife.js';
import { cacheFextralife, localDbPath, openLocalDb } from '../src/store/local.js';
import type { FetchLike } from '../src/sources/http.js';

const HTML = `<html><body><div id="sidebar">ads</div>
<div id="wiki-content-block">
<h2>Where to find Azur's Glintstone Staff</h2>
<ul><li>Raya Lucaria Academy</li><li>Nearest grace: <a href="/Church+of+the+Cuckoo">Church of the Cuckoo</a></li></ul>
<h3 class="bonfire">Notes</h3><p>Reduces casting time.</p>
<script>track()</script>
</div></body></html>`;

const ok = (body: string, status = 200) => ({ status, headers: { get: () => null }, text: async () => body });

test('fextralifeUrl uses + for spaces', () => {
  assert.equal(fextralifeUrl("Azur's Glintstone Staff"), "https://eldenring.wiki.fextralife.com/Azur's+Glintstone+Staff");
});

test('fextralifeUrl percent-encodes path, query and fragment characters', () => {
  assert.equal(fextralifeUrl('Weird/Title?x=1#frag'), 'https://eldenring.wiki.fextralife.com/Weird%2FTitle%3Fx%3D1%23frag');
  assert.equal(fextralifeUrl('../secret'), 'https://eldenring.wiki.fextralife.com/..%2Fsecret');
});

test('htmlToWikiMarkdown keeps only the content block with atx headings and no scripts', () => {
  const md = htmlToWikiMarkdown(HTML)!;
  assert.match(md, /^## Where to find Azur's Glintstone Staff/m);
  assert.match(md, /^### Notes/m);
  assert.match(md, /Nearest grace: \[Church of the Cuckoo\]/);
  assert.ok(!md.includes('ads'));
  assert.ok(!md.includes('track()'));
  assert.equal(htmlToWikiMarkdown('<html><body>nope</body></html>'), null);
});

test('localDbPath honors ELDEN_RING_MCP_CACHE', () => {
  const previous = process.env.ELDEN_RING_MCP_CACHE;
  process.env.ELDEN_RING_MCP_CACHE = '/tmp/er-cache';
  assert.equal(localDbPath(), '/tmp/er-cache/local.db');
  if (previous === undefined) delete process.env.ELDEN_RING_MCP_CACHE; else process.env.ELDEN_RING_MCP_CACHE = previous;
});

// The 1 request/second floor is the anti-bulk-crawl guard, so it has to live across calls: a fresh
// client per fetch let N consecutive `fetch: true` tool calls fire N unthrottled requests.
test('consecutive fetchFextralife calls share one rate limiter', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  resetFextralifeSession({
    fetchImpl: async () => { calls++; return ok(HTML); },
    sleep: async (ms) => { sleeps.push(ms); },
    minIntervalMs: 1000,
  });
  await fetchFextralife('Page One');
  await fetchFextralife('Page Two');
  assert.equal(calls, 2);
  assert.equal(sleeps.length, 1, `the second call must wait; sleeps were ${sleeps.join(',')}`);
  assert.ok(sleeps[0] >= 900, `expected a ~1s wait, got ${sleeps[0]}`);
  resetFextralifeSession();
});

test('one server process caps how many Fextralife pages it will fetch', async () => {
  resetFextralifeSession({ fetchImpl: async () => ok(HTML), sleep: async () => {}, minIntervalMs: 0 });
  for (let i = 0; i < FEXTRALIFE_PAGE_LIMIT; i++) assert.ok(await fetchFextralife(`Page ${i}`));
  await assert.rejects(fetchFextralife('One Too Many'), /limit/i);
  resetFextralifeSession();
});

test('cacheFextralife stores a local-only page with Fextralife license; 404 returns null', async () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), 'er-local-')), 'local.db'));
  const fetchImpl: FetchLike = async (url) => (url.endsWith('Missing+Page') ? ok('', 404) : ok(HTML));
  const id = await cacheFextralife(db, "Azur's Glintstone Staff", { fetchImpl, minIntervalMs: 0, sleep: async () => {} });
  assert.ok(id);
  const row = db.prepare('SELECT source, revid, license, wikitext FROM pages WHERE id = ?').get(id) as Record<string, unknown>;
  assert.deepEqual(row, { source: 'fextralife', revid: null, license: 'All rights reserved (Fextralife). Local cache only; never redistributed.', wikitext: null });
  assert.equal(await cacheFextralife(db, 'Missing Page', { fetchImpl, minIntervalMs: 0, sleep: async () => {} }), null);
});
