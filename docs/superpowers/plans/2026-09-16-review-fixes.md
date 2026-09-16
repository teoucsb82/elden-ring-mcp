# Review Fixes (issues #1–#18) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close GitHub issues #1–#18 on teoucsb82/elden-ring-mcp (the 2026-09-16 adversarial review) on one branch, one commit per task, each commit body naming the issues it closes.

**Architecture:** The DLC classifier (`src/extract/dlc.ts`) moves from "any `{{SotE}}` in the lead" to predicate-form lead markers in every spelling the wiki uses, plus two new signals (plain link, DLC index-page links) and a working category signal. The query layer (`src/query/`) applies the dlc mode inside the full-text fallback, carries `has_dlc_sections` and `alternates` on every resolved page, and can prefer the local Fextralife copy. The server (`src/server/`) refuses a stale (pre-DLC) snapshot with a named error instead of `no such column`, and exits with a message when launched by the old entry point. CI downloads the data release and re-extracts before testing.

**Tech Stack:** TypeScript (ESM, `tsx`), better-sqlite3 + FTS5, node:test, zod v4, @modelcontextprotocol/sdk, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-15-sote-dlc-layering-design.md` (DLC feature), issues #1–#18 at https://github.com/teoucsb82/elden-ring-mcp/issues (each task names its issues; the issue text is the acceptance criterion).

## Global Constraints

- **Node:** the `node` on PATH is v20 and segfaults better-sqlite3. Every command in this plan is run as `PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH" <command>`. Never run `npm test`, `npm run typecheck`, `npm run smoke`, `npm run extract` without that prefix.
- **Baseline:** `npm test` = 165 pass / 0 fail / 0 skipped; `npm run typecheck` clean; `npm run smoke` all `ok`. Every task must leave all three green (counts may grow).
- **Data:** `data/elden-ring.db` in this worktree is a private copy (gitignored). `npm run extract` and `npm run sync-categories` may modify it. **Never run `npm run sync` or `npm run build`** (full live crawl).
- **Network:** no live network calls in tests. The only live call allowed outside tests is `npm run sync-categories` (Task 3; ~10 MediaWiki API requests).
- **Commits:** one commit per task (fix rounds may add more). Body ends with `Closes #N` lines for every issue the task closes, then a blank line, then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Commit only files the task touches; never commit `data/*.db`, `.superpowers/`, or `.claude/`.
- **Result-shape rule (spec §3/§4):** a page that exists is never reported as `not_found` without a `reason`; `dlc: true|false` on every successful result from a Fandom page, absent on a Fextralife page; `compact()` drops `null`/`undefined`/empty, keeps `false`.
- **No subagents** from implementers.
- **Style:** existing code style: 2-space indent, single quotes, trailing commas absent on single-line objects, doc comments explain *why*. Tests use `node:test` + `node:assert/strict`, fixtures via `test/helpers.ts` (`memoryDb()`) or `test/query.test.ts`'s `fixtureDbs([...])`.

---

### Task 1: Old entry point exits with a message (#2)

**Files:**
- Modify: `src/server/mcp-server.ts` (top of file, before `openDbs()` at line 24)
- Test: `test/server.test.ts`

**Interfaces:**
- Produces: nothing new. `src/server/start.ts` and the in-process import path in tests must keep working unchanged.

- [ ] **Step 1: Write the failing test** — append to `test/server.test.ts`:

```ts
import { spawnSync } from 'node:child_process';

// Until 2026-09-16 the documented entry point was src/server/mcp-server.ts. It now only builds the
// server, so an old .mcp.json that still names it got a process that exited 0 with no output and a
// client that reported CONNECTION_CLOSED with nothing to go on.
test('running mcp-server.ts directly exits 1 and names the new entry point', () => {
  const result = spawnSync('npx', ['tsx', 'src/server/mcp-server.ts'], {
    cwd: REPO_ROOT, encoding: 'utf8',
    env: { ...process.env, ELDEN_RING_MCP_CACHE: mkdtempSync(join(tmpdir(), 'er-old-entry-')) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/server\/start\.ts/);
  assert.match(result.stderr, /entry point/i);
});
```

- [ ] **Step 2: Run it** — `npm test -- test/server.test.ts` → expect FAIL: `status` is 0.

- [ ] **Step 3: Implement** — in `src/server/mcp-server.ts`, after the imports and before `export const INSTRUCTIONS`:

```ts
import { pathToFileURL } from 'node:url';

// Guard the old entry point. This module is imported by start.ts and by tests; only a direct
// `tsx src/server/mcp-server.ts` (an .mcp.json written before 2026-09-16) reaches process.argv[1].
// Exiting 0 with no output here left clients reporting CONNECTION_CLOSED with nothing to go on.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  console.error('elden-ring-mcp: the entry point moved to src/server/start.ts (`npm run mcp`). Update your MCP config args to ["tsx", "src/server/start.ts"].');
  process.exit(1);
}
```

Update the file's header comment (lines 1–6) to say the same in one sentence.

- [ ] **Step 4: Run the suite** — `npm test` → 166 pass. `npm run smoke` → all ok (start.ts path unaffected).

- [ ] **Step 5: Commit** — `git add src/server/mcp-server.ts test/server.test.ts`, message `fix(server): exit with a message when the old entry point is run directly` + `Closes #2`.

---

### Task 2: Stale (pre-DLC) snapshot is a named error, not "no such column" (#1)

**Files:**
- Modify: `src/query/dbs.ts` (`Dbs`, `openDbs`)
- Modify: `src/server/mcp-server.ts` (tool handlers, INSTRUCTIONS)
- Modify: `src/query/lookups.ts` (`sourcesStatus`)
- Modify: `scripts/fetch-data.ts` (post-download schema check)
- Modify: `.github/workflows/weekly-data.yml` (release tag collision)
- Test: `test/query.test.ts`, `test/server.test.ts`

**Interfaces:**
- Produces: `Dbs.stale?: { path: string; detail: string }` — set (and `shipped: null`) when the shipped db lacks the `dlc` column. `STALE_DETAIL` exported from `src/query/dbs.ts`. Tool result `{ error: 'data_stale', detail }`.

- [ ] **Step 1: Failing tests**

`test/query.test.ts` (near the existing `openDbs`/`dlcPredicate` tests):

```ts
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDbs, STALE_DETAIL } from '../src/query/dbs.js';

// The only published data release (data-2026.09.16) predates the dlc columns. Opening it read-only
// skips the migration, so every query died with "no such column: dlc" and nothing said why.
test('openDbs reports a pre-dlc shipped db as stale instead of opening it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-stale-'));
  const path = join(dir, 'old.db');
  const old = new Database(path);
  old.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
    revid INTEGER, fetched_at TEXT NOT NULL, license TEXT NOT NULL, patch TEXT, wikitext TEXT, UNIQUE (source, title));`);
  old.close();
  process.env.ELDEN_RING_MCP_DB = path;
  process.env.ELDEN_RING_MCP_CACHE = join(dir, 'cache');
  const dbs = openDbs();
  assert.equal(dbs.shipped, null);
  assert.equal(dbs.stale?.path, path);
  assert.equal(dbs.stale?.detail, STALE_DETAIL);
  assert.match(STALE_DETAIL, /npm run extract/);
  delete process.env.ELDEN_RING_MCP_DB;
});
```

`test/server.test.ts` — a second stdio boot test, same shape as the existing one, but `dbPath` is a pre-dlc db built exactly as above; after connecting:

```ts
const result = await client.callTool({ name: 'where_is', arguments: { name: 'Uchigatana' } });
const text = (result.content as { text: string }[])[0].text;
assert.match(text, /"error":"data_stale"/);
assert.match(text, /npm run extract/);
const status = await client.callTool({ name: 'sources_status', arguments: {} });
assert.match((status.content as { text: string }[])[0].text, /"stale"/);
```

- [ ] **Step 2: Run** — expect FAIL (`no such column` / `stale` undefined).

- [ ] **Step 3: Implement**

`src/query/dbs.ts`:

```ts
export interface Dbs {
  shipped: Db | null;
  local: Db | null;
  /** Set when the shipped db exists but predates the dlc columns; shipped is null in that case. */
  stale?: { path: string; detail: string };
}

export const STALE_DETAIL = 'The shipped snapshot predates the Shadow of the Erdtree columns (built before 2026-09-16). Run `npm run extract` to migrate and classify it, or `npm run fetch-data` once a newer data-* release exists. Results are unavailable until then; this is not missing data.';

function hasDlcColumns(db: Db): boolean {
  return (db.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).some((c) => c.name === 'dlc');
}

export function openDbs(): Dbs {
  const shippedPath = process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH;
  const local = openDb(localDbPath());
  if (!existsSync(shippedPath)) return { shipped: null, local };
  const shipped = openDb(shippedPath, { readonly: true });
  if (hasDlcColumns(shipped)) return { shipped, local };
  shipped.close();
  return { shipped: null, local, stale: { path: shippedPath, detail: STALE_DETAIL } };
}
```

`src/server/mcp-server.ts`: add `const staleReply = () => reply({ error: 'data_stale', path: dbs.stale?.path, detail: dbs.stale?.detail });` and in every tool handler except `sources_status`, return `staleReply()` first when `dbs.stale` is set (put the check inside `withFetch` and in the two inline handlers). Add to INSTRUCTIONS: `A result with error: "data_stale" means the shipped snapshot predates this server's schema; tell the user to run npm run extract (or fetch a newer data release). It is not missing data.`

`src/query/lookups.ts` `sourcesStatus`: when `dbs.stale`, return `shipped: { stale: dbs.stale.detail, path: dbs.stale.path }` instead of `null`.

`scripts/fetch-data.ts`: after `writeFileSync`, open the file with `new Database(DEFAULT_DB_PATH, { readonly: true })`, run the same PRAGMA, and if `dlc` is missing print `console.error('warning: ${release.tag_name} predates the dlc columns; run npm run extract before starting the server')` (still exit 0).

`.github/workflows/weekly-data.yml` "Publish release" step: replace the `TAG=` line with

```bash
TAG="data-$(date -u +%Y.%m.%d)"
if gh release view "$TAG" >/dev/null 2>&1; then TAG="$TAG.${GITHUB_RUN_NUMBER}"; fi
```

(the 2026-09-16 tag already exists, so a re-run today would fail on `gh release create`).

- [ ] **Step 4: Run** — `npm test`, `npm run typecheck`, `npm run smoke` all green.

- [ ] **Step 5: Commit** — `fix(server): report a pre-dlc snapshot as data_stale instead of failing every tool` + `Closes #1`.

---

### Task 3: Category signal actually runs (#8)

**Files:**
- Create: `scripts/sync-categories.ts`
- Modify: `package.json` (script `sync-categories`)
- Modify: `src/query/lookups.ts` (`sourcesStatus` adds `dlc_categories` count)
- Modify: `scripts/extract.ts`, `scripts/sync.ts`, `scripts/build.ts` (warn when the table is empty)
- Test: `test/dlc-coverage.test.ts`

**Interfaces:**
- Produces: `npm run sync-categories` — crawls `Category:Shadow of the Erdtree` (bounded), writes `dlc_categories`, re-runs `classifyDlc`, prints the report. `sources_status.shipped.dlc_categories: number`.

- [ ] **Step 1: Failing test** — `test/dlc-coverage.test.ts`:

```ts
// dlc_categories was empty in the first shipped snapshot (synced two hours before the crawl
// landed), so the category signal had only ever fired in synthetic unit tests.
test('the shipped db carries category membership and the category signal fired', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  const titles = (db.prepare('SELECT count(*) AS n FROM dlc_categories').get() as { n: number }).n;
  assert.ok(titles >= 60, `expected 60+ dlc category titles (Locations alone has 64 live), got ${titles}`);
  const hits = (db.prepare("SELECT hits FROM dlc_report WHERE signal = 'category'").get() as { hits: number }).hits;
  assert.ok(hits >= 50, `expected the category signal to fire on 50+ pages, got ${hits}`);
  db.close();
});
```

- [ ] **Step 2: Run** — FAIL (0 titles).

- [ ] **Step 3: Implement** `scripts/sync-categories.ts`:

```ts
// Refreshes only the Shadow of the Erdtree category membership (a bounded crawl: one root category,
// a handful of subcategories) and re-runs the classifier. Use it when the snapshot predates the
// category crawl, or when the wiki's categories changed but nothing else did.
// Run: npm run sync-categories
import { openDb } from '../src/db/open.js';
import { classifyDlc } from '../src/extract/dlc.js';
import { createFandom } from '../src/sources/fandom.js';
import { replaceDlcCategories, DEFAULT_DB_PATH } from '../src/store/pages.js';

const db = openDb(process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH);
const titles = await createFandom().listDlcCategoryTitles();
replaceDlcCategories(db, titles);
console.log(`dlc category titles: ${titles.length}`);
const dlc = classifyDlc(db);
console.log(`dlc: ${dlc.dlc}/${dlc.pages} pages, ${dlc.hasDlcSections} base pages mention DLC`);
console.log(`signals: ${Object.entries(dlc.bySignal).map(([signal, hits]) => `${signal}=${hits}`).join(' ')}`);
db.close();
```

`package.json`: `"sync-categories": "tsx scripts/sync-categories.ts"`.

In `scripts/extract.ts`, `scripts/sync.ts`, `scripts/build.ts`, after `classifyDlc`: `if (dlc.bySignal.category === 0) console.warn('warning: dlc_categories is empty, the category signal fired on nothing; run npm run sync-categories');` (extract the three duplicated report-printing blocks into one `printDlcReport(report)` in a new `scripts/report.ts` while you are there — three verbatim copies is the current state).

`sourcesStatus`: add `dlc_categories: count(dbs.shipped, 'SELECT count(*) AS n FROM dlc_categories')`.

- [ ] **Step 4: Run the crawl** — `npm run sync-categories` (live; ~10 requests). Record the printed `dlc category titles: N` and `signals:` line in your report. Then `npm test` → the new test passes.

- [ ] **Step 5: Commit** — `feat(data): sync-categories script so the category signal fires on real data` + `Closes #8`.

---

### Task 4: Classifier reads every marker spelling, in predicate form only (#3, #4, #5)

**Files:**
- Modify: `src/extract/dlc.ts` (`SOTE_TEMPLATE`, `INLINE_MARKER`, `BOTH_GAMES`, `soteMentions`, `classifyPage`, `DlcSignal`)
- Modify: `data/dlc-overrides.json`
- Modify: `test/dlc.test.ts`, `test/dlc-coverage.test.ts`

**Interfaces:**
- Produces: `DlcSignal` gains `'sote_link'`. `soteMentions(wikitext)` keeps its `{ any, pageMarker }` shape; `pageMarker` now means "the lead states the subject is in the DLC".

**Rules (replace the three exclusions and `BOTH_GAMES` entirely):**

```ts
const SOTE = String.raw`\{\{\s*SotE\b`;
const IN_SE = String.raw`\{\{\s*in\s*\|\s*(?:se|sote)\s*(?:\||\}\})`;   // {{in|se}}, {{in|sote}}: the wiki's other marker template
/** Any spelling, anywhere: what has_dlc_sections reports. */
const SOTE_ANY = new RegExp(`${SOTE}|${IN_SE}|\\[\\[Elden Ring: Shadow of the Erdtree(?:\\|[^\\]]*)?\\]\\]`, 'gi');
/**
 * A page IS DLC when its lead says so in predicate form. Any other lead mention ("[[X]] {{SotE}}",
 * "in {{ER}} and {{SotE}}", "not implemented in {{ER}} or {{SotE}}") is a reference, not a claim.
 */
const LEAD_MARKERS: RegExp[] = [
  new RegExp(IN_SE, 'i'),
  new RegExp(String.raw`\bin\s+\{\{\s*ER\s*\}\}\s*(?:<i>)?\s*:\s*(?:</i>)?\s*${SOTE}`, 'i'),   // in {{ER}}: {{SotE}}
  new RegExp(String.raw`\bin\s+(?:the\s+)?${SOTE}`, 'i'),                                       // in {{SotE}} / in the {{SotE}} expansion
  new RegExp(String.raw`\bincluded\s+in\s+(?:the\s+)?${SOTE}`, 'i'),                            // in {{ER}}, included in the {{SotE}} DLC
];
/** Same predicate form with the plain link instead of a template. A distinct signal so it can be measured on its own. */
const LEAD_LINK = /\bin\s+(?:the\s+)?\[\[Elden Ring: Shadow of the Erdtree(?:\|[^\]]*)?\]\]/i;
```

`soteMentions` returns `{ any: SOTE_ANY matches anywhere, pageMarker: some LEAD_MARKERS matches the lead, linkMarker: LEAD_LINK matches the lead }`; `classifyPage` pushes `'sote_template'` for `pageMarker` and `'sote_link'` for `linkMarker`. Delete `INLINE_MARKER` and `BOTH_GAMES`. Keep `LEAD_END`. Overrides: add to `"dlc"`: `"Cocoon of the Empyrean"`, `"Moangrave"`, `"Dragon Communion Altar"`, `"Miquella the Kind/dialogue"`, `"Stranded Souls/dialogue"` (leads say "in {{ER}} and {{SotE}}" for DLC-only subjects; no rule reads that safely). Update the `_comment`.

- [ ] **Step 1: Failing unit tests** — in `test/dlc.test.ts` add (keep every existing test; adjust only the one named 'the lead forms real dlc pages use still classify as dlc' if its expectations change — they should not):

```ts
test('the {{in|se}} and {{in|sote}} spellings mark a page as dlc', () => {
  for (const wikitext of ["The '''Beast Claw''' is a [[Beast Claws|Beast Claw]], a [[Melee Armaments|melee armament]] {{in|se}}.\n\n==Notes==", "'''Milady''' is a [[Light Greatsword]] {{in|SotE}}.\n\n==Notes=="]) {
    const result = classifyPage(page('X', wikitext), ctx());
    assert.equal(result.dlc, true, wikitext);
    assert.deepEqual(result.signals, ['sote_template']);
  }
});

test('a plain link in predicate form marks a page as dlc with its own signal', () => {
  const result = classifyPage(page('Great Katana', "The '''Great Katana''' is a [[Great Katanas|Great Katana]] in [[Elden Ring: Shadow of the Erdtree]].\n\n==Notes=="), ctx());
  assert.equal(result.dlc, true);
  assert.deepEqual(result.signals, ['sote_link']);
});

test('a lead that only mentions the DLC in passing does not make the page dlc', () => {
  const leads = [
    "'''Godslayer Incantations''' are a group of six [[Incantations]] in {{ER}} and {{ERN}}. Boosted by [[Godslayer's Seal]] {{SotE}} too.",
    "'''Unused content''' refers to data not fully implemented in {{ER}} or {{SotE}}.",
    "'''Paintings''' are [[Info Items]] in {{ER}} and {{ER}}<i>:</i> {{SotE}}.",
    "'''Version 1.15''' was released for {{ER}} on PC. It also patched {{SotE}}.",
  ];
  for (const wikitext of leads) {
    const result = classifyPage(page('X', wikitext + '\n\n==Notes=='), ctx());
    assert.equal(result.dlc, false, wikitext);
    assert.equal(result.hasDlcSections, true, wikitext);
  }
});
```

- [ ] **Step 2: Run** — `npm test -- test/dlc.test.ts` → the three new tests FAIL.

- [ ] **Step 3: Implement** the rules above. Run `npm test -- test/dlc.test.ts` → all pass (if an existing test now disagrees with the rules, the rules win; explain in the report which test changed and why).

- [ ] **Step 4: Re-classify the real snapshot and measure** — `npm run extract` (≈1 min). Record `dlc:` and `signals:` lines. Then run this query and paste the *full* output into your report:

```bash
sqlite3 data/elden-ring.db "SELECT title FROM pages WHERE title IN ('Milady','Great Katana','Putrescent Knight','Backhand Blade','Midra, Lord of Frenzied Flame','Beast Claw (weapon)','Needle Knight Leda','Bloodfiend''s Fork','Cocoon of the Empyrean','Moangrave','Godslayer Incantations','Death Sorcery','Game Version/1.15','Paintings','Unused Content','Works and Adaptations') ORDER BY dlc, title" 
sqlite3 data/elden-ring.db "SELECT dlc, count(*) FROM pages GROUP BY dlc"
```

(If `sqlite3` is not on PATH, use a 5-line tsx script with better-sqlite3.) Expected: the first eight `dlc=1`, the last six `dlc=0`. If any base-game title is still `dlc=1`, read its lead: if the wiki genuinely writes "in {{SotE}}" for a base subject, add it to the override `base` list with a one-line reason in your report; otherwise fix the rule.

- [ ] **Step 5: Coverage pins** — `test/dlc-coverage.test.ts`:
  - 'known dlc pages are classified as dlc': add `'Milady', 'Great Katana', 'Putrescent Knight', 'Backhand Blade', 'Midra, Lord of Frenzied Flame', 'Beast Claw (weapon)', 'Cocoon of the Empyrean', 'Moangrave'`.
  - 'base-game pages that merely link dlc items are not classified as dlc': add `'Godslayer Incantations', 'Death Sorcery', 'Game Version/1.15', 'Paintings', 'Unused Content', 'Works and Adaptations'`.
  - Bounds test: replace `560`/`680` with the measured count ±40 and rewrite the doc comment with the new measurement and date. Keep the `has_dlc_sections >= 200` floor if it still holds; otherwise set it to measured −40 and say so.
  - `npm test` → all green.

- [ ] **Step 6: Commit** — `fix(extract): classify on predicate-form lead markers in every spelling; drop the both-products rule` + `Closes #3`, `Closes #4`, `Closes #5`. (Task 5 finishes #3's unmarked pages; still list `Closes #3` here — Task 5 references it as "Refs #3".)

---

### Task 5: DLC index-page links as a signal (#3, unmarked pages)

**Files:**
- Modify: `src/extract/dlc.ts` (`DlcSignal` gains `'index_link'`; `ClassifyContext.indexLinkedTitles: Set<string>`; `classifyDlc` builds it)
- Test: `test/dlc.test.ts`, `test/dlc-coverage.test.ts`

**Interfaces:**
- Consumes: `TITLE_SUFFIX` from Task 4's file.
- Produces: `indexLinkedTitles(pages: PageRow[], overrides: Overrides): Set<string>` exported from `src/extract/dlc.ts`.

**Rule:** the 22 pages whose title ends in `(Shadow of the Erdtree)` are the DLC's own indexes. Every `[[Target]]` / `[[Target|label]]` / `[[Target#frag]]` they link (excluding targets containing `:` such as `File:`, `Category:`; excluding targets that are themselves index pages or `Elden Ring: Shadow of the Erdtree`; excluding titles in the override `base` list) is DLC content. Normalise: first character upper-cased, `_`→space, trim. Signal name `index_link`, evaluated after `category`.

- [ ] **Step 1: Failing unit test**

```ts
test('pages linked from a DLC index page are dlc', () => {
  const index = page('Weapons (Shadow of the Erdtree)', "==Melee==\n* [[Rellana's Twin Blades]]\n* [[star-Lined Sword|Star-Lined]]\n* [[Weapons]]\n* [[File:x.png]]\n* [[Great Katanas#List|Great Katanas]]");
  const linked = indexLinkedTitles([index], { dlc: [], base: ['Weapons'] });
  assert.deepEqual([...linked].sort(), ['Great Katanas', "Rellana's Twin Blades", 'Star-Lined Sword']);
  const result = classifyPage(page("Rellana's Twin Blades", "'''Rellana's Twin Blades''' are a [[Light Greatsword]] featured in {{ER}}."), { ...ctx(), indexLinkedTitles: linked });
  assert.equal(result.dlc, true);
  assert.deepEqual(result.signals, ['index_link']);
});
```

Update the `ctx()` helper in `test/dlc.test.ts` to include `indexLinkedTitles: new Set()`.

- [ ] **Step 2: Run** — FAIL (`indexLinkedTitles` not exported).

- [ ] **Step 3: Implement**

```ts
const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const normaliseTitle = (raw: string): string => { const t = raw.replace(/_/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

/**
 * The DLC's own index pages ("Weapons (Shadow of the Erdtree)", …) enumerate its content. A link
 * from one is the only signal that reaches pages the wiki never marked — Rellana's Twin Blades says
 * "featured in {{ER}}". Hub targets come from the override base list, never a heuristic.
 */
export function indexLinkedTitles(pages: PageRow[], overrides: Overrides): Set<string> {
  const forcedBase = lowerSet(overrides.base);
  const titles = new Set<string>();
  for (const index of pages) {
    if (!TITLE_SUFFIX.test(index.title)) continue;
    for (const m of (index.wikitext ?? '').matchAll(WIKI_LINK)) {
      const target = normaliseTitle(m[1]);
      if (target.includes(':') || TITLE_SUFFIX.test(target) || forcedBase.has(target.toLowerCase())) continue;
      titles.add(target);
    }
  }
  return titles;
}
```

`classifyDlc`: `const indexLinkedTitles = indexLinkedTitles(pages, overrides)` after loading pages; pass in ctx; `classifyPage`: `if (ctx.indexLinkedTitles.has(page.title)) signals.push('index_link');`. Add `'index_link'` to `DlcSignal` and `DLC_SIGNALS`.

- [ ] **Step 4: Measure** — `npm run extract`. In your report paste: the `signals:` line, and the full list of titles that are `dlc=1` with `dlc_signals = '["index_link"]'` (index_link as the *only* signal) — `SELECT title FROM pages WHERE dlc_signals = '["index_link"]' ORDER BY title`. That list is what the controller eyeballs for base-game leakage. If it contains an obviously base-game page (a base boss, a stat, a base-only weapon), add it to the override `base` list, re-extract, and say which.

- [ ] **Step 5: Coverage pins** — add `"Rellana's Twin Blades", 'Star-Lined Sword', 'Spear of the Impaler'` to 'known dlc pages are classified as dlc' (verify each is in the extracted list first; drop any that is not and say so). Re-set the bounds test to measured ±40. `npm test` green.

- [ ] **Step 6: Commit** — `feat(extract): index_link signal reaches DLC pages the wiki never marked` + `Refs #3`.

---

### Task 6: Full-text fallback respects the dlc mode (#6)

**Files:**
- Modify: `src/query/resolve.ts` (`resolveIn` gains `mode`; FTS fallback filtered first, unfiltered second)
- Test: `test/query.test.ts`

**Interfaces:**
- Produces: `resolveName` signature unchanged. Behaviour: a `match: 'search'` result is the top permitted hit when one exists; `dlc_filtered` with `match: 'search'` only when no permitted page matches at all.

- [ ] **Step 1: Failing tests** (`fixtureDbs` from `test/query.test.ts`; its single section per page is indexed):

```ts
// "Knight Arm" in base mode gated on Death Knight Gauntlets (dlc) while 39 base pages matched.
test('the search fallback prefers a page the mode permits', () => {
  const dbs = fixtureDbs([
    { title: 'Death Knight Gauntlets', wikitext: 'Death Knight Gauntlets knight gauntlets knight gauntlets', dlc: 1 },
    { title: 'Vagabond Knight Gauntlets', wikitext: 'knight gauntlets', dlc: 0 },
  ]);
  const base = resolveName(dbs, 'knight gauntlet', 'base');
  assert.ok(base && !('filtered' in base));
  assert.equal(base.provenance.title, 'Vagabond Knight Gauntlets');
  assert.equal(base.match, 'search');
  const only = resolveName(dbs, 'knight gauntlet', 'only');
  assert.ok(only && !('filtered' in only));
  assert.equal(only.provenance.title, 'Death Knight Gauntlets');
});

test('the search fallback still gates when nothing the mode permits matches', () => {
  const dbs = fixtureDbs([{ title: 'Death Knight Gauntlets', wikitext: 'knight gauntlets', dlc: 1 }]);
  const r = resolveName(dbs, 'knight gauntlet', 'base');
  assert.ok(r && 'filtered' in r);
  assert.equal(r.match, 'search');
});
```

- [ ] **Step 2: Run** — first test FAILS (base returns filtered).

- [ ] **Step 3: Implement** — `resolveIn(db, name, mode)`: build the FTS statement with `AND ${dlcPredicate(mode, 'p')}`; if it returns nothing, run the existing unfiltered statement (so the gated-guess behaviour survives). Update the doc comment on `resolveName` to say the fallback is mode-aware and why (issue #6: a guess must be a page the caller can use).

- [ ] **Step 4: Run** — `npm test` green; the existing 'Verdigris Greatsword → Enir-Ilim' style expectations in `test/dlc-coverage.test.ts` / `test/query.test.ts` must still hold (they gate on `match: 'exact'`).

- [ ] **Step 5: Commit** — `fix(query): apply the dlc mode inside the full-text fallback` + `Closes #6`.

---

### Task 7: `has_dlc_sections` and `dlc` on every resolved result; truthful INSTRUCTIONS (#10, #16)

**Files:**
- Modify: `src/query/resolve.ts` (`PROVENANCE_COLUMNS`, `Resolved.hasDlcSections`, `toResolved`)
- Modify: `src/query/lookups.ts` (`getPage` drops its own query; `whereIs`, `questSteps`, `bossInfo`, `itemStats` by name add `has_dlc_sections`)
- Modify: `src/server/mcp-server.ts` (INSTRUCTIONS)
- Test: `test/query.test.ts`, `test/server.test.ts`

**Interfaces:**
- Produces: `Resolved.hasDlcSections: boolean` (false for Fextralife rows). Result field `has_dlc_sections: boolean` on `get_page`, `where_is`, `quest_steps`, `boss`, `item_stats {name}`.

- [ ] **Step 1: Failing tests** in `test/query.test.ts`:

```ts
test('every name lookup reports dlc and has_dlc_sections', () => {
  const dbs = fixtureDbs([
    { title: 'Flask of Crimson Tears', wikitext: 'flask', dlc: 0, hasDlcSections: 1 },
    { title: 'Verdigris Armor', wikitext: 'armor', dlc: 1 },
  ]);
  for (const lookup of [whereIs, questSteps, bossInfo] as const) {
    const flagged = lookup(dbs, 'Flask of Crimson Tears', 'all') as { dlc: boolean; has_dlc_sections: boolean };
    assert.equal(flagged.dlc, false, lookup.name);
    assert.equal(flagged.has_dlc_sections, true, lookup.name);
    const dlc = lookup(dbs, 'Verdigris Armor', 'all') as { dlc: boolean; has_dlc_sections: boolean };
    assert.equal(dlc.dlc, true, lookup.name);
    assert.equal(dlc.has_dlc_sections, false, lookup.name);
  }
  const page = getPage(dbs, 'Flask of Crimson Tears', undefined, 'all') as { has_dlc_sections: boolean };
  assert.equal(page.has_dlc_sections, true);
});
```

Plus an `itemStats` case: insert a `weapons` row for a `dlc: 1` fixture page (`db.prepare('INSERT INTO weapons (page_id, name) VALUES (?, ?)')`) and assert `itemStats(dbs, { name }, 'all')` returns `{ dlc: true, has_dlc_sections: false, rows: [...] }`.

`test/server.test.ts`: extend 'the server instructions state the base-game default' with `assert.match(INSTRUCTIONS, /marker/i)` and `assert.doesNotMatch(INSTRUCTIONS, /discusses DLC events/)`.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement**. INSTRUCTIONS replacement for the two sentences on `has_dlc_sections` and the "NO dlc field" rule:

> A result with has_dlc_sections: true is a base-game page whose wiki text carries the Shadow of the Erdtree marker template (it links or notes DLC content); pages that discuss the DLC in prose without the marker are not flagged. Every successful lookup of a Fandom page carries dlc and has_dlc_sections (true or false). A successful result with NO dlc field is a cached Fextralife page, which the classifier never labels: its DLC status is unknown, so never state it is base game or DLC, and no dlc mode filters it out. Error and not-found shapes carry neither field.

- [ ] **Step 4: Run** — `npm test`, `npm run smoke` green.

- [ ] **Step 5: Commit** — `fix(query): carry has_dlc_sections on every resolved result and say what it means` + `Closes #10`, `Closes #16`.

---

### Task 8: `fetch: true` prefers the cached copy and every result lists alternates (#9, #17)

**Files:**
- Modify: `src/query/resolve.ts` (`resolveName(dbs, name, mode, opts?)`, `Resolved.alternates`)
- Modify: `src/query/lookups.ts` (`resolveFor`, `getPage`, `whereIs`, `questSteps`, `bossInfo` accept `opts`)
- Modify: `src/server/mcp-server.ts` (`withFetch` passes `{ preferLocal: fetch === true }`)
- Modify: `test/server.test.ts` (set `ELDEN_RING_MCP_DB` to a fixture db **before** the dynamic import), `test/query.test.ts`

**Interfaces:**
- Consumes: `Resolved` from Task 7.
- Produces: `export interface ResolveOptions { preferLocal?: boolean }`; `resolveName(dbs, name, mode = 'base', opts: ResolveOptions = {})`; `Resolved.alternates: Provenance[]` (exact-title matches in the other db(s), case-insensitive; empty when none); lookups `getPage(dbs, title, section?, mode?, opts?)`, `whereIs(dbs, name, mode?, opts?)`, `questSteps(dbs, npc, mode?, opts?)`, `bossInfo(dbs, name, mode?, opts?)`; result field `alternates` (dropped by `compact` when empty).

- [ ] **Step 1: Failing tests**

`test/query.test.ts` (build `local` with `upsertPage(local, { source: 'fextralife', title: 'Uchigatana', url: 'https://eldenring.wiki.fextralife.com/Uchigatana', revid: null, fetchedAt: '2026-09-16T00:00:00.000Z', wikitext: null, markdown: '# Uchigatana\n\nFextralife text.', license: 'Fextralife' })`, shipped from `fixtureDbs([{ title: 'Uchigatana', wikitext: 'katana', dlc: 0 }])`):

```ts
test('a cached Fextralife copy is returned when the caller asked to fetch, and listed otherwise', () => {
  const plain = getPage(dbs, 'Uchigatana') as { provenance: Provenance; alternates: Provenance[] };
  assert.equal(plain.provenance.source, 'fandom');
  assert.equal(plain.alternates.length, 1);
  assert.equal(plain.alternates[0].source, 'fextralife');
  const fetched = getPage(dbs, 'Uchigatana', undefined, 'base', { preferLocal: true }) as { provenance: Provenance; alternates: Provenance[]; dlc?: boolean | null };
  assert.equal(fetched.provenance.source, 'fextralife');
  assert.equal(fetched.dlc, null);
  assert.equal(fetched.alternates[0].source, 'fandom');
});
```

`test/server.test.ts` — fetch wiring (#17). At the top, before the dynamic import: `process.env.ELDEN_RING_MCP_DB = join(tmp, 'fixture.db'); buildFixtureDb(process.env.ELDEN_RING_MCP_DB).close();`. Then:

```ts
import { resetFextralifeSession } from '../src/sources/fextralife.js';

test('get_page with fetch: true caches the Fextralife page and returns it', async () => {
  const html = '<html><body><div id="wiki-content-block"><h2>Uchigatana</h2><p>Fextralife says Physical 115.</p></div></body></html>';
  const urls: string[] = [];
  resetFextralifeSession({ fetchImpl: async (url) => { urls.push(url); return { status: 200, headers: { get: () => null }, text: async () => html }; }, sleep: async () => {} });
  const client = new Client({ name: 'fetch-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const result = await client.callTool({ name: 'get_page', arguments: { title: 'Uchigatana', fetch: true } });
    const text = (result.content as { text: string }[])[0].text;
    assert.deepEqual(urls, ['https://eldenring.wiki.fextralife.com/Uchigatana']);
    assert.match(text, /"source":"fextralife"/);
    assert.match(text, /Physical 115/);
    assert.match(text, /"alternates":\[\{"source":"fandom"/);
  } finally { await client.close(); resetFextralifeSession(); }
});
```

(Check `resetFextralifeSession`'s `fetchImpl` typing in `src/sources/http.ts` `FetchLike` and match it exactly.)

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** — in `resolveName`: `const order = opts.preferLocal ? [dbs.local, dbs.shipped] : [dbs.shipped, dbs.local]`; after `found`, compute `alternates` = for each *other* db in `order`, `SELECT source, title, url, revid, fetched_at, license FROM pages WHERE title = ? COLLATE NOCASE` with `found.provenance.title`. `toResolved` gets `alternates` param default `[]`. Lookups spread `alternates: r.alternates` into the four results next to `match`. `withFetch(title, fetch, lookup)` stays; call sites pass `{ preferLocal: fetch === true }` into the lookup closure.

- [ ] **Step 4: Run** — `npm test`, `npm run typecheck`, `npm run smoke` green.

- [ ] **Step 5: Commit** — `feat(query): prefer the cached Fextralife copy on fetch: true and list alternates` + `Closes #9`, `Closes #17`.

---

### Task 9: `item_stats` feedback is truthful (#14, #18)

**Files:**
- Modify: `src/query/lookups.ts` (`itemStats`)
- Modify: `src/server/mcp-server.ts` (`max_req` schema `.strict()`)
- Test: `test/query.test.ts`, `test/server.test.ts`

**Interfaces:**
- Produces: `{ not_found: true, query, reason: 'no_stats', page, provenance, match, hint }` when the name resolves to a page with no item row; `invalid_filter` when every requested kind lacks the requirement columns `max_req` names.

- [ ] **Step 1: Failing tests**

```ts
test('item_stats on a page that is not an item says so instead of "no page matched"', () => {
  const dbs = fixtureDbs([{ title: 'Godrick the Grafted', wikitext: 'boss', dlc: 0 }]);
  const r = itemStats(dbs, { name: 'Godrick the Grafted' }) as { not_found: true; reason: string; page: string; match: string; hint: string };
  assert.equal(r.reason, 'no_stats');
  assert.equal(r.page, 'Godrick the Grafted');
  assert.equal(r.match, 'exact');
  assert.doesNotMatch(r.hint, /No page matched/);
});

test('item_stats says when max_req cannot apply to the requested kind', () => {
  const dbs = fixtureDbs([{ title: 'Claw Talisman', wikitext: 'talisman', dlc: 0 }]);
  const r = itemStats(dbs, { kind: 'talisman', max_req: { str: 10 } }) as { error: string; detail: string };
  assert.equal(r.error, 'invalid_filter');
  assert.match(r.detail, /talisman/);
});
```

`test/server.test.ts`: over the in-memory client, `item_stats { max_req: { luck: 5 } }` → `result.isError === true` and the text matches `/luck|Unrecognized key/`.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** — `noStats(query, r)` helper next to `emptyPage`, hint: `The page "${title}" is in the snapshot but is not a weapon, spell, talisman or armor piece, so it has no stats. Use get_page, where_is or boss for it.` In the filter path track `skipped: Kind[]`; if `rows` is empty and `skipped.length === kinds.length && maxReq.length` return `invalidFilter(\`max_req names ${stats} but ${skipped.join(', ')} carry no requirement columns; drop max_req or ask for weapon/spell.\`)`. Schema: `max_req: z.object({...}).partial().strict().optional()`.

- [ ] **Step 4: Run** — green; check `npm run smoke` (tool list budget 8000 chars).

- [ ] **Step 5: Commit** — `fix(query): truthful item_stats misses for non-items and inapplicable max_req` + `Closes #14`, `Closes #18`.

---

### Task 10: Product-name templates render as text; `extract` re-renders sections (#15)

**Files:**
- Modify: `src/wikitext/markdown.ts` (`wikitextToMarkdown(wikitext, title?)`, template substitution before `stripTemplates`)
- Modify: `src/store/pages.ts` (`upsertPage` passes title; new `rerenderSections(db)`)
- Modify: `scripts/extract.ts` (call `rerenderSections` before `runExtractors`)
- Test: `test/wikitext.test.ts`, `test/extract.test.ts` or `test/db.test.ts`

**Interfaces:**
- Produces: `wikitextToMarkdown(wikitext: string, title = ''): string`; `rerenderSections(db: Db): number` (pages re-rendered; Fandom rows with non-null wikitext only).

Substitution table (applied with a single regex pass before `stripTemplates`; case-insensitive on the name, whitespace-tolerant):

| template | text |
|---|---|
| `{{ER}}` | `Elden Ring` |
| `{{SotE}}` / `{{SOTE}}` | `Shadow of the Erdtree` |
| `{{ERN}}` | `Elden Ring Nightreign` |
| `{{in\|er}}` | `in Elden Ring` |
| `{{in\|se}}` / `{{in\|sote}}` | `in Shadow of the Erdtree` |
| `{{in\|ern}}` | `in Elden Ring Nightreign` |
| `{{PAGENAME}}` | the page title (`''` when unknown) |

- [ ] **Step 1: Failing tests** — `test/wikitext.test.ts`:

```ts
test('product-name templates render as text instead of vanishing', () => {
  assert.equal(wikitextToMarkdown("'''{{PAGENAME}}''' is an [[Arrow]] in {{ER}}.", 'Arrow'), '**Arrow** is an Arrow in Elden Ring.');
  assert.equal(wikitextToMarkdown("'''Milady''' is a sword {{in|se}}. Also in {{ER}}<i>:</i> {{SotE}}."), '**Milady** is a sword in Shadow of the Erdtree. Also in Elden Ring: Shadow of the Erdtree.');
  assert.equal(wikitextToMarkdown('{{Infobox Weapon\n| type = Axe\n}}\nText {{ERN}}.'), 'Text Elden Ring Nightreign.');
});
```

(If `<i>:</i>` is not stripped by `convertInline`, add `i` to its tag list.) And in `test/db.test.ts` or `test/extract.test.ts`:

```ts
test('rerenderSections rebuilds sections from stored wikitext', () => {
  const db = memoryDb();
  const id = upsertPage(db, { source: 'fandom', title: 'Arrow', url: 'u', revid: 1, fetchedAt: 'now', wikitext: "'''{{PAGENAME}}''' is an arrow in {{ER}}.", markdown: null, license: 'l' });
  db.prepare("UPDATE sections SET markdown = 'stale' WHERE page_id = ?").run(id);
  assert.equal(rerenderSections(db), 1);
  const row = db.prepare('SELECT markdown FROM sections WHERE page_id = ? ORDER BY ord').get(id) as { markdown: string };
  assert.equal(row.markdown, '**Arrow** is an arrow in Elden Ring.');
  assert.equal((db.prepare("SELECT count(*) AS n FROM sections_fts WHERE sections_fts MATCH 'stale'").get() as { n: number }).n, 0);
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** — factor the section insert loop in `upsertPage` into `writeSections(db, id, title, markdown)` used by both `upsertPage` and `rerenderSections`. `rerenderSections` iterates `SELECT id, title, wikitext FROM pages WHERE source = 'fandom' AND wikitext IS NOT NULL` inside one transaction. `scripts/extract.ts`: `console.log(\`re-rendered ${rerenderSections(db)} pages\`)` before `runExtractors`.

- [ ] **Step 4: Run** — `npm test` green; `npm run extract` on the worktree db, then `sqlite3 data/elden-ring.db "SELECT count(*) FROM sections WHERE markdown LIKE '% in .%'"` — record the number (expect near 0, from 3614).

- [ ] **Step 5: Commit** — `fix(wikitext): render product-name templates and PAGENAME; extract re-renders sections` + `Closes #15`.

---

### Task 11: CI runs the coverage tests against real data (#7)

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `test/dlc-coverage.test.ts` (skip → hard failure under `CI`)

**Interfaces:**
- Consumes: `npm run sync-categories` (Task 3), `npm run extract` re-rendering (Task 10), `fetch-data` stale warning (Task 2).

- [ ] **Step 1: Test change** — replace `const hasDb = existsSync(DB_PATH);` with:

```ts
const hasDb = existsSync(DB_PATH);
// Locally a missing snapshot is a legitimate skip. In CI it is a broken pipeline: the workflow
// downloads the release before testing, and a silent skip here is how all seven of these tests
// went unrun on every PR.
if (!hasDb && process.env.CI) throw new Error(`${DB_PATH} is missing in CI; the workflow must run npm run fetch-data before npm test`);
```

- [ ] **Step 2: Verify locally** — from a temp cwd with no `data/`: `CI=1 node --import tsx --test /abs/path/test/dlc-coverage.test.ts` → fails with that message; without `CI` → 7 skipped; in the worktree → 8+ pass.

- [ ] **Step 3: Workflow** — `.github/workflows/ci.yml` steps after `npm ci`:

```yaml
      - run: npm run fetch-data        # release asset; exit 2 (no release) is fatal here on purpose
      - run: npm run sync-categories   # bounded MediaWiki crawl; fills dlc_categories
      - run: npm run extract           # migrate + re-render + re-extract + classify with THIS commit's code
      - run: npm run typecheck
      - run: npm test
      - run: npm run smoke
```

Add `timeout-minutes: 15` on the job.

- [ ] **Step 4: Commit** — `ci: download the data release and re-extract so coverage tests run` + `Closes #7`.

---

### Task 12: README and example config tell the truth (#12, #13)

**Files:**
- Modify: `README.md`, `.mcp.json.example`

- [ ] **Step 1: README** — add after Quick start:

```markdown
Requires Node 22 or newer (`.nvmrc` says 24). On Node 20 the sqlite driver crashes with a bare
segfault before any message can print, so if the server "fails to connect" with no output, check
`node -v` first. If your MCP config still names `src/server/mcp-server.ts` (the entry point before
2026-09-16), change it to `src/server/start.ts`; the old path now exits with a message saying so.
```

Add a `## Shadow of the Erdtree` section before "Building data yourself":

```markdown
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
```

Update the Tools table row for `sources_status` to "data freshness, base/DLC counts, classifier signals". Under "Building data yourself" add `npm run sync-categories   # refresh DLC category membership only` and `npm run extract   # re-render, re-extract and re-classify without syncing`.

- [ ] **Step 2: `.mcp.json.example`** — JSON cannot carry comments; leave it, but make sure it still names `start.ts` (it does).

- [ ] **Step 3: Commit** — `docs(readme): state the base-game default, dlc modes, Node requirement and entry point` + `Closes #12`, `Closes #13`.

---

### Task 13: Spec matches the code (#11)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-sote-dlc-layering-design.md` (§2, §3, §4, Known limitations, Files touched)

- [ ] **Step 1: §2 rewrite** — replace the paragraph "Registered in `src/extract/registry.ts` …" with: the classifier is `classifyDlc(db)` in `src/extract/dlc.ts`, a separate pass run by `scripts/sync.ts`, `scripts/extract.ts`, `scripts/build.ts` and `scripts/sync-categories.ts` after `runExtractors`, because it writes columns on `pages` rather than derived rows; it does not write `extract_failures`. Replace signals 2–3 with the Task 4 rules (predicate-form lead markers in four spellings; no inline/below-lead/both-products exclusions; "hub-page exclusion" is the override file's `base` list only — there is no heuristic). Add signal `sote_link` (plain link, predicate form) and signal 6 `index_link` (Task 5). Replace "recorded as ambiguous in `dlc_report`" with: `dlc_report` holds per-signal hit counts; the scripts print the `has_dlc_sections` list as override candidates.
- [ ] **Step 2: §3** — add: the full-text fallback applies the mode predicate first and gates only when no permitted page matches (#6). `resolveName` accepts `{ preferLocal }` and returns `alternates`.
- [ ] **Step 3: §4** — `has_dlc_sections` is on every successful Fandom result; `alternates` lists the other source's provenance; `error: "data_stale"` shape.
- [ ] **Step 4: Known limitations** — replace the "Measured coverage" and "False negatives" bullets with the numbers the controller supplies in the dispatch (post-Task-5 `signals:` line, dlc count, has_dlc_sections count, `dlc_categories` count) and the remaining known gaps (pages neither marked, categorised, nor index-linked; hub detection is override-only). Update the "Files touched" table (`registry.ts` row → "not touched"; add `scripts/sync-categories.ts`, `src/wikitext/markdown.ts`).
- [ ] **Step 5: Commit** — `docs(spec): describe the classifier and query layer as built` + `Closes #11`.
