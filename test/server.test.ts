import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { compact } from '../src/server/compact.js';
import { buildFixtureDb } from './fixtures/build-fixture-db.js';

// Isolate the local cache db this import opens as a side effect, so the test never touches the real
// ~/.cache/elden-ring-mcp used by an actual `npm run mcp` — even for a developer who has that env var
// exported already. Plain `=`, not `??=`: this must win unconditionally, not defer to it.
process.env.ELDEN_RING_MCP_CACHE = mkdtempSync(join(tmpdir(), 'er-server-test-'));

// mcp-server.ts never starts stdio just by being imported — only its exported startStdio() does
// that (see src/server/start.ts) — so importing it here for `server` and `INSTRUCTIONS` is
// side-effect-free beyond opening the dbs above.
const { server, INSTRUCTIONS } = await import('../src/server/mcp-server.js');

/** Lists the server's registered tools over a same-process (in-memory) MCP client/server pair. */
async function listTools() {
  const client = new Client({ name: 'server-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('compact drops null, undefined and empty containers', () => {
  assert.deepEqual(compact({ a: 1, b: null, c: undefined, d: [], e: {}, f: 'x' }), { a: 1, f: 'x' });
});

test('compact keeps false, 0 and empty strings, which are answers and not absences', () => {
  // whereIs returns missable: false, and an infobox can legitimately say 0.
  assert.deepEqual(compact({ missable: false, runes: 0, note: '' }), { missable: false, runes: 0, note: '' });
});

test('compact recurses into nested objects and arrays', () => {
  const value = {
    provenance: { title: 'Uchigatana', revid: null },
    sections: [{ heading: 'Acquisition', markdown: 'text', extra: null }],
    acquisition: { prereqs: [], nearest_grace: 'Debate Parlor' },
  };
  assert.deepEqual(compact(value), {
    provenance: { title: 'Uchigatana' },
    sections: [{ heading: 'Acquisition', markdown: 'text' }],
    acquisition: { nearest_grace: 'Debate Parlor' },
  });
});

test('compact drops a nested object that empties out, but keeps the parent', () => {
  assert.deepEqual(compact({ match: 'exact', boss: { hp: null, runes: null } }), { match: 'exact' });
});

test('compact leaves a not_found result intact', () => {
  const miss = { not_found: true, query: 'zzqx', reason: 'no_sections', hint: 'try fetch: true' };
  assert.deepEqual(compact(miss), miss);
});

test('compact passes primitives and arrays of primitives through', () => {
  assert.equal(compact('x'), 'x');
  assert.equal(compact(0), 0);
  assert.equal(compact(null), null);
  assert.deepEqual(compact(['a', 'b']), ['a', 'b']);
});

test('every lookup tool accepts a dlc mode', async () => {
  const tools = await listTools();
  const withDlc = ['search', 'get_page', 'where_is', 'quest_steps', 'item_stats', 'boss'];
  for (const name of withDlc) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} must exist`);
    assert.ok(tool.inputSchema.properties?.dlc, `${name} must accept dlc`);
  }
  assert.equal(tools.find((t) => t.name === 'sources_status')?.inputSchema.properties?.dlc, undefined);
});

test('the server instructions state the base-game default', () => {
  assert.match(INSTRUCTIONS, /base game/i);
  assert.match(INSTRUCTIONS, /dlc_filtered/);
});

// This spawns the real entry point (src/server/start.ts) as a subprocess over stdio, the same way an
// MCP client (Claude Code, an .mcp.json entry) actually launches the server — unlike listTools()
// above, which talks to the in-process `server` object directly and would stay green even if
// start.ts never called startStdio() at all. That gap is exactly what left the argv-guessing guard
// this test replaces untested: 144/144 passed with `if (false)` in its place.
test('the server actually boots over stdio and answers initialize', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-server-boot-'));
  const dbPath = join(dir, 'fixture.db');
  buildFixtureDb(dbPath).close();

  const client = new Client({ name: 'server-boot-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/server/start.ts'],
      cwd: REPO_ROOT,
      env: { ...process.env, ELDEN_RING_MCP_DB: dbPath, ELDEN_RING_MCP_CACHE: join(dir, 'cache') } as Record<string, string>,
    }),
    { timeout: 10_000 },
  );
  try {
    assert.equal(client.getServerVersion()?.name, 'elden-ring');
    const { tools } = await client.listTools();
    assert.ok(tools.find((t) => t.name === 'where_is'));
  } finally {
    await client.close();
  }
});

// Until 2026-09-16 the documented entry point was src/server/mcp-server.ts. It now only builds the
// server, so an old .mcp.json that still names it got a process that exited 0 with no output and a
// client that reported CONNECTION_CLOSED with nothing to go on.
test('running mcp-server.ts directly exits 1 and names the new entry point', () => {
  const result = spawnSync('npx', ['tsx', 'src/server/mcp-server.ts'], {
    cwd: REPO_ROOT, encoding: 'utf8',
    env: { ...process.env, ELDEN_RING_MCP_CACHE: mkdtempSync(join(tmpdir(), 'er-old-entry-')) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/server\/start\.ts/);
  assert.match(result.stderr, /entry point/i);
});
