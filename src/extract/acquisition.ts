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
  if (/\b(quest|questline)\b/.test(lower)) return 'quest';
  if (/\b(found|corpse|ground|loot|pick(ed)? up|interacting with)\b/.test(lower)) return 'ground';
  return 'other';
}

export function parseAcquisition(markdown: string): Acquisition {
  const graceMatch = /([A-Z][A-Za-z'’\- ]{2,60}?) [Ss]ite of [Gg]race/.exec(markdown);
  let nearest_grace = graceMatch ? graceMatch[1].replace(/^(?:(?:from|at|rest at|near|the)\s+)+/i, '').trim() : null;
  if (nearest_grace && (/\bnearest\b/i.test(nearest_grace) || nearest_grace.length < 3)) nearest_grace = null;
  const sentences = markdown.split('\n').flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z])/)).map((s) => s.trim()).filter(Boolean);
  const prereqs = sentences.filter((s) => /\b(after|must|requires?|required|upon completing|once you|only (?:after|once|when))\b/i.test(s));
  const missable = /\bmissable\b|no longer (?:be )?(?:available|obtainable)|cannot be obtained (?:after|once)|permanently (?:lost|lose|loses|missed|missable|unavailable|unobtainable|fail(?:s|ed)?|locked|unable|gone)/i.test(markdown);
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
