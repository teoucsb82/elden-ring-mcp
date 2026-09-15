# elden-ring-mcp v1 (data + lookup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP server that answers Elden Ring lookups (where is X, quest steps, stats, bosses) from a local, versioned, source-attributed copy of the Fandom wiki, with an optional local-only Fextralife cache.

**Architecture:** Source adapters (Fandom MediaWiki API, Fextralife on-demand) feed a SQLite store (pages, sections, FTS5). Extractors parse infoboxes and sections into typed tables. A query layer resolves names and answers tools; a thin MCP server exposes them.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 20+, `@modelcontextprotocol/sdk` 1.30, `zod` 4, `better-sqlite3` 13, `node-html-parser` 9, `turndown` 7, `tsx`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-15-elden-ring-mcp-v1-design.md`

## Global Constraints

- Code license MIT. Fandom-derived data license CC BY-SA 3.0 (Fandom siteinfo reports "CC-BY-SA"; Fandom licensing = 3.0 Unported).
- Fextralife content is never written under `data/` and never committed. Local cache path: `$ELDEN_RING_MCP_CACHE` or `~/.cache/elden-ring-mcp/local.db`.
- eldenring.fanapis.com is not used (no license).
- Every tool answer carries provenance: `source`, `title`, `url`, `revid`, `fetched_at`, `license`. On a miss, return `{ "not_found": true, ... }`. Never fabricate.
- Max 1 request/second per source; retry 429/5xx/network errors up to 3 times with exponential backoff, honoring `Retry-After`.
- User-Agent: `elden-ring-mcp/0.1 (open-source MCP data sync)`.
- No live network in tests.
- Mirror `~/Code/slate-mcp` conventions: `tsx`, `node --import tsx --test test/*.test.ts`, stdio server, `compact()` + `reply()`/`fail()` helpers, `READ_ONLY` annotations.

## Spec deviations (decided while planning, recorded in Task 1)

1. **Change detection:** compare stored revids to `generator=allpages&prop=info` `lastrevid` (≈10 requests for 4,922 articles) instead of `recentchanges` (retention is limited; misses changes if sync lapses).
2. **Shipped db is a GitHub Release asset, not committed.** Measured 2026-09-15: 4,922 articles, 17.1 MB wikitext; db with sections + FTS ≈ 50 MB and binary diffs bloat git. Committed: `data/CHANGELOG-data.md`, `data/LICENSE`, `data/ATTRIBUTION.md`. `npm run fetch-data` downloads the latest release db.
3. **Provenance by join:** typed rows reference `page_id`; provenance columns live on `pages`.
4. **Local cache queried as a second db handle**, not ATTACH.
5. **Bosses:** Fandom `Infobox Boss` has location/hp/runes/drops only; no resistance fields. `bosses.drops` is text; no separate `drops` table. Resistances come from page sections (or Fextralife cache).
6. **Quest steps** parse Fandom "Questline progression" (`#` = location step, `#*` = actions).

## File map

| File | Responsibility |
|---|---|
| `src/types.ts` | `SourceId`, `RawPage` |
| `src/db/schema.sql`, `src/db/open.ts` | schema, `openDb()` |
| `src/wikitext/infobox.ts` | `findInfobox()` |
| `src/wikitext/markdown.ts` | `wikitextToMarkdown()`, `convertInline()`, `plainText()`, `stripTemplates()` |
| `src/wikitext/sections.ts` | `splitSections()` |
| `src/sources/http.ts` | rate-limited retrying `createHttp()` |
| `src/sources/fandom.ts` | `createFandom()` |
| `src/sources/fextralife.ts` | `fetchFextralife()` html → `RawPage` |
| `src/store/pages.ts` | `upsertPage`, `deletePage`, `clearDerived`, `storedRevids`, `replaceRedirects`, `recordSync` |
| `src/sync.ts` | `syncFandom()` |
| `src/extract/*.ts` | extractors + `runExtractors()` |
| `src/changelog.ts` | `snapshotRows`, `diffSnapshots`, `formatChangelog` |
| `src/query/*.ts` | `resolveName`, `search`, `getPage`, `whereIs`, `questSteps`, `itemStats`, `bossInfo`, `sourcesStatus` |
| `src/server/mcp-server.ts` | MCP tool registration |
| `scripts/*.ts` | `sync`, `extract`, `build`, `smoke-mcp`, `fetch-data` |
| `test/*.test.ts`, `test/helpers.ts` | tests |

---

### Task 1: Scaffold repo, docs, spec deviations

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `LEGAL.md`, `NOTES.md`, `src/types.ts`, `test/scaffold.test.ts`
- Modify: `docs/superpowers/specs/2026-09-15-elden-ring-mcp-v1-design.md` (append "Revisions" section)

**Interfaces:**
- Produces: `SourceId = 'fandom' | 'fextralife'`; `RawPage { source; title; url; revid: number|null; fetchedAt: string; wikitext: string|null; markdown: string|null; license: string }`

- [ ] **Step 1: package.json**

```json
{
  "name": "elden-ring-mcp",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "license": "MIT",
  "description": "Elden Ring lookups (locations, quests, stats, bosses) from a versioned, attributed wiki snapshot, served as MCP tools",
  "engines": { "node": ">=20" },
  "scripts": {
    "sync": "tsx scripts/sync.ts",
    "extract": "tsx scripts/extract.ts",
    "build": "tsx scripts/build.ts",
    "fetch-data": "tsx scripts/fetch-data.ts",
    "mcp": "tsx src/server/mcp-server.ts",
    "smoke": "tsx scripts/smoke-mcp.ts",
    "test": "node --import tsx --test test/*.test.ts",
    "typecheck": "tsc"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "better-sqlite3": "^13.0.3",
    "node-html-parser": "^9.0.4",
    "turndown": "^7.2.4",
    "zod": "^4.6.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.20.2",
    "@types/turndown": "^5.0.5",
    "tsx": "^4.23.13",
    "typescript": "^7.0.2"
  }
}
```

- [ ] **Step 2: tsconfig.json + .gitignore**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noEmit": true, "skipLibCheck": true, "resolveJsonModule": true, "types": ["node"]
  },
  "include": ["src", "scripts", "test"]
}
```

`.gitignore`:
```
node_modules/
data/*.db
data/*.db-*
.cache/
*.log
```

- [ ] **Step 3: `src/types.ts`**

```ts
export type SourceId = 'fandom' | 'fextralife';

/** One wiki page as fetched. Fandom supplies wikitext; Fextralife supplies markdown. */
export interface RawPage {
  source: SourceId;
  title: string;
  url: string;
  revid: number | null;
  fetchedAt: string;
  wikitext: string | null;
  markdown: string | null;
  license: string;
}
```

- [ ] **Step 4: Legal + notes files**

`LICENSE`: standard MIT text, `Copyright (c) 2026 Teo Dell'Amico`.

`LEGAL.md`:
```markdown
# Legal

- **Code**: MIT (`LICENSE`).
- **Data in releases (`elden-ring.db`)**: derived from eldenring.fandom.com, licensed CC BY-SA 3.0. See `data/LICENSE` and `data/ATTRIBUTION.md`. Every row links to its source page and revision.
- **Fextralife**: pages are copyright Fextralife. This project only fetches single pages on explicit request into a cache on the user's own machine (`~/.cache/elden-ring-mcp/`). That cache is never committed or published.
- **eldenring.fanapis.com**: not used; its repository has no license.
- Elden Ring is a trademark of FromSoftware / Bandai Namco. This project is unofficial.
```

`NOTES.md`:
```markdown
# Decision log

## 2026-09-15
- v1 scope: data + lookup. Run state and route planner are later sub-projects.
- Change detection via allpages `lastrevid`, not `recentchanges`.
- DB shipped as a GitHub Release asset (≈50 MB), not committed. Changelog committed.
- Fandom Infobox Boss lacks resistances; bosses table stores location/hp/runes/drops.
- Quest steps parsed from Fandom "Questline progression" lists.
- Found on day one: Fandom and Fextralife disagree on Graven-School Talisman (+8% vs +4%). Provenance on every answer is why.
```

- [ ] **Step 5: Append revisions to the spec**

Append to the spec file:
```markdown

## Revisions (2026-09-15, during planning)

1. Change detection uses allpages `lastrevid` comparison instead of `recentchanges`.
2. `data/elden-ring.db` is published as a GitHub Release asset, not committed (≈50 MB binary). `npm run fetch-data` downloads it.
3. Provenance is stored on `pages`; typed rows join via `page_id`.
4. The local cache db is queried as a separate handle rather than ATTACHed.
5. `bosses` has no resistances (not in Fandom infobox); `drops` is a text column; no `drops` table.
6. Data license is CC BY-SA 3.0 (Fandom), not 4.0.
```

- [ ] **Step 6: Scaffold test**

`test/scaffold.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RawPage } from '../src/types.js';

test('RawPage type compiles and holds provenance', () => {
  const page: RawPage = { source: 'fandom', title: 'X', url: 'u', revid: 1, fetchedAt: '2026-09-15T00:00:00Z', wikitext: '', markdown: null, license: 'CC BY-SA 3.0' };
  assert.equal(page.source, 'fandom');
});
```

- [ ] **Step 7: Install and run**

Run: `npm install && npm test && npm run typecheck`
Expected: 1 test passes; typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "chore: scaffold elden-ring-mcp, legal docs, spec revisions"
```

---

### Task 2: SQLite schema and `openDb`

**Files:**
- Create: `src/db/schema.sql`, `src/db/open.ts`, `test/helpers.ts`, `test/db.test.ts`

**Interfaces:**
- Produces: `type Db = Database.Database`; `openDb(path: string, opts?: { readonly?: boolean }): Db`; `DERIVED_TABLES: readonly string[]`; test helper `memoryDb(): Db`

- [ ] **Step 1: Write the failing test**

`test/helpers.ts`:
```ts
import { openDb, type Db } from '../src/db/open.js';
export const memoryDb = (): Db => openDb(':memory:');
```

`test/db.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryDb } from './helpers.js';
import { DERIVED_TABLES, openDb } from '../src/db/open.js';

test('schema creates all tables', () => {
  const db = memoryDb();
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as { name: string }[]).map((r) => r.name);
  for (const t of ['pages', 'sections', 'sections_fts', 'redirects', 'sync_state', ...DERIVED_TABLES]) assert.ok(names.includes(t), t);
});

test('fts5 matches stemmed words', () => {
  const db = memoryDb();
  db.prepare('INSERT INTO sections_fts (rowid, title, heading, markdown) VALUES (1, ?, ?, ?)').run('Terra Magica', 'Summary', 'Raises magic damage while standing in the sigil');
  const hit = db.prepare("SELECT rowid FROM sections_fts WHERE sections_fts MATCH 'raise'").get();
  assert.deepEqual(hit, { rowid: 1 });
});

test('openDb twice on the same file does not throw', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'erdb-')), 'x.db');
  openDb(path).close();
  assert.doesNotThrow(() => openDb(path).close());
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL, cannot find module `../src/db/open.js`.

- [ ] **Step 3: `src/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  revid INTEGER,
  fetched_at TEXT NOT NULL,
  license TEXT NOT NULL,
  patch TEXT,
  wikitext TEXT,
  UNIQUE (source, title)
);
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  heading TEXT NOT NULL,
  markdown TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sections_page ON sections (page_id, ord);
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5 (title, heading, markdown, tokenize = 'porter unicode61');
CREATE TABLE IF NOT EXISTS redirects (
  source TEXT NOT NULL,
  from_title TEXT NOT NULL,
  to_title TEXT NOT NULL,
  fragment TEXT,
  PRIMARY KEY (source, from_title)
);
CREATE TABLE IF NOT EXISTS entities (
  page_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (page_id, type)
);
CREATE INDEX IF NOT EXISTS entities_name ON entities (name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS weapons (
  page_id INTEGER PRIMARY KEY, name TEXT NOT NULL, weapon_type TEXT, weight REAL,
  str_req INTEGER, dex_req INTEGER, int_req INTEGER, fai_req INTEGER, arc_req INTEGER,
  str_scale TEXT, dex_scale TEXT, int_scale TEXT, fai_scale TEXT, arc_scale TEXT,
  sorcery_scaling INTEGER, incant_scaling INTEGER, skill TEXT, effects TEXT
);
CREATE TABLE IF NOT EXISTS spells (
  page_id INTEGER PRIMARY KEY, name TEXT NOT NULL, spell_type TEXT, sub_type TEXT,
  fp_cost TEXT, stamina_cost INTEGER, slots_used INTEGER,
  int_req INTEGER, fai_req INTEGER, arc_req INTEGER, effect TEXT
);
CREATE TABLE IF NOT EXISTS talismans (
  page_id INTEGER PRIMARY KEY, name TEXT NOT NULL, weight REAL, effect TEXT, summary TEXT
);
CREATE TABLE IF NOT EXISTS armor (
  page_id INTEGER PRIMARY KEY, name TEXT NOT NULL, slot TEXT, weight REAL, poise REAL, effects TEXT
);
CREATE TABLE IF NOT EXISTS bosses (
  page_id INTEGER PRIMARY KEY, name TEXT NOT NULL, location TEXT, hp TEXT, runes TEXT, drops TEXT
);
CREATE TABLE IF NOT EXISTS acquisition (
  page_id INTEGER PRIMARY KEY, method TEXT NOT NULL, location_text TEXT NOT NULL,
  nearest_grace TEXT, prereqs TEXT NOT NULL DEFAULT '[]', missable INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quests (
  page_id INTEGER NOT NULL, npc TEXT NOT NULL, step_ord INTEGER NOT NULL,
  location TEXT, action TEXT NOT NULL, breaks_quest TEXT,
  PRIMARY KEY (page_id, step_ord)
);
CREATE TABLE IF NOT EXISTS extract_failures (
  page_id INTEGER NOT NULL, extractor TEXT NOT NULL, error TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT PRIMARY KEY, last_run TEXT NOT NULL, pages INTEGER NOT NULL
);
```

- [ ] **Step 4: `src/db/open.ts`**

```ts
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export type Db = Database.Database;

/** Tables whose rows are derived from a page by extractors; all keyed by page_id. */
export const DERIVED_TABLES = ['entities', 'weapons', 'spells', 'talismans', 'armor', 'bosses', 'acquisition', 'quests', 'extract_failures'] as const;

export function openDb(path: string, opts: { readonly?: boolean } = {}): Db {
  const readonly = opts.readonly ?? false;
  if (path !== ':memory:' && !readonly) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { readonly, fileMustExist: readonly });
  if (!readonly) db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS (all db tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(db): sqlite schema with fts5 and openDb"
```

---

### Task 3: Wikitext parsing (infobox, markdown, sections)

**Files:**
- Create: `src/wikitext/infobox.ts`, `src/wikitext/markdown.ts`, `src/wikitext/sections.ts`, `test/fixtures/wikitext.ts`, `test/wikitext.test.ts`

**Interfaces:**
- Produces:
  - `interface Infobox { template: string; params: Record<string, string> }`
  - `findInfobox(wikitext: string, names: string[]): Infobox | null` (param keys lowercased; values raw wikitext)
  - `stripTemplates(text: string): string`
  - `convertInline(text: string): string`
  - `wikitextToMarkdown(wikitext: string): string`
  - `plainText(value: string): string`
  - `interface Section { ord: number; heading: string; markdown: string }`
  - `splitSections(markdown: string): Section[]` (text before the first heading = `"Summary"`)
  - Fixtures: `AZUR_STAFF`, `COMET_AZUR`, `GRAVEN_SCHOOL`, `AZUR_CROWN`, `RED_WOLF`, `SELLEN_QUEST`, `MALFORMED` (strings)

- [ ] **Step 1: Fixtures** (trimmed copies of real Fandom wikitext fetched 2026-09-15)

`test/fixtures/wikitext.ts`:
```ts
export const AZUR_STAFF = `{{Infobox Weapon
| title         = Azur's Glintstone Staff
| japanese  	= アズールの輝石杖<br/>(Azūru no Kisekijō)
| type          = Glintstone Staff
| skills        = [[No Skill]]
| weight        = 4.0
| sorcery_scaling   = 151
| incant_scaling    =
| str_scale     = D
| dex_scale     = -
| int_scale     = B
| fai_scale     = -
| arc_scale     = -
| str_req       = 10
| dex_req       = 0
| int_req       = 52
| fai_req       = 0
| arc_req       = 0
| effects       =
}}
'''Azur's Glintstone Staff''' is a [[Staves|Glintstone Staff]] and [[Weapons|catalyst]] found in {{ER}}.

==Acquisition==
Found in a secluded room on the highest level of the [[Church of the Cuckoo]]. The level can be accessed via the rooftops of the [[Academy of Raya Lucaria]].

From the [[Debate Parlor]] site of grace, go outside to the left until you meet two sorcerers.
`;

export const COMET_AZUR = `{{stub|missing data}}
{{Infobox_Item
| title       = Comet Azur
| type        = Sorcery
| sub_type    = Primeval
| item_effect = Fires a tremendous comet within a starry torrent
| fp_cost     = 40 (10)
| stamina_cost= 34
| slots_used  = 3
| int_req     = 60
| fai_req     = 0
| arc_req     = 0
| obtained    = [[Primeval Sorcerer Azur]]
}}
'''Comet Azur''' is a [[Sorceries|sorcery]] [[Spells|spell]] in {{ER}}.

==Acquisition==
'''Quest Item:''' [[Hermit Village]]
* Comet Azur is obtained by interacting with [[Primeval Sorcerer Azur]], found on the cliffs southeast of the Hermit Village in [[Mt. Gelmir]].
`;

export const GRAVEN_SCHOOL = `{{Infobox_Item
| title       = Graven-School Talisman
| type        = Talisman
| item_effect = Raises potency of sorceries
| weight      = 0.7
| sell_price  = 1,000
}}
'''Graven-School Talisman''' is a [[Talismans|talisman]] in {{ER}}.

Increases damage from sorceries by 8%. Can be stacked with the [[Graven-Mass Talisman]].

== Acquisition ==
* Obtained from a large pile of crystals in [[Raya Lucaria Academy]]. Look for an empty bookshelf on the north side of the room, which is an illusory wall.

{{Navbox Talismans}}
[[ru:Талисман могильной школы]]
`;

export const AZUR_CROWN = `{{Infobox Armor
| type       = head
| title      = Azur's Glintstone Crown
| weight     = 3.6
| effects    = Boosts the potency of [[Comet Azur]] by 15%. Increases {{stat|fp}} [[FP]] consumption by 15%.
| poise      = 4
}}

==Acquisition==
'''Location''': [[Primeval Sorcerer Azur]]
* Obtained upon completing [[Sorceress Sellen]]'s questline, then returning to the spot where [[Azur]] was found.
`;

export const RED_WOLF = `{{Infobox Boss
|title = Red Wolf of Radagon
|location = [[Academy of Raya Lucaria]]
|hp= 2,204
|runes= 14,000
|drops= [[Memory Stone]]
}}
'''{{PAGENAME}}''' is a [[boss]] in {{ER}}.

==Overview==
Giant wolves with red fur.
{| class="article-table"
! Move Name
|-
| Phase
|}
[[Category:Bosses]]
`;

export const SELLEN_QUEST = `{{Infobox Character
| title         = Sorceress Sellen
| location      = [[Waypoint Ruins]] cellar
| type          = [[Merchant]]
}}
'''Sorceress Sellen''' is a [[merchant]] [[NPC]] in {{ER}}.

==Quests==
===Questline progression===
#[[Waypoint Ruins]]
#*Sellen can be found in the cellar after defeating the [[Mad Pumpkin Head]]. Select "I wish to learn glintstone sorceries".
#Waypoint Ruins
#*Find Primeval Sorcerer Azur. Return to Sellen and select "I have a favor to ask" to obtain the Sellian Sealbreaker.
#[[Witchbane Ruins]]
#*After Starscourge Radahn has been defeated, speak to the shackled Sellen.
#*Attacking Sellen here will fail the questline.

==Notes==
* Killing Preceptor Seluvis early locks you out of the puppet step.
`;

export const MALFORMED = `{{Infobox Weapon
| title = Broken Page
| int_req = 12
`;
```

- [ ] **Step 2: Failing tests**

`test/wikitext.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInfobox } from '../src/wikitext/infobox.js';
import { plainText, wikitextToMarkdown } from '../src/wikitext/markdown.js';
import { splitSections } from '../src/wikitext/sections.js';
import { AZUR_STAFF, COMET_AZUR, GRAVEN_SCHOOL, MALFORMED, RED_WOLF, SELLEN_QUEST } from './fixtures/wikitext.js';

test('findInfobox reads params with spaces/underscores in the template name', () => {
  const box = findInfobox(COMET_AZUR, ['Infobox Item']);
  assert.equal(box?.params.title, 'Comet Azur');
  assert.equal(box?.params.int_req, '60');
  assert.equal(box?.params.obtained, '[[Primeval Sorcerer Azur]]');
});

test('findInfobox keeps pipes inside links', () => {
  const box = findInfobox(AZUR_STAFF, ['Infobox Weapon']);
  assert.equal(box?.params.skills, '[[No Skill]]');
  assert.equal(box?.params.int_scale, 'B');
});

test('findInfobox returns null for missing or unclosed templates', () => {
  assert.equal(findInfobox(AZUR_STAFF, ['Infobox Boss']), null);
  assert.equal(findInfobox(MALFORMED, ['Infobox Weapon']), null);
});

test('wikitextToMarkdown strips templates, tables, categories and converts links/bold/headings/lists', () => {
  const md = wikitextToMarkdown(RED_WOLF);
  assert.ok(!md.includes('{{'));
  assert.ok(!md.includes('article-table'));
  assert.ok(!md.includes('Category'));
  assert.match(md, /## Overview/);
  const graven = wikitextToMarkdown(GRAVEN_SCHOOL);
  assert.match(graven, /\*\*Graven-School Talisman\*\* is a talisman in/);
  assert.match(graven, /- Obtained from a large pile of crystals in Raya Lucaria Academy/);
  assert.ok(!graven.includes('ru:'));
});

test('numbered lists with nested bullets', () => {
  const md = wikitextToMarkdown(SELLEN_QUEST);
  assert.match(md, /^1\. Waypoint Ruins$/m);
  assert.match(md, /^ {2}- Sellen can be found in the cellar/m);
});

test('plainText flattens inline markup', () => {
  assert.equal(plainText("Boosts [[Comet Azur]] by 15%. Increases {{stat|fp}} [[FP]] consumption"), 'Boosts Comet Azur by 15%. Increases FP consumption');
});

test('splitSections names the lead "Summary" and keeps heading order', () => {
  const sections = splitSections(wikitextToMarkdown(AZUR_STAFF));
  assert.deepEqual(sections.map((s) => s.heading), ['Summary', 'Acquisition']);
  assert.match(sections[1].markdown, /Debate Parlor site of grace/);
  assert.deepEqual(sections.map((s) => s.ord), [0, 1]);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test`
Expected: FAIL, modules not found.

- [ ] **Step 4: `src/wikitext/infobox.ts`**

```ts
export interface Infobox {
  template: string;
  params: Record<string, string>;
}

/** Exclusive end index of the template opening at `start` ("{{"), or -1 if unclosed. */
function closeOf(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') { depth++; i++; }
    else if (text[i] === '}' && text[i + 1] === '}') { depth--; i++; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Splits template body on "|" outside [[...]] and {{...}}. */
function splitParams(body: string): string[] {
  const parts: string[] = [];
  let square = 0;
  let curly = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '[[' || two === ']]' || two === '{{' || two === '}}') {
      if (two === '[[') square++;
      if (two === ']]') square = Math.max(0, square - 1);
      if (two === '{{') curly++;
      if (two === '}}') curly = Math.max(0, curly - 1);
      current += two;
      i++;
      continue;
    }
    if (body[i] === '|' && square === 0 && curly === 0) { parts.push(current); current = ''; continue; }
    current += body[i];
  }
  parts.push(current);
  return parts;
}

const normalizeName = (name: string) => name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** First template on the page whose name is one of `names` (case/underscore-insensitive). */
export function findInfobox(wikitext: string, names: string[]): Infobox | null {
  const wanted = new Set(names.map(normalizeName));
  const text = wikitext.replace(/<!--[\s\S]*?-->/g, '');
  const opener = /\{\{\s*([^|}\n]+)/g;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    if (!wanted.has(normalizeName(match[1]))) continue;
    const end = closeOf(text, match.index);
    if (end < 0) return null;
    const [, ...rawParams] = splitParams(text.slice(match.index + 2, end - 2));
    const params: Record<string, string> = {};
    for (const raw of rawParams) {
      const eq = raw.indexOf('=');
      if (eq >= 0) params[raw.slice(0, eq).trim().toLowerCase()] = raw.slice(eq + 1).trim();
    }
    return { template: match[1].trim(), params };
  }
  return null;
}
```

- [ ] **Step 5: `src/wikitext/markdown.ts`**

```ts
/** Removes every {{...}} template, including nested ones. */
export function stripTemplates(text: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === '{{') { depth++; i++; continue; }
    if (two === '}}' && depth > 0) { depth--; i++; continue; }
    if (depth === 0) out += text[i];
  }
  return out;
}

/** Removes {| ... |} tables line by line (nesting-aware). */
function stripTables(text: string): string {
  let depth = 0;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('{|')) { depth++; continue; }
    if (trimmed.startsWith('|}') && depth > 0) { depth--; continue; }
    if (depth === 0) kept.push(line);
  }
  return kept.join('\n');
}

export function convertInline(text: string): string {
  return text
    .replace(/\[\[(?:File|Image|Category|[a-z]{2,3}(?:-[a-z]+)?):[^\]]*\]\]/gi, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')
    .replace(/'''(.*?)'''/g, '**$1**')
    .replace(/''(.*?)''/g, '*$1*')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:small|span|div|center|big|sup|sub|u|s|nowiki|p)\b[^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ');
}

export function wikitextToMarkdown(wikitext: string): string {
  let text = wikitext.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  text = text.replace(/<gallery[\s\S]*?<\/gallery>/gi, '');
  text = convertInline(stripTables(stripTemplates(text)));
  const lines = text.split('\n').map((line) => {
    const heading = /^(={2,6})\s*(.*?)\s*\1\s*$/.exec(line);
    if (heading) return `${'#'.repeat(heading[1].length)} ${heading[2]}`;
    const list = /^([*#]+)\s*(.*)$/.exec(line);
    if (list) return `${'  '.repeat(list[1].length - 1)}${list[1].endsWith('#') ? '1.' : '-'} ${list[2].trim()}`;
    return line.trimEnd();
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Single-line plain text for infobox values. */
export function plainText(value: string): string {
  return convertInline(stripTemplates(value.replace(/<!--[\s\S]*?-->/g, '')))
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
```

- [ ] **Step 6: `src/wikitext/sections.ts`**

```ts
export interface Section {
  ord: number;
  heading: string;
  markdown: string;
}

/** Splits markdown on headings; empty sections are dropped; lead text is "Summary". */
export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let heading = 'Summary';
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) sections.push({ ord: sections.length, heading, markdown: body });
    buffer = [];
  };
  for (const line of markdown.split('\n')) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match) { flush(); heading = match[1].trim(); continue; }
    buffer.push(line);
  }
  flush();
  return sections;
}
```

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: PASS. If the nested-list test fails, check `list[1].length - 1` indentation (2 spaces per extra level).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(wikitext): infobox parser, wikitext to markdown, section splitter"
```

---

### Task 4: HTTP client and Fandom adapter

**Files:**
- Create: `src/sources/http.ts`, `src/sources/fandom.ts`, `test/fandom.test.ts`

**Interfaces:**
- Consumes: `RawPage` (Task 1)
- Produces:
  - `type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>`
  - `class HttpError extends Error { status: number; url: string }`
  - `createHttp(opts: { userAgent: string; minIntervalMs?: number; retries?: number; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> }): (url: string) => Promise<string>`
  - `USER_AGENT`, `FANDOM_API`, `FANDOM_LICENSE = 'CC BY-SA 3.0 (eldenring.fandom.com)'`, `fandomUrl(title: string): string`
  - `createFandom(opts?: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; minIntervalMs?: number; now?: () => Date })` returning `{ listRevisions(): AsyncGenerator<{title: string; revid: number}>; listRedirects(): AsyncGenerator<{from: string; to: string; fragment: string | null}>; fetchPages(titles: string[]): Promise<RawPage[]> }`
  - `type Fandom = ReturnType<typeof createFandom>`

- [ ] **Step 1: Failing tests**

`test/fandom.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttp, HttpError, type FetchLike } from '../src/sources/http.js';
import { createFandom } from '../src/sources/fandom.js';

const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const noSleep = async () => {};

test('http retries 429 honoring Retry-After, then succeeds', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const fetchImpl: FetchLike = async () => (++calls === 1 ? response(429, '', { 'retry-after': '2' }) : response(200, 'ok'));
  const get = createHttp({ userAgent: 'ua', minIntervalMs: 0, fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(await get('https://x'), 'ok');
  assert.equal(calls, 2);
  assert.ok(sleeps.includes(2000));
});

test('http gives up after retries and does not retry 404', async () => {
  const get500 = createHttp({ userAgent: 'ua', minIntervalMs: 0, retries: 2, sleep: noSleep, fetchImpl: async () => response(503, '') });
  await assert.rejects(get500('https://x'), HttpError);
  let calls = 0;
  const get404 = createHttp({ userAgent: 'ua', minIntervalMs: 0, sleep: noSleep, fetchImpl: async () => { calls++; return response(404, ''); } });
  await assert.rejects(get404('https://x'), HttpError);
  assert.equal(calls, 1);
});

test('http retries thrown network errors', async () => {
  let calls = 0;
  const get = createHttp({ userAgent: 'ua', minIntervalMs: 0, sleep: noSleep, fetchImpl: async () => { if (++calls < 3) throw new Error('ECONNRESET'); return response(200, 'ok'); } });
  assert.equal(await get('https://x'), 'ok');
});

test('listRevisions follows continuation', async () => {
  const fetchImpl: FetchLike = async (url) => {
    const params = new URL(url).searchParams;
    if (!params.get('gapcontinue')) return response(200, { continue: { gapcontinue: 'B', continue: 'gapcontinue||' }, query: { pages: [{ title: 'A', lastrevid: 1 }] } });
    return response(200, { query: { pages: [{ title: 'B', lastrevid: 2 }] } });
  };
  const fandom = createFandom({ fetchImpl, sleep: noSleep, minIntervalMs: 0 });
  const seen = [];
  for await (const row of fandom.listRevisions()) seen.push(row);
  assert.deepEqual(seen, [{ title: 'A', revid: 1 }, { title: 'B', revid: 2 }]);
});

test('fetchPages batches by 50 and builds RawPage with provenance', async () => {
  const batches: number[] = [];
  const fetchImpl: FetchLike = async (url) => {
    const titles = new URL(url).searchParams.get('titles')!.split('|');
    batches.push(titles.length);
    return response(200, { query: { pages: titles.map((title) => (title === 'Gone' ? { title, missing: true } : { title, revisions: [{ revid: 7, slots: { main: { content: `text of ${title}` } } }] })) } });
  };
  const fandom = createFandom({ fetchImpl, sleep: noSleep, minIntervalMs: 0, now: () => new Date('2026-09-15T00:00:00Z') });
  const titles = [...Array.from({ length: 60 }, (_, i) => `P${i}`), 'Gone'];
  const pages = await fandom.fetchPages(titles);
  assert.deepEqual(batches, [50, 11]);
  assert.equal(pages.length, 60);
  assert.deepEqual(pages[0], { source: 'fandom', title: 'P0', url: 'https://eldenring.fandom.com/wiki/P0', revid: 7, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext: 'text of P0', markdown: null, license: 'CC BY-SA 3.0 (eldenring.fandom.com)' });
});

test('listRedirects yields from/to/fragment', async () => {
  const fetchImpl: FetchLike = async () => response(200, { query: { redirects: [{ from: 'Magma Wyrm Makar', to: 'Magma Wyrm', tofragment: 'Bosses' }] } });
  const fandom = createFandom({ fetchImpl, sleep: noSleep, minIntervalMs: 0 });
  const rows = [];
  for await (const row of fandom.listRedirects()) rows.push(row);
  assert.deepEqual(rows, [{ from: 'Magma Wyrm Makar', to: 'Magma Wyrm', fragment: 'Bosses' }]);
});

test('MediaWiki error payload throws', async () => {
  const fandom = createFandom({ fetchImpl: async () => response(200, { error: { code: 'badvalue', info: 'nope' } }), sleep: noSleep, minIntervalMs: 0 });
  await assert.rejects(fandom.fetchPages(['X']), /MediaWiki badvalue: nope/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL, modules not found.

- [ ] **Step 3: `src/sources/http.ts`**

```ts
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

export interface HttpOptions {
  userAgent: string;
  minIntervalMs?: number;
  retries?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

/** GET-as-text with a per-client minimum interval and retries for 429, 5xx and network errors. */
export function createHttp(opts: HttpOptions): (url: string) => Promise<string> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const minInterval = opts.minIntervalMs ?? 1000;
  const retries = opts.retries ?? 3;
  let lastRequest = 0;

  return async function getText(url: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequest + minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequest = Date.now();
      let res;
      try {
        res = await fetchImpl(url, { headers: { 'User-Agent': opts.userAgent } });
      } catch (error) {
        if (attempt >= retries) throw error;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 200) return res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) throw new HttpError(res.status, url);
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    }
  };
}
```

- [ ] **Step 4: `src/sources/fandom.ts`**

```ts
import type { RawPage } from '../types.js';
import { createHttp, type FetchLike } from './http.js';

export const USER_AGENT = 'elden-ring-mcp/0.1 (open-source MCP data sync)';
export const FANDOM_API = 'https://eldenring.fandom.com/api.php';
export const FANDOM_LICENSE = 'CC BY-SA 3.0 (eldenring.fandom.com)';

export const fandomUrl = (title: string) => `https://eldenring.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

export interface FandomOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  now?: () => Date;
}

// MediaWiki JSON is loosely typed; only the fields read below are relied on.
type Json = any;

export function createFandom(opts: FandomOptions = {}) {
  const getText = createHttp({ userAgent: USER_AGENT, fetchImpl: opts.fetchImpl, sleep: opts.sleep, minIntervalMs: opts.minIntervalMs });
  const now = opts.now ?? (() => new Date());

  async function api(params: Record<string, string>): Promise<Json> {
    const query = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
    const json = JSON.parse(await getText(`${FANDOM_API}?${query}`));
    if (json.error) throw new Error(`MediaWiki ${json.error.code}: ${json.error.info}`);
    return json;
  }

  async function* paged(params: Record<string, string>): AsyncGenerator<Json> {
    let cont: Record<string, string> = {};
    for (;;) {
      const json = await api({ ...params, ...cont });
      yield json;
      if (!json.continue) return;
      cont = json.continue;
    }
  }

  return {
    async *listRevisions(): AsyncGenerator<{ title: string; revid: number }> {
      for await (const json of paged({ action: 'query', generator: 'allpages', gapnamespace: '0', gaplimit: '500', gapfilterredir: 'nonredirects', prop: 'info' })) {
        for (const page of json.query?.pages ?? []) yield { title: page.title, revid: page.lastrevid };
      }
    },

    async *listRedirects(): AsyncGenerator<{ from: string; to: string; fragment: string | null }> {
      for await (const json of paged({ action: 'query', generator: 'allpages', gapnamespace: '0', gaplimit: '50', gapfilterredir: 'redirects', redirects: '1' })) {
        for (const r of json.query?.redirects ?? []) yield { from: r.from, to: r.to, fragment: r.tofragment ?? null };
      }
    },

    async fetchPages(titles: string[]): Promise<RawPage[]> {
      const pages: RawPage[] = [];
      for (let i = 0; i < titles.length; i += 50) {
        const json = await api({ action: 'query', prop: 'revisions', rvprop: 'ids|content', rvslots: 'main', titles: titles.slice(i, i + 50).join('|') });
        for (const page of json.query?.pages ?? []) {
          if (page.missing || !page.revisions?.length) continue;
          const revision = page.revisions[0];
          pages.push({
            source: 'fandom', title: page.title, url: fandomUrl(page.title), revid: revision.revid,
            fetchedAt: now().toISOString(), wikitext: revision.slots.main.content, markdown: null, license: FANDOM_LICENSE,
          });
        }
      }
      return pages;
    },
  };
}

export type Fandom = ReturnType<typeof createFandom>;
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(sources): rate-limited http client and Fandom MediaWiki adapter"
```

---

### Task 5: Page store and incremental Fandom sync

**Files:**
- Create: `src/store/pages.ts`, `src/sync.ts`, `scripts/sync.ts`, `test/sync.test.ts`

**Interfaces:**
- Consumes: `Db`, `DERIVED_TABLES` (Task 2); `wikitextToMarkdown`, `splitSections` (Task 3); `RawPage` (Task 1); `Fandom` shape (Task 4)
- Produces:
  - `upsertPage(db: Db, page: RawPage): number` (returns page id; rewrites sections + FTS)
  - `clearDerived(db: Db, pageId: number): void`
  - `deletePage(db: Db, source: SourceId, title: string): void`
  - `storedRevids(db: Db, source: SourceId): Map<string, number | null>`
  - `replaceRedirects(db: Db, source: SourceId, rows: { from: string; to: string; fragment: string | null }[]): void`
  - `recordSync(db: Db, source: SourceId, pages: number, at?: Date): void`
  - `interface SyncReport { added: string[]; changed: string[]; removed: string[]; unchanged: number }`
  - `syncFandom(db: Db, fandom: Pick<Fandom, 'listRevisions' | 'listRedirects' | 'fetchPages'>, log?: (message: string) => void): Promise<SyncReport>`
  - `DEFAULT_DB_PATH = 'data/elden-ring.db'` exported from `src/store/pages.ts`

- [ ] **Step 1: Failing tests**

`test/sync.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { upsertPage, storedRevids, deletePage } from '../src/store/pages.js';
import { syncFandom } from '../src/sync.js';
import type { RawPage } from '../src/types.js';
import { AZUR_STAFF, GRAVEN_SCHOOL } from './fixtures/wikitext.js';

const page = (title: string, revid: number, wikitext: string): RawPage => ({
  source: 'fandom', title, url: `https://eldenring.fandom.com/wiki/${title}`, revid, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext, markdown: null, license: 'CC BY-SA 3.0 (eldenring.fandom.com)',
});

function fakeFandom(wiki: Map<string, { revid: number; text: string }>) {
  const fetched: string[] = [];
  return {
    fetched,
    async *listRevisions() { for (const [title, p] of wiki) yield { title, revid: p.revid }; },
    async *listRedirects() { yield { from: 'Azur Staff', to: "Azur's Glintstone Staff", fragment: null }; },
    async fetchPages(titles: string[]) { fetched.push(...titles); return titles.map((t) => page(t, wiki.get(t)!.revid, wiki.get(t)!.text)); },
  };
}

test('upsertPage writes sections and FTS, and re-upsert replaces them', () => {
  const db = memoryDb();
  const id = upsertPage(db, page("Azur's Glintstone Staff", 1, AZUR_STAFF));
  const headings = (db.prepare('SELECT heading FROM sections WHERE page_id=? ORDER BY ord').all(id) as { heading: string }[]).map((r) => r.heading);
  assert.deepEqual(headings, ['Summary', 'Acquisition']);
  upsertPage(db, page("Azur's Glintstone Staff", 2, AZUR_STAFF));
  assert.equal((db.prepare('SELECT count(*) AS n FROM sections').get() as { n: number }).n, 2);
  assert.equal((db.prepare('SELECT count(*) AS n FROM sections_fts').get() as { n: number }).n, 2);
  const hit = db.prepare("SELECT title FROM sections_fts WHERE sections_fts MATCH 'cuckoo'").get();
  assert.deepEqual(hit, { title: "Azur's Glintstone Staff" });
});

test('deletePage removes page, sections, fts and derived rows', () => {
  const db = memoryDb();
  const id = upsertPage(db, page('X', 1, GRAVEN_SCHOOL));
  db.prepare("INSERT INTO entities (page_id, type, name) VALUES (?, 'talisman', 'X')").run(id);
  deletePage(db, 'fandom', 'X');
  for (const table of ['pages', 'sections', 'sections_fts', 'entities']) {
    assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  }
});

test('sync fetches new and changed pages only, removes vanished, stores redirects', async () => {
  const db = memoryDb();
  const wiki = new Map([["Azur's Glintstone Staff", { revid: 1, text: AZUR_STAFF }], ['Graven-School Talisman', { revid: 5, text: GRAVEN_SCHOOL }]]);
  const first = fakeFandom(wiki);
  const r1 = await syncFandom(db, first);
  assert.equal(r1.added.length, 2);
  assert.equal(first.fetched.length, 2);

  const second = fakeFandom(wiki);
  const r2 = await syncFandom(db, second);
  assert.deepEqual([r2.added, r2.changed, r2.removed, r2.unchanged], [[], [], [], 2]);
  assert.equal(second.fetched.length, 0);

  wiki.set('Graven-School Talisman', { revid: 6, text: GRAVEN_SCHOOL });
  wiki.delete("Azur's Glintstone Staff");
  const third = fakeFandom(wiki);
  const r3 = await syncFandom(db, third);
  assert.deepEqual(r3.changed, ['Graven-School Talisman']);
  assert.deepEqual(r3.removed, ["Azur's Glintstone Staff"]);
  assert.deepEqual([...storedRevids(db, 'fandom')], [['Graven-School Talisman', 6]]);
  assert.deepEqual(db.prepare('SELECT from_title, to_title FROM redirects').all(), [{ from_title: 'Azur Staff', to_title: "Azur's Glintstone Staff" }]);
  assert.equal((db.prepare("SELECT pages FROM sync_state WHERE source='fandom'").get() as { pages: number }).pages, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL, modules not found.

- [ ] **Step 3: `src/store/pages.ts`**

```ts
import { DERIVED_TABLES, type Db } from '../db/open.js';
import type { RawPage, SourceId } from '../types.js';
import { wikitextToMarkdown } from '../wikitext/markdown.js';
import { splitSections } from '../wikitext/sections.js';

export const DEFAULT_DB_PATH = 'data/elden-ring.db';

function clearSections(db: Db, pageId: number): void {
  db.prepare('DELETE FROM sections_fts WHERE rowid IN (SELECT id FROM sections WHERE page_id = ?)').run(pageId);
  db.prepare('DELETE FROM sections WHERE page_id = ?').run(pageId);
}

export function clearDerived(db: Db, pageId: number): void {
  for (const table of DERIVED_TABLES) db.prepare(`DELETE FROM ${table} WHERE page_id = ?`).run(pageId);
}

export function upsertPage(db: Db, page: RawPage): number {
  const markdown = page.markdown ?? wikitextToMarkdown(page.wikitext ?? '');
  return db.transaction(() => {
    db.prepare(`
      INSERT INTO pages (source, title, url, revid, fetched_at, license, wikitext)
      VALUES (@source, @title, @url, @revid, @fetchedAt, @license, @wikitext)
      ON CONFLICT (source, title) DO UPDATE SET
        url = excluded.url, revid = excluded.revid, fetched_at = excluded.fetched_at,
        license = excluded.license, wikitext = excluded.wikitext
    `).run({ source: page.source, title: page.title, url: page.url, revid: page.revid, fetchedAt: page.fetchedAt, license: page.license, wikitext: page.wikitext });
    const { id } = db.prepare('SELECT id FROM pages WHERE source = ? AND title = ?').get(page.source, page.title) as { id: number };
    clearSections(db, id);
    const insertSection = db.prepare('INSERT INTO sections (page_id, ord, heading, markdown) VALUES (?, ?, ?, ?)');
    const insertFts = db.prepare('INSERT INTO sections_fts (rowid, title, heading, markdown) VALUES (?, ?, ?, ?)');
    for (const section of splitSections(markdown)) {
      const { lastInsertRowid } = insertSection.run(id, section.ord, section.heading, section.markdown);
      insertFts.run(lastInsertRowid, page.title, section.heading, section.markdown);
    }
    return id;
  })();
}

export function deletePage(db: Db, source: SourceId, title: string): void {
  const row = db.prepare('SELECT id FROM pages WHERE source = ? AND title = ?').get(source, title) as { id: number } | undefined;
  if (!row) return;
  db.transaction(() => {
    clearSections(db, row.id);
    clearDerived(db, row.id);
    db.prepare('DELETE FROM pages WHERE id = ?').run(row.id);
  })();
}

export function storedRevids(db: Db, source: SourceId): Map<string, number | null> {
  const rows = db.prepare('SELECT title, revid FROM pages WHERE source = ? ORDER BY title').all(source) as { title: string; revid: number | null }[];
  return new Map(rows.map((r) => [r.title, r.revid]));
}

export function replaceRedirects(db: Db, source: SourceId, rows: { from: string; to: string; fragment: string | null }[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM redirects WHERE source = ?').run(source);
    const insert = db.prepare('INSERT OR REPLACE INTO redirects (source, from_title, to_title, fragment) VALUES (?, ?, ?, ?)');
    for (const r of rows) insert.run(source, r.from, r.to, r.fragment);
  })();
}

export function recordSync(db: Db, source: SourceId, pages: number, at = new Date()): void {
  db.prepare('INSERT INTO sync_state (source, last_run, pages) VALUES (?, ?, ?) ON CONFLICT (source) DO UPDATE SET last_run = excluded.last_run, pages = excluded.pages')
    .run(source, at.toISOString(), pages);
}
```

- [ ] **Step 4: `src/sync.ts`**

```ts
import type { Db } from './db/open.js';
import type { Fandom } from './sources/fandom.js';
import { deletePage, recordSync, replaceRedirects, storedRevids, upsertPage } from './store/pages.js';

export interface SyncReport {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: number;
}

/** Brings the db in line with Fandom: fetches only new/changed revisions, drops deleted pages, refreshes redirects. */
export async function syncFandom(
  db: Db,
  fandom: Pick<Fandom, 'listRevisions' | 'listRedirects' | 'fetchPages'>,
  log: (message: string) => void = () => {},
): Promise<SyncReport> {
  const stored = storedRevids(db, 'fandom');
  const seen = new Set<string>();
  const added: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;

  for await (const { title, revid } of fandom.listRevisions()) {
    seen.add(title);
    const previous = stored.get(title);
    if (previous === undefined) added.push(title);
    else if (previous !== revid) changed.push(title);
    else unchanged++;
  }
  log(`revisions: ${added.length} new, ${changed.length} changed, ${unchanged} unchanged`);

  const toFetch = [...added, ...changed];
  for (let i = 0; i < toFetch.length; i += 50) {
    const pages = await fandom.fetchPages(toFetch.slice(i, i + 50));
    db.transaction(() => { for (const page of pages) upsertPage(db, page); })();
    log(`fetched ${Math.min(i + 50, toFetch.length)}/${toFetch.length}`);
  }

  const removed = [...stored.keys()].filter((title) => !seen.has(title));
  for (const title of removed) deletePage(db, 'fandom', title);

  const redirects: { from: string; to: string; fragment: string | null }[] = [];
  for await (const redirect of fandom.listRedirects()) redirects.push(redirect);
  replaceRedirects(db, 'fandom', redirects);
  log(`redirects: ${redirects.length}`);

  recordSync(db, 'fandom', seen.size);
  return { added, changed, removed, unchanged };
}
```

- [ ] **Step 5: `scripts/sync.ts`**

```ts
// Pulls new/changed Fandom pages into data/elden-ring.db. Safe to re-run; unchanged pages are not fetched.
// Run: npm run sync
import { openDb } from '../src/db/open.js';
import { createFandom } from '../src/sources/fandom.js';
import { DEFAULT_DB_PATH } from '../src/store/pages.js';
import { syncFandom } from '../src/sync.js';

const db = openDb(process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH);
const report = await syncFandom(db, createFandom(), (message) => console.log(message));
console.log(JSON.stringify({ added: report.added.length, changed: report.changed.length, removed: report.removed.length, unchanged: report.unchanged }));
db.close();
```

- [ ] **Step 6: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(sync): page store with fts and incremental Fandom sync"
```

---

### Task 6: Infobox extractors (weapon, spell, talisman, armor, boss) and runner

**Files:**
- Create: `src/extract/types.ts`, `src/extract/common.ts`, `src/extract/weapon.ts`, `src/extract/spell.ts`, `src/extract/talisman.ts`, `src/extract/armor.ts`, `src/extract/boss.ts`, `src/extract/registry.ts`, `src/extract/run.ts`, `test/extract.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 2); `findInfobox`, `plainText` (Task 3); `upsertPage`, `clearDerived` (Task 5)
- Produces:
  - `interface PageRow { id: number; source: string; title: string; wikitext: string | null }`
  - `interface Extractor { name: string; matches(page: PageRow): boolean; write(db: Db, page: PageRow): void }`
  - `num(value?: string): number | null`, `text(value?: string): string | null`, `scale(value?: string): string | null`, `SCALING_ORDER = ['E','D','C','B','A','S']`, `addEntity(db, pageId, type, name)`, `sectionMarkdown(db, pageId, heading: RegExp): string | null`
  - `EXTRACTORS: Extractor[]` (registry; Task 7 appends acquisition + quest)
  - `interface ExtractReport { pages: number; rows: Record<string, number>; failures: { title: string; extractor: string; error: string }[] }`
  - `runExtractors(db: Db, opts?: { pageIds?: number[]; extractors?: Extractor[]; now?: () => Date }): ExtractReport`

- [ ] **Step 1: Failing tests**

`test/extract.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { upsertPage } from '../src/store/pages.js';
import { runExtractors } from '../src/extract/run.js';
import type { RawPage } from '../src/types.js';
import { AZUR_CROWN, AZUR_STAFF, COMET_AZUR, GRAVEN_SCHOOL, MALFORMED, RED_WOLF, SELLEN_QUEST } from './fixtures/wikitext.js';

const page = (title: string, wikitext: string): RawPage => ({
  source: 'fandom', title, url: `https://eldenring.fandom.com/wiki/${title}`, revid: 1, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext, markdown: null, license: 'CC BY-SA 3.0 (eldenring.fandom.com)',
});

function seeded() {
  const db = memoryDb();
  for (const [title, text] of [["Azur's Glintstone Staff", AZUR_STAFF], ['Comet Azur', COMET_AZUR], ['Graven-School Talisman', GRAVEN_SCHOOL], ["Azur's Glintstone Crown", AZUR_CROWN], ['Red Wolf of Radagon', RED_WOLF], ['Sorceress Sellen', SELLEN_QUEST], ['Broken Page', MALFORMED]] as const) {
    upsertPage(db, page(title, text));
  }
  return db;
}

test('weapon row with requirements and scaling', () => {
  const db = seeded();
  runExtractors(db);
  assert.deepEqual(db.prepare('SELECT name, weapon_type, weight, str_req, int_req, int_scale, str_scale, dex_scale, sorcery_scaling, skill FROM weapons').get(), {
    name: "Azur's Glintstone Staff", weapon_type: 'Glintstone Staff', weight: 4, str_req: 10, int_req: 52, int_scale: 'B', str_scale: 'D', dex_scale: null, sorcery_scaling: 151, skill: 'No Skill',
  });
});

test('spell, talisman, armor, boss rows', () => {
  const db = seeded();
  runExtractors(db);
  assert.deepEqual(db.prepare('SELECT name, spell_type, sub_type, fp_cost, stamina_cost, slots_used, int_req FROM spells').get(), { name: 'Comet Azur', spell_type: 'Sorcery', sub_type: 'Primeval', fp_cost: '40 (10)', stamina_cost: 34, slots_used: 3, int_req: 60 });
  const talisman = db.prepare('SELECT name, weight, effect, summary FROM talismans').get() as Record<string, unknown>;
  assert.equal(talisman.effect, 'Raises potency of sorceries');
  assert.match(String(talisman.summary), /Increases damage from sorceries by 8%/);
  assert.deepEqual(db.prepare('SELECT name, slot, weight, poise, effects FROM armor').get(), { name: "Azur's Glintstone Crown", slot: 'head', weight: 3.6, poise: 4, effects: 'Boosts the potency of Comet Azur by 15%. Increases FP consumption by 15%.' });
  assert.deepEqual(db.prepare('SELECT name, location, hp, runes, drops FROM bosses').get(), { name: 'Red Wolf of Radagon', location: 'Academy of Raya Lucaria', hp: '2,204', runes: '14,000', drops: 'Memory Stone' });
});

test('entities registered per typed row', () => {
  const db = seeded();
  runExtractors(db);
  const types = (db.prepare('SELECT type FROM entities ORDER BY type').all() as { type: string }[]).map((r) => r.type);
  assert.deepEqual(types, ['armor', 'boss', 'spell', 'talisman', 'weapon']);
});

test('non-matching and malformed pages produce no rows and no crash', () => {
  const db = seeded();
  const report = runExtractors(db);
  assert.equal(report.pages, 7);
  assert.equal((db.prepare("SELECT count(*) AS n FROM weapons WHERE name = 'Broken Page'").get() as { n: number }).n, 0);
});

test('extractor that throws is logged to extract_failures and the run continues', () => {
  const db = seeded();
  const boom = { name: 'boom', matches: () => true, write: () => { throw new Error('bad infobox'); } };
  const report = runExtractors(db, { extractors: [boom], now: () => new Date('2026-09-15T00:00:00Z') });
  assert.equal(report.failures.length, 7);
  assert.equal((db.prepare('SELECT count(*) AS n FROM extract_failures').get() as { n: number }).n, 7);
});

test('re-running replaces rows instead of duplicating', () => {
  const db = seeded();
  runExtractors(db);
  runExtractors(db);
  assert.equal((db.prepare('SELECT count(*) AS n FROM weapons').get() as { n: number }).n, 1);
});

test('pageIds limits the run', () => {
  const db = seeded();
  const id = (db.prepare("SELECT id FROM pages WHERE title = 'Comet Azur'").get() as { id: number }).id;
  const report = runExtractors(db, { pageIds: [id] });
  assert.equal(report.pages, 1);
  assert.equal((db.prepare('SELECT count(*) AS n FROM weapons').get() as { n: number }).n, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL, modules not found.

- [ ] **Step 3: `src/extract/types.ts` and `src/extract/common.ts`**

```ts
// src/extract/types.ts
import type { Db } from '../db/open.js';

export interface PageRow {
  id: number;
  source: string;
  title: string;
  wikitext: string | null;
}

export interface Extractor {
  name: string;
  matches(page: PageRow): boolean;
  /** Writes this extractor's rows for the page; prior derived rows are already cleared. Throws on unparseable input. */
  write(db: Db, page: PageRow): void;
}
```

```ts
// src/extract/common.ts
import type { Db } from '../db/open.js';
import { plainText } from '../wikitext/markdown.js';

export const SCALING_ORDER = ['E', 'D', 'C', 'B', 'A', 'S'] as const;

export function text(value?: string): string | null {
  if (!value) return null;
  const plain = plainText(value);
  return plain && plain !== '-' ? plain : null;
}

export function num(value?: string): number | null {
  const plain = text(value);
  const match = plain ? /-?\d[\d,]*(?:\.\d+)?/.exec(plain) : null;
  return match ? Number(match[0].replace(/,/g, '')) : null;
}

export function scale(value?: string): string | null {
  const letter = text(value)?.toUpperCase();
  return letter && (SCALING_ORDER as readonly string[]).includes(letter) ? letter : null;
}

export function addEntity(db: Db, pageId: number, type: string, name: string): void {
  db.prepare('INSERT OR REPLACE INTO entities (page_id, type, name) VALUES (?, ?, ?)').run(pageId, type, name);
}

export function sectionMarkdown(db: Db, pageId: number, heading: RegExp): string | null {
  const rows = db.prepare('SELECT heading, markdown FROM sections WHERE page_id = ? ORDER BY ord').all(pageId) as { heading: string; markdown: string }[];
  return rows.find((row) => heading.test(row.heading))?.markdown ?? null;
}
```

- [ ] **Step 4: Typed extractors**

```ts
// src/extract/weapon.ts
import { findInfobox } from '../wikitext/infobox.js';
import { addEntity, num, scale, text } from './common.js';
import type { Extractor } from './types.js';

const NAMES = ['Infobox Weapon'];

export const weaponExtractor: Extractor = {
  name: 'weapon',
  matches: (page) => !!page.wikitext && findInfobox(page.wikitext, NAMES) !== null,
  write(db, page) {
    const f = findInfobox(page.wikitext!, NAMES)!.params;
    const name = text(f.title) ?? page.title;
    db.prepare(`INSERT INTO weapons (page_id, name, weapon_type, weight, str_req, dex_req, int_req, fai_req, arc_req,
      str_scale, dex_scale, int_scale, fai_scale, arc_scale, sorcery_scaling, incant_scaling, skill, effects)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      page.id, name, text(f.type), num(f.weight), num(f.str_req), num(f.dex_req), num(f.int_req), num(f.fai_req), num(f.arc_req),
      scale(f.str_scale), scale(f.dex_scale), scale(f.int_scale), scale(f.fai_scale), scale(f.arc_scale),
      num(f.sorcery_scaling), num(f.incant_scaling), text(f.skills), text(f.effects),
    );
    addEntity(db, page.id, 'weapon', name);
  },
};
```

```ts
// src/extract/spell.ts
import { findInfobox, type Infobox } from '../wikitext/infobox.js';
import { addEntity, num, text } from './common.js';
import type { Extractor, PageRow } from './types.js';

const SPELL_TYPES = new Set(['sorcery', 'incantation']);

function spellBox(page: PageRow): Infobox | null {
  const box = page.wikitext ? findInfobox(page.wikitext, ['Infobox Item']) : null;
  return box && SPELL_TYPES.has((text(box.params.type) ?? '').toLowerCase()) ? box : null;
}

export const spellExtractor: Extractor = {
  name: 'spell',
  matches: (page) => spellBox(page) !== null,
  write(db, page) {
    const f = spellBox(page)!.params;
    const name = text(f.title) ?? page.title;
    db.prepare(`INSERT INTO spells (page_id, name, spell_type, sub_type, fp_cost, stamina_cost, slots_used, int_req, fai_req, arc_req, effect)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      page.id, name, text(f.type), text(f.sub_type), text(f.fp_cost), num(f.stamina_cost), num(f.slots_used), num(f.int_req), num(f.fai_req), num(f.arc_req), text(f.item_effect),
    );
    addEntity(db, page.id, 'spell', name);
  },
};
```

```ts
// src/extract/talisman.ts
import { findInfobox, type Infobox } from '../wikitext/infobox.js';
import { addEntity, num, sectionMarkdown, text } from './common.js';
import type { Extractor, PageRow } from './types.js';

function talismanBox(page: PageRow): Infobox | null {
  const box = page.wikitext ? findInfobox(page.wikitext, ['Infobox Item']) : null;
  return box && (text(box.params.type) ?? '').toLowerCase() === 'talisman' ? box : null;
}

export const talismanExtractor: Extractor = {
  name: 'talisman',
  matches: (page) => talismanBox(page) !== null,
  write(db, page) {
    const f = talismanBox(page)!.params;
    const name = text(f.title) ?? page.title;
    db.prepare('INSERT INTO talismans (page_id, name, weight, effect, summary) VALUES (?, ?, ?, ?, ?)')
      .run(page.id, name, num(f.weight), text(f.item_effect), sectionMarkdown(db, page.id, /^Summary$/));
    addEntity(db, page.id, 'talisman', name);
  },
};
```

```ts
// src/extract/armor.ts
import { findInfobox } from '../wikitext/infobox.js';
import { addEntity, num, text } from './common.js';
import type { Extractor } from './types.js';

const NAMES = ['Infobox Armor'];

export const armorExtractor: Extractor = {
  name: 'armor',
  matches: (page) => !!page.wikitext && findInfobox(page.wikitext, NAMES) !== null,
  write(db, page) {
    const f = findInfobox(page.wikitext!, NAMES)!.params;
    const name = text(f.title) ?? page.title;
    db.prepare('INSERT INTO armor (page_id, name, slot, weight, poise, effects) VALUES (?, ?, ?, ?, ?, ?)')
      .run(page.id, name, text(f.type), num(f.weight), num(f.poise), text(f.effects));
    addEntity(db, page.id, 'armor', name);
  },
};
```

```ts
// src/extract/boss.ts
import { findInfobox, type Infobox } from '../wikitext/infobox.js';
import { addEntity, text } from './common.js';
import type { Extractor, PageRow } from './types.js';

/** Infobox Boss, or Infobox Character whose type mentions Boss (e.g. Rennala). */
function bossBox(page: PageRow): Infobox | null {
  if (!page.wikitext) return null;
  const boss = findInfobox(page.wikitext, ['Infobox Boss']);
  if (boss) return boss;
  const character = findInfobox(page.wikitext, ['Infobox Character']);
  return character && /\bboss\b/i.test(text(character.params.type) ?? '') ? character : null;
}

export const bossExtractor: Extractor = {
  name: 'boss',
  matches: (page) => bossBox(page) !== null,
  write(db, page) {
    const f = bossBox(page)!.params;
    const name = text(f.title) ?? page.title;
    db.prepare('INSERT INTO bosses (page_id, name, location, hp, runes, drops) VALUES (?, ?, ?, ?, ?, ?)')
      .run(page.id, name, text(f.location), text(f.hp), text(f.runes), text(f.drops));
    addEntity(db, page.id, 'boss', name);
  },
};
```

- [ ] **Step 5: Registry and runner**

```ts
// src/extract/registry.ts
import { armorExtractor } from './armor.js';
import { bossExtractor } from './boss.js';
import { spellExtractor } from './spell.js';
import { talismanExtractor } from './talisman.js';
import type { Extractor } from './types.js';
import { weaponExtractor } from './weapon.js';

/** Order matters only for readability; extractors write to separate tables. Add new extractors here. */
export const EXTRACTORS: Extractor[] = [weaponExtractor, spellExtractor, talismanExtractor, armorExtractor, bossExtractor];
```

```ts
// src/extract/run.ts
import type { Db } from '../db/open.js';
import { clearDerived } from '../store/pages.js';
import { EXTRACTORS } from './registry.js';
import type { Extractor, PageRow } from './types.js';

export interface ExtractReport {
  pages: number;
  rows: Record<string, number>;
  failures: { title: string; extractor: string; error: string }[];
}

export function runExtractors(db: Db, opts: { pageIds?: number[]; extractors?: Extractor[]; now?: () => Date } = {}): ExtractReport {
  const extractors = opts.extractors ?? EXTRACTORS;
  const now = opts.now ?? (() => new Date());
  const pages = opts.pageIds
    ? opts.pageIds.map((id) => db.prepare('SELECT id, source, title, wikitext FROM pages WHERE id = ?').get(id) as PageRow | undefined).filter((p): p is PageRow => !!p)
    : (db.prepare('SELECT id, source, title, wikitext FROM pages ORDER BY id').all() as PageRow[]);
  const report: ExtractReport = { pages: pages.length, rows: {}, failures: [] };
  const logFailure = db.prepare('INSERT INTO extract_failures (page_id, extractor, error, at) VALUES (?, ?, ?, ?)');

  for (const page of pages) {
    db.transaction(() => {
      clearDerived(db, page.id);
      for (const extractor of extractors) {
        try {
          if (!extractor.matches(page)) continue;
          db.transaction(() => extractor.write(db, page))();
          report.rows[extractor.name] = (report.rows[extractor.name] ?? 0) + 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logFailure.run(page.id, extractor.name, message, now().toISOString());
          report.failures.push({ title: page.title, extractor: extractor.name, error: message });
        }
      }
    })();
  }
  return report;
}
```

Note: the inner `db.transaction` is a savepoint, so a throwing `write` rolls back only its own partial rows.

- [ ] **Step 6: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(extract): infobox extractors for weapons, spells, talismans, armor, bosses"
```

---

### Task 7: Acquisition and quest-step extractors

**Files:**
- Create: `src/extract/acquisition.ts`, `src/extract/quest.ts`, `test/extract-sections.test.ts`
- Modify: `src/extract/registry.ts` (append two extractors)

**Interfaces:**
- Consumes: `Extractor`, `PageRow`, `sectionMarkdown` (Task 6); `findInfobox` (Task 3)
- Produces:
  - `interface Acquisition { method: 'drop' | 'merchant' | 'chest' | 'quest' | 'ground' | 'other'; location_text: string; nearest_grace: string | null; prereqs: string[]; missable: boolean }`
  - `parseAcquisition(markdown: string): Acquisition`
  - `interface QuestStep { step_ord: number; location: string | null; action: string; breaks_quest: string | null }`
  - `parseQuestSteps(markdown: string): QuestStep[]`
  - `BREAK_PATTERN: RegExp` (exported from `quest.ts`; reused by the query layer for warnings)
  - `acquisitionExtractor`, `questExtractor`

- [ ] **Step 1: Failing tests**

`test/extract-sections.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { upsertPage } from '../src/store/pages.js';
import { runExtractors } from '../src/extract/run.js';
import { parseAcquisition } from '../src/extract/acquisition.js';
import { parseQuestSteps } from '../src/extract/quest.js';
import { wikitextToMarkdown } from '../src/wikitext/markdown.js';
import { splitSections } from '../src/wikitext/sections.js';
import { AZUR_CROWN, AZUR_STAFF, SELLEN_QUEST } from './fixtures/wikitext.js';

const section = (wikitext: string, heading: string) => splitSections(wikitextToMarkdown(wikitext)).find((s) => s.heading === heading)!.markdown;

test('acquisition: ground pickup with nearest grace', () => {
  const a = parseAcquisition(section(AZUR_STAFF, 'Acquisition'));
  assert.equal(a.method, 'ground');
  assert.equal(a.nearest_grace, 'Debate Parlor');
  assert.equal(a.missable, false);
});

test('acquisition: quest prerequisite sentence captured', () => {
  const a = parseAcquisition(section(AZUR_CROWN, 'Acquisition'));
  assert.equal(a.method, 'quest');
  assert.deepEqual(a.prereqs, ["- Obtained upon completing Sorceress Sellen's questline, then returning to the spot where Azur was found."]);
});

test('acquisition: missable and drop detection', () => {
  const a = parseAcquisition('Dropped by the boss. This item is missable after the capital burns.');
  assert.equal(a.method, 'drop');
  assert.equal(a.missable, true);
});

test('quest steps: numbered locations with nested actions and quest breakers', () => {
  const steps = parseQuestSteps(section(SELLEN_QUEST, 'Questline progression'));
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0], { step_ord: 1, location: 'Waypoint Ruins', action: 'Sellen can be found in the cellar after defeating the Mad Pumpkin Head. Select "I wish to learn glintstone sorceries".', breaks_quest: null });
  assert.equal(steps[2].location, 'Witchbane Ruins');
  assert.match(steps[2].action, /speak to the shackled Sellen/);
  assert.equal(steps[2].breaks_quest, 'Attacking Sellen here will fail the questline.');
});

test('extractors write acquisition and quest rows', () => {
  const db = memoryDb();
  for (const [title, text] of [["Azur's Glintstone Staff", AZUR_STAFF], ['Sorceress Sellen', SELLEN_QUEST]] as const) {
    upsertPage(db, { source: 'fandom', title, url: 'u', revid: 1, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext: text, markdown: null, license: 'CC BY-SA 3.0 (eldenring.fandom.com)' });
  }
  runExtractors(db);
  assert.deepEqual(db.prepare('SELECT method, nearest_grace, missable FROM acquisition').get(), { method: 'ground', nearest_grace: 'Debate Parlor', missable: 0 });
  assert.equal((db.prepare("SELECT count(*) AS n FROM quests WHERE npc = 'Sorceress Sellen'").get() as { n: number }).n, 3);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL, modules not found.

- [ ] **Step 3: `src/extract/acquisition.ts`**

```ts
import { findInfobox } from '../wikitext/infobox.js';
import { sectionMarkdown } from './common.js';
import type { Extractor } from './types.js';

export interface Acquisition {
  method: 'drop' | 'merchant' | 'chest' | 'quest' | 'ground' | 'other';
  location_text: string;
  nearest_grace: string | null;
  prereqs: string[];
  missable: boolean;
}

const ITEM_INFOBOXES = ['Infobox Weapon', 'Infobox Item', 'Infobox Armor'];
const ACQUISITION_HEADING = /^(acquisition|location|locations|where to find)$/i;

function detectMethod(markdown: string): Acquisition['method'] {
  const lower = markdown.toLowerCase();
  if (/\bdrop(s|ped)?\b/.test(lower)) return 'drop';
  if (/\b(sold|purchased?|buy|merchant|exchange|trade)\b/.test(lower)) return 'merchant';
  if (/\bchest\b/.test(lower)) return 'chest';
  if (/\b(quest|questline|interacting with)\b/.test(lower)) return 'quest';
  if (/\b(found|corpse|ground|loot|pick(ed)? up)\b/.test(lower)) return 'ground';
  return 'other';
}

export function parseAcquisition(markdown: string): Acquisition {
  const graceMatch = /([A-Z][A-Za-z'’,\- ]{2,60}?) [Ss]ite of [Gg]race/.exec(markdown);
  const nearest_grace = graceMatch ? graceMatch[1].replace(/^(?:(?:from|at|rest at|near|the)\s+)+/i, '').trim() : null;
  const sentences = markdown.split('\n').flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z])/)).map((s) => s.trim()).filter(Boolean);
  const prereqs = sentences.filter((s) => /\b(after|must|requires?|required|upon completing|once you|only (?:after|once|when))\b/i.test(s));
  const missable = /\bmissable\b|no longer (?:be )?(?:available|obtainable)|cannot be obtained (?:after|once)|permanently/i.test(markdown);
  return { method: detectMethod(markdown), location_text: markdown, nearest_grace, prereqs, missable };
}

export const acquisitionExtractor: Extractor = {
  name: 'acquisition',
  matches: (page) => !!page.wikitext && findInfobox(page.wikitext, ITEM_INFOBOXES) !== null,
  write(db, page) {
    const markdown = sectionMarkdown(db, page.id, ACQUISITION_HEADING);
    if (!markdown) return;
    const a = parseAcquisition(markdown);
    db.prepare('INSERT INTO acquisition (page_id, method, location_text, nearest_grace, prereqs, missable) VALUES (?, ?, ?, ?, ?, ?)')
      .run(page.id, a.method, a.location_text, a.nearest_grace, JSON.stringify(a.prereqs), a.missable ? 1 : 0);
  },
};
```

Check against the tests: in `AZUR_STAFF` the text "Found in a secluded room" makes `method = 'ground'`; the grace regex captures "From the Debate Parlor", and the prefix strip leaves "Debate Parlor". In `AZUR_CROWN` the Acquisition markdown contains "questline", so `method = 'quest'`. Its only sentence with "upon completing" is the list line. That line is not split because the split requires `[.!?]` followed by a capital letter, and "Sellen's questline, then returning" contains no such boundary.

- [ ] **Step 4: `src/extract/quest.ts`**

```ts
import { findInfobox } from '../wikitext/infobox.js';
import { sectionMarkdown, text } from './common.js';
import type { Extractor } from './types.js';

export interface QuestStep {
  step_ord: number;
  location: string | null;
  action: string;
  breaks_quest: string | null;
}

export const BREAK_PATTERN = /\b(fail(s|ed)? the quest(line)?|will fail|locks? (you )?out|locked out|cannot be completed|quest(line)? (will )?end|permanently|missable)\b/i;

/** Parses "1. Location" items with nested "- action" bullets (Fandom "Questline progression"). */
export function parseQuestSteps(markdown: string): QuestStep[] {
  const steps: QuestStep[] = [];
  for (const line of markdown.split('\n')) {
    const top = /^1\.\s+(.*)$/.exec(line);
    const nested = /^\s{2,}(?:-|1\.)\s+(.*)$/.exec(line);
    if (top) {
      steps.push({ step_ord: steps.length + 1, location: top[1].trim() || null, action: '', breaks_quest: null });
    } else if (nested && steps.length) {
      const step = steps[steps.length - 1];
      const sentence = nested[1].trim();
      if (BREAK_PATTERN.test(sentence)) step.breaks_quest = step.breaks_quest ? `${step.breaks_quest} ${sentence}` : sentence;
      else step.action = step.action ? `${step.action} ${sentence}` : sentence;
    }
  }
  return steps.filter((step) => step.action || step.breaks_quest);
}

const QUEST_HEADING = /^(questline progression|quest progression|quest walkthrough|questline)$/i;

export const questExtractor: Extractor = {
  name: 'quest',
  matches: (page) => !!page.wikitext && findInfobox(page.wikitext, ['Infobox Character']) !== null,
  write(db, page) {
    const markdown = sectionMarkdown(db, page.id, QUEST_HEADING);
    if (!markdown) return;
    const npc = text(findInfobox(page.wikitext!, ['Infobox Character'])!.params.title) ?? page.title;
    const insert = db.prepare('INSERT INTO quests (page_id, npc, step_ord, location, action, breaks_quest) VALUES (?, ?, ?, ?, ?, ?)');
    for (const step of parseQuestSteps(markdown)) insert.run(page.id, npc, step.step_ord, step.location, step.action, step.breaks_quest);
  },
};
```

- [ ] **Step 5: Register**

Replace `src/extract/registry.ts`:
```ts
import { acquisitionExtractor } from './acquisition.js';
import { armorExtractor } from './armor.js';
import { bossExtractor } from './boss.js';
import { questExtractor } from './quest.js';
import { spellExtractor } from './spell.js';
import { talismanExtractor } from './talisman.js';
import type { Extractor } from './types.js';
import { weaponExtractor } from './weapon.js';

/** Each extractor writes its own table(s). Add new extractors here. */
export const EXTRACTORS: Extractor[] = [
  weaponExtractor, spellExtractor, talismanExtractor, armorExtractor, bossExtractor, acquisitionExtractor, questExtractor,
];
```

- [ ] **Step 6: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS (including Task 6 tests, since the entity-type assertion only counts `entities`, which these extractors don't write).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(extract): acquisition and questline step extractors"
```

---

### Task 8: Data changelog and build scripts

**Files:**
- Create: `src/changelog.ts`, `scripts/extract.ts`, `scripts/build.ts`, `data/CHANGELOG-data.md`, `test/changelog.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 2); `syncFandom`, `SyncReport` (Task 5); `runExtractors`, `ExtractReport` (Task 6)
- Produces:
  - `TYPED_TABLES = ['weapons', 'spells', 'talismans', 'armor', 'bosses'] as const`
  - `type Snapshot = Map<string, Record<string, unknown>>` (key `"<table>:<name>"`)
  - `snapshotRows(db: Db, pageIds?: number[]): Snapshot`
  - `interface FieldChange { key: string; field: string; before: unknown; after: unknown }`
  - `interface SnapshotDiff { added: string[]; removed: string[]; changed: FieldChange[] }`
  - `diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff`
  - `formatChangelog(date: string, sync: SyncReport, diff: SnapshotDiff, failures: number): string`

- [ ] **Step 1: Failing tests**

`test/changelog.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, formatChangelog, snapshotRows } from '../src/changelog.js';
import { memoryDb } from './helpers.js';

test('diffSnapshots reports added, removed and per-field changes (ignoring page_id)', () => {
  const before = new Map([['weapons:Azur', { page_id: 1, name: 'Azur', int_req: 52 }], ['spells:Old', { page_id: 2, name: 'Old' }]]);
  const after = new Map([['weapons:Azur', { page_id: 9, name: 'Azur', int_req: 48 }], ['spells:New', { page_id: 3, name: 'New' }]]);
  assert.deepEqual(diffSnapshots(before, after), {
    added: ['spells:New'], removed: ['spells:Old'], changed: [{ key: 'weapons:Azur', field: 'int_req', before: 52, after: 48 }],
  });
});

test('snapshotRows keys rows by table and name, optionally limited to pages', () => {
  const db = memoryDb();
  db.prepare("INSERT INTO weapons (page_id, name, int_req) VALUES (1, 'Azur', 52), (2, 'Lusat', 60)").run();
  assert.deepEqual([...snapshotRows(db).keys()], ['weapons:Azur', 'weapons:Lusat']);
  assert.deepEqual([...snapshotRows(db, [2]).keys()], ['weapons:Lusat']);
});

test('formatChangelog renders a dated markdown entry', () => {
  const md = formatChangelog('2026-09-15', { added: ['A'], changed: ['B', 'C'], removed: [], unchanged: 10 }, { added: [], removed: [], changed: [{ key: 'weapons:Azur', field: 'int_req', before: 52, after: 48 }] }, 2);
  assert.equal(md, [
    '## 2026-09-15',
    '',
    '- Pages: 1 added, 2 changed, 0 removed, 10 unchanged',
    '- Extract failures: 2',
    '- `weapons:Azur` int_req: 52 → 48',
    '',
  ].join('\n'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL, module not found.

- [ ] **Step 3: `src/changelog.ts`**

```ts
import type { Db } from './db/open.js';
import type { SyncReport } from './sync.js';

export const TYPED_TABLES = ['weapons', 'spells', 'talismans', 'armor', 'bosses'] as const;

export type Snapshot = Map<string, Record<string, unknown>>;

export function snapshotRows(db: Db, pageIds?: number[]): Snapshot {
  const snapshot: Snapshot = new Map();
  for (const table of TYPED_TABLES) {
    const rows = (pageIds
      ? pageIds.flatMap((id) => db.prepare(`SELECT * FROM ${table} WHERE page_id = ?`).all(id))
      : db.prepare(`SELECT * FROM ${table} ORDER BY name`).all()) as Record<string, unknown>[];
    for (const row of rows) snapshot.set(`${table}:${row.name}`, row);
  }
  return snapshot;
}

export interface FieldChange { key: string; field: string; before: unknown; after: unknown }
export interface SnapshotDiff { added: string[]; removed: string[]; changed: FieldChange[] }

export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const diff: SnapshotDiff = { added: [], removed: [], changed: [] };
  for (const key of after.keys()) if (!before.has(key)) diff.added.push(key);
  for (const key of before.keys()) if (!after.has(key)) diff.removed.push(key);
  for (const [key, row] of after) {
    const previous = before.get(key);
    if (!previous) continue;
    for (const field of Object.keys(row)) {
      if (field === 'page_id') continue;
      if (previous[field] !== row[field]) diff.changed.push({ key, field, before: previous[field], after: row[field] });
    }
  }
  return diff;
}

export function formatChangelog(date: string, sync: SyncReport, diff: SnapshotDiff, failures: number): string {
  const lines = [
    `## ${date}`,
    '',
    `- Pages: ${sync.added.length} added, ${sync.changed.length} changed, ${sync.removed.length} removed, ${sync.unchanged} unchanged`,
    `- Extract failures: ${failures}`,
    ...diff.added.map((key) => `- Added \`${key}\``),
    ...diff.removed.map((key) => `- Removed \`${key}\``),
    ...diff.changed.map((c) => `- \`${c.key}\` ${c.field}: ${c.before} → ${c.after}`),
    '',
  ];
  return lines.join('\n');
}
```

- [ ] **Step 4: Scripts**

`data/CHANGELOG-data.md`:
```markdown
# Data changelog

Generated by `npm run build`. Newest first. Each entry lists page sync counts and field-level changes to typed rows.
```

`scripts/extract.ts`:
```ts
// Re-runs all extractors over every page in the db (use after changing an extractor).
// Run: npm run extract
import { openDb } from '../src/db/open.js';
import { runExtractors } from '../src/extract/run.js';
import { DEFAULT_DB_PATH } from '../src/store/pages.js';

const db = openDb(process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH);
const report = runExtractors(db);
console.log(JSON.stringify({ pages: report.pages, rows: report.rows, failures: report.failures.length }, null, 2));
for (const failure of report.failures.slice(0, 50)) console.log(`FAIL ${failure.extractor} ${failure.title}: ${failure.error}`);
db.close();
```

`scripts/build.ts`:
```ts
// Sync changed Fandom pages, re-extract only those pages, and prepend a dated entry to data/CHANGELOG-data.md.
// Run: npm run build
import { readFileSync, writeFileSync } from 'node:fs';
import { diffSnapshots, formatChangelog, snapshotRows } from '../src/changelog.js';
import { openDb } from '../src/db/open.js';
import { runExtractors } from '../src/extract/run.js';
import { createFandom } from '../src/sources/fandom.js';
import { DEFAULT_DB_PATH } from '../src/store/pages.js';
import { syncFandom } from '../src/sync.js';

const CHANGELOG = 'data/CHANGELOG-data.md';
const db = openDb(process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH);

const before = snapshotRows(db);
const sync = await syncFandom(db, createFandom(), (message) => console.log(message));
const touched = [...sync.added, ...sync.changed]
  .map((title) => (db.prepare("SELECT id FROM pages WHERE source = 'fandom' AND title = ?").get(title) as { id: number } | undefined)?.id)
  .filter((id): id is number => id !== undefined);
const extract = runExtractors(db, { pageIds: touched });
const diff = diffSnapshots(before, snapshotRows(db));

const date = new Date().toISOString().slice(0, 10);
const [title, intro, ...rest] = readFileSync(CHANGELOG, 'utf8').split('\n\n');
writeFileSync(CHANGELOG, [title, intro, formatChangelog(date, sync, diff, extract.failures.length).trimEnd(), ...rest].join('\n\n'));
console.log(JSON.stringify({ touched: touched.length, rows: extract.rows, failures: extract.failures.length, fieldChanges: diff.changed.length }));
db.exec('VACUUM');
db.close();
```

The changelog file is `title\n\nintro\n\n...entries`; new entries are inserted right after the intro, so newest is first.

- [ ] **Step 5: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(build): field-level data changelog and build/extract scripts"
```

---

### Task 9: Fextralife on-demand local cache

**Files:**
- Create: `src/sources/fextralife.ts`, `src/store/local.ts`, `test/fextralife.test.ts`

**Interfaces:**
- Consumes: `createHttp`, `FetchLike`, `USER_AGENT` (Task 4); `upsertPage` (Task 5); `openDb`, `Db` (Task 2)
- Produces:
  - `FEXTRALIFE_LICENSE = 'All rights reserved (Fextralife). Local cache only; never redistributed.'`
  - `fextralifeUrl(title: string): string`
  - `htmlToWikiMarkdown(html: string): string | null` (content of `#wiki-content-block`, atx headings; null if the block is missing)
  - `fetchFextralife(title: string, opts?: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; minIntervalMs?: number; now?: () => Date }): Promise<RawPage | null>`
  - `localDbPath(): string` (`$ELDEN_RING_MCP_CACHE` or `~/.cache/elden-ring-mcp/local.db`)
  - `openLocalDb(path?: string): Db`
  - `cacheFextralife(localDb: Db, title: string, opts?: Parameters<typeof fetchFextralife>[1]): Promise<number | null>` (page id or null)

- [ ] **Step 1: Failing tests**

`test/fextralife.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fextralifeUrl, htmlToWikiMarkdown } from '../src/sources/fextralife.js';
import { cacheFextralife, localDbPath, openLocalDb } from '../src/store/local.js';
import type { FetchLike } from '../src/sources/http.js';

const HTML = `<html><body><div id="sidebar">ads</div>
<div id="wiki-content-block">
<h2>Where to find Azur's Glintstone Staff</h2>
<ul><li>Raya Lucaria Academy</li><li>Nearest grace: <a href="/Church+of+the+Cuckoo">Church of the Cuckoo</a></li></ul>
<h3 class="bonfire">Notes</h3><p>Reduces casting time.</p>
<script>track()</script>
</div></body></html>`;

const ok = (body: string, status = 200) => ({ status, headers: { get: () => null }, text: async () => body });

test('fextralifeUrl uses + for spaces', () => {
  assert.equal(fextralifeUrl("Azur's Glintstone Staff"), "https://eldenring.wiki.fextralife.com/Azur's+Glintstone+Staff");
});

test('htmlToWikiMarkdown keeps only the content block with atx headings and no scripts', () => {
  const md = htmlToWikiMarkdown(HTML)!;
  assert.match(md, /^## Where to find Azur's Glintstone Staff/m);
  assert.match(md, /^### Notes/m);
  assert.match(md, /Nearest grace: \[Church of the Cuckoo\]/);
  assert.ok(!md.includes('ads'));
  assert.ok(!md.includes('track()'));
  assert.equal(htmlToWikiMarkdown('<html><body>nope</body></html>'), null);
});

test('localDbPath honors ELDEN_RING_MCP_CACHE', () => {
  const previous = process.env.ELDEN_RING_MCP_CACHE;
  process.env.ELDEN_RING_MCP_CACHE = '/tmp/er-cache';
  assert.equal(localDbPath(), '/tmp/er-cache/local.db');
  if (previous === undefined) delete process.env.ELDEN_RING_MCP_CACHE; else process.env.ELDEN_RING_MCP_CACHE = previous;
});

test('cacheFextralife stores a local-only page with Fextralife license; 404 returns null', async () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), 'er-local-')), 'local.db'));
  const fetchImpl: FetchLike = async (url) => (url.endsWith('Missing+Page') ? ok('', 404) : ok(HTML));
  const id = await cacheFextralife(db, "Azur's Glintstone Staff", { fetchImpl, minIntervalMs: 0, sleep: async () => {} });
  assert.ok(id);
  const row = db.prepare('SELECT source, revid, license, wikitext FROM pages WHERE id = ?').get(id) as Record<string, unknown>;
  assert.deepEqual(row, { source: 'fextralife', revid: null, license: 'All rights reserved (Fextralife). Local cache only; never redistributed.', wikitext: null });
  assert.equal(await cacheFextralife(db, 'Missing Page', { fetchImpl, minIntervalMs: 0, sleep: async () => {} }), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL, modules not found.

- [ ] **Step 3: `src/sources/fextralife.ts`**

```ts
import { parse } from 'node-html-parser';
import TurndownService from 'turndown';
import type { RawPage } from '../types.js';
import { USER_AGENT } from './fandom.js';
import { createHttp, HttpError, type FetchLike } from './http.js';

export const FEXTRALIFE_LICENSE = 'All rights reserved (Fextralife). Local cache only; never redistributed.';

export const fextralifeUrl = (title: string) => `https://eldenring.wiki.fextralife.com/${title.trim().replace(/\s+/g, '+')}`;

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });

export function htmlToWikiMarkdown(html: string): string | null {
  const block = parse(html).querySelector('#wiki-content-block');
  if (!block) return null;
  for (const junk of block.querySelectorAll('script, style, iframe, noscript')) junk.remove();
  return turndown.turndown(block.innerHTML).replace(/\n{3,}/g, '\n\n').trim();
}

export async function fetchFextralife(
  title: string,
  opts: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; minIntervalMs?: number; now?: () => Date } = {},
): Promise<RawPage | null> {
  const url = fextralifeUrl(title);
  const getText = createHttp({ userAgent: USER_AGENT, fetchImpl: opts.fetchImpl, sleep: opts.sleep, minIntervalMs: opts.minIntervalMs });
  let html: string;
  try {
    html = await getText(url);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
  const markdown = htmlToWikiMarkdown(html);
  if (!markdown) return null;
  return {
    source: 'fextralife', title, url, revid: null, fetchedAt: (opts.now ?? (() => new Date()))().toISOString(),
    wikitext: null, markdown, license: FEXTRALIFE_LICENSE,
  };
}
```

- [ ] **Step 4: `src/store/local.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../db/open.js';
import { fetchFextralife } from '../sources/fextralife.js';
import { upsertPage } from './pages.js';

export function localDbPath(): string {
  return join(process.env.ELDEN_RING_MCP_CACHE ?? join(homedir(), '.cache', 'elden-ring-mcp'), 'local.db');
}

export const openLocalDb = (path = localDbPath()): Db => openDb(path);

/** Fetches one Fextralife page into the user's local cache db. Never touches data/. */
export async function cacheFextralife(localDb: Db, title: string, opts: Parameters<typeof fetchFextralife>[1] = {}): Promise<number | null> {
  const page = await fetchFextralife(title, opts);
  return page ? upsertPage(localDb, page) : null;
}
```

- [ ] **Step 5: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(sources): Fextralife single-page local cache (never shipped)"
```

---

### Task 10: Query layer (resolve, search, page, where, quest, stats, boss, status)

**Files:**
- Create: `src/query/dbs.ts`, `src/query/resolve.ts`, `src/query/lookups.ts`, `test/fixtures/build-fixture-db.ts`, `test/query.test.ts`

**Interfaces:**
- Consumes: `Db`, `openDb` (Task 2); `upsertPage`, `replaceRedirects`, `recordSync` (Task 5); `runExtractors` (Task 6/7); `BREAK_PATTERN` (Task 7); `SCALING_ORDER` (Task 6); fixtures (Task 3)
- Produces:
  - `interface Dbs { shipped: Db | null; local: Db | null }`
  - `interface Provenance { source: string; title: string; url: string; revid: number | null; fetched_at: string; license: string }`
  - `interface Resolved { db: Db; pageId: number; provenance: Provenance; match: 'exact' | 'redirect' | 'entity' | 'search'; fragment: string | null }`
  - `resolveName(dbs: Dbs, name: string): Resolved | null` (shipped first, then local)
  - `NotFound = { not_found: true; query: string; hint: string }`
  - `search(dbs: Dbs, query: string, limit?: number): { results: { title: string; heading: string; snippet: string; provenance: Provenance }[] }`
  - `getPage(dbs: Dbs, title: string, section?: string): { provenance; match; sections: { heading: string; markdown: string }[] } | NotFound`
  - `whereIs(dbs: Dbs, name: string): { provenance; match; acquisition: {...} | null; sections: {heading; markdown}[] } | NotFound`
  - `questSteps(dbs: Dbs, npc: string): { provenance; match; steps: QuestStep[]; warnings: string[] } | NotFound`
  - `itemStats(dbs: Dbs, filter: { name?: string; kind?: 'weapon'|'spell'|'talisman'|'armor'; scaling_stat?: 'str'|'dex'|'int'|'fai'|'arc'; min_scaling?: string; max_req?: Partial<Record<'str'|'dex'|'int'|'fai'|'arc', number>>; limit?: number }): { rows: (Record<string, unknown> & { kind: string; provenance: Provenance })[] } | NotFound`
  - `bossInfo(dbs: Dbs, name: string): { provenance; match; boss: Record<string, unknown> | null; sections: {heading; markdown}[] } | NotFound`
  - `sourcesStatus(dbs: Dbs): { shipped: { sync: unknown[]; pages: number; failures: number } | null; local: { pages: number } | null }`
  - Test helper: `buildFixtureDb(path?: string): Db` (seeds all fixtures, a redirect `Magma Wyrm Makar → Red Wolf of Radagon#Overview`, runs extractors, records sync)

- [ ] **Step 1: Fixture db builder**

`test/fixtures/build-fixture-db.ts`:
```ts
import { openDb, type Db } from '../../src/db/open.js';
import { runExtractors } from '../../src/extract/run.js';
import { recordSync, replaceRedirects, upsertPage } from '../../src/store/pages.js';
import { AZUR_CROWN, AZUR_STAFF, COMET_AZUR, GRAVEN_SCHOOL, RED_WOLF, SELLEN_QUEST } from './wikitext.js';

export const FIXTURE_PAGES: [string, string][] = [
  ["Azur's Glintstone Staff", AZUR_STAFF], ['Comet Azur', COMET_AZUR], ['Graven-School Talisman', GRAVEN_SCHOOL],
  ["Azur's Glintstone Crown", AZUR_CROWN], ['Red Wolf of Radagon', RED_WOLF], ['Sorceress Sellen', SELLEN_QUEST],
];

/** Small shipped-style db used by query tests and the MCP smoke test. The Makar redirect reuses Red Wolf content to exercise fragments. */
export function buildFixtureDb(path = ':memory:'): Db {
  const db = openDb(path);
  for (const [title, wikitext] of FIXTURE_PAGES) {
    upsertPage(db, { source: 'fandom', title, url: `https://eldenring.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`, revid: 100, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext, markdown: null, license: 'CC BY-SA 3.0 (eldenring.fandom.com)' });
  }
  replaceRedirects(db, 'fandom', [{ from: 'Magma Wyrm Makar', to: 'Red Wolf of Radagon', fragment: 'Overview' }]);
  runExtractors(db);
  recordSync(db, 'fandom', FIXTURE_PAGES.length, new Date('2026-09-15T00:00:00Z'));
  return db;
}
```

- [ ] **Step 2: Failing tests**

`test/query.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFixtureDb } from './fixtures/build-fixture-db.js';
import { memoryDb } from './helpers.js';
import { upsertPage } from '../src/store/pages.js';
import { resolveName } from '../src/query/resolve.js';
import { bossInfo, getPage, itemStats, questSteps, search, sourcesStatus, whereIs } from '../src/query/lookups.js';
import type { Dbs } from '../src/query/dbs.js';

const dbs = (): Dbs => ({ shipped: buildFixtureDb(), local: null });

test('resolveName: exact (case-insensitive), redirect with fragment, entity, search', () => {
  const d = dbs();
  assert.equal(resolveName(d, "azur's glintstone staff")?.match, 'exact');
  const makar = resolveName(d, 'Magma Wyrm Makar')!;
  assert.deepEqual([makar.match, makar.provenance.title, makar.fragment], ['redirect', 'Red Wolf of Radagon', 'Overview']);
  assert.equal(resolveName(d, 'cuckoo church staff')?.match, 'search');
  assert.equal(resolveName(d, 'zzqx nonsense'), null);
});

test('resolveName falls back to the local cache db', () => {
  const local = memoryDb();
  upsertPage(local, { source: 'fextralife', title: 'Lusat', url: 'https://eldenring.wiki.fextralife.com/Lusat', revid: null, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext: null, markdown: '## Location\nSellia Hideaway', license: 'All rights reserved (Fextralife). Local cache only; never redistributed.' });
  const resolved = resolveName({ shipped: buildFixtureDb(), local }, 'Lusat')!;
  assert.equal(resolved.provenance.source, 'fextralife');
});

test('search returns snippets with provenance', () => {
  const { results } = search(dbs(), 'damage sorceries');
  assert.equal(results[0].title, 'Graven-School Talisman');
  assert.equal(results[0].provenance.license, 'CC BY-SA 3.0 (eldenring.fandom.com)');
  assert.ok(results[0].snippet.length > 0);
  assert.doesNotThrow(() => search(dbs(), 'weird "quote AND ( syntax'));
});

test('getPage whole and single section; not_found on miss', () => {
  const page = getPage(dbs(), "Azur's Glintstone Staff", 'acq') as any;
  assert.deepEqual(page.sections.map((s: any) => s.heading), ['Acquisition']);
  assert.equal(page.provenance.revid, 100);
  assert.deepEqual(getPage(dbs(), 'zzqx nonsense'), { not_found: true, query: 'zzqx nonsense', hint: 'No page matched in the shipped data or local cache. Try search, or pass fetch: true to cache the Fextralife page.' });
});

test('whereIs returns parsed acquisition', () => {
  const result = whereIs(dbs(), "Azur's Glintstone Staff") as any;
  assert.equal(result.acquisition.nearest_grace, 'Debate Parlor');
  assert.deepEqual(result.acquisition.prereqs, []);
  assert.equal(result.acquisition.missable, false);
});

test('questSteps returns ordered steps and warnings from Notes', () => {
  const result = questSteps(dbs(), 'Sellen') as any;
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[0].location, 'Waypoint Ruins');
  assert.deepEqual(result.warnings, ['- Killing Preceptor Seluvis early locks you out of the puppet step.']);
});

test('itemStats by name and by filter', () => {
  const byName = itemStats(dbs(), { name: "Azur's Glintstone Staff" }) as any;
  assert.equal(byName.rows[0].int_req, 52);
  assert.equal(byName.rows[0].kind, 'weapon');
  const filtered = itemStats(dbs(), { kind: 'weapon', scaling_stat: 'int', min_scaling: 'C', max_req: { int: 60 } }) as any;
  assert.equal(filtered.rows.length, 1);
  assert.equal((itemStats(dbs(), { kind: 'weapon', scaling_stat: 'int', min_scaling: 'A' }) as any).rows.length, 0);
});

test('bossInfo via redirect returns boss row and fragment section', () => {
  const result = bossInfo(dbs(), 'Magma Wyrm Makar') as any;
  assert.equal(result.boss.hp, '2,204');
  assert.deepEqual(result.sections.map((s: any) => s.heading), ['Overview']);
});

test('sourcesStatus reports sync and counts', () => {
  const status = sourcesStatus(dbs());
  assert.equal(status.shipped?.pages, 6);
  assert.equal(status.local, null);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test`
Expected: FAIL, modules not found.

- [ ] **Step 4: `src/query/dbs.ts`**

```ts
import { existsSync } from 'node:fs';
import { openDb, type Db } from '../db/open.js';
import { localDbPath } from '../store/local.js';
import { DEFAULT_DB_PATH } from '../store/pages.js';

export interface Dbs {
  shipped: Db | null;
  local: Db | null;
}

/** Opens the shipped db read-only (if present) and the local cache read-write (created on demand). */
export function openDbs(): Dbs {
  const shippedPath = process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH;
  return {
    shipped: existsSync(shippedPath) ? openDb(shippedPath, { readonly: true }) : null,
    local: openDb(localDbPath()),
  };
}
```

- [ ] **Step 5: `src/query/resolve.ts`**

```ts
import type { Db } from '../db/open.js';
import type { Dbs } from './dbs.js';

export interface Provenance {
  source: string;
  title: string;
  url: string;
  revid: number | null;
  fetched_at: string;
  license: string;
}

export interface Resolved {
  db: Db;
  pageId: number;
  provenance: Provenance;
  match: 'exact' | 'redirect' | 'entity' | 'search';
  fragment: string | null;
}

const PROVENANCE_COLUMNS = 'id, source, title, url, revid, fetched_at, license';

type PageRecord = Provenance & { id: number };

const toResolved = (db: Db, row: PageRecord, match: Resolved['match'], fragment: string | null = null): Resolved => {
  const { id, ...provenance } = row;
  return { db, pageId: id, provenance, match, fragment };
};

/** Quotes each word so user text can't inject FTS5 syntax. */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}]+/gu);
  return words?.length ? words.map((word) => `"${word}"`).join(' ') : null;
}

function resolveIn(db: Db, name: string): Resolved | null {
  const exact = db.prepare(`SELECT ${PROVENANCE_COLUMNS} FROM pages WHERE title = ? COLLATE NOCASE`).get(name) as PageRecord | undefined;
  if (exact) return toResolved(db, exact, 'exact');

  const redirect = db.prepare('SELECT to_title, fragment FROM redirects WHERE from_title = ? COLLATE NOCASE').get(name) as { to_title: string; fragment: string | null } | undefined;
  if (redirect) {
    const target = db.prepare(`SELECT ${PROVENANCE_COLUMNS} FROM pages WHERE title = ?`).get(redirect.to_title) as PageRecord | undefined;
    if (target) return toResolved(db, target, 'redirect', redirect.fragment);
  }

  const entity = db.prepare(`SELECT ${PROVENANCE_COLUMNS.split(', ').map((c) => `p.${c}`).join(', ')} FROM entities e JOIN pages p ON p.id = e.page_id WHERE e.name = ? COLLATE NOCASE`).get(name) as PageRecord | undefined;
  if (entity) return toResolved(db, entity, 'entity');

  const query = ftsQuery(name);
  if (!query) return null;
  const hit = db.prepare(`
    SELECT ${PROVENANCE_COLUMNS.split(', ').map((c) => `p.${c}`).join(', ')}
    FROM sections_fts f JOIN sections s ON s.id = f.rowid JOIN pages p ON p.id = s.page_id
    WHERE sections_fts MATCH ? ORDER BY bm25(sections_fts, 10.0, 2.0, 1.0) LIMIT 1
  `).get(query) as PageRecord | undefined;
  return hit ? toResolved(db, hit, 'search') : null;
}

/** Shipped data first, then the local cache. Within a db: exact title, redirect, entity name, full-text search. */
export function resolveName(dbs: Dbs, name: string): Resolved | null {
  for (const db of [dbs.shipped, dbs.local]) {
    if (!db) continue;
    const resolved = resolveIn(db, name.trim());
    if (resolved && resolved.match !== 'search') return resolved;
  }
  for (const db of [dbs.shipped, dbs.local]) {
    if (!db) continue;
    const resolved = resolveIn(db, name.trim());
    if (resolved) return resolved;
  }
  return null;
}
```

Note: the two loops let a strong match in the local cache (exact/redirect/entity) beat a weak full-text hit in shipped data. The `Lusat` test passes either way (no fixture page contains "Lusat"), but real data needs the rule.

- [ ] **Step 6: `src/query/lookups.ts`**

```ts
import type { Db } from '../db/open.js';
import { SCALING_ORDER } from '../extract/common.js';
import { BREAK_PATTERN, type QuestStep } from '../extract/quest.js';
import type { Dbs } from './dbs.js';
import { ftsQuery, resolveName, type Provenance, type Resolved } from './resolve.js';

export interface NotFound { not_found: true; query: string; hint: string }

const notFound = (query: string): NotFound => ({
  not_found: true, query,
  hint: 'No page matched in the shipped data or local cache. Try search, or pass fetch: true to cache the Fextralife page.',
});

type SectionOut = { heading: string; markdown: string };

function sectionsOf(r: Resolved, heading?: RegExp): SectionOut[] {
  const rows = r.db.prepare('SELECT heading, markdown FROM sections WHERE page_id = ? ORDER BY ord').all(r.pageId) as SectionOut[];
  return heading ? rows.filter((row) => heading.test(row.heading)) : rows;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function search(dbs: Dbs, query: string, limit = 10) {
  const fts = ftsQuery(query);
  const results: { title: string; heading: string; snippet: string; provenance: Provenance }[] = [];
  if (!fts) return { results };
  for (const db of [dbs.shipped, dbs.local]) {
    if (!db) continue;
    const rows = db.prepare(`
      SELECT p.source, p.title, p.url, p.revid, p.fetched_at, p.license, s.heading,
             snippet(sections_fts, 2, '**', '**', ' … ', 24) AS snippet
      FROM sections_fts f JOIN sections s ON s.id = f.rowid JOIN pages p ON p.id = s.page_id
      WHERE sections_fts MATCH ? ORDER BY bm25(sections_fts, 10.0, 2.0, 1.0) LIMIT ?
    `).all(fts, limit) as (Provenance & { heading: string; snippet: string })[];
    for (const { heading, snippet, ...provenance } of rows) results.push({ title: provenance.title, heading, snippet, provenance });
  }
  return { results: results.slice(0, limit) };
}

export function getPage(dbs: Dbs, title: string, section?: string) {
  const r = resolveName(dbs, title);
  if (!r) return notFound(title);
  const heading = section ? new RegExp(escapeRegex(section), 'i') : r.fragment ? new RegExp(`^${escapeRegex(r.fragment)}$`, 'i') : undefined;
  return { provenance: r.provenance, match: r.match, sections: sectionsOf(r, heading) };
}

export function whereIs(dbs: Dbs, name: string) {
  const r = resolveName(dbs, name);
  if (!r) return notFound(name);
  const row = r.db.prepare('SELECT method, location_text, nearest_grace, prereqs, missable FROM acquisition WHERE page_id = ?').get(r.pageId) as
    { method: string; location_text: string; nearest_grace: string | null; prereqs: string; missable: number } | undefined;
  return {
    provenance: r.provenance,
    match: r.match,
    acquisition: row ? { ...row, prereqs: JSON.parse(row.prereqs) as string[], missable: row.missable === 1 } : null,
    sections: sectionsOf(r, /acquisition|location|where to find|how to get/i),
  };
}

export function questSteps(dbs: Dbs, npc: string) {
  const r = resolveName(dbs, npc);
  if (!r) return notFound(npc);
  const steps = r.db.prepare('SELECT step_ord, location, action, breaks_quest FROM quests WHERE page_id = ? ORDER BY step_ord').all(r.pageId) as QuestStep[];
  const notes = sectionsOf(r, /^notes$/i).flatMap((s) => s.markdown.split('\n')).filter((line) => BREAK_PATTERN.test(line));
  return { provenance: r.provenance, match: r.match, steps, warnings: notes, ...(steps.length ? {} : { sections: sectionsOf(r, /quest/i) }) };
}

const KIND_TABLE = { weapon: 'weapons', spell: 'spells', talisman: 'talismans', armor: 'armor' } as const;
type Kind = keyof typeof KIND_TABLE;
type Stat = 'str' | 'dex' | 'int' | 'fai' | 'arc';

function provenanceOf(db: Db, pageId: number): Provenance {
  return db.prepare('SELECT source, title, url, revid, fetched_at, license FROM pages WHERE id = ?').get(pageId) as Provenance;
}

export function itemStats(dbs: Dbs, filter: { name?: string; kind?: Kind; scaling_stat?: Stat; min_scaling?: string; max_req?: Partial<Record<Stat, number>>; limit?: number }) {
  const limit = filter.limit ?? 25;
  if (filter.name) {
    const r = resolveName(dbs, filter.name);
    if (!r) return notFound(filter.name);
    const rows = (Object.entries(KIND_TABLE) as [Kind, string][]).flatMap(([kind, table]) =>
      (r.db.prepare(`SELECT * FROM ${table} WHERE page_id = ?`).all(r.pageId) as Record<string, unknown>[]).map((row) => ({ kind, ...row, provenance: r.provenance })));
    return rows.length ? { rows } : notFound(filter.name);
  }
  const kinds = filter.kind ? [filter.kind] : (Object.keys(KIND_TABLE) as Kind[]);
  const rows: (Record<string, unknown> & { kind: string; provenance: Provenance })[] = [];
  for (const db of [dbs.shipped, dbs.local]) {
    if (!db) continue;
    for (const kind of kinds) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (filter.scaling_stat && filter.min_scaling && kind === 'weapon') {
        const allowed = SCALING_ORDER.slice(SCALING_ORDER.indexOf(filter.min_scaling.toUpperCase() as (typeof SCALING_ORDER)[number]));
        where.push(`${filter.scaling_stat}_scale IN (${allowed.map(() => '?').join(', ')})`);
        params.push(...allowed);
      }
      for (const [stat, max] of Object.entries(filter.max_req ?? {}) as [Stat, number][]) {
        if (kind === 'weapon' || (kind === 'spell' && ['int', 'fai', 'arc'].includes(stat))) { where.push(`coalesce(${stat}_req, 0) <= ?`); params.push(max); }
      }
      const sql = `SELECT * FROM ${KIND_TABLE[kind]}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name LIMIT ?`;
      for (const row of db.prepare(sql).all(...params, limit) as Record<string, unknown>[]) rows.push({ kind, ...row, provenance: provenanceOf(db, row.page_id as number) });
    }
  }
  return { rows: rows.slice(0, limit) };
}

export function bossInfo(dbs: Dbs, name: string) {
  const r = resolveName(dbs, name);
  if (!r) return notFound(name);
  const boss = (r.db.prepare('SELECT name, location, hp, runes, drops FROM bosses WHERE page_id = ?').get(r.pageId) as Record<string, unknown> | undefined) ?? null;
  const heading = r.fragment ? new RegExp(`^${escapeRegex(r.fragment)}$`, 'i') : /overview|location|strateg|weakness|resist/i;
  return { provenance: r.provenance, match: r.match, boss, sections: sectionsOf(r, heading) };
}

export function sourcesStatus(dbs: Dbs) {
  const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    shipped: dbs.shipped
      ? { sync: dbs.shipped.prepare('SELECT source, last_run, pages FROM sync_state').all(), pages: count(dbs.shipped, 'SELECT count(*) AS n FROM pages'), failures: count(dbs.shipped, 'SELECT count(*) AS n FROM extract_failures') }
      : null,
    local: dbs.local ? { pages: count(dbs.local, 'SELECT count(*) AS n FROM pages') } : null,
  };
}
```

Check against the tests:
- `itemStats` filter `min_scaling: 'C'` on `int` allows C/B/A/S. The staff is B, so 1 row. With `A`, 0 rows.
- `max_req: { int: 60 }` gives `int_req 52 <= 60`.
- `search('damage sorceries')`: the Graven-School Summary section contains both words ("Increases damage from sorceries by 8%"), so it ranks first.

- [ ] **Step 7: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS. If `resolveName(d, 'cuckoo church staff')` returns null, FTS requires all quoted words to match. "church", "cuckoo" and "staff" all appear in the staff page's sections, so it should resolve.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(query): name resolution and lookup functions with provenance"
```

---

### Task 11: MCP server and smoke test

**Files:**
- Create: `src/server/mcp-server.ts`, `scripts/smoke-mcp.ts`, `.mcp.json.example`

**Interfaces:**
- Consumes: `openDbs` (Task 10); `search`, `getPage`, `whereIs`, `questSteps`, `itemStats`, `bossInfo`, `sourcesStatus` (Task 10); `cacheFextralife` (Task 9); `buildFixtureDb` (Task 10)
- Produces: stdio MCP server named `elden-ring` with tools `search`, `get_page`, `where_is`, `quest_steps`, `item_stats`, `boss`, `sources_status`. Env: `ELDEN_RING_MCP_DB`, `ELDEN_RING_MCP_CACHE`.

- [ ] **Step 1: `src/server/mcp-server.ts`**

```ts
// Elden Ring lookups over the shipped Fandom snapshot (data/elden-ring.db) plus the user's local Fextralife cache.
// Network access happens only when a tool is called with fetch: true (one Fextralife page into the local cache).
// Run: npx tsx src/server/mcp-server.ts (stdio; Claude Code spawns it via .mcp.json)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { openDbs } from '../query/dbs.js';
import { bossInfo, getPage, itemStats, questSteps, search, sourcesStatus, whereIs } from '../query/lookups.js';
import { cacheFextralife } from '../store/local.js';

const INSTRUCTIONS = `Elden Ring reference data from a versioned snapshot of eldenring.fandom.com (CC BY-SA 3.0), plus an optional per-user Fextralife page cache. Every result carries provenance (source, title, url, revid, fetched_at, license): cite it when answering. A result with not_found means the data does not cover it; say so instead of guessing, or retry with fetch: true to cache the Fextralife page. Fandom and Fextralife sometimes disagree on numbers; when both are present, show both with their sources. Directions from the wiki may omit prerequisites; state prerequisites the result lists.`;

const server = new McpServer({ name: 'elden-ring', version: '0.1.0' }, { instructions: INSTRUCTIONS });
const dbs = openDbs();

/** Drops null, undefined, empty arrays and empty objects so results carry only fields with content. */
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== 'object') return value;
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const clean = compact(field);
    const empty = clean === null || clean === undefined
      || (Array.isArray(clean) && !clean.length)
      || (typeof clean === 'object' && !Array.isArray(clean) && !Object.keys(clean).length);
    if (!empty) kept[key] = clean;
  }
  return kept;
}

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(compact(value)) }] });
const fail = (error: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: 'tool_failed', detail: error instanceof Error ? error.message : String(error) }) }], isError: true });

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
const MAY_FETCH = { readOnlyHint: false, idempotentHint: true, openWorldHint: true } as const;

const fetchArg = z.boolean().optional().describe('If true, first fetch this page from Fextralife into the local cache (network; local only, never shipped)');

/** Runs a lookup; with fetch: true, caches the Fextralife page for `title` first. */
async function withFetch<T>(title: string, fetch: boolean | undefined, lookup: () => T) {
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
  },
  annotations: READ_ONLY,
}, async ({ query, limit }) => { try { return reply(search(dbs, query, limit)); } catch (error) { return fail(error); } });

server.registerTool('get_page', {
  title: 'Get page',
  description: 'Returns a wiki page as markdown sections, or only sections whose heading contains `section` (e.g. "Acquisition", "Notes"). Resolves names via exact title, redirect, item/boss name, then search; `match` says which.',
  inputSchema: {
    title: z.string().min(1).describe('Page or item name'),
    section: z.string().optional().describe('Only sections whose heading contains this text'),
    fetch: fetchArg,
  },
  annotations: MAY_FETCH,
}, async ({ title, section, fetch }) => withFetch(title, fetch, () => getPage(dbs, title, section)));

server.registerTool('where_is', {
  title: 'Where is an item',
  description: 'How to get an item, spell, talisman or armor piece: method (drop/merchant/chest/quest/ground), nearest site of grace if the wiki names one, prerequisite sentences, missable flag, and the acquisition/location sections verbatim.',
  inputSchema: { name: z.string().min(1).describe('Item name, e.g. "Azur\'s Glintstone Staff"'), fetch: fetchArg },
  annotations: MAY_FETCH,
}, async ({ name, fetch }) => withFetch(name, fetch, () => whereIs(dbs, name)));

server.registerTool('quest_steps', {
  title: 'NPC quest steps',
  description: 'Ordered questline steps for an NPC (location + actions), per-step quest-breaking warnings, and warnings from the page notes. Falls back to quest sections when steps could not be parsed.',
  inputSchema: { npc: z.string().min(1).describe('NPC name, e.g. "Sorceress Sellen"'), fetch: fetchArg },
  annotations: MAY_FETCH,
}, async ({ npc, fetch }) => withFetch(npc, fetch, () => questSteps(dbs, npc)));

server.registerTool('item_stats', {
  title: 'Item stats',
  description: 'Requirements, scaling, weight and effects for weapons, spells, talismans and armor. Give `name` for one item, or filter: kind, scaling_stat + min_scaling (weapons), max_req per stat.',
  inputSchema: {
    name: z.string().optional().describe('One item by name'),
    kind: z.enum(['weapon', 'spell', 'talisman', 'armor']).optional(),
    scaling_stat: z.enum(['str', 'dex', 'int', 'fai', 'arc']).optional(),
    min_scaling: z.enum(['E', 'D', 'C', 'B', 'A', 'S']).optional(),
    max_req: z.object({ str: z.number(), dex: z.number(), int: z.number(), fai: z.number(), arc: z.number() }).partial().optional().describe('Only items whose requirement for each given stat is at or under this'),
    limit: z.number().int().min(1).max(100).optional(),
  },
  annotations: READ_ONLY,
}, async (args) => { try { return reply(itemStats(dbs, args)); } catch (error) { return fail(error); } });

server.registerTool('boss', {
  title: 'Boss info',
  description: 'Boss location, HP, runes and drops from the wiki infobox, plus overview/strategy/weakness sections. Names that redirect to a section of a shared page (e.g. "Magma Wyrm Makar") return that section.',
  inputSchema: { name: z.string().min(1), fetch: fetchArg },
  annotations: MAY_FETCH,
}, async ({ name, fetch }) => withFetch(name, fetch, () => bossInfo(dbs, name)));

server.registerTool('sources_status', {
  title: 'Data sources status',
  description: 'When the shipped data was last synced, how many pages it holds, how many extraction failures it has, and how many pages are in the local Fextralife cache.',
  inputSchema: {},
  annotations: READ_ONLY,
}, async () => { try { return reply(sourcesStatus(dbs)); } catch (error) { return fail(error); } });

await server.connect(new StdioServerTransport());
```

- [ ] **Step 2: `scripts/smoke-mcp.ts`**

```ts
// Dev check: builds a fixture db, spawns the MCP server over stdio against it, lists tools and calls each once.
// Exits non-zero on any tool error, not_found where data is expected, or tool-list budget overrun.
// Run: npm run smoke
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildFixtureDb } from '../test/fixtures/build-fixture-db.js';

const TOOL_LIST_BUDGET = 8_000;

const dir = mkdtempSync(join(tmpdir(), 'er-smoke-'));
const dbPath = process.env.ELDEN_RING_MCP_DB ?? join(dir, 'fixture.db');
if (!process.env.ELDEN_RING_MCP_DB) buildFixtureDb(dbPath).close();

const client = new Client({ name: 'elden-ring-smoke', version: '0.0.0' });
await client.connect(new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/server/mcp-server.ts'],
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, ELDEN_RING_MCP_DB: dbPath, ELDEN_RING_MCP_CACHE: join(dir, 'cache') } as Record<string, string>,
}));

let failures = 0;
const check = (ok: boolean, message: string) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`); };

const { tools } = await client.listTools();
const toolChars = JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length;
check(tools.length === 7, `${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
check(toolChars <= TOOL_LIST_BUDGET, `tool list ${toolChars} chars (budget ${TOOL_LIST_BUDGET})`);

const calls: [string, Record<string, unknown>][] = process.env.SMOKE_CALLS
  ? JSON.parse(process.env.SMOKE_CALLS)
  : [
      ['search', { query: 'damage sorceries' }],
      ['get_page', { title: "Azur's Glintstone Staff", section: 'Acquisition' }],
      ['where_is', { name: "Azur's Glintstone Staff" }],
      ['quest_steps', { npc: 'Sorceress Sellen' }],
      ['item_stats', { kind: 'weapon', scaling_stat: 'int', min_scaling: 'C' }],
      ['boss', { name: 'Magma Wyrm Makar' }],
      ['sources_status', {}],
    ];

for (const [name, args] of calls) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text?: string }[]).map((part) => part.text ?? '').join('\n');
  check(!result.isError && !text.includes('"not_found":true') && (name === 'sources_status' || text.includes('"provenance"')), `${name} ${JSON.stringify(args)} (${text.length} chars)`);
  console.log(`     ${text.slice(0, 300)}`);
}

await client.close();
process.exit(failures ? 1 : 0);
```

`SMOKE_CALLS` lets Task 13 run the real acceptance questions against the real db through the same script.

- [ ] **Step 3: `.mcp.json.example`**

```json
{
  "mcpServers": {
    "elden-ring": {
      "command": "npx",
      "args": ["tsx", "src/server/mcp-server.ts"],
      "cwd": "/absolute/path/to/elden-ring-mcp"
    }
  }
}
```

- [ ] **Step 4: Run smoke + tests**

Run: `npm run smoke && npm test && npm run typecheck`
Expected: 9 `ok` lines (tool count, budget, 7 calls), exit 0; tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): MCP stdio server with 7 lookup tools and smoke test"
```

---

### Task 12: Docs, data release download, CI

**Files:**
- Create: `README.md`, `CONTRIBUTING.md`, `data/LICENSE`, `scripts/attribution.ts`, `scripts/fetch-data.ts`, `.github/workflows/ci.yml`, `.github/workflows/weekly-data.yml`

**Interfaces:**
- Consumes: `openDb`, `DEFAULT_DB_PATH`; npm scripts from Tasks 5, 8, 11
- Produces: `npm run fetch-data` (downloads `elden-ring.db` from the latest GitHub release whose tag starts with `data-`); `npm run attribution` (writes `data/ATTRIBUTION.md`)

- [ ] **Step 1: `scripts/attribution.ts`** (add `"attribution": "tsx scripts/attribution.ts"` to package.json scripts)

```ts
// Writes data/ATTRIBUTION.md: one line per shipped page with its URL and revision, as CC BY-SA requires.
// Run: npm run attribution
import { writeFileSync } from 'node:fs';
import { openDb } from '../src/db/open.js';
import { DEFAULT_DB_PATH } from '../src/store/pages.js';

const db = openDb(process.env.ELDEN_RING_MCP_DB ?? DEFAULT_DB_PATH, { readonly: true });
const rows = db.prepare("SELECT title, url, revid FROM pages WHERE source = 'fandom' ORDER BY title").all() as { title: string; url: string; revid: number }[];
writeFileSync('data/ATTRIBUTION.md', [
  '# Attribution',
  '',
  `Text in \`elden-ring.db\` is adapted from the Elden Ring Wiki at Fandom (https://eldenring.fandom.com), licensed CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/). Authors are listed in each page's history. Converted from wikitext to markdown and parsed into tables.`,
  '',
  ...rows.map((r) => `- [${r.title}](${r.url}) (revision ${r.revid})`),
  '',
].join('\n'));
console.log(`attributed ${rows.length} pages`);
```

- [ ] **Step 2: `scripts/fetch-data.ts`**

```ts
// Downloads data/elden-ring.db from the newest GitHub release tagged data-*.
// Run: npm run fetch-data   (set ELDEN_RING_MCP_REPO=owner/name if not the default remote)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_DB_PATH } from '../src/store/pages.js';

const repo = process.env.ELDEN_RING_MCP_REPO
  ?? execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim().replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
const releases = await (await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers: { Accept: 'application/vnd.github+json' } })).json() as { tag_name: string; assets: { name: string; browser_download_url: string }[] }[];
const release = releases.find((r) => r.tag_name.startsWith('data-'));
const asset = release?.assets.find((a) => a.name === 'elden-ring.db');
if (!release || !asset) { console.error(`No data-* release with elden-ring.db in ${repo}`); process.exit(1); }
const bytes = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
mkdirSync('data', { recursive: true });
writeFileSync(DEFAULT_DB_PATH, bytes);
console.log(`downloaded ${release.tag_name} (${(bytes.length / 1e6).toFixed(1)} MB) to ${DEFAULT_DB_PATH}`);
```

- [ ] **Step 3: `data/LICENSE`**

```
Data files derived from the Elden Ring Wiki (https://eldenring.fandom.com) are licensed under
Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0):
https://creativecommons.org/licenses/by-sa/3.0/legalcode

Per-page attribution: data/ATTRIBUTION.md. Changes: wikitext converted to markdown; infobox fields parsed into tables.
```

- [ ] **Step 4: `README.md`**

````markdown
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
````

- [ ] **Step 5: `CONTRIBUTING.md`**

````markdown
# Contributing

## Setup
`npm install && npm test && npm run smoke`

## Adding an extractor
1. Save a trimmed real page's wikitext into `test/fixtures/wikitext.ts` (fetch with
   `https://eldenring.fandom.com/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=<Title>`).
2. Add a table to `src/db/schema.sql` with `page_id INTEGER PRIMARY KEY` and add the table name to `DERIVED_TABLES` in `src/db/open.ts`.
3. Create `src/extract/<name>.ts` exporting an `Extractor` (`matches`, `write`). Use `findInfobox`, `text`, `num`, `scale`, `sectionMarkdown`, `addEntity`.
4. Register it in `src/extract/registry.ts`.
5. Write tests in `test/` for a normal page and a malformed page.
6. If the table should appear in the data changelog, add it to `TYPED_TABLES` in `src/changelog.ts`.
7. `npm test && npm run typecheck && npm run smoke`, then open a PR.

## Rules
- Never commit Fextralife content or anything from `~/.cache/elden-ring-mcp/`.
- No live network calls in tests.
- Every tool result must include provenance.
- Log decisions in `NOTES.md` (dated).
````

- [ ] **Step 6: `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run smoke
```

- [ ] **Step 7: `.github/workflows/weekly-data.yml`**

```yaml
name: weekly-data
on:
  schedule:
    - cron: '17 6 * * 1'
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: Restore previous db
        env: { GH_TOKEN: '${{ github.token }}' }
        run: npm run fetch-data || echo "no previous release; full build"
      - run: npm run build
      - run: npm run attribution
      - name: Publish release
        env: { GH_TOKEN: '${{ github.token }}' }
        run: |
          TAG="data-$(date -u +%Y.%m.%d)"
          gh release create "$TAG" data/elden-ring.db --title "$TAG" --notes-file data/CHANGELOG-data.md
      - name: Open PR with changelog
        uses: peter-evans/create-pull-request@v6
        with:
          branch: data/weekly
          commit-message: 'data: weekly sync'
          title: 'data: weekly sync'
          body: 'Automated Fandom sync. Release: data-${{ github.run_id }}. See data/CHANGELOG-data.md.'
          add-paths: |
            data/CHANGELOG-data.md
            data/ATTRIBUTION.md
```

- [ ] **Step 8: Verify and commit**

Run: `npm test && npm run typecheck && npm run smoke`
Expected: PASS.

```bash
git add -A && git commit -m "docs: README, contributing, data license; ci and weekly data workflows"
```

---

### Task 13: First real build and acceptance questions

**Files:**
- Modify: `data/CHANGELOG-data.md`, `data/ATTRIBUTION.md`, `NOTES.md`
- No new source files unless a failure below requires a fix (fix with a test first).

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: logs `revisions: ~4922 new`, fetch progress to completion, `redirects: N`, final JSON with `touched` ≈ 4922 and non-zero `rows.weapon`, `rows.spell`, `rows.talisman`, `rows.armor`, `rows.boss`, `rows.acquisition`, `rows.quest`.

- [ ] **Step 2: Incremental check (spec "done" criterion)**

Run: `npm run sync`
Expected: final JSON `{"added":0,"changed":<small>,"removed":0,"unchanged":~4922}`. Only pages edited in the minutes since Step 1 may appear as changed.

- [ ] **Step 3: Extraction quality check**

Run:
```bash
sqlite3 data/elden-ring.db "SELECT extractor, count(*) FROM extract_failures GROUP BY extractor;
SELECT 'weapons', count(*) FROM weapons UNION ALL SELECT 'spells', count(*) FROM spells UNION ALL SELECT 'talismans', count(*) FROM talismans UNION ALL SELECT 'armor', count(*) FROM armor UNION ALL SELECT 'bosses', count(*) FROM bosses UNION ALL SELECT 'quests(npcs)', count(DISTINCT npc) FROM quests;"
```
Expected: failures under 2% of pages per extractor; weapons > 300, spells > 150, talismans > 100, armor > 500, bosses > 50, quest NPCs > 20 (base game + DLC pages on Fandom). If an extractor has many failures, pick three failing titles, add a fixture + test reproducing each, fix, and re-run `npm run extract`.

- [ ] **Step 4: Acceptance questions through the real server**

Run:
```bash
ELDEN_RING_MCP_DB=data/elden-ring.db SMOKE_CALLS='[
 ["where_is", {"name": "Azur'"'"'s Glintstone Staff"}],
 ["quest_steps", {"npc": "Sorceress Sellen"}],
 ["search", {"query": "Comet Azur damage"}],
 ["boss", {"name": "Magma Wyrm Makar"}],
 ["where_is", {"name": "Graven-School Talisman"}]
]' npm run smoke
```
Expected: all `ok`, each result containing provenance. Read the output and confirm by eye:
- Azur staff mentions Church of the Cuckoo.
- Sellen has ≥ 4 steps including Witchbane Ruins.
- The search surfaces Azur's Glintstone Crown (+15%).
- Makar returns the Magma Wyrm page's boss section.
- Graven-School mentions Raya Lucaria.
Any miss: reproduce with a fixture test, fix, rebuild.

- [ ] **Step 5: Attribution and notes**

Run: `npm run attribution`

Append to `NOTES.md` under a new dated heading: page count, db size (`ls -lh data/elden-ring.db`), per-extractor row and failure counts from Step 3, and any fixes made in Step 4.

- [ ] **Step 6: Commit**

```bash
git add data/CHANGELOG-data.md data/ATTRIBUTION.md NOTES.md
git commit -m "data: first full Fandom build (db published as release, not committed)"
```

Publishing the first `data-YYYY.MM.DD` release requires a GitHub remote. Ask Teo before creating the repo or release; that's outward-facing.
