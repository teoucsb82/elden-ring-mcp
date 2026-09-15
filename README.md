# elden-ring-mcp

MCP server for Elden Ring lookups: where to find items, NPC quest steps, weapon/spell/talisman/armor stats, and boss info. Answers come from a versioned snapshot of the [Elden Ring Fandom wiki](https://eldenring.fandom.com), and every answer includes its source page and revision.

## Quick start

```bash
npm install
npm run fetch-data        # download the latest data release (data/elden-ring.db)
npm run smoke             # sanity check with a tiny fixture db
```

Add to Claude Code (`.mcp.json`, see `.mcp.json.example`):

```json
{ "mcpServers": { "elden-ring": { "command": "npx", "args": ["tsx", "src/server/mcp-server.ts"], "cwd": "/path/to/elden-ring-mcp" } } }
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
| `sources_status` | data freshness and counts |

`get_page`, `where_is`, `quest_steps` and `boss` accept `fetch: true` to cache the matching Fextralife page on your machine (`~/.cache/elden-ring-mcp/`). That cache is never committed or shared.

## Building data yourself

```bash
npm run build             # sync changed Fandom pages, re-extract, update data/CHANGELOG-data.md
npm run attribution       # regenerate data/ATTRIBUTION.md
```

First build fetches ~4,900 pages at 1 request/second (a few minutes). Later builds fetch only changed revisions.

## Keeping up with patches

A weekly GitHub Action runs the build, commits the data changelog in a PR, and publishes the db as a `data-YYYY.MM.DD` release. `data/CHANGELOG-data.md` lists field-level changes such as a requirement or effect edited after a patch.

## Licensing

Code: MIT. Data: CC BY-SA 3.0 (Fandom). See `LEGAL.md`.
