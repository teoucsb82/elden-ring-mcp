import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RawPage } from '../src/types.js';

test('RawPage type compiles and holds provenance', () => {
  const page: RawPage = { source: 'fandom', title: 'X', url: 'u', revid: 1, fetchedAt: '2026-09-15T00:00:00Z', wikitext: '', markdown: null, license: 'CC BY-SA 3.0' };
  assert.equal(page.source, 'fandom');
});
