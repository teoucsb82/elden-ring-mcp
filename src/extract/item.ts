import { findInfobox, type Infobox } from '../wikitext/infobox.js';
import { addEntity, text } from './common.js';
import type { Extractor, PageRow } from './types.js';

/** Infobox Item types that already have their own table. */
const OWN_TABLE = new Set(['sorcery', 'incantation', 'talisman']);

/** Tools, Ashes of War, crystal tears, cookbooks, consumables: every Infobox Item the typed extractors skip. */
function itemBox(page: PageRow): Infobox | null {
  const box = page.wikitext ? findInfobox(page.wikitext, ['Infobox Item']) : null;
  const type = box ? text(box.params.type) : null;
  return box && type && !OWN_TABLE.has(type.toLowerCase()) ? box : null;
}

export const itemExtractor: Extractor = {
  name: 'item',
  matches: (page) => itemBox(page) !== null,
  write(db, page) {
    const f = itemBox(page)!.params;
    // "Ash of War: <br>Lion's Claw" renders with a stray space; the page title is the clean name.
    const name = (text(f.title) ?? page.title).replace(/:\s+/g, ': ');
    db.prepare('INSERT INTO items (page_id, name, item_type, sub_type, effect, fp_cost, affinity, obtained) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(page.id, name, text(f.type), text(f.sub_type), text(f.item_effect), text(f.fp_cost), text(f.affinity), text(f.obtained));
    addEntity(db, page.id, 'item', name);
  },
};
