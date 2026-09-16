# elden-ring-mcp: npm distribution

Date: 2026-09-15
Status: approved, ready for implementation plan

## Goal

A stranger adds five lines to `.mcp.json` and gets a working Elden Ring MCP
server. No clone, no `npm install`, no manual data step, no Node version
folklore.

Target install:

```json
{ "mcpServers": { "elden-ring": { "command": "npx", "args": ["-y", "elden-ring-mcp"] } } }
```

## Why this is not just "npm publish"

Four things in the current repo break the moment the code runs outside a
developer's checkout:

1. **`DEFAULT_DB_PATH` is the relative string `data/elden-ring.db`.** An npx
   user's cwd is wherever their editor launched the server. The path resolves
   to nothing and `openDbs()` silently returns `shipped: null`.
2. **`better-sqlite3@13` requires Node >= 22 and segfaults on Node 20** when
   its N-API 10 prebuild registers against a Node that only speaks N-API 9. The
   crash is `SIGSEGV` inside `napi_module_register_by_symbol`, with no stderr.
   `engines` does not prevent this: `npx` warns at most.
3. **The 54 MB database cannot ship in the npm tarball** and cannot be fetched
   synchronously at startup without blowing the MCP client's handshake timeout.
4. **`scripts/fetch-data.ts` derives the repo from `git remote get-url
   origin`.** There is no git remote inside `node_modules`.

Each gets a section below.

## 1. Package shape

| Field | Value |
|---|---|
| `bin` | `{ "elden-ring-mcp": "dist/server/cli.js" }` |
| `files` | `["dist"]` |
| `main` | unset (this is an executable, not a library) |
| `engines.node` | `>=22` (already correct) |
| `repository` | `{ "type": "git", "url": "git+https://github.com/teoucsb82/elden-ring-mcp.git" }` |
| `bugs` | `https://github.com/teoucsb82/elden-ring-mcp/issues` |
| `homepage` | `https://github.com/teoucsb82/elden-ring-mcp#readme` |
| `keywords` | `["mcp", "model-context-protocol", "elden-ring", "claude"]` |

`repository` is not decoration: npm provenance attestation requires it to match
the publishing repository, and the workflow in section 5 fails without it.

New `tsconfig.build.json` extends the root config and overrides:
`noEmit: false`, `outDir: "dist"`, `include: ["src"]`, `declaration: false`.

The root `tsconfig.json` keeps `noEmit: true` and its `src` + `scripts` +
`test` include list. It is the typecheck config and nothing else. Two configs
because the published artifact must not contain tests, scripts, or the
`scripts/` tree's dev-only imports.

Scripts added to `package.json`:

- `compile`: `tsc -p tsconfig.build.json`
- `prepublishOnly`: `npm run compile`

`prepublishOnly` runs on `npm publish` but not on `npm ci`, so contributors
never pay for it.

### Data is not in the tarball

`files: ["dist"]` excludes `data/`. The database arrives at runtime
(section 4). This keeps the package around 200 KB and decouples data refreshes
from version bumps — a new `data-YYYY.MM.DD` release reaches every existing
install without a republish.

## 2. The Node version guard needs its own entry file

The obvious implementation — check `process.versions.node` at the top of
`mcp-server.ts` — does not work. ESM hoists all `import` statements above
module body code, so `better-sqlite3` loads and segfaults before the check
runs. The process dies without printing the guard's message.

Therefore `src/server/cli.ts`, the `bin` target, contains only:

```ts
#!/usr/bin/env node
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(
    `elden-ring-mcp requires Node 22 or newer (found ${process.versions.node}).\n` +
    `Its sqlite driver ships an N-API 10 binary that crashes older runtimes.`
  );
  process.exit(1);
}
await import('./start.js');
```

No static imports. The dynamic `import()` is what defers `better-sqlite3`
past the check. This file exists for exactly this reason and should carry a
comment saying so, because it looks like pointless indirection otherwise.

`mcp-server.ts` loses its `#!/usr/bin/env node` responsibilities. It is no
longer otherwise unchanged in structure, though: it now only builds the
server and exports `startStdio()`, and the separate `src/server/start.ts`
makes the explicit call that starts stdio — which is what `cli.ts` imports
above, rather than importing `mcp-server.js` and duplicating that call.

## 3. Two database paths, split by purpose

The single `DEFAULT_DB_PATH` constant serves two incompatible callers. Split
them.

**Build-time (unchanged).** `scripts/sync.ts`, `extract.ts`, `build.ts`,
`attribution.ts` keep importing `DEFAULT_DB_PATH` from `src/store/pages.ts`.
These only ever run from a checkout with cwd at the repo root. The relative
path is correct for them.

**Runtime (new).** `src/store/db-path.ts` exports `resolveShippedDbPath()`,
which returns the first of:

1. `process.env.ELDEN_RING_MCP_DB` — explicit override, absolute or relative
   to cwd, wins unconditionally.
2. `join(cacheDir(), 'elden-ring.db')` — where the background download writes.
   `cacheDir()` is `ELDEN_RING_MCP_CACHE` or `~/.cache/elden-ring-mcp`, the
   same directory `localDbPath()` already uses.
3. The repo's `data/elden-ring.db`, resolved from the package root via
   `new URL('../../data/elden-ring.db', import.meta.url)` — **not** from cwd.
   This is the contributor case: a checkout that ran `npm run fetch-data`.
   Absent in a published install, which is fine; it is the last candidate.

Resolution rules, precisely: candidate 1 is returned as-is if the env var is
set, existing or not — an explicit override must not be silently ignored.
Otherwise candidates 2 and 3 are probed for existence in order and the first
that exists wins. If neither exists, candidate 2 is returned, because that is
where the downloader will write.

So the returned path is not guaranteed to exist. `openDbs()` keeps its
existing `existsSync` guard and its `shipped: Db | null` shape.

## 4. Background download

### Behaviour

Startup never blocks. `server.connect()` runs immediately, the handshake
completes in milliseconds, and the download proceeds alongside it. This is the
whole point: a synchronous 54 MB fetch would hit Claude Code's startup timeout
and surface as `CONNECTION_CLOSED`, which is indistinguishable from a crash.

On startup, after `openDbs()`:

- If `dbs.shipped` is non-null, status is `ready`. Nothing downloads.
- If it is null, kick off the download and set status to `downloading`.

### State

`src/store/fetch-db.ts` owns a module-level record:

```ts
type DataStatus =
  | { status: 'ready' }
  | { status: 'downloading'; percent: number }
  | { status: 'failed'; error: string };
```

`percent` comes from the response's `content-length` and bytes read so far.
When `content-length` is absent, report `percent: 0` rather than guessing.

Single-flight: a second call while a download is in progress returns the
existing promise. The server only calls it once, but the exported function is
also used by `scripts/fetch-data.ts` and should not be foot-gun shaped.

### Atomicity

Download to `elden-ring.db.part`, `fsync`, then `rename()` onto the final
path. A rename within one filesystem is atomic, so a killed process never
leaves a truncated database that `openDb(..., {fileMustExist: true})` would
happily open and then fail strange queries against. On completion, reopen the
database and swap it into the shared `Dbs` object so tools pick it up without
a restart.

A stale `.part` file from a previous killed run is overwritten, not resumed.
Resumable downloads are not worth the complexity for a one-time 54 MB fetch.

### Tool responses while downloading

Every tool currently distinguishes a hit from `not_found`. `not_found` is a
factual claim — "the data does not cover this" — and the server must not make
that claim when the data is not there yet. The MCP instructions already tell
the model to trust `not_found` and say so instead of guessing, which makes a
wrong `not_found` actively harmful.

So: when the shipped database is unavailable and the local Fextralife cache
produces no answer, tools return

```json
{ "status": "data_downloading", "percent": 41 }
```

and, on a failed download,

```json
{ "status": "data_unavailable", "error": "..." }
```

A hit from the local Fextralife cache is still returned normally — a user who
passed `fetch: true` gets a real answer even mid-download.

`sources_status` gains the same status field so the model can check directly.

The `INSTRUCTIONS` string gains one sentence: a `data_downloading` result means
the reference data is still being fetched, not that the subject is missing, and
the tool should be retried shortly.

### Repo resolution

`fetch-data.ts`'s `resolveRepo()` moves into `fetch-db.ts` with the git
fallback replaced by the hardcoded constant `teoucsb82/elden-ring-mcp`.
`ELDEN_RING_MCP_REPO`
still overrides it, which is what forks use. The `git remote` probe is deleted
outright: it cannot work from `node_modules` and its failure mode (exit 1 with
a message about setting an env var) would be baffling to someone who never
cloned anything.

The existing exit-code contract of `scripts/fetch-data.ts` (0 downloaded, 2 no
release yet, 1 error) is preserved; the script becomes a thin wrapper over the
shared function.

## 5. Publish workflow

`.github/workflows/publish.yml`, triggered on tags matching `v*`:

```yaml
permissions:
  contents: read
  id-token: write   # npm provenance
```

Steps: checkout, setup-node 24 with `registry-url: https://registry.npmjs.org`,
`npm ci`, `npm run typecheck`, `npm test`, `npm run smoke`, `npm publish
--provenance --access public`, with `NODE_AUTH_TOKEN` from an `NPM_TOKEN`
secret.

The full test suite runs before publish rather than trusting the CI run on the
commit, because a tag can point at a commit whose CI never ran.

Manual prerequisites, which the implementer cannot do and must surface:

1. Create the npm account / confirm `elden-ring-mcp` is still unclaimed.
2. Generate a granular automation token scoped to this package.
3. Add it as the `NPM_TOKEN` repository secret.

## 6. Documentation

**`README.md`** — the Quick start section is replaced. New order:

1. The `npx -y elden-ring-mcp` `.mcp.json` snippet, stated as the whole
   install.
2. One short paragraph: first launch downloads ~54 MB to
   `~/.cache/elden-ring-mcp/`; tools report `data_downloading` until it lands.
3. Requirements: Node 22+.
4. Everything from "Building data yourself" onward moves under a **Contributing
   / building from source** heading, where the clone + `npm install` +
   `npm run fetch-data` flow lives.

**`.mcp.json.example`** — replaced with the npx form. The `cwd`-based form
stays as a commented-out alternative for contributors running from a checkout.

**`CONTRIBUTING.md`** — gains a short release section: bump version, tag `vX.Y.Z`,
push the tag, the workflow publishes.

## Testing

| What | How |
|---|---|
| Version guard | Run `cli.js` under a stubbed `process.versions.node`; assert exit 1 and the message. Cannot spawn a real Node 20, so the check is extracted into a pure `assertNodeVersion(version)` that the test calls directly, with `cli.ts` passing the real value. |
| Path precedence | `resolveShippedDbPath()` against a temp dir: env override wins; cache file beats repo file; neither present returns the cache path. |
| Download atomicity | Point the downloader at a local HTTP fixture; assert no file at the final path until completion, and that a `.part` file existed mid-flight. |
| Tool responses | With `shipped: null` and status `downloading`, assert each tool returns `data_downloading` and not `not_found`. |
| Packaging | `npm pack --dry-run` in CI; assert `dist/server/cli.js` is present and `data/` is absent. |

The existing `scripts/smoke-mcp.ts` continues to run against the fixture db via
`ELDEN_RING_MCP_DB`, which the new resolution order honours first.

## Out of scope

Issue and PR templates, `CODE_OF_CONDUCT.md`, `SECURITY.md`, README badges, a
user-facing `CHANGELOG.md`, and release automation such as release-please.
Deliberately deferred; the goal here is a package that installs and runs.

## Known loose end

The working tree currently has an unrelated cosmetic reformat of
`package.json` (the `engines` object expanded across three lines) and a
correction in `package-lock.json` (`engines.node` `>=20` → `>=22`, which had
drifted from `package.json`). The lockfile change is correct and should be
kept. The `package.json` reformat should be reverted before the first
implementation commit.
