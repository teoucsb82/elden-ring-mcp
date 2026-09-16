// Elden Ring lookups over the shipped Fandom snapshot (data/elden-ring.db) plus the user's local Fextralife cache.
// Network access happens only when a tool is called with fetch: true (one Fextralife page into the local cache).
// This module only builds `server` and its tools and exports `startStdio()` — it never starts stdio
// on import, so it stays safe to import from a test (or, later, the npm-distribution guard file in
// docs/superpowers/specs/2026-09-15-npm-distribution-design.md §2) without side effects.
// To actually run the server: npx tsx src/server/start.ts (stdio; see that file, or `npm run mcp`).
// Run directly instead — an old .mcp.json entry from before 2026-09-16 — and it exits 1 naming the new entry point.

import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { openDbs } from '../query/dbs.js';
import { bossInfo, getPage, itemStats, questSteps, search, sourcesStatus, whereIs } from '../query/lookups.js';
import { cacheFextralife } from '../store/local.js';
import { compact } from './compact.js';

// Guard the old entry point. This module is imported by start.ts and by tests; only a direct
// `tsx src/server/mcp-server.ts` (an .mcp.json written before 2026-09-16) reaches process.argv[1].
// Exiting 0 with no output here left clients reporting CONNECTION_CLOSED with nothing to go on.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  console.error('elden-ring-mcp: the entry point moved to src/server/start.ts (`npm run mcp`). Update your MCP config args to ["tsx", "src/server/start.ts"].');
  process.exit(1);
}

export const INSTRUCTIONS = `Elden Ring reference data from a versioned snapshot of eldenring.fandom.com (CC BY-SA 3.0), plus an optional per-user Fextralife page cache. Every result carries provenance (source, title, url, revid, fetched_at, license): cite it when answering.

Results are base game only by default. Pass dlc: "all" to include Shadow of the Erdtree content, or dlc: "only" for DLC content alone. A result with reason: "dlc_filtered" means the page exists but this call's dlc mode excluded it — base mode (the default) excludes DLC content, only mode excludes base-game content — and the hint on the result says which way and how to re-run; never report it as missing data. Check its match field first: match: "search" means the name did not resolve and the gate describes a full-text guess at another page, not the subject asked about. A result with has_dlc_sections: true is a base-game page whose wiki text carries the Shadow of the Erdtree marker template (it links or notes DLC content); pages that discuss the DLC in prose without the marker are not flagged. get_page, where_is, quest_steps, boss and item_stats with a name carry dlc and has_dlc_sections (true or false) on every successful Fandom result; search rows and item_stats filter rows carry dlc only. A successful result with NO dlc field is a cached Fextralife page, which the classifier never labels: its DLC status is unknown, so never state it is base game or DLC, and no dlc mode filters it out. Error and not-found shapes carry neither field. A result with alternates lists the same title in the other source (Fandom or the Fextralife cache); pass fetch: true to answer from the cached Fextralife copy.

A result with error: "data_stale" means the shipped snapshot predates this server's schema; tell the user to run npm run extract (or fetch a newer data release). It is not missing data.

A result with not_found and no reason means the data does not cover it; say so instead of guessing, or retry with fetch: true to cache the Fextralife page. Fandom and Fextralife sometimes disagree on numbers; when both are present, show both with their sources. Directions from the wiki may omit prerequisites; state prerequisites the result lists.`;

export const server = new McpServer({ name: 'elden-ring', version: '0.1.0' }, { instructions: INSTRUCTIONS });
const dbs = openDbs();

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(compact(value)) }] });
const fail = (error: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: 'tool_failed', detail: error instanceof Error ? error.message : String(error) }) }], isError: true });

/**
 * A shipped db built before the dlc columns answers every query with "no such column: dlc", which
 * reads as a broken server. Name it instead, and say the command that fixes it. sources_status is
 * the exception: it reports the staleness as status rather than failing.
 */
const staleReply = () => reply({ error: 'data_stale', path: dbs.stale?.path, detail: dbs.stale?.detail });

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
const MAY_FETCH = { readOnlyHint: false, idempotentHint: true, openWorldHint: true } as const;

const fetchArg = z.boolean().optional().describe('If true, first fetch this page from Fextralife into the local cache (network; local only, never shipped)');

const dlcArg = z.enum(['base', 'all', 'only']).optional().default('base')
  .describe('Which content to search: "base" (default) is base game only, "all" includes Shadow of the Erdtree, "only" is DLC content alone');

/**
 * Runs a lookup; with fetch: true, caches the Fextralife page for `title` first.
 *
 * Each call site pairs this with `{ preferLocal: fetch === true }` on its lookup, because caching a
 * page the shipped snapshot also holds used to change nothing a caller could see: the resolver went
 * shipped-first and handed back the Fandom copy anyway (issue #9).
 */
async function withFetch<T>(title: string, fetch: boolean | undefined, lookup: () => T) {
  if (dbs.stale) return staleReply();
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
    dlc: dlcArg,
  },
  annotations: READ_ONLY,
}, async ({ query, limit, dlc }) => { if (dbs.stale) return staleReply(); try { return reply(search(dbs, query, limit, dlc)); } catch (error) { return fail(error); } });

server.registerTool('get_page', {
  title: 'Get page',
  description: 'Returns a wiki page as markdown sections, or only sections whose heading contains `section` (e.g. "Acquisition", "Notes"). Resolves names via exact title, redirect, item/boss name, then search; `match` says which.',
  inputSchema: {
    title: z.string().min(1).describe('Page or item name'),
    section: z.string().optional().describe('Only sections whose heading contains this text'),
    fetch: fetchArg,
    dlc: dlcArg,
  },
  annotations: MAY_FETCH,
}, async ({ title, section, fetch, dlc }) => withFetch(title, fetch, () => getPage(dbs, title, section, dlc, { preferLocal: fetch === true })));

server.registerTool('where_is', {
  title: 'Where is an item',
  description: 'How to get an item, spell, talisman or armor piece: method (drop/merchant/chest/quest/ground), nearest site of grace if the wiki names one, prerequisite sentences, missable flag, and the acquisition/location sections verbatim.',
  inputSchema: { name: z.string().min(1).describe('Item name, e.g. "Azur\'s Glintstone Staff"'), fetch: fetchArg, dlc: dlcArg },
  annotations: MAY_FETCH,
}, async ({ name, fetch, dlc }) => withFetch(name, fetch, () => whereIs(dbs, name, dlc, { preferLocal: fetch === true })));

server.registerTool('quest_steps', {
  title: 'NPC quest steps',
  description: 'Ordered questline steps for an NPC (location + actions), per-step quest-breaking warnings, and warnings from the page notes. Falls back to quest sections when steps could not be parsed.',
  inputSchema: { npc: z.string().min(1).describe('NPC name, e.g. "Sorceress Sellen"'), fetch: fetchArg, dlc: dlcArg },
  annotations: MAY_FETCH,
}, async ({ npc, fetch, dlc }) => withFetch(npc, fetch, () => questSteps(dbs, npc, dlc, { preferLocal: fetch === true })));

server.registerTool('item_stats', {
  title: 'Item stats',
  description: 'Requirements, scaling, weight and effects for weapons, spells, talismans and armor. Give `name` for one item: it wins over the other filters, but `kind` must agree with the item or you get kind_mismatch. Otherwise filter: kind, scaling_stat (weapons; min_scaling defaults to E, i.e. scales with that stat at all, and min_scaling alone is an error), max_req per stat (items whose requirement the wiki does not state are excluded, not treated as 0). No match returns not_found.',
  inputSchema: {
    name: z.string().optional().describe('One item by name'),
    kind: z.enum(['weapon', 'spell', 'talisman', 'armor']).optional(),
    scaling_stat: z.enum(['str', 'dex', 'int', 'fai', 'arc']).optional(),
    min_scaling: z.enum(['E', 'D', 'C', 'B', 'A', 'S']).optional(),
    max_req: z.object({ str: z.number(), dex: z.number(), int: z.number(), fai: z.number(), arc: z.number() }).partial().strict().optional().describe('Only items whose requirement for each given stat is at or under this'),
    limit: z.number().int().min(1).max(100).optional(),
    dlc: dlcArg,
  },
  annotations: READ_ONLY,
}, async ({ dlc, ...filter }) => { if (dbs.stale) return staleReply(); try { return reply(itemStats(dbs, filter, dlc)); } catch (error) { return fail(error); } });

server.registerTool('boss', {
  title: 'Boss info',
  description: 'Boss location, HP, runes and drops from the wiki infobox, plus overview/strategy/weakness sections. Names that redirect to a section of a shared page (e.g. "Magma Wyrm Makar") return that section.',
  inputSchema: { name: z.string().min(1), fetch: fetchArg, dlc: dlcArg },
  annotations: MAY_FETCH,
}, async ({ name, fetch, dlc }) => withFetch(name, fetch, () => bossInfo(dbs, name, dlc, { preferLocal: fetch === true })));

server.registerTool('sources_status', {
  title: 'Data sources status',
  description: 'When the shipped data was last synced, how many pages it holds, how many extraction failures it has, and how many pages are in the local Fextralife cache.',
  inputSchema: {},
  annotations: READ_ONLY,
}, async () => { try { return reply(sourcesStatus(dbs)); } catch (error) { return fail(error); } });

/**
 * Starts the server over stdio. Importing this module must never do this on its own — tests import
 * it for `server` and `INSTRUCTIONS` alone, and a future npm-distribution entry file may import it
 * dynamically too — so starting is only ever an explicit call. src/server/start.ts is that call.
 */
export async function startStdio() {
  await server.connect(new StdioServerTransport());
}
