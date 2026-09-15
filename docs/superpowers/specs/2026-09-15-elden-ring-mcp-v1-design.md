# elden-ring-mcp v1: data + lookup

Date: 2026-09-15
Status: approved design, pre-implementation

## Goal

An open-source MCP server that answers Elden Ring questions from a local,
versioned copy of wiki data instead of ad-hoc web fetches. v1 covers
**data + lookup** only.

v1 must answer well:

1. Where is X: location, nearest site of grace, directions, prerequisites, missable flag.
2. Quest steps: ordered NPC quest steps, what breaks the quest.
3. Stats and scaling: requirements, scaling, weight, damage boosts; filterable.
4. Boss info: location, resistances/weaknesses, status immunities, drops.

The data must keep up with game patches and wiki edits over time.

## Out of scope for v1

Later sub-projects, each with its own spec:

- Player run state (replacing `~/.claude/skills/elden-ring/state.md`).
- Route planner ("what's next" from owned items + graces).
- Interactive map / coordinates.
- Shadow of the Erdtree-specific tooling (DLC pages are ingested if Fandom has them, but no DLC-specific tools).

## Licensing and data policy

| Part | License / policy | Committed to repo |
|---|---|---|
| Code | MIT | yes |
| Fandom-derived data (eldenring.fandom.com) | CC-BY-SA (confirmed via MediaWiki `siteinfo` rightsinfo, 2026-09-15). Attribution per page: title, URL, revision. | yes |
| Fextralife pages | Their copyright. On-demand single-page fetch into a local user cache only. Never crawled in bulk. | **no** (gitignored, lives in `~/.cache/elden-ring-mcp/`) |
| eldenring.fanapis.com | GitHub repo `deliton/eldenring-api` has no license (checked 2026-09-15) = all rights reserved. Not shipped. May be added later as a local-only source if a license appears. | **no** |

`LEGAL.md` states all of the above. The data directory carries its own
`data/LICENSE` (CC-BY-SA 4.0) and `data/ATTRIBUTION.md`.

## Approach: hybrid

- **Page corpus + full-text search** is the base layer. Directions and quest steps work from day one because they live in page text.
- **Structured tables** are extracted from wiki infoboxes where parsing is reliable: weapons, spells, talismans, armor, bosses, drops.
- Extractors are added incrementally. A page that no extractor understands still exists in the corpus and is searchable.

Rejected: page-corpus-only (no numeric filtering) and fully-structured (brittle, slow to become useful).

## Architecture

Stack: TypeScript (ESM), `@modelcontextprotocol/sdk`, `zod`, `better-sqlite3`
with FTS5, `tsx` for scripts, `node:test` for tests. Mirrors `~/Code/slate-mcp`.

```
src/
  sources/          one adapter per source, shared interface
    types.ts        SourceAdapter, RawPage
    fandom.ts       MediaWiki API: list pages, fetch wikitext+HTML, revisions
    fextralife.ts   single-page on-demand fetch into local cache
  extract/          one extractor per entity type
    types.ts        Extractor interface
    weapon.ts, spell.ts, talisman.ts, armor.ts, boss.ts
    sections.ts     split page into named sections (Location, Walkthrough, Notes...)
  db/
    schema.sql
    open.ts         open db, run migrations
  server/
    mcp-server.ts   tool registration
    tools/          one file per tool
scripts/
  sync.ts           pull changed pages from sources
  extract.ts        run extractors over changed pages
  build.ts          sync + extract + changelog
  smoke-mcp.ts      start server, call each tool
data/
  elden-ring.db     committed build output
  CHANGELOG-data.md
  LICENSE, ATTRIBUTION.md
test/
  fixtures/         saved wiki pages
  *.test.ts
docs/superpowers/specs/
README.md, CONTRIBUTING.md, LEGAL.md, NOTES.md, LICENSE (MIT)
```

### Source adapter interface

```ts
interface SourceAdapter {
  id: "fandom" | "fextralife";
  shippable: boolean;                      // false => never written to data/
  listChangedSince(cursor: string | null): AsyncIterable<{ title: string; revid: number }>;
  fetchPage(title: string): Promise<RawPage>;
}

interface RawPage {
  source: string; title: string; url: string;
  revid: number | null;                   // null for sources without revisions
  fetchedAt: string;                       // ISO
  wikitext: string | null; html: string | null;
  license: string;
}
```

### Extractor interface

```ts
interface Extractor<T> {
  entity: "weapon" | "spell" | "talisman" | "armor" | "boss";
  matches(page: RawPage): boolean;         // e.g. infobox template present
  extract(page: RawPage): T;               // throws ExtractError on failure
}
```

## Data model (SQLite)

Every row in every table carries provenance: `source`, `page_title`,
`page_url`, `revid`, `fetched_at`, `license`, and optional `patch`.

- `pages` — one row per page: provenance + `markdown` body.
- `sections` — `page_id`, `heading`, `markdown`, `ord`.
- `pages_fts` — FTS5 over page title + section text.
- `entities` — `id`, `type`, `name`, `aliases` (JSON), `page_id`.
- `weapons` / `spells` / `talismans` / `armor` — typed columns (requirements per stat, scaling letters, weight, FP cost, effect text).
- `bosses` — location text, `resistances` (JSON), `immunities` (JSON), `hp` if listed.
- `drops` — `entity_id` (source enemy/boss), `item_name`, `note`.
- `acquisition` — `entity_id`, `method` (chest/drop/merchant/quest/ground), `location_text`, `nearest_grace`, `prereqs` (JSON), `missable` (bool).
- `quests` — `npc`, `step_ord`, `location`, `action`, `prereqs` (JSON), `breaks_quest` (text, nullable).
- `sync_state` — `source`, `cursor`, `last_run`.
- `extract_failures` — `page_id`, `extractor`, `error`, `at`.

Local-only Fextralife rows live in a **separate** db file in the user cache
(`~/.cache/elden-ring-mcp/local.db`), same schema, attached at query time.
This keeps non-shippable data physically out of `data/`.

## MCP tools (v1)

| Tool | Input | Output |
|---|---|---|
| `search` | `query`, `limit?` | titles + snippets + source/revid |
| `get_page` | `title`, `section?` | page or one section, with provenance |
| `where_is` | `name` | acquisition rows (method, location, nearest grace, prereqs, missable) + source |
| `quest_steps` | `npc` | ordered steps + quest-breakers + source |
| `item_stats` | `name?`, filters (`type`, `stat`, `min_scaling`, ...) | typed rows |
| `boss` | `name` | location, resistances, immunities, drops |
| `sources_status` | none | last sync per source, page counts, local-cache hits |

Rules for every tool:

- Every answer includes source + revision. No answer without provenance.
- Lookup order: shipped db, then local cache db. On a miss, return an explicit `not_found`. Never fabricate.
- `fetch: true` (on `get_page`, `where_is`, `quest_steps`, `boss`) fetches the live Fextralife page into the local cache, then answers from it.
- Name matching: exact, then alias, then FTS best match. The response states which match kind was used.

## Data flow and updates

1. `npm run sync`: for each shippable source, `listChangedSince(cursor)` using MediaWiki `recentchanges`/revision ids; fetch changed pages only; upsert `pages` + `sections`; advance cursor.
2. `npm run extract`: run matching extractors on changed pages; upsert typed tables; record failures.
3. `npm run build`: sync + extract, then append to `data/CHANGELOG-data.md` a dated entry listing field-level diffs for typed rows (e.g. `Azur's Glintstone Staff: requirements.int 52 -> 48 (rev 12345)`) and counts of added/changed/removed pages.
4. `patch` column is set when a page's "patch notes" section names a game version for the change.

Rate limiting: max 1 request/second per source, honor `Retry-After`/`maxlag`, set a descriptive User-Agent with repo URL.

## Error handling

- Extractor failure: log to `extract_failures`, keep the page in the corpus, continue.
- Build prints a failure report (count per extractor + page titles).
- Network failure during sync: retry with exponential backoff (3 attempts), then leave the cursor unchanged so the next run resumes.
- MCP tool errors return structured `{ error, detail }`, never a stack trace.

## Testing

- Extractor unit tests over saved fixture pages in `test/fixtures/` (at least one per entity type, plus one malformed page per extractor).
- Sections splitter tests.
- Source adapter tests against recorded API responses (no live network in CI).
- `npm run smoke`: starts the MCP server over stdio and calls every tool once against a small fixture db.

## Versioning and project hygiene

- Git from day one; semver for code (`0.1.0` first release).
- Data releases tagged by date: `data-YYYY.MM.DD`.
- GitHub Actions:
  - on PR: typecheck + tests + smoke.
  - weekly schedule: `npm run build`, open a PR containing the db + data changelog diff.
- `NOTES.md`: dated decision log, appended as the project evolves.
- `CONTRIBUTING.md`: how to add an extractor (interface, fixture, test, register).

## v1 done when

- Fandom corpus synced and searchable.
- Extractors for weapons, spells, talismans, armor, bosses pass fixture tests.
- All 7 tools work in `npm run smoke`.
- These real questions from the 2026-09-14/15 session answer with provenance from the shipped db (or the local cache, if Fandom lacks the detail), with no live fetch at question time: "where is Azur's Glintstone Staff" (`where_is`), "Sellen quest steps" (`quest_steps`), "what boosts Comet Azur" (`search` over effect text), "Magma Wyrm Makar location" (`boss`), "Graven-School Talisman location" (`where_is`).
- Incremental sync run twice in a row: second run fetches 0 unchanged pages.
