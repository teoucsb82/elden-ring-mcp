import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { compact } from '../src/server/compact.js';

// Isolate the local cache db this import opens as a side effect, so the test never touches
// the real ~/.cache/elden-ring-mcp used by an actual `npm run mcp`.
process.env.ELDEN_RING_MCP_CACHE ??= mkdtempSync(join(tmpdir(), 'er-server-test-'));

// mcp-server.ts only connects stdio when run as the entry point, so importing it here (to read
// `server` and `INSTRUCTIONS`) is side-effect-free beyond opening the dbs above.
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
