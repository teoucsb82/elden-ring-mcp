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
