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
  244 others (247 counting the hub pages). It is *not* set on pages that discuss DLC events in prose without
  the template — `Great Runes` describes Miquella breaking his rune in the Land
  of Shadow but uses no `{{SotE}}`, so it stays 0. The flag tracks the marker,
  not the subject matter; nothing detects the latter.

The unused `patch` column is left alone. Reusing it would conflate "which game
patch" with "which product", and it is already load-bearing in nothing.

`src/db/open.ts` gains a migration guard that adds the columns when absent, so
a database built before this change keeps working.

## 2. Classifier — `src/extract/dlc.ts`

Registered in `src/extract/registry.ts` and run by the existing
`runExtractors` pass, so it inherits the `extract_failures` reporting already in
place.

Signals evaluated in precedence order. First match wins.

1. **Override file** — `data/dlc-overrides.json`:
   ```json
   {
     "dlc":  ["Rellana, Twin Moon Knight"],
     "base": ["Weapons", "Armor Sets", "Armor", "Talismans"]
   }
   ```
   Absolute. Short-circuits every other signal. This is where human judgment
   lands, and the only place it lands.

2. **Hub-page exclusion** — the page is an index or list page: its title is a
   bare category noun, or its wikitext is dominated by list/gallery markup.
   Forces `dlc = 0`, and sets `has_dlc_sections = 1` when `{{SotE}}` is present.
   This is what stops `Weapons` and `Armor Sets` from being swept in.

3. **`{{SotE}}` template** — present in the wikitext *as a page marker*. The
   workhorse. `{{SotE}}` is more often an inline LINK marker than a page marker:
   the wiki writes `[[Deflecting Hardtear]] {{SotE}}` inside base-game lists to
   tag the linked thing. Three exclusions separate "this page IS DLC" from "this
   page MENTIONS DLC", each measured against the snapshot's 847 pages carrying
   the template:
   - an occurrence preceded by `]]` or `<br>` tags that link — 167 pages;
   - an occurrence below the lead is a note about the DLC, e.g. "all bosses in
     `{{SotE}}` are resistant to percentage damage" — 40 pages;
   - a lead naming both products, "in `{{ER}}` and `{{SotE}}`" or "in `{{ER}}`,
     `{{SotE}}`, and `{{ERN}}`", says the subject ships with the base game —
     41 pages.

   What remains is 599 pages. A genuine DLC page states its subject in the lead
   and names one product: "in `{{ER}}`: `{{SotE}}`", "in `{{ER}}`, included in
   the `{{SotE}}` DLC", or "in `{{SotE}}`".

   An excluded page is base game *and* carries `has_dlc_sections`. The text is
   never withheld; the answer is caveated.

4. **Title suffix** — title ends with `(Shadow of the Erdtree)`.

5. **DLC category membership** — the page is in
   `Category:Shadow of the Erdtree Locations` or a recursive subcategory of
   `Category:Shadow of the Erdtree`. Requires the sync step to capture category
   membership (see §5).

A page matching no signal is base-game. A page where signal 2 contradicts
signals 3–5 is recorded as ambiguous in `dlc_report` and left at `dlc = 0`;
ambiguity is the queue for the override file.

Classification is page-level, never section-level. Section-level filtering would
silently delete text from an answer on the strength of a heuristic; a
`has_dlc_sections` flag lets a caller caveat instead.

## 3. Query layer

`Dbs` gains a mode:

```ts
export type DlcMode = 'base' | 'all' | 'only';   // default 'base'
```

One helper produces the SQL fragment, and every query in `src/query/lookups.ts`
composes it. No per-tool filtering logic:

```ts
export function dlcPredicate(mode: DlcMode): string {
  switch (mode) {
    case 'base': return 'pages.dlc = 0';
    case 'only': return 'pages.dlc = 1';
    case 'all':  return '1=1';
  }
}
```

`search` applies it by joining FTS hits back to `pages`. `itemStats` applies it
in its existing WHERE clause.

### The `dlc_filtered` result

`resolveName` in `src/query/resolve.ts` resolves against **all** pages
regardless of mode, then compares the result to the mode:

- resolved, and the mode permits it → normal result
- resolved, but the mode excludes it → `{ notFound: true, reason: 'dlc_filtered', title, match, dlc: true }`
- not resolved at all → `{ notFound: true }` as today
- never classified (a cached Fextralife page, which has no wikitext for the
  classifier to read) → normal result in every mode, with no `dlc` field.
  "Unknown" is not "base game", and no mode filters an unknown out.

`match` rides along on the gated shape because the gate is only as good as the
resolution behind it. `resolveName` falls back to full-text search, so
`item_stats {name: "Verdigris Greatsword"}` — not a page — lands on `Enir-Ilim`,
which *is* DLC. Without `match` the caller cannot tell "your page is DLC" from "a
guess is DLC", and re-running with `dlc: 'all'` returns a page about something
else. On a `match: 'search'` gate the hint says so in words.

This is what makes "Verdigris Armor is Shadow of the Erdtree content; re-run
with `dlc: 'all'`" possible, and it is why the filter is applied at the query
layer rather than by excluding rows from the resolver's view. A caller can
always tell "the snapshot does not cover this" from "you did not ask for DLC".

## 4. Tool surface

Every tool except `sources_status` gains:

```ts
dlc: z.enum(['base','all','only']).optional().default('base')
  .describe("Base game only (default), 'all' to include Shadow of the Erdtree, 'only' for DLC content alone")
```

Result shape, alongside the existing provenance block:

- `dlc: true | false` on every result from a classified page; **absent** on a
  cached Fextralife page, whose DLC status nobody measured
- `has_dlc_sections: true` when set, so an answer can note that a base-game page
  discusses DLC events
- `reason: 'dlc_filtered'` plus `match` on the gated not-found

`sources_status` reports base and DLC page counts plus the last classifier run's
signal breakdown from `dlc_report`.

The server `INSTRUCTIONS` string in `src/server/mcp-server.ts` is updated to
state: results are base-game by default, `dlc` opts in, and `dlc_filtered` means
the page exists but was excluded by the caller's own mode.

## 5. Sync changes

`src/sources/fandom.ts` gains a category-membership fetch: for
`Category:Shadow of the Erdtree` and its subcategories, recursively collect
member titles into a set persisted for the classifier. This is a bounded crawl —
27 top-level members, three subcategories — not a second full sync.

`src/sync.ts` runs the classifier after extraction and writes `dlc_report`.

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
| `src/db/schema.sql` | new columns, index, `dlc_report` |
| `src/db/open.ts` | additive migration guard |
| `src/extract/dlc.ts` | new — the classifier |
| `src/extract/registry.ts` | register it |
| `src/query/dbs.ts` | `DlcMode`, thread through `Dbs` |
| `src/query/lookups.ts` | `dlcPredicate`, apply in every query |
| `src/query/resolve.ts` | resolve-then-compare, `dlc_filtered` |
| `src/server/mcp-server.ts` | `dlc` param on six tools, INSTRUCTIONS |
| `src/server/compact.ts` | surface `dlc` / `has_dlc_sections` in results |
| `src/sources/fandom.ts` | category membership crawl |
| `src/sync.ts` | run classifier, write report |
| `data/dlc-overrides.json` | new — committed override list |
| `test/` | fixtures and the suites above |

## Known limitations

- **The classifier will be wrong on some pages at first.** Rellana proves no
  automatic signal is complete. The coverage report and the override file are
  the mechanism for converging on correctness, not a promise of day-one
  accuracy.
- **Measured coverage (2026-09-16):** the classifier labels 618 of 4,922 pages
  as DLC, by signal: sote_template=598, title_suffix=22, category=0,
  hub_page=12, override=1 (a page can carry more than one signal, so these do
  not sum to 618). 247 base-game pages are flagged `has_dlc_sections`. These
  replace the 2026-09-15 figures (857 DLC, 8 flagged), which counted the
  inline-link-marker false positives described in §2 signal 3.
  `category=0` because `dlc_categories` is empty in the local database — it has
  not been synced since the category crawl was added, so the category signal has
  never fired on real data, only in synthetic unit tests.
- **Measured false negatives: 167 pages.** The wiki marks the DLC three ways and
  the classifier reads one of them. 81 base-labelled pages carry `{{in|SotE}}`
  or `{{in|se}}` — the same marker template under a different invocation — and
  87 carry a plain `[[Elden Ring: Shadow of the Erdtree]]` link instead of any
  template; 167 pages match one or the other. Every one of them is DLC content
  that base mode now serves and labels `dlc: false`: `Milady`, `Backhand Blade`,
  `Great Katana`, `Midra, Lord of Frenzied Flame`, `Putrescent Knight`,
  `Needle Knight Leda`, `Bloodfiend's Fork`, `Black Steel Twinblade`. This is
  pre-existing — no signal ever read those forms — and unaddressed. Adding
  `{{in|SotE}}` as a fourth exclusion-aware spelling of signal 3 is the obvious
  next step; the plain-link form is a genuinely new signal and needs its own
  measurement.
- **Accuracy is spot-checked, not measured.** `test/dlc-coverage.test.ts` pins
  four known-hub pages, six known-DLC pages, three known-base pages and fifteen
  former false positives against the shipped snapshot, plus a two-sided bound on
  the DLC count. Accuracy across all 4,922 pages is unmeasured.
- **The `base` override list carries two different corrections.** It began as
  hub-page exclusion and now also holds `Starscourge Radahn`, a base-game boss
  whose lead says he appears in both products in a shape no rule reads safely.
  Both emit the signal name `hub_page`, so `dlc_signals` on Radahn is imprecise
  about *why* he was forced base.
- **Page-level only.** A base-game page that discusses DLC events returns that
  text in base mode. `has_dlc_sections` flags it; nothing strips it.
- **Hub detection is a heuristic.** The override file's `base` list is the
  backstop for hub pages it misses.
- **Category membership is a point-in-time capture.** It refreshes when sync
  runs, like every other fact in the snapshot.
