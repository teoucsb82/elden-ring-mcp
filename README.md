# elden-ring-mcp

MCP server for Elden Ring lookups: where to find items, NPC quest steps, weapon/spell/talisman/armor stats, and boss info. Answers come from a versioned snapshot of the [Elden Ring Fandom wiki](https://eldenring.fandom.com), and every answer includes its source page and revision.

## Quick start

```bash
npm install
npm run fetch-data        # download the latest data release (data/elden-ring.db)
npm run smoke             # sanity check with a tiny fixture db
```

Requires Node 22 or newer (`.nvmrc` says 24). On Node 20 the sqlite driver crashes with a bare
segfault before any message can print, so if the server "fails to connect" with no output, check
`node -v` first. If your MCP config still names `src/server/mcp-server.ts` (the entry point before
2026-09-16), change it to `src/server/start.ts`; the old path now exits with a message saying so.

Add to Claude Code (`.mcp.json`, see `.mcp.json.example`):

```json
{ "mcpServers": { "elden-ring": { "command": "npx", "args": ["tsx", "src/server/start.ts"], "cwd": "/path/to/elden-ring-mcp" } } }
```

## Tools

| Tool | Use |
|---|---|
| `search` | full-text search across all pages |
| `get_page` | a page or one section as markdown |
| `where_is` | how to get an item, nearest grace, prerequisites, missable |
| `quest_steps` | ordered NPC quest steps + quest-breakers |
| `item_stats` | requirements/scaling; filter by stat and scaling letter |
| `boss` | location, HP, runes, drops, strategy sections |
| `sources_status` | data freshness, base/DLC counts, classifier signals |

`get_page`, `where_is`, `quest_steps` and `boss` accept `fetch: true` to cache the matching Fextralife page on your machine (`~/.cache/elden-ring-mcp/`). That cache is never committed or shared. Fextralife is fetched one page per request, at most one request per second and at most 20 pages per server process, so it can never be bulk-crawled.

Nothing matched is always explicit: `not_found` (no page, no search hit, no item matching the filters) or `section_not_found` (the page exists, the section does not - the result lists the page's real headings). `item_stats` excludes items whose requirement the wiki does not state rather than reporting them as free.

## Shadow of the Erdtree

Every tool answers **base game only by default**. Pass `dlc: "all"` to include Shadow of the
Erdtree content, or `dlc: "only"` for DLC content alone. A result with `reason: "dlc_filtered"`
means the page exists but your `dlc` mode excluded it — it is never missing data; `match: "search"`
on such a result means the name did not resolve and the gate describes a full-text guess.
Results carry `dlc: true|false`; a cached Fextralife page carries neither flag because the classifier
only reads Fandom wikitext. `sources_status` reports base/DLC page counts and the classifier's
signal breakdown. Classification is a heuristic over wiki markers plus `data/dlc-overrides.json`;
a wrong label is fixed by editing that file and running `npm run extract`.

A result with `error: "data_stale"` means `data/elden-ring.db` predates this code's schema: run
`npm run extract` (migrates and classifies in place).

A result with `alternates` lists the same title in the other source (Fandom or the Fextralife
cache); pass `fetch: true` to answer from the cached copy.

## Building data yourself

```bash
npm run build             # sync changed Fandom pages, re-extract, update data/CHANGELOG-data.md
npm run sync-categories   # refresh DLC category membership only
npm run extract           # re-render, re-extract and re-classify without syncing
npm run attribution       # regenerate data/ATTRIBUTION.md
```

First build fetches ~4,900 pages at 1 request/second (a few minutes). Later builds fetch only changed revisions.

## Keeping up with patches

A weekly GitHub Action runs the build, commits the data changelog in a PR, and publishes the db as a `data-YYYY.MM.DD` release. `data/CHANGELOG-data.md` lists field-level changes such as a requirement or effect edited after a patch.

## Licensing

Code: MIT. Data: CC BY-SA 3.0 (Fandom). See `LEGAL.md`.
