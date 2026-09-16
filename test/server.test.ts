import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compact } from '../src/server/compact.js';

test('compact drops null, undefined and empty containers', () => {
  assert.deepEqual(compact({ a: 1, b: null, c: undefined, d: [], e: {}, f: 'x' }), { a: 1, f: 'x' });
});

test('compact keeps false, 0 and empty strings, which are answers and not absences', () => {
  // whereIs returns missable: false, and an infobox can legitimately say 0.
  assert.deepEqual(compact({ missable: false, runes: 0, note: '' }), { missable: false, runes: 0, note: '' });
});

test('compact recurses into nested objects and arrays', () => {
  const value = {
    provenance: { title: 'Uchigatana', revid: null },
    sections: [{ heading: 'Acquisition', markdown: 'text', extra: null }],
    acquisition: { prereqs: [], nearest_grace: 'Debate Parlor' },
  };
  assert.deepEqual(compact(value), {
    provenance: { title: 'Uchigatana' },
    sections: [{ heading: 'Acquisition', markdown: 'text' }],
    acquisition: { nearest_grace: 'Debate Parlor' },
  });
});

test('compact drops a nested object that empties out, but keeps the parent', () => {
  assert.deepEqual(compact({ match: 'exact', boss: { hp: null, runes: null } }), { match: 'exact' });
});

test('compact leaves a not_found result intact', () => {
  const miss = { not_found: true, query: 'zzqx', reason: 'no_sections', hint: 'try fetch: true' };
  assert.deepEqual(compact(miss), miss);
});

test('compact passes primitives and arrays of primitives through', () => {
  assert.equal(compact('x'), 'x');
  assert.equal(compact(0), 0);
  assert.equal(compact(null), null);
  assert.deepEqual(compact(['a', 'b']), ['a', 'b']);
});
