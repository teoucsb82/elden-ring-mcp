# Decision log

## 2026-09-15
- v1 scope: data + lookup. Run state and route planner are later sub-projects.
- Change detection via allpages `lastrevid`, not `recentchanges`.
- DB shipped as a GitHub Release asset (≈50 MB), not committed. Changelog committed.
- Fandom Infobox Boss lacks resistances; bosses table stores location/hp/runes/drops.
- Quest steps parsed from Fandom "Questline progression" lists.
- Found on day one: Fandom and Fextralife disagree on Graven-School Talisman (+8% vs +4%). Provenance on every answer is why.
- Node 20 segfaults with better-sqlite3 v13 under tsx; project pins Node 24 (.nvmrc) and requires >=22.

## 2026-09-15 — first full build against the live Fandom wiki

Twelve tasks of code had only ever seen six fixture pages. Running it against all 4,922 article
pages found five real bugs; each was reproduced with a fixture and a test before being fixed.

### What shipped

| | |
|---|---|
| Pages | 4,922 (`{"added":0,"changed":0,"removed":0,"unchanged":4922}` on the re-sync) |
| Sections | 21,823 |
| Redirects | 2,730 |
| DB size | 47 MB after `VACUUM` |
| Extract failures | 0 |

Typed rows: weapons 480, armor 680, spells 213, bosses 165, talismans 156, acquisition 2,609,
quest steps 341 across 68 NPCs, entities 1,694. All above the task's thresholds.

Note the wiki mixes base game, Shadow of the Erdtree and Nightreign pages in one namespace, so these
counts are wider than base-game Elden Ring. Nothing was excluded; nothing needed to be.

### Bugs the fixtures never showed

1. **`listRedirects` never worked.** The live API rejects `redirects=1` on an `allpages` generator
   ("Use gapfilterredir=nonredirects instead"). The build crashed after fetching all 4,922 pages.
   The old test mocked one response and asserted nothing about the request, so it passed. Now two
   passes: enumerate redirect titles, then resolve each batch of 50 with `titles=…&redirects=1`.
   A test asserts the rejected combination is never sent.
2. **Quest heading variants.** Only "Questline progression" was matched. The wiki also writes
   "Questline steps", "Quest", "Quests" and "<NPC>'s Quest" — 16 NPC pages. "Quest items" must
   still not match; it lists items, not steps. A page can carry a "Quests" stub *before* its real
   "Questline steps", so the extractor now takes the first matching section that actually parses.
3. **NPCs are not all `Infobox Character`.** Patches uses `Infobox Boss`; invader NPCs (Eleonora,
   Juno Hoslow, Rileigh) use `Infobox Enemy` — 7 pages, Patches among them.
4. **Flat questlines.** The parser assumed `1. Location` + nested `- action` bullets and silently
   dropped every step of a flat numbered list (Leda, Aureliette, Tanith). A flat item is now its
   own action with no location.
5. **`<tabber>` leaked into the text.** 689 sections on 371 pages kept literal `<tabber>` and
   `|-|Makar=` scaffolding where the prose should be. Tab labels now become headings (including the
   two-line `|-|\nLabel =` form location pages use). 55 sections still carry a `|-|` where the tab's
   content sits on the same line as the label; those are galleries and progress-tracking tables
   whose content is stripped anyway.

Effect of 2–4 together: quest NPCs went 45 → 68, steps 236 → 341.

### Consequences worth knowing

- **`boss` needed a fallback.** "Magma Wyrm Makar" redirects to `Magma Wyrm#Bosses`, and that
  heading holds only a `<tabber>`; each wyrm's prose sits under a deeper `===Background===`. Once
  the scaffolding stopped counting as text, the fragment section was empty and dropped, so the
  answer had no prose at all. `bossInfo` now prefers the fragment but falls back to the usual
  overview/location/strategy sections rather than answering with nothing.
- **Nested tab content loses its label.** `splitSections` is flat and drops empty sections, so a
  tab label whose prose lives under a deeper heading disappears and its `Background` section is left
  anonymous (Magma Wyrm has four). Making sections depth-aware would change headings site-wide and
  break lookups that match on `^Notes$` or `Questline progression`, so it was left alone.
- **A markdown-converter change cannot be re-applied without a re-fetch.** Sections are derived in
  `upsertPage`, and `npm run extract` only rebuilds the typed tables. Fixing `<tabber>` needed a
  one-off script to re-split all 4,922 pages from the wikitext already stored. A `npm run reindex`
  would be worth adding.
- **The first changelog entry is 60 KB** — one "Added" line per typed row, 1,682 of them. Correct,
  and later entries are small diffs, but the first one is not readable.

### Acceptance questions (through the MCP server, against the real db)

All five `ok` with provenance:

1. `where_is` Azur's Glintstone Staff → "highest level of the **Church of the Cuckoo**", grace Debate Parlor.
2. `quest_steps` Sorceress Sellen → 7 steps; step 3 is **Witchbane Ruins** after Radahn.
3. `search` "Comet Azur damage" → **Azur's Glintstone Crown** at rank 3: "Increases the damage of Comet Azur by **15%**".
4. `boss` Magma Wyrm Makar → `match: redirect` to Magma Wyrm; **Ruin-Strewn Precipice**, 7,141 HP, 24,000 runes, drops Magma Wyrm's Scalesword + Dragon Heart.
5. `where_is` Graven-School Talisman → "large pile of crystals in **Raya Lucaria** Academy".

72 tests and both smoke runs (fixture db and real db) pass.
