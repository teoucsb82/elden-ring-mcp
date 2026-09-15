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
