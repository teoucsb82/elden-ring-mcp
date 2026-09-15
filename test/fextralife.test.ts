import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fextralifeUrl, htmlToWikiMarkdown } from '../src/sources/fextralife.js';
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

test('cacheFextralife stores a local-only page with Fextralife license; 404 returns null', async () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), 'er-local-')), 'local.db'));
  const fetchImpl: FetchLike = async (url) => (url.endsWith('Missing+Page') ? ok('', 404) : ok(HTML));
  const id = await cacheFextralife(db, "Azur's Glintstone Staff", { fetchImpl, minIntervalMs: 0, sleep: async () => {} });
  assert.ok(id);
  const row = db.prepare('SELECT source, revid, license, wikitext FROM pages WHERE id = ?').get(id) as Record<string, unknown>;
  assert.deepEqual(row, { source: 'fextralife', revid: null, license: 'All rights reserved (Fextralife). Local cache only; never redistributed.', wikitext: null });
  assert.equal(await cacheFextralife(db, 'Missing Page', { fetchImpl, minIntervalMs: 0, sleep: async () => {} }), null);
});
