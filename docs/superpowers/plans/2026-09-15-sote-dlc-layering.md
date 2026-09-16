# Shadow of the Erdtree Layering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every MCP tool answers base-game-only by default; callers opt into Shadow of the Erdtree content explicitly, and a DLC page requested without opting in says so rather than reporting missing data.

**Architecture:** One database, one new `pages.dlc` column. A multi-signal classifier runs as a pass after extraction and labels pages from the `{{SotE}}` template, title suffixes, DLC category membership, and a committed override file, with hub-page exclusion to stop base-game index pages being swept in. Query-layer filtering is a single composable SQL predicate applied uniformly; the resolver resolves against all pages and then compares against the caller's mode, which is what makes the `dlc_filtered` answer possible.

**Tech Stack:** TypeScript (ESM, `type: module`), better-sqlite3 13, node:test via `node --import tsx --test`, zod 4, MCP SDK 1.30.

**Spec:** `docs/superpowers/specs/2026-09-15-sote-dlc-layering-design.md`

## Global Constraints

- Node >= 22 (`engines.node`). better-sqlite3 13 segfaults on Node 20.
- ESM only. Every relative import ends in `.js`, even from a `.ts` file.
- Tests run with `npm test` (`node --import tsx --test test/*.test.ts`). New test files go in `test/` and end in `.test.ts`.
- `npm run typecheck` (`tsc`) must pass.
- Schema changes are additive only: an existing `data/elden-ring.db` must still open.
- SQL is parameterised. Caller-supplied strings never reach a query as SQL text; `DlcMode` is a closed enum, and `dlcPredicate` returns only constant fragments.
- The shipped DB opens **readonly**. Nothing in the query path may write.
- `data/elden-ring.db` is 37 MB and gitignored — never `git add` it.

### Deviation from the spec, deliberate

The spec says the classifier is "registered in `src/extract/registry.ts` and run by the existing `runExtractors` pass". That is wrong and this plan does not do it. `runExtractors` calls `clearDerived(db, page.id)` before each page, which truncates the per-page derived tables; the `Extractor` contract is "write rows keyed by `page_id` into your own table". The classifier instead **updates a column on `pages`**, which `clearDerived` neither clears nor knows about. Registering it there would mean a contract violation that works by accident.

Instead: `classifyDlc(db)` is a standalone pass in `src/extract/dlc.ts`, called after `runExtractors` by both `scripts/extract.ts` and `src/sync.ts`. Everything else in the spec stands.

---

### Task 1: Schema and migration

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/open.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: `openDb(path, opts)` from `src/db/open.js`
- Produces: `pages.dlc` (INTEGER NOT NULL DEFAULT 0), `pages.dlc_signals` (TEXT, JSON array), `pages.has_dlc_sections` (INTEGER NOT NULL DEFAULT 0), tables `dlc_report(signal, hits, at)` and `dlc_categories(title PRIMARY KEY)`

- [ ] **Step 1: Write the failing test**

Append to `test/db.test.ts`:

```ts
test('pages carries dlc columns', () => {
  const db = memoryDb();
  const cols = (db.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('dlc'));
  assert.ok(cols.includes('dlc_signals'));
  assert.ok(cols.includes('has_dlc_sections'));
});

test('dlc columns default to not-dlc', () => {
  const db = memoryDb();
  db.prepare("INSERT INTO pages (source, title, url, fetched_at, license) VALUES ('fandom','X','u','now','l')").run();
  const row = db.prepare('SELECT dlc, has_dlc_sections, dlc_signals FROM pages WHERE title = ?').get('X') as
    { dlc: number; has_dlc_sections: number; dlc_signals: string | null };
  assert.equal(row.dlc, 0);
  assert.equal(row.has_dlc_sections, 0);
  assert.equal(row.dlc_signals, null);
});

test('a pre-dlc database gains the columns on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-migrate-'));
  const path = join(dir, 'old.db');
  const old = new Database(path);
  old.exec(`CREATE TABLE pages (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
    revid INTEGER, fetched_at TEXT NOT NULL, license TEXT NOT NULL, patch TEXT, wikitext TEXT,
    UNIQUE (source, title));`);
  old.prepare("INSERT INTO pages (source, title, url, fetched_at, license) VALUES ('fandom','Old','u','now','l')").run();
  old.close();

  const db = openDb(path);
  const cols = (db.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('dlc'));
  assert.equal((db.prepare('SELECT dlc FROM pages WHERE title = ?').get('Old') as { dlc: number }).dlc, 0);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

Add these imports at the top of `test/db.test.ts` if not already present:

```ts
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/open.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='dlc columns'`
Expected: FAIL — `pages` has no column `dlc`.

- [ ] **Step 3: Add the schema**

Append to `src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS dlc_report (
  signal TEXT NOT NULL,
  hits INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dlc_categories (
  title TEXT PRIMARY KEY
);
```

The three `pages` columns are added by the migration rather than the `CREATE TABLE`, so that fresh and existing databases take the same code path. In `src/db/open.ts`, replace the body of `openDb`:

```ts
/** Columns added after the initial schema. CREATE TABLE IF NOT EXISTS will not add them to an existing table. */
const PAGE_MIGRATIONS: { column: string; ddl: string }[] = [
  { column: 'dlc', ddl: 'ALTER TABLE pages ADD COLUMN dlc INTEGER NOT NULL DEFAULT 0' },
  { column: 'dlc_signals', ddl: 'ALTER TABLE pages ADD COLUMN dlc_signals TEXT' },
  { column: 'has_dlc_sections', ddl: 'ALTER TABLE pages ADD COLUMN has_dlc_sections INTEGER NOT NULL DEFAULT 0' },
];

function migrate(db: Db): void {
  const existing = new Set((db.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).map((c) => c.name));
  for (const { column, ddl } of PAGE_MIGRATIONS) if (!existing.has(column)) db.exec(ddl);
  db.exec('CREATE INDEX IF NOT EXISTS pages_dlc ON pages (dlc)');
}

export function openDb(path: string, opts: { readonly?: boolean } = {}): Db {
  const readonly = opts.readonly ?? false;
  if (path !== ':memory:' && !readonly) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { readonly, fileMustExist: readonly });
  if (!readonly) {
    db.exec(SCHEMA);
    migrate(db);
  }
  return db;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS, including the pre-existing suites.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/open.ts test/db.test.ts
git commit -m "feat(db): add dlc columns, report and category tables"
```

---

### Task 2: Classification signals

**Files:**
- Create: `src/extract/dlc.ts`
- Create: `data/dlc-overrides.json`
- Test: `test/dlc.test.ts`

**Interfaces:**
- Consumes: `PageRow` from `src/extract/types.js`
- Produces:
  - `export type DlcSignal = 'override' | 'hub_page' | 'sote_template' | 'title_suffix' | 'category'`
  - `export interface Classification { dlc: boolean; signals: DlcSignal[]; hasDlcSections: boolean }`
  - `export interface Overrides { dlc: string[]; base: string[] }`
  - `export function loadOverrides(path?: string): Overrides`
  - `export function classifyPage(page: PageRow, ctx: { overrides: Overrides; dlcCategoryTitles: Set<string> }): Classification`

- [ ] **Step 1: Write the failing test**

Create `test/dlc.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPage, loadOverrides, type Overrides } from '../src/extract/dlc.js';
import type { PageRow } from '../src/extract/types.js';

const page = (title: string, wikitext: string | null): PageRow => ({ id: 1, source: 'fandom', title, wikitext });
const noOverrides: Overrides = { dlc: [], base: [] };
const ctx = (overrides = noOverrides, titles: string[] = []) => ({ overrides, dlcCategoryTitles: new Set(titles) });

test('the SotE template marks a page as dlc', () => {
  const result = classifyPage(page('Verdigris Armor', '{{Infobox Armor}}\nAdded in the {{SotE}} expansion.'), ctx());
  assert.equal(result.dlc, true);
  assert.deepEqual(result.signals, ['sote_template']);
});

test('a page with no signal is base game', () => {
  const result = classifyPage(page('Icerind Hatchet', '{{Infobox Weapon\n| type = Axe\n}}'), ctx());
  assert.equal(result.dlc, false);
  assert.deepEqual(result.signals, []);
  assert.equal(result.hasDlcSections, false);
});

test('a title suffix marks a page as dlc', () => {
  const result = classifyPage(page('Sorceries (Shadow of the Erdtree)', 'list'), ctx());
  assert.equal(result.dlc, true);
  assert.ok(result.signals.includes('title_suffix'));
});

test('dlc category membership marks a page as dlc', () => {
  const result = classifyPage(page('Scadu Altus', 'A region.'), ctx(noOverrides, ['Scadu Altus']));
  assert.equal(result.dlc, true);
  assert.ok(result.signals.includes('category'));
});

test('a hub page that lists dlc items stays base and is flagged', () => {
  const result = classifyPage(page('Weapons', 'Includes {{SotE}} armaments.'), ctx({ dlc: [], base: ['Weapons'] }));
  assert.equal(result.dlc, false);
  assert.ok(result.signals.includes('hub_page'));
  assert.equal(result.hasDlcSections, true);
});

test('an override forces dlc where no signal fires', () => {
  const result = classifyPage(page('Rellana, Twin Moon Knight', 'A boss.'), ctx({ dlc: ['Rellana, Twin Moon Knight'], base: [] }));
  assert.equal(result.dlc, true);
  assert.deepEqual(result.signals, ['override']);
});

test('a base override beats the template', () => {
  const result = classifyPage(page('Armor Sets', 'Lists {{SotE}} sets.'), ctx({ dlc: [], base: ['Armor Sets'] }));
  assert.equal(result.dlc, false);
  assert.equal(result.hasDlcSections, true);
});

test('overrides are matched case-insensitively', () => {
  const result = classifyPage(page('Rellana, Twin Moon Knight', ''), ctx({ dlc: ['rellana, twin moon knight'], base: [] }));
  assert.equal(result.dlc, true);
});

test('a null wikitext page classifies without throwing', () => {
  const result = classifyPage(page('Empty', null), ctx());
  assert.equal(result.dlc, false);
});

test('loadOverrides reads the committed file', () => {
  const overrides = loadOverrides();
  assert.ok(Array.isArray(overrides.dlc));
  assert.ok(Array.isArray(overrides.base));
  assert.ok(overrides.dlc.includes('Rellana, Twin Moon Knight'));
});

test('loadOverrides returns empty lists when the file is absent', () => {
  const overrides = loadOverrides('/nonexistent/dlc-overrides.json');
  assert.deepEqual(overrides, { dlc: [], base: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='dlc|override|hub'`
Expected: FAIL — cannot find module `../src/extract/dlc.js`.

- [ ] **Step 3: Write the override file**

Create `data/dlc-overrides.json`:

```json
{
  "_comment": "Human corrections to the DLC classifier. 'dlc' forces a page to DLC; 'base' forces it to base game. 'base' is for index/hub pages that list DLC items without being DLC content. Both win over every automatic signal.",
  "dlc": [
    "Rellana, Twin Moon Knight"
  ],
  "base": [
    "Weapons",
    "Armor",
    "Armor Sets",
    "Talismans",
    "Spells",
    "Sorceries",
    "Incantations",
    "Bosses",
    "Ashes of War",
    "Shields",
    "Key Items"
  ]
}
```

- [ ] **Step 4: Write the classifier**

Create `src/extract/dlc.ts`:

```ts
import { readFileSync } from 'node:fs';
import type { PageRow } from './types.js';

export type DlcSignal = 'override' | 'hub_page' | 'sote_template' | 'title_suffix' | 'category';

export interface Classification {
  dlc: boolean;
  signals: DlcSignal[];
  hasDlcSections: boolean;
}

export interface Overrides {
  dlc: string[];
  base: string[];
}

const DEFAULT_OVERRIDES_PATH = new URL('../../data/dlc-overrides.json', import.meta.url).pathname;

/** Missing or malformed overrides must not take a sync down; an empty list is the safe default. */
export function loadOverrides(path: string = DEFAULT_OVERRIDES_PATH): Overrides {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { dlc: [], base: [] };
    const raw = parsed as Record<string, unknown>;
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
    return { dlc: list(raw.dlc), base: list(raw.base) };
  } catch {
    return { dlc: [], base: [] };
  }
}

const lowerSet = (titles: string[]): Set<string> => new Set(titles.map((t) => t.toLowerCase()));

/** The wiki's own DLC marker template, e.g. "added in the {{SotE}} expansion". */
const SOTE_TEMPLATE = /\{\{\s*SotE\b/i;
const TITLE_SUFFIX = /\(Shadow of the Erdtree\)\s*$/i;

export interface ClassifyContext {
  overrides: Overrides;
  /** Titles reachable from Category:Shadow of the Erdtree and its subcategories. */
  dlcCategoryTitles: Set<string>;
}

/**
 * Page-level only, never section-level: stripping sections on a heuristic would silently delete text
 * from an answer. A base page that discusses DLC events keeps its text and sets hasDlcSections.
 *
 * Precedence: override, then hub exclusion, then the automatic signals. The first two are decisions a
 * human made; the rest are guesses.
 */
export function classifyPage(page: PageRow, ctx: ClassifyContext): Classification {
  const wikitext = page.wikitext ?? '';
  const mentionsDlc = SOTE_TEMPLATE.test(wikitext);
  const title = page.title.toLowerCase();

  const forcedDlc = lowerSet(ctx.overrides.dlc);
  const forcedBase = lowerSet(ctx.overrides.base);

  if (forcedDlc.has(title)) return { dlc: true, signals: ['override'], hasDlcSections: false };
  if (forcedBase.has(title)) return { dlc: false, signals: ['hub_page'], hasDlcSections: mentionsDlc };

  const signals: DlcSignal[] = [];
  if (mentionsDlc) signals.push('sote_template');
  if (TITLE_SUFFIX.test(page.title)) signals.push('title_suffix');
  if (ctx.dlcCategoryTitles.has(page.title)) signals.push('category');

  return { dlc: signals.length > 0, signals, hasDlcSections: false };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern='dlc|override|hub' && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/extract/dlc.ts data/dlc-overrides.json test/dlc.test.ts
git commit -m "feat(extract): classify pages as base game or Shadow of the Erdtree"
```

---

### Task 3: The classification pass

**Files:**
- Modify: `src/extract/dlc.ts`
- Test: `test/dlc.test.ts`

**Interfaces:**
- Consumes: `classifyPage`, `loadOverrides` from Task 2; `Db` from `src/db/open.js`
- Produces:
  - `export interface DlcReport { pages: number; dlc: number; hasDlcSections: number; bySignal: Record<DlcSignal, number>; ambiguous: string[] }`
  - `export function classifyDlc(db: Db, opts?: { overrides?: Overrides; now?: () => Date }): DlcReport`

- [ ] **Step 1: Write the failing test**

Append to `test/dlc.test.ts`:

```ts
import { classifyDlc } from '../src/extract/dlc.js';
import { memoryDb } from './helpers.js';

const insert = (db: ReturnType<typeof memoryDb>, title: string, wikitext: string) =>
  db.prepare('INSERT INTO pages (source, title, url, fetched_at, license, wikitext) VALUES (?,?,?,?,?,?)')
    .run('fandom', title, `https://x/${title}`, 'now', 'CC BY-SA 3.0', wikitext);

test('classifyDlc labels every page and reports the signals', () => {
  const db = memoryDb();
  insert(db, 'Verdigris Armor', 'Added in the {{SotE}} expansion.');
  insert(db, 'Icerind Hatchet', '{{Infobox Weapon}}');
  insert(db, 'Weapons', 'Includes {{SotE}} armaments.');
  db.prepare('INSERT INTO dlc_categories (title) VALUES (?)').run('Scadu Altus');
  insert(db, 'Scadu Altus', 'A region.');

  const report = classifyDlc(db, { overrides: { dlc: ['Rellana, Twin Moon Knight'], base: ['Weapons'] } });

  assert.equal(report.pages, 4);
  assert.equal(report.dlc, 2);
  assert.equal(report.hasDlcSections, 1);
  assert.equal(report.bySignal.sote_template, 1);
  assert.equal(report.bySignal.category, 1);

  const row = (title: string) => db.prepare('SELECT dlc, has_dlc_sections, dlc_signals FROM pages WHERE title = ?').get(title) as
    { dlc: number; has_dlc_sections: number; dlc_signals: string | null };
  assert.equal(row('Verdigris Armor').dlc, 1);
  assert.deepEqual(JSON.parse(row('Verdigris Armor').dlc_signals ?? '[]'), ['sote_template']);
  assert.equal(row('Icerind Hatchet').dlc, 0);
  assert.equal(row('Weapons').dlc, 0);
  assert.equal(row('Weapons').has_dlc_sections, 1);
  assert.equal(row('Scadu Altus').dlc, 1);
});

test('classifyDlc records ambiguous pages without marking them dlc', () => {
  const db = memoryDb();
  insert(db, 'Armor Sets', 'Lists {{SotE}} sets.');
  const report = classifyDlc(db, { overrides: { dlc: [], base: ['Armor Sets'] } });
  assert.deepEqual(report.ambiguous, ['Armor Sets']);
  assert.equal((db.prepare('SELECT dlc FROM pages WHERE title = ?').get('Armor Sets') as { dlc: number }).dlc, 0);
});

test('classifyDlc writes a dlc_report row per signal', () => {
  const db = memoryDb();
  insert(db, 'Verdigris Armor', '{{SotE}}');
  classifyDlc(db, { overrides: { dlc: [], base: [] }, now: () => new Date('2026-09-15T00:00:00.000Z') });
  const rows = db.prepare('SELECT signal, hits, at FROM dlc_report ORDER BY signal').all() as { signal: string; hits: number; at: string }[];
  assert.ok(rows.some((r) => r.signal === 'sote_template' && r.hits === 1));
  assert.ok(rows.every((r) => r.at === '2026-09-15T00:00:00.000Z'));
});

test('classifyDlc is idempotent', () => {
  const db = memoryDb();
  insert(db, 'Verdigris Armor', '{{SotE}}');
  const first = classifyDlc(db, { overrides: { dlc: [], base: [] } });
  const second = classifyDlc(db, { overrides: { dlc: [], base: [] } });
  assert.deepEqual(first.bySignal, second.bySignal);
  assert.equal((db.prepare('SELECT count(*) AS n FROM dlc_report').get() as { n: number }).n, second.pages > 0 ? 5 : 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='classifyDlc'`
Expected: FAIL — `classifyDlc` is not exported.

- [ ] **Step 3: Write the pass**

Append to `src/extract/dlc.ts`:

```ts
import type { Db } from '../db/open.js';

export const DLC_SIGNALS: DlcSignal[] = ['override', 'hub_page', 'sote_template', 'title_suffix', 'category'];

export interface DlcReport {
  pages: number;
  dlc: number;
  hasDlcSections: number;
  bySignal: Record<DlcSignal, number>;
  /** Base-game pages that nonetheless mention DLC content: the queue for the override file. */
  ambiguous: string[];
}

/**
 * Labels every page in the db. Runs after runExtractors rather than inside it: extractors write rows
 * keyed by page_id into tables clearDerived truncates, and this writes a column on pages itself.
 */
export function classifyDlc(db: Db, opts: { overrides?: Overrides; now?: () => Date } = {}): DlcReport {
  const overrides = opts.overrides ?? loadOverrides();
  const now = opts.now ?? (() => new Date());
  const dlcCategoryTitles = new Set((db.prepare('SELECT title FROM dlc_categories').all() as { title: string }[]).map((r) => r.title));
  const ctx: ClassifyContext = { overrides, dlcCategoryTitles };

  const pages = db.prepare('SELECT id, source, title, wikitext FROM pages ORDER BY id').all() as PageRow[];
  const bySignal = Object.fromEntries(DLC_SIGNALS.map((s) => [s, 0])) as Record<DlcSignal, number>;
  const report: DlcReport = { pages: pages.length, dlc: 0, hasDlcSections: 0, bySignal, ambiguous: [] };

  const update = db.prepare('UPDATE pages SET dlc = ?, dlc_signals = ?, has_dlc_sections = ? WHERE id = ?');
  db.transaction(() => {
    for (const page of pages) {
      const result = classifyPage(page, ctx);
      update.run(result.dlc ? 1 : 0, result.signals.length ? JSON.stringify(result.signals) : null, result.hasDlcSections ? 1 : 0, page.id);
      if (result.dlc) report.dlc++;
      if (result.hasDlcSections) {
        report.hasDlcSections++;
        report.ambiguous.push(page.title);
      }
      for (const signal of result.signals) bySignal[signal]++;
    }

    const at = now().toISOString();
    db.prepare('DELETE FROM dlc_report').run();
    const insertReport = db.prepare('INSERT INTO dlc_report (signal, hits, at) VALUES (?, ?, ?)');
    for (const signal of DLC_SIGNALS) insertReport.run(signal, bySignal[signal], at);
  })();

  return report;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extract/dlc.ts test/dlc.test.ts
git commit -m "feat(extract): classifyDlc pass writes labels and a coverage report"
```

---

### Task 4: Capture DLC category membership during sync

**Files:**
- Modify: `src/sources/fandom.ts`
- Modify: `src/sync.ts`
- Test: `test/fandom.test.ts`, `test/sync.test.ts`

**Interfaces:**
- Consumes: `createFandom`, `syncFandom`
- Produces:
  - On the Fandom client: `listDlcCategoryTitles(): Promise<string[]>`
  - `export function replaceDlcCategories(db: Db, titles: string[]): void` in `src/store/pages.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/fandom.test.ts`. Match the existing fetch-stub style in that file; the stub below returns categorymembers pages keyed by the `cmtitle` parameter.

```ts
test('listDlcCategoryTitles walks subcategories once each', async () => {
  const responses: Record<string, unknown> = {
    'Category:Shadow of the Erdtree': { query: { categorymembers: [
      { title: 'Weapons (Shadow of the Erdtree)', ns: 0 },
      { title: 'Category:Shadow of the Erdtree Locations', ns: 14 },
    ] } },
    'Category:Shadow of the Erdtree Locations': { query: { categorymembers: [
      { title: 'Scadu Altus', ns: 0 },
      { title: 'Category:Shadow of the Erdtree', ns: 14 },
    ] } },
  };
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    const cmtitle = decodeURIComponent(new URL(url).searchParams.get('cmtitle') ?? '');
    calls.push(cmtitle);
    return { ok: true, status: 200, text: async () => JSON.stringify(responses[cmtitle] ?? { query: { categorymembers: [] } }) } as Response;
  };

  const fandom = createFandom({ fetchImpl, sleep: async () => {}, minIntervalMs: 0 });
  const titles = await fandom.listDlcCategoryTitles();

  assert.deepEqual(titles.sort(), ['Scadu Altus', 'Weapons (Shadow of the Erdtree)']);
  assert.equal(calls.filter((c) => c === 'Category:Shadow of the Erdtree').length, 1, 'must not revisit a category');
});
```

Append to `test/sync.test.ts`:

```ts
test('syncFandom stores dlc category titles', async () => {
  const db = memoryDb();
  const fandom = {
    listRevisions: async function* () { yield { title: 'Scadu Altus', revid: 1 }; },
    listRedirects: async function* () {},
    fetchPages: async (titles: string[]) => titles.map((title) => ({
      source: 'fandom', title, url: `https://x/${title}`, revid: 1,
      fetchedAt: 'now', wikitext: 'A region.', markdown: null, license: 'CC BY-SA 3.0',
    })),
    listDlcCategoryTitles: async () => ['Scadu Altus'],
  };
  await syncFandom(db, fandom);
  const stored = db.prepare('SELECT title FROM dlc_categories').all() as { title: string }[];
  assert.deepEqual(stored, [{ title: 'Scadu Altus' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='DlcCategor|dlc category'`
Expected: FAIL — `listDlcCategoryTitles` is not a function.

- [ ] **Step 3: Add the crawl**

In `src/sources/fandom.ts`, add to the object returned by `createFandom`:

```ts
    /**
     * Breadth-first over Category:Shadow of the Erdtree and its subcategories. Fandom's category graph
     * contains cycles (a subcategory lists its parent), so visited titles are tracked. Bounded: ~27
     * top-level members and three subcategories, not a second full sync.
     */
    async listDlcCategoryTitles(): Promise<string[]> {
      const ROOT = 'Category:Shadow of the Erdtree';
      const seen = new Set<string>([ROOT]);
      const queue = [ROOT];
      const titles: string[] = [];

      while (queue.length) {
        const category = queue.shift() as string;
        for await (const json of paged({ action: 'query', list: 'categorymembers', cmtitle: category, cmlimit: '500' })) {
          for (const member of json.query?.categorymembers ?? []) {
            if (member.ns === 14) {
              if (!seen.has(member.title)) { seen.add(member.title); queue.push(member.title); }
            } else if (member.ns === 0) {
              titles.push(member.title);
            }
          }
        }
      }
      return [...new Set(titles)];
    },
```

In `src/store/pages.ts`, add:

```ts
/** Replaces the DLC category membership captured from the wiki. */
export function replaceDlcCategories(db: Db, titles: string[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM dlc_categories').run();
    const insert = db.prepare('INSERT OR IGNORE INTO dlc_categories (title) VALUES (?)');
    for (const title of titles) insert.run(title);
  })();
}
```

In `src/sync.ts`, widen the client type and call it. Change the `fandom` parameter type to:

```ts
  fandom: Pick<Fandom, 'listRevisions' | 'listRedirects' | 'fetchPages' | 'listDlcCategoryTitles'>,
```

add `replaceDlcCategories` to the import from `./store/pages.js`, and insert before `recordSync`:

```ts
  const dlcTitles = await fandom.listDlcCategoryTitles();
  replaceDlcCategories(db, dlcTitles);
  log(`dlc category titles: ${dlcTitles.length}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS. If other `syncFandom` tests fail to typecheck for a missing `listDlcCategoryTitles`, add `listDlcCategoryTitles: async () => []` to those stubs.

- [ ] **Step 5: Commit**

```bash
git add src/sources/fandom.ts src/store/pages.ts src/sync.ts test/fandom.test.ts test/sync.test.ts
git commit -m "feat(sync): capture Shadow of the Erdtree category membership"
```

---

### Task 5: Run the classifier from the sync and extract entry points

**Files:**
- Modify: `scripts/extract.ts`
- Modify: `scripts/sync.ts`
- Test: `test/dlc.test.ts`

**Interfaces:**
- Consumes: `classifyDlc` from Task 3, `runExtractors` from `src/extract/run.js`
- Produces: nothing new; wiring only

- [ ] **Step 1: Read both scripts**

Run: `cat scripts/extract.ts scripts/sync.ts`

Note how each opens the database and prints its report; match that style exactly rather than inventing a new one.

- [ ] **Step 2: Write the failing test**

Append to `test/dlc.test.ts`:

```ts
test('classification survives a re-extract', () => {
  const db = memoryDb();
  insert(db, 'Verdigris Armor', 'Added in the {{SotE}} expansion.');
  classifyDlc(db, { overrides: { dlc: [], base: [] } });
  assert.equal((db.prepare('SELECT dlc FROM pages WHERE title = ?').get('Verdigris Armor') as { dlc: number }).dlc, 1);

  // runExtractors clears derived tables per page; pages.dlc is not one of them and must survive.
  runExtractors(db);
  assert.equal((db.prepare('SELECT dlc FROM pages WHERE title = ?').get('Verdigris Armor') as { dlc: number }).dlc, 1);
});
```

Add to the imports of `test/dlc.test.ts`:

```ts
import { runExtractors } from '../src/extract/run.js';
```

- [ ] **Step 3: Run test to verify it passes or fails**

Run: `npm test -- --test-name-pattern='survives a re-extract'`
Expected: PASS. This test pins the invariant that motivated keeping the classifier out of `EXTRACTORS`; if it fails, `clearDerived` has been changed to touch `pages` and that must be fixed before continuing.

- [ ] **Step 4: Wire the classifier into both scripts**

In `scripts/extract.ts`, after the `runExtractors` call and its report output, add:

```ts
const dlc = classifyDlc(db);
console.log(`dlc: ${dlc.dlc}/${dlc.pages} pages, ${dlc.hasDlcSections} base pages mention DLC`);
console.log(`signals: ${Object.entries(dlc.bySignal).map(([signal, hits]) => `${signal}=${hits}`).join(' ')}`);
if (dlc.ambiguous.length) console.log(`ambiguous (candidates for data/dlc-overrides.json): ${dlc.ambiguous.slice(0, 20).join(', ')}`);
```

with `import { classifyDlc } from '../src/extract/dlc.js';` at the top.

In `scripts/sync.ts`, add the same import and the same three log lines after the sync completes and after extraction runs, so a sync leaves the database fully classified.

- [ ] **Step 5: Verify against the real database**

Run: `npm run extract`
Expected: a `dlc:` line reporting several hundred DLC pages, and a `signals:` line where `sote_template` is the largest contributor. Record the actual numbers — Task 10 asserts on them.

- [ ] **Step 6: Commit**

```bash
git add scripts/extract.ts scripts/sync.ts test/dlc.test.ts
git commit -m "feat(scripts): classify DLC after extraction and report coverage"
```

---

### Task 6: Query mode and predicate

**Files:**
- Modify: `src/query/dbs.ts`
- Test: `test/query.test.ts`

**Interfaces:**
- Consumes: `openDbs()`
- Produces:
  - `export type DlcMode = 'base' | 'all' | 'only'`
  - `export const DEFAULT_DLC_MODE: DlcMode = 'base'`
  - `export function dlcPredicate(mode: DlcMode, alias?: string): string`

- [ ] **Step 1: Write the failing test**

Append to `test/query.test.ts`:

```ts
test('dlcPredicate produces constant SQL per mode', () => {
  assert.equal(dlcPredicate('base'), 'pages.dlc = 0');
  assert.equal(dlcPredicate('only'), 'pages.dlc = 1');
  assert.equal(dlcPredicate('all'), '1=1');
});

test('dlcPredicate honours a table alias', () => {
  assert.equal(dlcPredicate('base', 'p'), 'p.dlc = 0');
  assert.equal(dlcPredicate('all', 'p'), '1=1');
});
```

Add `dlcPredicate` to the import from `../src/query/dbs.js` in `test/query.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='dlcPredicate'`
Expected: FAIL — `dlcPredicate` is not exported.

- [ ] **Step 3: Implement**

Append to `src/query/dbs.ts`:

```ts
export type DlcMode = 'base' | 'all' | 'only';

export const DEFAULT_DLC_MODE: DlcMode = 'base';

/**
 * Returns a constant SQL fragment — never caller text — so composing it into a query cannot inject.
 * `alias` names the pages table in queries that join it under a short name.
 */
export function dlcPredicate(mode: DlcMode, alias = 'pages'): string {
  switch (mode) {
    case 'only': return `${alias}.dlc = 1`;
    case 'all': return '1=1';
    case 'base':
    default: return `${alias}.dlc = 0`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/query/dbs.ts test/query.test.ts
git commit -m "feat(query): add DlcMode and the dlc SQL predicate"
```

---

### Task 7: The `dlc_filtered` resolver result

**Files:**
- Modify: `src/query/resolve.ts`
- Test: `test/query.test.ts`

**Interfaces:**
- Consumes: `DlcMode` from Task 6
- Produces:
  - `Resolved` gains `dlc: boolean`
  - `export interface DlcFiltered { filtered: 'dlc'; title: string; provenance: Provenance }`
  - `export function resolveName(dbs: Dbs, name: string, mode?: DlcMode): Resolved | DlcFiltered | null`
  - `export function isDlcFiltered(r: Resolved | DlcFiltered | null): r is DlcFiltered`

- [ ] **Step 1: Write the failing test**

Append to `test/query.test.ts`. Use whatever fixture-building helper `query.test.ts` already has; the calls below assume a helper that inserts a page and returns the `Dbs`.

```ts
test('resolveName returns the page when the mode permits it', () => {
  const dbs = fixtureDbs([{ title: 'Icerind Hatchet', wikitext: 'axe', dlc: 0 }]);
  const r = resolveName(dbs, 'Icerind Hatchet', 'base');
  assert.ok(r && !isDlcFiltered(r));
  assert.equal(r.dlc, false);
});

test('resolveName reports a dlc page as filtered in base mode', () => {
  const dbs = fixtureDbs([{ title: 'Verdigris Armor', wikitext: 'armor', dlc: 1 }]);
  const r = resolveName(dbs, 'Verdigris Armor', 'base');
  assert.ok(r && isDlcFiltered(r));
  assert.equal(r.title, 'Verdigris Armor');
  assert.equal(r.provenance.title, 'Verdigris Armor');
});

test('resolveName returns a dlc page in all mode', () => {
  const dbs = fixtureDbs([{ title: 'Verdigris Armor', wikitext: 'armor', dlc: 1 }]);
  const r = resolveName(dbs, 'Verdigris Armor', 'all');
  assert.ok(r && !isDlcFiltered(r));
  assert.equal(r.dlc, true);
});

test('resolveName filters a base page in only mode', () => {
  const dbs = fixtureDbs([{ title: 'Icerind Hatchet', wikitext: 'axe', dlc: 0 }]);
  const r = resolveName(dbs, 'Icerind Hatchet', 'only');
  assert.ok(r && isDlcFiltered(r));
});

test('a page that does not exist is still a plain miss', () => {
  const dbs = fixtureDbs([{ title: 'Icerind Hatchet', wikitext: 'axe', dlc: 0 }]);
  assert.equal(resolveName(dbs, 'Nonexistent Sword of Nothing', 'base'), null);
});

test('resolveName defaults to base mode', () => {
  const dbs = fixtureDbs([{ title: 'Verdigris Armor', wikitext: 'armor', dlc: 1 }]);
  const r = resolveName(dbs, 'Verdigris Armor');
  assert.ok(r && isDlcFiltered(r));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='resolveName'`
Expected: FAIL — `isDlcFiltered` is not exported and `resolveName` takes two arguments.

- [ ] **Step 3: Implement**

In `src/query/resolve.ts`:

Add to the imports: `import { DEFAULT_DLC_MODE, type DlcMode, type Dbs } from './dbs.js';`

Add `dlc: boolean` to `Resolved`, and extend the provenance column list and `toResolved`:

```ts
const PROVENANCE_COLUMNS = 'id, source, title, url, revid, fetched_at, license, dlc';

type PageRecord = Provenance & { id: number; dlc: number };

const toResolved = (db: Db, row: PageRecord, match: Resolved['match'], fragment: string | null = null): Resolved => {
  const { id, dlc, ...provenance } = row;
  return { db, pageId: id, provenance, match, fragment, dlc: dlc === 1 };
};
```

Add the filtered result and the guard:

```ts
export interface DlcFiltered {
  filtered: 'dlc';
  title: string;
  provenance: Provenance;
}

export const isDlcFiltered = (r: Resolved | DlcFiltered | null): r is DlcFiltered =>
  r !== null && 'filtered' in r;

const permits = (mode: DlcMode, dlc: boolean): boolean =>
  mode === 'all' || (mode === 'only' ? dlc : !dlc);
```

Replace `resolveName`:

```ts
/**
 * Resolves against every page regardless of mode, then compares. Excluding DLC rows from the
 * resolver's view instead would make "the snapshot does not cover this" and "you did not ask for
 * DLC" indistinguishable, which is the failure this whole feature exists to avoid.
 */
export function resolveName(dbs: Dbs, name: string, mode: DlcMode = DEFAULT_DLC_MODE): Resolved | DlcFiltered | null {
  const trimmed = name.trim();
  let found: Resolved | null = null;

  for (const db of [dbs.shipped, dbs.local]) {
    if (!db) continue;
    const resolved = resolveIn(db, trimmed);
    if (resolved && resolved.match !== 'search') { found = resolved; break; }
  }
  if (!found) {
    for (const db of [dbs.shipped, dbs.local]) {
      if (!db) continue;
      const resolved = resolveIn(db, trimmed);
      if (resolved) { found = resolved; break; }
    }
  }

  if (!found) return null;
  if (permits(mode, found.dlc)) return found;
  return { filtered: 'dlc', title: found.provenance.title, provenance: found.provenance };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern='resolveName' && npm run typecheck`
Expected: the resolver tests PASS. `lookups.ts` will now fail to typecheck because its callers do not handle `DlcFiltered` — Task 8 fixes that. If `tsc` blocks the test run, proceed to Task 8 and commit both together.

- [ ] **Step 5: Commit**

```bash
git add src/query/resolve.ts test/query.test.ts
git commit -m "feat(query): resolve against all pages, then report dlc_filtered"
```

---

### Task 8: Apply filtering across every lookup

**Files:**
- Modify: `src/query/lookups.ts`
- Test: `test/query.test.ts`

**Interfaces:**
- Consumes: `dlcPredicate`, `DlcMode`, `DEFAULT_DLC_MODE` (Task 6); `resolveName`, `isDlcFiltered`, `DlcFiltered` (Task 7)
- Produces: every exported lookup takes a trailing `mode: DlcMode = DEFAULT_DLC_MODE`:
  - `search(dbs, query, limit?, mode?)`
  - `getPage(dbs, title, section?, mode?)`
  - `whereIs(dbs, name, mode?)`
  - `questSteps(dbs, npc, mode?)`
  - `itemStats(dbs, filter, mode?)`
  - `bossInfo(dbs, name, mode?)`
  - `sourcesStatus(dbs)` — unchanged signature, extra fields

- [ ] **Step 1: Write the failing test**

Append to `test/query.test.ts`:

```ts
test('whereIs on a dlc item in base mode explains the filter', () => {
  const dbs = fixtureDbs([{ title: 'Verdigris Armor', wikitext: 'armor', dlc: 1 }]);
  const result = whereIs(dbs, 'Verdigris Armor', 'base') as { not_found: true; reason: string; page: string; hint: string };
  assert.equal(result.not_found, true);
  assert.equal(result.reason, 'dlc_filtered');
  assert.equal(result.page, 'Verdigris Armor');
  assert.match(result.hint, /Shadow of the Erdtree/);
  assert.match(result.hint, /dlc/);
});

test('whereIs on a dlc item in all mode answers', () => {
  const dbs = fixtureDbs([{ title: 'Verdigris Armor', wikitext: 'armor', dlc: 1 }]);
  const result = whereIs(dbs, 'Verdigris Armor', 'all') as { provenance: { title: string }; dlc: boolean };
  assert.equal(result.provenance.title, 'Verdigris Armor');
  assert.equal(result.dlc, true);
});

test('a genuinely missing page is not reported as dlc_filtered', () => {
  const dbs = fixtureDbs([{ title: 'Icerind Hatchet', wikitext: 'axe', dlc: 0 }]);
  const result = whereIs(dbs, 'Sword Of Nothing At All', 'base') as { not_found: true; reason?: string };
  assert.equal(result.not_found, true);
  assert.equal(result.reason, undefined);
});

test('search excludes dlc results in base mode', () => {
  const dbs = fixtureDbs([
    { title: 'Verdigris Armor', wikitext: 'verdigris plate', dlc: 1 },
    { title: 'Icerind Hatchet', wikitext: 'frost axe', dlc: 0 },
  ]);
  const base = search(dbs, 'verdigris', 10, 'base') as { not_found?: true };
  assert.equal(base.not_found, true);

  const all = search(dbs, 'verdigris', 10, 'all') as { results: { title: string; dlc: boolean }[] };
  assert.equal(all.results.length, 1);
  assert.equal(all.results[0].dlc, true);
});

test('search in only mode returns dlc results alone', () => {
  const dbs = fixtureDbs([
    { title: 'Verdigris Armor', wikitext: 'plate armor', dlc: 1 },
    { title: 'Icerind Hatchet', wikitext: 'plate axe', dlc: 0 },
  ]);
  const result = search(dbs, 'plate', 10, 'only') as { results: { title: string }[] };
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Verdigris Armor');
});

test('getPage carries has_dlc_sections on a base page that mentions dlc', () => {
  const dbs = fixtureDbs([{ title: 'Great Runes', wikitext: 'lore', dlc: 0, hasDlcSections: 1 }]);
  const result = getPage(dbs, 'Great Runes', undefined, 'base') as { has_dlc_sections: boolean };
  assert.equal(result.has_dlc_sections, true);
});

test('sourcesStatus reports base and dlc counts', () => {
  const dbs = fixtureDbs([
    { title: 'Verdigris Armor', wikitext: 'a', dlc: 1 },
    { title: 'Icerind Hatchet', wikitext: 'b', dlc: 0 },
  ]);
  const status = sourcesStatus(dbs) as { shipped: { pages: number; dlc_pages: number; base_pages: number } };
  assert.equal(status.shipped.pages, 2);
  assert.equal(status.shipped.dlc_pages, 1);
  assert.equal(status.shipped.base_pages, 1);
});
```

Extend the `fixtureDbs` helper in `test/query.test.ts` so each fixture accepts `dlc` and optional `hasDlcSections`, writing both into the `pages` insert. If no such helper exists, create one:

```ts
type Fixture = { title: string; wikitext: string; dlc: number; hasDlcSections?: number };

function fixtureDbs(fixtures: Fixture[]): Dbs {
  const db = memoryDb();
  const insertPage = db.prepare(
    'INSERT INTO pages (source, title, url, revid, fetched_at, license, wikitext, dlc, has_dlc_sections) VALUES (?,?,?,?,?,?,?,?,?)');
  const insertSection = db.prepare('INSERT INTO sections (page_id, ord, heading, markdown) VALUES (?,?,?,?)');
  const insertFts = db.prepare('INSERT INTO sections_fts (rowid, title, heading, markdown) VALUES (?,?,?,?)');
  for (const f of fixtures) {
    const { lastInsertRowid } = insertPage.run(
      'fandom', f.title, `https://x/${f.title}`, 1, '2026-09-15', 'CC BY-SA 3.0', f.wikitext, f.dlc, f.hasDlcSections ?? 0);
    const pageId = Number(lastInsertRowid);
    const section = insertSection.run(pageId, 0, 'Acquisition', f.wikitext);
    insertFts.run(Number(section.lastInsertRowid), f.title, 'Acquisition', f.wikitext);
  }
  return { shipped: db, local: null };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='dlc|search excludes|sourcesStatus'`
Expected: FAIL — lookups take no mode argument.

- [ ] **Step 3: Implement**

In `src/query/lookups.ts`:

Extend the imports:

```ts
import { DEFAULT_DLC_MODE, dlcPredicate, type Dbs, type DlcMode } from './dbs.js';
import { ftsQuery, isDlcFiltered, resolveName, type DlcFiltered, type Provenance, type Resolved } from './resolve.js';
```

Add the filtered result shape next to the other miss helpers:

```ts
/**
 * The page exists but the caller's own mode excluded it. Distinct from not_found so an answer never
 * claims the snapshot lacks something it holds.
 */
const dlcFiltered = (query: string, r: DlcFiltered) => ({
  not_found: true as const, query, reason: 'dlc_filtered' as const, page: r.title,
  provenance: r.provenance,
  hint: `"${r.title}" is Shadow of the Erdtree content and this call asked for base-game results. Re-run with dlc: "all" to include the DLC, or dlc: "only" for DLC alone.`,
});
```

Add one shared entry point so no lookup forgets the check:

```ts
type ResolveOutcome =
  | { kind: 'ok'; resolved: Resolved }
  | { kind: 'filtered'; miss: ReturnType<typeof dlcFiltered> }
  | { kind: 'missing'; miss: NotFound };

function resolveFor(dbs: Dbs, name: string, mode: DlcMode): ResolveOutcome {
  const r = resolveName(dbs, name, mode);
  if (!r) return { kind: 'missing', miss: notFound(name) };
  if (isDlcFiltered(r)) return { kind: 'filtered', miss: dlcFiltered(name, r) };
  return { kind: 'ok', resolved: r };
}
```

Rewrite each name-resolving lookup to use it. `whereIs` becomes:

```ts
export function whereIs(dbs: Dbs, name: string, mode: DlcMode = DEFAULT_DLC_MODE) {
  const outcome = resolveFor(dbs, name, mode);
  if (outcome.kind !== 'ok') return outcome.miss;
  const r = outcome.resolved;
  const row = r.db.prepare('SELECT method, location_text, nearest_grace, prereqs, missable FROM acquisition WHERE page_id = ?').get(r.pageId) as
    { method: string; location_text: string; nearest_grace: string | null; prereqs: string; missable: number } | undefined;
  return {
    provenance: r.provenance,
    match: r.match,
    dlc: r.dlc,
    acquisition: row ? { ...row, prereqs: parsePrereqs(row.prereqs), missable: row.missable === 1 } : null,
    sections: sectionsOf(r, /acquisition|location|where to find|how to get/i),
  };
}
```

Apply the identical `resolveFor` pattern to `getPage`, `questSteps`, `bossInfo`, and the `filter.name` branch of `itemStats`, each gaining a trailing `mode: DlcMode = DEFAULT_DLC_MODE` parameter and each adding `dlc: r.dlc` to its successful result. `getPage` additionally reads and surfaces the flag:

```ts
  const hasDlcSections = (r.db.prepare('SELECT has_dlc_sections FROM pages WHERE id = ?').get(r.pageId) as { has_dlc_sections: number }).has_dlc_sections === 1;
```

and includes `dlc: r.dlc, has_dlc_sections: hasDlcSections` in each returned object.

`search` filters in SQL:

```ts
export function search(dbs: Dbs, query: string, limit = 10, mode: DlcMode = DEFAULT_DLC_MODE) {
  const fts = ftsQuery(query);
  const results: { title: string; heading: string; snippet: string; dlc: boolean; provenance: Provenance }[] = [];
  if (!fts) return noMatch(query, NO_SEARCH_HINT);
  for (const db of [dbs.shipped, dbs.local]) {
    if (!db) continue;
    const rows = db.prepare(`
      SELECT p.source, p.title, p.url, p.revid, p.fetched_at, p.license, p.dlc, s.heading,
             snippet(sections_fts, 2, '**', '**', ' … ', 24) AS snippet
      FROM sections_fts f JOIN sections s ON s.id = f.rowid JOIN pages p ON p.id = s.page_id
      WHERE sections_fts MATCH ? AND ${dlcPredicate(mode, 'p')}
      ORDER BY bm25(sections_fts, 10.0, 2.0, 1.0) LIMIT ?
    `).all(fts, limit) as (Provenance & { heading: string; snippet: string; dlc: number })[];
    for (const { heading, snippet, dlc, ...provenance } of rows) {
      results.push({ title: provenance.title, heading, snippet, dlc: dlc === 1, provenance });
    }
  }
  return results.length ? { results: results.slice(0, limit) } : noMatch(query, NO_SEARCH_HINT);
}
```

The filterless branch of `itemStats` joins `pages` so the predicate applies. Change its per-kind SQL to:

```ts
      const sql = `SELECT t.* FROM ${KIND_TABLE[kind]} t JOIN pages p ON p.id = t.page_id${where.length ? ` WHERE ${where.map((clause) => `t.${clause}`).join(' AND ')} AND ` : ' WHERE '}${dlcPredicate(mode, 'p')} ORDER BY t.name LIMIT ?`;
```

Note the `t.` prefix on the existing `where` clauses: they name columns such as `str_req` that now sit on an aliased table.

`sourcesStatus` gains the counts and the last report:

```ts
export function sourcesStatus(dbs: Dbs) {
  const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    shipped: dbs.shipped
      ? {
          sync: dbs.shipped.prepare('SELECT source, last_run, pages FROM sync_state').all(),
          pages: count(dbs.shipped, 'SELECT count(*) AS n FROM pages'),
          base_pages: count(dbs.shipped, 'SELECT count(*) AS n FROM pages WHERE dlc = 0'),
          dlc_pages: count(dbs.shipped, 'SELECT count(*) AS n FROM pages WHERE dlc = 1'),
          dlc_signals: dbs.shipped.prepare('SELECT signal, hits, at FROM dlc_report ORDER BY signal').all(),
          failures: count(dbs.shipped, 'SELECT count(*) AS n FROM extract_failures'),
        }
      : null,
    local: dbs.local ? { pages: count(dbs.local, 'SELECT count(*) AS n FROM pages') } : null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS, including every pre-existing query test. Pre-existing tests calling `whereIs(dbs, name)` with base-game fixtures keep working because the mode defaults to `base`.

- [ ] **Step 5: Commit**

```bash
git add src/query/lookups.ts test/query.test.ts
git commit -m "feat(query): filter every lookup by dlc mode"
```

---

### Task 9: Expose the mode on the MCP tools

**Files:**
- Modify: `src/server/mcp-server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: every lookup's `mode` parameter (Task 8)
- Produces: a `dlc` input on `search`, `get_page`, `where_is`, `quest_steps`, `item_stats`, `boss`

- [ ] **Step 1: Write the failing test**

Append to `test/server.test.ts`, matching the existing harness in that file for listing tools and calling one:

```ts
test('every lookup tool accepts a dlc mode', async () => {
  const tools = await listTools();
  const withDlc = ['search', 'get_page', 'where_is', 'quest_steps', 'item_stats', 'boss'];
  for (const name of withDlc) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} must exist`);
    assert.ok(tool.inputSchema.properties.dlc, `${name} must accept dlc`);
  }
  assert.equal(tools.find((t) => t.name === 'sources_status')?.inputSchema.properties?.dlc, undefined);
});

test('the server instructions state the base-game default', () => {
  assert.match(INSTRUCTIONS, /base game/i);
  assert.match(INSTRUCTIONS, /dlc_filtered/);
});
```

Export `INSTRUCTIONS` from `src/server/mcp-server.ts` so the test can read it:

```ts
export const INSTRUCTIONS = `…`;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='dlc mode|instructions'`
Expected: FAIL — `dlc` is not in any tool's input schema.

- [ ] **Step 3: Implement**

In `src/server/mcp-server.ts`, add next to `fetchArg`:

```ts
const dlcArg = z.enum(['base', 'all', 'only']).optional().default('base')
  .describe('Which content to search: "base" (default) is base game only, "all" includes Shadow of the Erdtree, "only" is DLC content alone');
```

Add `dlc: dlcArg` to the `inputSchema` of `search`, `get_page`, `where_is`, `quest_steps`, `item_stats` and `boss`, and pass it through to each lookup. For example:

```ts
}, async ({ query, limit, dlc }) => { try { return reply(search(dbs, query, limit, dlc)); } catch (error) { return fail(error); } });
```

and

```ts
}, async ({ name, fetch, dlc }) => withFetch(name, fetch, () => whereIs(dbs, name, dlc)));
```

Replace `INSTRUCTIONS` with:

```ts
export const INSTRUCTIONS = `Elden Ring reference data from a versioned snapshot of eldenring.fandom.com (CC BY-SA 3.0), plus an optional per-user Fextralife page cache. Every result carries provenance (source, title, url, revid, fetched_at, license): cite it when answering.

Results are base game only by default. Pass dlc: "all" to include Shadow of the Erdtree content, or dlc: "only" for DLC content alone. A result with reason: "dlc_filtered" means the page exists but this call asked for base-game results: say so and offer to re-run with dlc: "all"; never report it as missing data. A result with has_dlc_sections means a base-game page whose text also discusses DLC events.

A result with not_found and no reason means the data does not cover it; say so instead of guessing, or retry with fetch: true to cache the Fextralife page. Fandom and Fextralife sometimes disagree on numbers; when both are present, show both with their sources. Directions from the wiki may omit prerequisites; state prerequisites the result lists.`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify end to end**

Run: `npm run smoke`
Expected: the smoke script completes. Then confirm by hand that `where_is` for a DLC item behaves in both modes — from a node REPL or by extending `scripts/smoke-mcp.ts`:

```
where_is("Verdigris Armor")                 -> not_found, reason dlc_filtered
where_is("Verdigris Armor", dlc: "all")     -> acquisition from Moore
where_is("Icerind Hatchet")                 -> acquisition, unchanged from today
```

- [ ] **Step 6: Commit**

```bash
git add src/server/mcp-server.ts test/server.test.ts
git commit -m "feat(server): add the dlc mode input and document the default"
```

---

### Task 10: Coverage assertion against the shipped database

**Files:**
- Create: `test/dlc-coverage.test.ts`
- Modify: `docs/superpowers/specs/2026-09-15-sote-dlc-layering-design.md`

**Interfaces:**
- Consumes: the shipped `data/elden-ring.db`, `classifyDlc` from Task 3

- [ ] **Step 1: Write the test**

Create `test/dlc-coverage.test.ts`. It skips when the 37 MB database is absent, so a fresh clone still passes:

```ts
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { openDb } from '../src/db/open.js';

const DB_PATH = 'data/elden-ring.db';
const hasDb = existsSync(DB_PATH);

test('the shipped db classifies a plausible share of pages as dlc', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  const dlc = (db.prepare('SELECT count(*) AS n FROM pages WHERE dlc = 1').get() as { n: number }).n;
  const total = (db.prepare('SELECT count(*) AS n FROM pages').get() as { n: number }).n;
  assert.ok(dlc >= 800, `expected at least 800 dlc pages, got ${dlc} of ${total}`);
  assert.ok(dlc < total / 2, `dlc share implausible: ${dlc} of ${total}`);
  db.close();
});

test('known hub pages are never classified as dlc', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  const hubs = ['Weapons', 'Armor Sets', 'Talismans', 'Bosses'];
  for (const title of hubs) {
    const row = db.prepare('SELECT dlc FROM pages WHERE title = ?').get(title) as { dlc: number } | undefined;
    if (row) assert.equal(row.dlc, 0, `${title} must stay base game`);
  }
  db.close();
});

test('known dlc pages are classified as dlc', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  for (const title of ['Verdigris Armor', 'Messmer the Impaler', 'Scadu Altus', 'Rellana, Twin Moon Knight']) {
    const row = db.prepare('SELECT dlc FROM pages WHERE title = ?').get(title) as { dlc: number } | undefined;
    assert.ok(row, `${title} must exist in the snapshot`);
    assert.equal(row.dlc, 1, `${title} must be classified as dlc`);
  }
  db.close();
});

test('known base pages are not classified as dlc', { skip: hasDb ? false : 'data/elden-ring.db not present' }, () => {
  const db = openDb(DB_PATH, { readonly: true });
  for (const title of ['Icerind Hatchet', 'Godrick the Grafted', 'Stormveil Castle']) {
    const row = db.prepare('SELECT dlc FROM pages WHERE title = ?').get(title) as { dlc: number } | undefined;
    assert.ok(row, `${title} must exist in the snapshot`);
    assert.equal(row.dlc, 0, `${title} must stay base game`);
  }
  db.close();
});
```

- [ ] **Step 2: Run the classifier over the real data**

Run: `npm run extract`
Expected: the `dlc:` and `signals:` lines from Task 5.

- [ ] **Step 3: Run the coverage test**

Run: `npm test -- --test-name-pattern='shipped db|hub pages|known dlc|known base'`
Expected: PASS. Any failure here is a real classifier gap, not a test bug. Fix it by adding the offending title to the right list in `data/dlc-overrides.json`, re-running `npm run extract`, and re-running the test.

- [ ] **Step 4: Record the measured numbers in the spec**

The spec's "Known limitations" says no accuracy figure has been measured. Replace that clause with the real numbers from Step 2, for example:

```markdown
- **Measured coverage (2026-09-15):** the classifier labels N of 4,922 pages as
  DLC, by signal: sote_template=N, category=N, title_suffix=N, override=N. M
  base-game pages are flagged `has_dlc_sections`. Accuracy on the spot-check set
  in `test/dlc-coverage.test.ts` is 100%; accuracy across the full snapshot is
  unmeasured, and the override file is the mechanism for correcting what the
  report surfaces as ambiguous.
```

Use the actual counts. Do not write a figure you have not run.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/dlc-coverage.test.ts docs/superpowers/specs/2026-09-15-sote-dlc-layering-design.md
git commit -m "test: assert dlc classification coverage on the shipped snapshot"
```

---

## Self-review notes

**Spec coverage.** §1 Schema → Task 1. §2 Classifier signals and precedence → Tasks 2 and 3. §3 Query layer, `dlcPredicate` and `dlc_filtered` → Tasks 6, 7, 8. §4 Tool surface → Task 9. §5 Sync changes → Tasks 4 and 5. §6 Testing → the test steps throughout, plus Task 10.

**One spec item deliberately dropped.** The spec lists `src/server/compact.ts` as a file to modify. It needs no change: `compact` treats `false` as content and only strips `null`, `undefined`, empty arrays and empty objects, so `dlc: false` survives serialisation already. No task touches it.

**One spec item corrected.** The classifier is not registered in `EXTRACTORS`; see the deviation note above the tasks.

**Known risk carried into execution.** Task 8's change to `itemStats` rewrites live SQL that already carries careful semantics around unparsed requirement columns (`str_req IS NOT NULL AND str_req <= ?`). The `t.` prefixing there is the most error-prone edit in this plan. The existing `itemStats` tests must pass unchanged; if they do not, the join is wrong, not the tests.
