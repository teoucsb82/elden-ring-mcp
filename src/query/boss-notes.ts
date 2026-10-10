import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_NOTES_PATH = fileURLToPath(new URL('../../data/boss-notes.json', import.meta.url));

export interface BossEncounter {
  encounter: string;
  aliases?: string[];
  dlc: boolean;
  parryable: 'yes' | 'no' | 'some';
  detail?: string;
  exceptions?: string[];
  checked_against: string;
  checked: string;
}

export type BossNotes = Map<string, BossEncounter[]>;

let cached: BossNotes | null = null;

/**
 * Hand-checked notes, keyed by lowercased Fandom page title. Read at query time, not extract time,
 * so a new note needs a server restart and nothing else. A missing or malformed file means no notes:
 * these only add to an answer, so losing them must never take the boss tool down.
 */
export function loadBossNotes(path: string = DEFAULT_NOTES_PATH): BossNotes {
  const notes: BossNotes = new Map();
  try {
    const pages = (JSON.parse(readFileSync(path, 'utf8')) as { pages?: Record<string, unknown> }).pages ?? {};
    for (const [title, encounters] of Object.entries(pages)) {
      if (Array.isArray(encounters)) notes.set(title.toLowerCase(), encounters as BossEncounter[]);
    }
  } catch {
    // fall through with whatever loaded
  }
  return notes;
}

export const bossNotes = (): BossNotes => (cached ??= loadBossNotes());

/** Test seam: install notes (or null to reload from disk on next use). */
export function setBossNotes(notes: BossNotes | null): void {
  cached = notes;
}

const names = (e: BossEncounter) => [e.encounter, ...(e.aliases ?? [])].map((n) => n.toLowerCase());

/** The page's encounters, or failing that any page's encounter the query names directly. */
export function encountersFor(notes: BossNotes, pageTitle: string, query: string): BossEncounter[] | null {
  const byPage = notes.get(pageTitle.toLowerCase());
  if (byPage) return byPage;
  const q = query.trim().toLowerCase();
  for (const encounters of notes.values()) if (encounters.some((e) => names(e).includes(q))) return encounters;
  return null;
}

export const namesQuery = (e: BossEncounter, query: string) => names(e).includes(query.trim().toLowerCase());
