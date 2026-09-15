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
