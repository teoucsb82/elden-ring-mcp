# elden-ring-mcp: Shadow of the Erdtree layering

Date: 2026-09-15
Status: approved, ready for implementation plan

## Goal

Every tool answers base-game-only by default. A caller who wants Shadow of the
Erdtree content asks for it explicitly. A caller who asks for a DLC item without
opting in is told it is DLC-gated, never that the data is missing.

## What the request was, and what it actually is

The request was "a secondary DB for DLC content, layered onto the main game."
Investigation says that is not the shape of the problem.

The shipped database already holds the DLC. `src/sources/fandom.ts` syncs via
`generator=allpages`, which enumerates the entire namespace, so Messmer the
Impaler, Rellana, Scadu Altus, Jagged Peak, and the Verdigris set are all
present among the 4,922 pages.

```
sqlite> select count(*) from pages;              -- 4922
sqlite> select ifnull(patch,'(null)'), count(*)  -- (null)|4922
        from pages group by patch;
sqlite> select title from pages
        where title in ('Messmer the Impaler','Scadu Altus','Verdigris Armor');
        -- all three FOUND
```

Nothing distinguishes them. The `patch` column exists and is NULL on every row.

So the work is **classification and filtering**, not acquisition. A second
database would duplicate the FTS index, fork the sync path, and introduce drift
between two files that describe one wiki, in exchange for nothing — the rows are
already in the same table.

**Decision: one database, one new column.** The `dlc` flag lives on `pages`.

## Why classification is the hard part

Fandom does not tag DLC content per page. Messmer's categories are `Bosses`,
`Characters`, `Demigods`, `Remembrance bosses`, `Messmer's Army` — structurally
identical to a base-game boss. No category, template, or naming convention
covers the DLC completely.

Four candidate signals, each measured against the live wiki and the shipped DB:

| Signal | Coverage | Fails on |
|---|---|---|
| `{{SotE}}` template in wikitext | 847 pages, of which 599 are page markers | Misses Rellana. The other 248 are inline link markers and DLC mentions on base-game pages — `Weapons` and `Armor Sets`, but also `Flask of Crimson Tears` and 33 Ash of War pages (see §2 signal 3) |
| `Category:Shadow of the Erdtree Locations` | 64 pages | Locations only |
| Title suffix `(Shadow of the Erdtree)` | 22 pages | Index pages only |
| Links from the DLC index pages | ~0 useful | `Armor (Shadow of the Erdtree)` is a gallery of `File:` links, tagged `{{missing data|names, categories, stats}}` |

`Category:Shadow of the Erdtree` itself holds 22 index pages and three
subcategories; `Shadow of the Erdtree Enemies` is empty, and `Shadow of the
Erdtree Items` holds four more index pages rather than items.

Rellana is the load-bearing counterexample: a Remembrance boss, unambiguously
DLC, invisible to every automatic signal. Any design claiming full automatic
accuracy is wrong.

**Decision: multi-signal classifier with a committed override file.** Automate
the 95% that is mechanical, make the remainder explicit and reviewable, and
report what the classifier is unsure about instead of hiding it.

## 1. Schema

Additive only, so an existing database still opens.

```sql
ALTER TABLE pages ADD COLUMN dlc INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN dlc_signals TEXT;          -- JSON array
ALTER TABLE pages ADD COLUMN has_dlc_sections INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS pages_dlc ON pages (dlc);

CREATE TABLE IF NOT EXISTS dlc_report (
  signal TEXT NOT NULL,
  hits INTEGER NOT NULL,
  at TEXT NOT NULL
);
```

- `dlc` — 1 if the page *is* DLC content.
- `dlc_signals` — JSON array of the signal names that fired, e.g.
  `["sote_template","location_category"]`. Every classification is auditable
  without re-running the classifier.
- `has_dlc_sections` — 1 if a base page contains DLC-referencing text. Set on
  hub pages, and on any base-game page whose wikitext carries a `{{SotE}}`
  marker the classifier read as a reference rather than a claim about the page's
  own subject: `Flask of Crimson Tears`, `Arcane`, `Ash of War: Quickstep`, and
  243 others (246 counting the hub pages). It is *not* set on pages that discuss DLC events in prose without
  the template — `Great Runes` describes Miquella breaking his rune in the Land
  of Shadow but uses no `{{SotE}}`, so it stays 0. The flag tracks the marker,
  not the subject matter; nothing detects the latter.

The unused `patch` column is left alone. Reusing it would conflate "which game
patch" with "which product", and it is already load-bearing in nothing.

`src/db/open.ts` gains a migration guard that adds the columns when absent, so
a database built before this change keeps working.

## 2. Classifier — `src/extract/dlc.ts`

`classifyDlc(db)` is a separate pass, not an extractor: it writes columns on
`pages` itself rather than derived rows keyed by `page_id`, so it is run as a
standalone step by four scripts — after `runExtractors` in `scripts/extract.ts`
and `scripts/build.ts`, and on its own (no `runExtractors` call at all) in
`scripts/sync.ts` and `scripts/sync-categories.ts`. It is not registered in
`src/extract/registry.ts` — that file is untouched by this feature — and it
never writes `extract_failures`; a bad override file throws instead (see
signal 1).

Signals 1 and 2 are exclusive overrides, checked first, and short-circuit
everything below them. Signals 3–6 are not "first match wins": each is
evaluated independently against every remaining page, and any number of them
can fire on the same page (`dlc_signals` then lists all of them) — `dlc` is
simply `signals.length > 0`.

1. **Override file** — `data/dlc-overrides.json`:
   ```json
   {
     "dlc":  ["Rellana, Twin Moon Knight", "Realm of Shadow", "..."],
     "base": ["Weapons", "Armor Sets", "Armor", "Talismans", "Starscourge Radahn", "..."]
   }
   ```
   Absolute. Short-circuits every other signal, including hub detection: item 2
   below is not a heuristic, it is this list's `base` entries. This is where
   human judgment lands, and the only place it lands. The `dlc` list holds pages
   no signal reaches (`Rellana`) and pages a signal gets wrong (`Realm of
   Shadow` — see signal 3). The `base` list holds hub/index pages, base-game
   pages the predicate signal gets wrong (`Godslayer Incantations` — see signal
   3), individual index-link leaks (see signal 6), and `Starscourge Radahn` —
   whose lead matches no `LEAD_MARKERS` pattern (a stray `;` in
   `in {{ER}}<i>:</i>;{{SotE}}` breaks the `in {{ER}}: {{SotE}}` form), and
   whom no category or index page reaches either, so the override is
   redundant for his `dlc` value today and changes only his `dlc_signals`
   (forcing `hub_page`). A
   missing file yields empty lists; malformed JSON, or JSON that is not an
   object, throws — `loadOverrides` treats a typo here as loud failure, not a
   silent revert of every correction.

2. **Hub-page exclusion** — the page's title is in the override file's `base`
   list. There is no heuristic: no check of title shape, no check for
   list/gallery markup. Forces `dlc = 0` and emits the signal name `hub_page`
   for *every* `base`-list entry, hub or not — so `dlc_signals` on
   `Starscourge Radahn` says `hub_page` too, which is imprecise about why he
   was forced base. Sets `has_dlc_sections = 1` when the page carries any
   spelling of the DLC marker anywhere on the page (the `SOTE_ANY` regex below).
   An untracked hub page is not caught here at all; it falls through to the
   signals below like any other page.

3. **Predicate-form lead marker** — `{{SotE}}` (`sote_template`) or the plain
   article link (`sote_link`), present in the page's **lead** (everything before
   the first `==` heading) in one of a fixed set of predicate shapes. The
   template forms, from `LEAD_MARKERS` in the code:
   - `{{in|se}}` / `{{in|sote}}` on its own, e.g. "is a Light Greatsword `{{in|se}}`";
   - `in {{ER}}: {{SotE}}`;
   - `in {{SotE}}` / `in the {{SotE}} expansion`;
   - `in {{ER}}, included in the {{SotE}} DLC`.

   The link form (`LEAD_LINK`) is the same predicate shape written as a plain
   link instead of a template, italics markup and all — the wiki italicises a
   product title, so Milady, Putrescent Knight and Needle Knight Leda read "in
   ''[[Elden Ring: Shadow of the Erdtree]]''":
   `\bin\s+(?:the\s+)?(?:'{2,5}|<i>)?\s*\[\[Elden Ring: Shadow of the Erdtree(?:\|[^\]]*)?\]\]`.

   There is no exclusion list. This spec's 2026-09-15 draft described three
   explicit exclusions — an occurrence after a link, a mention below the lead,
   a lead naming both products — as separate rules; none of that logic exists
   in the code. Requiring one of the shapes above, in the lead, makes all
   three fall out for free instead. An inline tag on a linked item
   (`[[Deflecting Hardtear]] {{SotE}}`), a coordinate-products lead ("in
   `{{ER}}` and `{{SotE}}`" — Paintings), a negation ("not implemented in
   `{{ER}}` or `{{SotE}}`" — Unused Content) and a patch note ("it also patched
   `{{SotE}}`" — Game Version/1.15) simply do not match any of the five
   regexes above, so none of them need special-casing. `Death Sorcery` and
   `Works and Adaptations` stay base game the same way. `Godslayer Incantations`
   is the one page the design still gets wrong on its own — a *second* lead
   paragraph independently reads "All bosses in `{{SotE}}` are resistant..." —
   so it is the one entry in the override file's `base` list that exists purely
   because of this signal.

   Two DLC-only pages read as coordinate claims and are corrected the other
   way, via the override file's `dlc` list: `Realm of Shadow` ("the setting of
   the DLC expansion for `{{ER}}`, `{{SotE}}`" — a coordinate product *title*,
   not a coordinate list) and `Cocoon of the Empyrean` / `Moangrave` (leads
   reading "in `{{ER}}` and `{{SotE}}`").

   A page excluded from `sote_template`/`sote_link` because its marker sits
   outside the lead, or in the lead but not in predicate form, still gets
   `has_dlc_sections = 1` when it carries the marker anywhere at all (again,
   `SOTE_ANY`). The text is never withheld; the answer is caveated.

4. **Title suffix** — title ends with `(Shadow of the Erdtree)`.

5. **DLC category membership** — the page's title is in the `dlc_categories`
   table, populated by the crawl over `Category:Shadow of the Erdtree` and its
   subcategories (see §5). Requires that crawl to have run at least once; it is
   empty on a snapshot that predates it, and the category signal fires on
   nothing until then.

6. **Index-linked titles** (`index_link`) — the title is linked from one of the
   22 `… (Shadow of the Erdtree)` index pages, read by `indexLinkedTitles`. This
   is the signal that reaches most pages the wiki marks nowhere in their own
   wikitext at all (three such pages are reached by `category` alone instead):
   `Rellana's Twin Blades` (whose own lead misreads "featured in `{{ER}}`"),
   `Star-Lined Sword`, `Spear of the Impaler`. For each index page, the `See
   Also` section is dropped; the lead's links still count toward the page's
   contribution, but the lead is excluded from the separate test (below) that
   decides whether the page tags its entries. Two of the 22 tag their own DLC entries
   inline (a link followed later on the same line by a marker — `taggedEntry`):
   `Enemies (Shadow of the Erdtree)` and `Incantations (Shadow of the Erdtree)`.
   When a page tags *any* of its lines, only its tagged lines contribute —
   this is what keeps about sixty base-game creatures, `Basilisk` and `Wolf`
   among them, off `Enemies (Shadow of the Erdtree)`'s manifest (the code's own
   comment says 61 for that page alone). A page that tags none
   contributes every link it has. A target containing `:` (a `File:`/`Category:`
   link, or `Ash of War: …`), another index title, or a title already in the
   override file's `base` list is dropped. `npm run extract` prints one line per
   index page — `index_link: <index> kept N of M links (tagged|untagged)` — so
   a page that silently starts contributing fewer links is visible in the run
   output rather than only in a coverage-test diff.

A page matching no signal at all is base-game. `dlc_report` no longer records
per-page ambiguity — it holds one row per signal with its hit count
(`bySignal`), refreshed every run. The base-page-mentions-DLC list
(`has_dlc_sections`, `report.ambiguous` in the code) is printed by the scripts
as override candidates: `ambiguous (candidates for data/dlc-overrides.json):
<up to 20 titles>`.

Classification is page-level, never section-level. Section-level filtering would
silently delete text from an answer on the strength of a heuristic; a
`has_dlc_sections` flag lets a caller caveat instead.

## 3. Query layer

`Dbs` gains a mode:

```ts
export type DlcMode = 'base' | 'all' | 'only';   // default 'base'
```

One helper produces the SQL fragment, and every query in `src/query/lookups.ts`
composes it. No per-tool filtering logic. As shipped, a page whose classifier
never ran (a cached Fextralife row) is exempted from every mode rather than
treated as base game, so `dlcPredicate` — `src/query/dbs.ts` — is an
`alias`-aware fragment with an `OR` for that row's `source`, not the flat
three-way switch first sketched here:

```ts
export function dlcPredicate(mode: DlcMode, alias = 'pages'): string {
  const unclassified = `${alias}.source = 'fextralife'`;
  switch (mode) {
    case 'only': return `(${alias}.dlc = 1 OR ${unclassified})`;
    case 'all':  return '1=1';
    case 'base':
    default:     return `(${alias}.dlc = 0 OR ${unclassified})`;
  }
}
```

`search` applies it by joining FTS hits back to `pages`. `itemStats` applies it
in its existing WHERE clause. The full-text fallback inside `resolveName`
(below) applies it too, but earlier and differently: it filters the FTS query
itself by the caller's mode rather than filtering a resolved page afterwards
(issue #6).

### The `dlc_filtered` result

`resolveName(dbs, name, mode, opts)` in `src/query/resolve.ts` resolves exact
title, redirect and entity-name matches against **all** pages regardless of
mode, then compares the result to the mode. `opts: ResolveOptions` carries one
field, `preferLocal` — set only when the caller passed `fetch: true`, so a
copy just cached from Fextralife is checked before the shipped snapshot
instead of being silently shadowed by it (issue #9). A resolved page's
`alternates` — the same title, exactly, in whichever db(s) the answer did not
come from — is filled in only on the two paths below that return an actual
page; the `DlcFiltered` shape and a `null` miss carry no `alternates` at all.

- resolved, and the mode permits it → the ordinary `Resolved` value, with
  `alternates` filled in from the other db(s).
- resolved, but the mode excludes it → `resolveName` first looks for the same
  exact title in the *other* db, permitted by the mode (`permittedElsewhere`;
  a cached Fextralife copy of the title always qualifies, being unclassified).
  If one exists, that copy is returned as the normal result instead — the gate
  is a last resort, checked only once no db holds a copy the mode actually
  allows. Otherwise `resolveName` returns
  `{ filtered: 'dlc', title, provenance, match }` (the `DlcFiltered` shape).
  `permittedElsewhere` only runs for an exact/redirect/entity match, never for
  a `match: 'search'` guess — hopping a guessed title to a different db's copy
  of that same guess compounds one guess into another.
- not resolved at all → `null`, as before.
- never classified (a cached Fextralife page, which has no wikitext for the
  classifier to read) → normal result in every mode, with `dlc: null`.
  "Unknown" is not "base game", and no mode filters an unknown out
  (`dlcOf(source, dlc)` in `src/query/dbs.ts` returns `null` whenever
  `source === 'fextralife'`).

`match` rides along on the gated shape because the gate is only as good as the
resolution behind it. The full-text fallback (`resolveIn`) tries the mode's own
pages first — `ftsHit(db, query, dlcPredicate(mode, 'p'))` — and only reaches
for the unfiltered top hit, still gated afterwards, when nothing permitted
matched at all. Even so, `item_stats {name: "Verdigris Greatsword"}` — not a
page in the snapshot — lands on `Enir-Ilim`, which *is* DLC (confirmed against
the shipped db). Without `match` the caller cannot tell "your page is DLC" from
"a guess is DLC", and re-running with `dlc: 'all'` returns a page about
something else. On a `match: 'search'` gate the hint (§4) says so in words.

This is what makes "Verdigris Armor is Shadow of the Erdtree content; re-run
with `dlc: 'all'`" possible, and it is why the filter is applied at the query
layer rather than by excluding rows from the resolver's view. A caller can
always tell "the snapshot does not cover this" from "you did not ask for DLC".

## 4. Tool surface

Every tool except `sources_status` gains:

```ts
const dlcArg = z.enum(['base', 'all', 'only']).optional().default('base')
  .describe('Which content to search: "base" (default) is base game only, "all" includes Shadow of the Erdtree, "only" is DLC content alone');
```

Result shape, alongside the existing provenance block:

- `dlc: true | false` on every result row from a Fandom page — the four
  single-page tools (`get_page`, `where_is`, `quest_steps`, `boss`) and
  `item_stats` called with `name` at the top level; `search` and `item_stats`'s
  filter form (no `name`) per row; **absent** (`null`, dropped by `compact()`)
  wherever the row came from a cached Fextralife page, whose DLC status nobody
  measured.
- `has_dlc_sections: true | false` on the single-page results only (the four
  tools above, plus `item_stats` called with `name`) — every successful result
  from one of those, always, not only when it happens to be true. `search`
  rows and `item_stats`'s filter form carry no `has_dlc_sections` at all: the
  flag is per-page, and those two return multiple pages' worth of rows with no
  single page to hang it on.
- `alternates`: on `get_page`, `where_is`, `quest_steps` and `boss` only (not
  `item_stats`, not `search`) — an array of `Provenance` objects (source,
  title, url, revid, fetched_at, license — no `dlc`/`has_dlc_sections`), one
  per other db that holds the exact same title. Empty (and so dropped by
  `compact()`) when only one db holds the page. This is the mechanism behind
  "when Fandom and Fextralife disagree on a number, show both with their
  sources": the caller gets the second copy's provenance without a second
  lookup.
- `reason: 'dlc_filtered'` plus `match`, `page`, and `provenance` on the gated
  not-found (built by `dlcFiltered()` in `src/query/lookups.ts` from
  `resolve.ts`'s internal `DlcFiltered` value — see §3). `search`'s own miss
  path reaches the same `reason` a different way: on a zero-row hit it counts
  what the *opposite* mode would have matched and reports `hidden_matches`
  instead of `page`/`match`, because a full-text search never resolved a
  single page to gate.
- Two more `not_found` reasons exist alongside `dlc_filtered`, both page-found:
  `no_stats` (the page exists but is not an item table row) and `no_sections`
  (nothing survived wikitext-to-markdown rendering). `item_stats`'s
  `invalid_filter`/`kind_mismatch` are unrelated to DLC mode and unaffected by
  it.

`sources_status` is unaffected by a `dlc` argument (it takes none) and reports
`base_pages`, `dlc_pages`, `dlc_signals` (one row per signal from `dlc_report`)
and `dlc_categories` (the count backing signal 5) alongside the pre-existing
sync/failure counts — unless the shipped db is stale (below), in which case it
reports only that.

A result with `error: 'data_stale'` (`{ error: 'data_stale', path, detail }`,
built by `staleReply()`) means `openDbs()` found a shipped db whose `pages`
table has no `dlc` column — built before 2026-09-16 — and refused to open it
for querying; `dbs.shipped` is `null` and every tool but `sources_status`
returns this instead of running. `detail` is `STALE_DETAIL` from
`src/query/dbs.ts`, which names the fix (`npm run extract`, or a newer
`data-*` release).

The server `INSTRUCTIONS` string in `src/server/mcp-server.ts` states the
default and the three modes, what `has_dlc_sections` means, that a
`dlc_filtered` result (with `match: 'search'` meaning the excluded page is a
guess rather than the resolved subject) is never missing data, what `alternates`
is for, that a result with no `dlc` field is an unclassified Fextralife page,
and what `data_stale` means. It does not spell out the per-tool exceptions
above (which tools carry `has_dlc_sections`/`alternates` and which do not).

## 5. Sync changes

`src/sources/fandom.ts` gains a category-membership fetch: for
`Category:Shadow of the Erdtree` and its subcategories, recursively collect
member titles into a set persisted for the classifier. This is a bounded crawl —
27 top-level members, three subcategories — not a second full sync.

`src/sync.ts` itself writes `dlc_categories` but never calls `classifyDlc` or
touches `dlc_report`; `scripts/sync.ts` (see §2) runs the classifier right
after calling it.

## 6. Testing

Fixture database built from real wikitext for five pages, each covering a
distinct classification path:

| Page | Expected | Path |
|---|---|---|
| Verdigris Armor | dlc | `{{SotE}}` template |
| Rellana, Twin Moon Knight | dlc | override file only |
| Scadu Altus | dlc | location category |
| Icerind Hatchet | base | no signal |
| Weapons | base + `has_dlc_sections` | hub exclusion over `{{SotE}}` |

Tests:

- Classifier unit tests per signal, plus precedence: override beats hub
  exclusion beats template.
- Query tests: each of the three modes against each fixture.
- `dlc_filtered`: `where_is('Verdigris Armor')` in `base` mode returns the
  gated not-found with the title, not a bare miss.
- Migration test: a database created without the new columns opens and
  classifies.
- End-to-end through `scripts/smoke-mcp.ts`.
- Coverage assertions on the full shipped DB. The bound is two-sided: a floor
  alone can only catch under-labelling, and over-labelling is what the
  classifier actually did. It also pins zero known hub pages as DLC, the
  former false positives at `dlc = 0`, `has_dlc_sections` in the hundreds, and
  `where_is` answering normally for `Flask of Crimson Tears` while still gating
  `Verdigris Armor`.

## Files touched

| File | Change |
|---|---|
| `src/db/schema.sql` | new columns, index, `dlc_report`, `dlc_categories` |
| `src/db/open.ts` | additive migration guard |
| `src/extract/dlc.ts` | new — the classifier, `indexLinkedTitles`, signal regexes |
| `src/extract/registry.ts` | not touched — the classifier is a separate pass, not an extractor |
| `src/query/dbs.ts` | `DlcMode`, `dlcPredicate`, thread through `Dbs`, `Dbs.stale`/`STALE_DETAIL` |
| `src/query/lookups.ts` | apply `dlcPredicate` in every query; `dlc_filtered`/`no_stats`/`no_sections` reasons |
| `src/query/resolve.ts` | resolve-then-compare, `DlcFiltered`, `permittedElsewhere`, `alternates`, mode-aware FTS fallback |
| `src/server/mcp-server.ts` | `dlc` param on six tools, INSTRUCTIONS, `data_stale` reply |
| `src/server/compact.ts` | drops null/empty fields so an unclassified page's absent `dlc` disappears |
| `src/sources/fandom.ts` | category membership crawl (`listDlcCategoryTitles`) |
| `src/sync.ts` | write `dlc_categories`; does not run the classifier itself (see §5) |
| `scripts/sync-categories.ts` | new — refreshes `dlc_categories` alone and reclassifies |
| `scripts/extract.ts` | re-render every page's sections, then classify after `runExtractors` |
| `scripts/build.ts` | classify after re-extracting the changed pages; it does **not** re-render, so `.github/workflows/weekly-data.yml` runs `npm run extract` after `npm run build` to pick up renderer changes |
| `scripts/report.ts` | new — shared `printDlcReport()` console output |
| `src/wikitext/markdown.ts` | `substituteProductNames` — renders `{{PAGENAME}}` and the product-name templates instead of stripping them, so rendered prose (tool results, full-text search) keeps the product names; `classifyDlc` is unaffected, since it reads `pages.wikitext` directly, never rendered markdown |
| `src/store/pages.ts` | `rerenderSections` — re-renders every page's markdown from stored wikitext without a re-fetch |
| `data/dlc-overrides.json` | new — committed override list |
| `.github/workflows/ci.yml` | `npm run sync-categories` before `npm run extract`, so `dlc_categories` and the category signal are populated before tests run |
| `test/` | fixtures and the suites above, including `test/dlc-coverage.test.ts` against the shipped snapshot |

## Known limitations

- **The classifier will be wrong on some pages at first.** Rellana proves no
  automatic signal is complete. The coverage report and the override file are
  the mechanism for converging on correctness, not a promise of day-one
  accuracy.
- **Measured coverage (2026-09-16, shipped snapshot, post index-link):**
  `dlc: 821/4922 pages, 263 base pages mention DLC`. By signal — a page can
  carry more than one, so these do not sum to 821 — `override=7 hub_page=31
  sote_template=661 sote_link=69 title_suffix=22 category=123 index_link=508`
  (`hub_page` is the signal name emitted for every `base`-list override, hub or
  not — see §2 signal 2 and below). `dlc_categories` holds 127 titles from a
  live crawl run the same day; 65 pages carry `index_link` as their *only*
  signal — the pages no wikitext marker or category reaches at all. These
  replace both the 2026-09-15 figures (857 DLC, 8 flagged) and the
  post-predicate, pre-index-link figures (619 DLC, 246 flagged) recorded in an
  earlier draft of this section.
- **The product-name-template rendering fix changed what callers read, not
  what the classifier reads.** Before it, `stripTemplates` deleted `{{ER}}`,
  `{{SotE}}` and `{{PAGENAME}}` along with every other template, so a lead like
  "is an Arrow in {{ER}}." rendered as "is an Arrow in ." — 3,586 sections read
  that way in tool results and full-text search. `src/wikitext/markdown.ts`'s
  `substituteProductNames` now renders those five spellings (`PAGENAME`, `ER`,
  `ERN`, `SotE`, `{{in|...}}`) to their product names before templates are
  stripped, and `scripts/extract.ts` calls `rerenderSections` before
  `runExtractors` so a schema/renderer change reaches the stored
  `sections.markdown` without a full re-sync. `classifyDlc` was never affected
  either way: it reads `pages.wikitext` directly and its signals match the raw
  templates, not rendered markdown. 65 sections still read "… in ." on the
  current snapshot — templates outside the five substituted spellings,
  unaffected by this fix.
- **Known false positives, now pinned base.** `Godslayer Incantations` is
  corrected in the override file specifically because its *second* lead
  paragraph independently reads a predicate marker (§2 signal 3). `Death
  Sorcery`, `Game Version/1.15`, `Paintings`, `Unused Content` and `Works and
  Adaptations` need no override at all — the predicate-only design in §2
  signal 3 excludes their leads (negation, coordinate list, patch note) for
  free.
- **Known DLC-only pages that needed a `dlc` override.** `Realm of Shadow`,
  `Cocoon of the Empyrean`, `Moangrave`, `Dragon Communion Altar`, `Miquella
  the Kind/dialogue`, `Stranded Souls/dialogue` — leads that read as
  coordinate-products claims, or (the two `/dialogue` subpages) no lead
  predicate at all.
- **Individual `base` overrides for index-link leaks.** `Death Rite Bird`,
  `Fallingstar Beast`, `Tree Sentinel`, `Skeleton`, `Larval Tear`, `Lulling
  Branch`, `Painter Spirit`, `Stranded Souls` — each a base-game page listed,
  untagged, on an index page that tags none of its entries, so the per-entry
  tag rule (§2 signal 6) cannot reach it. `data/dlc-overrides.json` documents
  the specific reason for each.
- **Remaining known gaps, as of 2026-09-16:**
  - A page neither marked (no predicate-form lead), categorised, nor
    index-linked stays base. No signal reaches it; only a new signal or a
    `dlc` override would.
  - The index_link rule (§2 signal 6) is all-or-nothing per index page: an
    untagged addition to a page that already tags some of its entries would be
    silently dropped from that page's contribution. `npm run extract` prints
    `index_link: <index> kept N of M links` on every run, so a page going
    silently quiet is visible without waiting on a coverage-test failure.
  - The `:` exclusion in index-link target parsing (dropping `File:`/
    `Category:` links and other index titles) also drops `Ash of War: …`
    targets. Harmless today: every Ash of War page independently carries
    `sote_template` or is base game, so none currently depend on `index_link`
    to be classified correctly.
  - Hub detection is the override file's `base` list, full stop — there is no
    heuristic, and no page is ever excluded as a hub except by being named in
    that list.
  - A `base`-list override emits the signal name `hub_page` regardless of
    whether the page is actually a hub (`Starscourge Radahn`, `Godslayer
    Incantations`): `dlc_signals` cannot distinguish "this is an index page"
    from "this is a base-game page a signal mislabelled."
- **Accuracy is spot-checked, not measured.** `test/dlc-coverage.test.ts` pins
  known hub, DLC, base, and index-link-only pages against the shipped
  snapshot, plus a two-sided bound (`>= 781` and `<= 861`) on the total DLC
  count. Accuracy across all 4,922 pages is unmeasured.
- **Page-level only.** A base-game page that discusses DLC events returns that
  text in base mode. `has_dlc_sections` flags it; nothing strips it.
- **Category membership is a point-in-time capture.** It refreshes when
  `sync-categories` or a full sync runs, like every other fact in the
  snapshot.
