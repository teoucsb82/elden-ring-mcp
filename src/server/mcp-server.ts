// Elden Ring lookups over the shipped Fandom snapshot (data/elden-ring.db) plus the user's local Fextralife cache.
// Network access happens only when a tool is called with fetch: true (one Fextralife page into the local cache).
// Run: npx tsx src/server/mcp-server.ts (stdio; Claude Code spawns it via .mcp.json)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { openDbs } from '../query/dbs.js';
import { bossInfo, getPage, itemStats, questSteps, search, sourcesStatus, whereIs } from '../query/lookups.js';
import { cacheFextralife } from '../store/local.js';
import { compact } from './compact.js';

const INSTRUCTIONS = `Elden Ring reference data from a versioned snapshot of eldenring.fandom.com (CC BY-SA 3.0), plus an optional per-user Fextralife page cache. Every result carries provenance (source, title, url, revid, fetched_at, license): cite it when answering. A result with not_found means the data does not cover it; say so instead of guessing, or retry with fetch: true to cache the Fextralife page. Fandom and Fextralife sometimes disagree on numbers; when both are present, show both with their sources. Directions from the wiki may omit prerequisites; state prerequisites the result lists.`;

const server = new McpServer({ name: 'elden-ring', version: '0.1.0' }, { instructions: INSTRUCTIONS });
const dbs = openDbs();

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(compact(value)) }] });
const fail = (error: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: 'tool_failed', detail: error instanceof Error ? error.message : String(error) }) }], isError: true });

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
const MAY_FETCH = { readOnlyHint: false, idempotentHint: true, openWorldHint: true } as const;

const fetchArg = z.boolean().optional().describe('If true, first fetch this page from Fextralife into the local cache (network; local only, never shipped)');

/** Runs a lookup; with fetch: true, caches the Fextralife page for `title` first. */
async function withFetch<T>(title: string, fetch: boolean | undefined, lookup: () => T) {
  try {
    if (fetch && dbs.local) await cacheFextralife(dbs.local, title);
    return reply(lookup());
  } catch (error) {
    return fail(error);
  }
}

server.registerTool('search', {
  title: 'Full-text search',
  description: 'Searches every wiki page section (shipped Fandom data and local cache) and returns page titles, section headings and highlighted snippets with provenance. Use it when you do not know the exact page name or want every page mentioning something, e.g. "boosts sorcery damage".',
  inputSchema: {
    query: z.string().min(1).describe('Words to search for'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
  },
  annotations: READ_ONLY,
}, async ({ query, limit }) => { try { return reply(search(dbs, query, limit)); } catch (error) { return fail(error); } });

server.registerTool('get_page', {
  title: 'Get page',
  description: 'Returns a wiki page as markdown sections, or only sections whose heading contains `section` (e.g. "Acquisition", "Notes"). Resolves names via exact title, redirect, item/boss name, then search; `match` says which.',
  inputSchema: {
    title: z.string().min(1).describe('Page or item name'),
    section: z.string().optional().describe('Only sections whose heading contains this text'),
    fetch: fetchArg,
  },
  annotations: MAY_FETCH,
}, async ({ title, section, fetch }) => withFetch(title, fetch, () => getPage(dbs, title, section)));

server.registerTool('where_is', {
  title: 'Where is an item',
  description: 'How to get an item, spell, talisman or armor piece: method (drop/merchant/chest/quest/ground), nearest site of grace if the wiki names one, prerequisite sentences, missable flag, and the acquisition/location sections verbatim.',
  inputSchema: { name: z.string().min(1).describe('Item name, e.g. "Azur\'s Glintstone Staff"'), fetch: fetchArg },
  annotations: MAY_FETCH,
}, async ({ name, fetch }) => withFetch(name, fetch, () => whereIs(dbs, name)));

server.registerTool('quest_steps', {
  title: 'NPC quest steps',
  description: 'Ordered questline steps for an NPC (location + actions), per-step quest-breaking warnings, and warnings from the page notes. Falls back to quest sections when steps could not be parsed.',
  inputSchema: { npc: z.string().min(1).describe('NPC name, e.g. "Sorceress Sellen"'), fetch: fetchArg },
  annotations: MAY_FETCH,
}, async ({ npc, fetch }) => withFetch(npc, fetch, () => questSteps(dbs, npc)));

server.registerTool('item_stats', {
  title: 'Item stats',
  description: 'Requirements, scaling, weight and effects for weapons, spells, talismans and armor. Give `name` for one item: it wins over the other filters, but `kind` must agree with the item or you get kind_mismatch. Otherwise filter: kind, scaling_stat (weapons; min_scaling defaults to E, i.e. scales with that stat at all, and min_scaling alone is an error), max_req per stat (items whose requirement the wiki does not state are excluded, not treated as 0). No match returns not_found.',
  inputSchema: {
    name: z.string().optional().describe('One item by name'),
    kind: z.enum(['weapon', 'spell', 'talisman', 'armor']).optional(),
    scaling_stat: z.enum(['str', 'dex', 'int', 'fai', 'arc']).optional(),
    min_scaling: z.enum(['E', 'D', 'C', 'B', 'A', 'S']).optional(),
    max_req: z.object({ str: z.number(), dex: z.number(), int: z.number(), fai: z.number(), arc: z.number() }).partial().optional().describe('Only items whose requirement for each given stat is at or under this'),
    limit: z.number().int().min(1).max(100).optional(),
  },
  annotations: READ_ONLY,
}, async (args) => { try { return reply(itemStats(dbs, args)); } catch (error) { return fail(error); } });

server.registerTool('boss', {
  title: 'Boss info',
  description: 'Boss location, HP, runes and drops from the wiki infobox, plus overview/strategy/weakness sections. Names that redirect to a section of a shared page (e.g. "Magma Wyrm Makar") return that section.',
  inputSchema: { name: z.string().min(1), fetch: fetchArg },
  annotations: MAY_FETCH,
}, async ({ name, fetch }) => withFetch(name, fetch, () => bossInfo(dbs, name)));

server.registerTool('sources_status', {
  title: 'Data sources status',
  description: 'When the shipped data was last synced, how many pages it holds, how many extraction failures it has, and how many pages are in the local Fextralife cache.',
  inputSchema: {},
  annotations: READ_ONLY,
}, async () => { try { return reply(sourcesStatus(dbs)); } catch (error) { return fail(error); } });

await server.connect(new StdioServerTransport());
