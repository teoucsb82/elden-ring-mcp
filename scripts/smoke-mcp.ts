// Dev check: builds a fixture db, spawns the MCP server over stdio against it, lists tools and calls each once.
// Exits non-zero on any tool error, not_found where data is expected, or tool-list budget overrun.
// Run: npm run smoke
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildFixtureDb } from '../test/fixtures/build-fixture-db.js';

const TOOL_LIST_BUDGET = 8_000;

const dir = mkdtempSync(join(tmpdir(), 'er-smoke-'));
const dbPath = process.env.ELDEN_RING_MCP_DB ?? join(dir, 'fixture.db');
if (!process.env.ELDEN_RING_MCP_DB) buildFixtureDb(dbPath).close();

const client = new Client({ name: 'elden-ring-smoke', version: '0.0.0' });
await client.connect(new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/server/mcp-server.ts'],
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, ELDEN_RING_MCP_DB: dbPath, ELDEN_RING_MCP_CACHE: join(dir, 'cache') } as Record<string, string>,
}));

let failures = 0;
const check = (ok: boolean, message: string) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`); };

const { tools } = await client.listTools();
const toolChars = JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length;
check(tools.length === 7, `${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
check(toolChars <= TOOL_LIST_BUDGET, `tool list ${toolChars} chars (budget ${TOOL_LIST_BUDGET})`);

const calls: [string, Record<string, unknown>][] = process.env.SMOKE_CALLS
  ? JSON.parse(process.env.SMOKE_CALLS)
  : [
      ['search', { query: 'damage sorceries' }],
      ['get_page', { title: "Azur's Glintstone Staff", section: 'Acquisition' }],
      ['where_is', { name: "Azur's Glintstone Staff" }],
      ['quest_steps', { npc: 'Sorceress Sellen' }],
      ['item_stats', { kind: 'weapon', scaling_stat: 'int', min_scaling: 'C' }],
      ['boss', { name: 'Magma Wyrm Makar' }],
      ['sources_status', {}],
    ];

for (const [name, args] of calls) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text?: string }[]).map((part) => part.text ?? '').join('\n');
  check(!result.isError && !text.includes('"not_found":true') && (name === 'sources_status' || text.includes('"provenance"')), `${name} ${JSON.stringify(args)} (${text.length} chars)`);
  console.log(`     ${text.slice(0, 300)}`);
}

await client.close();
process.exit(failures ? 1 : 0);
