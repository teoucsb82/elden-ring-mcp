# elden-ring-mcp

MCP server exposing a versioned snapshot of eldenring.fandom.com (CC BY-SA 3.0),
plus an optional local Fextralife page cache.

## Answering Elden Ring questions in this repo

**Default: MCP only.** This repo is the sandbox for testing the server. Any Elden
Ring question here is a test of the MCP, not a question about Teo's save file.

- Answer **only** from the `elden-ring` MCP tools: `search`, `get_page`, `boss`,
  `where_is`, `quest_steps`, `sources_status`.
- Do **not** invoke the `elden-ring` skill.
- Do **not** read `~/.claude/skills/elden-ring/state.md` or `trophies.md`.
- Do **not** assume anything about his character, level, gear, progress, or NG
  cycle. Answer generically.
- Do **not** fall back to model memory when a tool returns `not_found`. Say the
  data doesn't cover it, and offer `fetch: true` to cache the Fextralife page.
- Cite provenance (source, title, url) on every answer — the server returns it.
- When Fandom and Fextralife disagree on a number, show both with their sources.

## Opting in to his real save

**"in my game"** is the phrase to watch for. It doesn't have to be the first
words, and near-misses count — "in my run", "on my save", "in my NG++", "for my
character" all mean the same thing. Once he opts in, it holds for the rest of
the session unless he says otherwise.

When he opts in:

1. Invoke the `elden-ring` skill and follow it.
2. Read `~/.claude/skills/elden-ring/state.md` before answering.
3. MCP tools are still the lookup layer — the skill supplies who he is and where
   he's up to, the MCP supplies the facts.

Without an opt-in, stay MCP-only and answer generically. If a question is
clearly about his actual save ("should I respec?", "what's next for me?") and he
hasn't opted in, just ask — one line, "your run or generic?" — rather than
guessing or lecturing him about the phrase.

## State docs

One file, opt-in only: `~/.claude/skills/elden-ring/state.md`.

- It holds every journey in the same doc. The live NG++ run is the
  `## JOURNEY 3 (NG++) LIVE PROGRESS` section; earlier journeys sit above it.
- `~/.claude/skills/elden-ring/trophies.md` is the trophy reference.
- Never edit either file from this repo unless he's opted in, and then only in
  the section for the journey he's actually playing. If it's unclear which
  journey, ask before writing.
