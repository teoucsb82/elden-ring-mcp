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

export type ParryVerdict = 'yes' | 'no' | null;

/**
 * The wiki's own parry claim: the infobox `parry` field first (most are left blank), then the stats
 * bullet ("Cannot be [[Parrying|parried]]"). null means the page says nothing, not "no".
 */
export function parryFromWikitext(wikitext: string | null): ParryVerdict {
  if (!wikitext) return null;
  const field = findInfobox(wikitext, ['Infobox Boss', 'Infobox Character'])?.params.parry?.trim().toLowerCase();
  if (field?.startsWith('yes')) return 'yes';
  if (field?.startsWith('no')) return 'no';
  const plain = wikitext.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1');
  if (/^\s*\*\s*cannot be parried\b/im.test(plain)) return 'no';
  if (/^\s*\*\s*can be parried\b/im.test(plain)) return 'yes';
  return null;
}
