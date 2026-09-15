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
