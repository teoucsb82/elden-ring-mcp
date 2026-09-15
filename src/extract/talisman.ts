import { findInfobox, type Infobox } from '../wikitext/infobox.js';
import { addEntity, num, sectionMarkdown, text } from './common.js';
import type { Extractor, PageRow } from './types.js';

function talismanBox(page: PageRow): Infobox | null {
  const box = page.wikitext ? findInfobox(page.wikitext, ['Infobox Item']) : null;
  return box && (text(box.params.type) ?? '').toLowerCase() === 'talisman' ? box : null;
}

export const talismanExtractor: Extractor = {
  name: 'talisman',
  matches: (page) => talismanBox(page) !== null,
  write(db, page) {
    const f = talismanBox(page)!.params;
    const name = text(f.title) ?? page.title;
    db.prepare('INSERT INTO talismans (page_id, name, weight, effect, summary) VALUES (?, ?, ?, ?, ?)')
      .run(page.id, name, num(f.weight), text(f.item_effect), sectionMarkdown(db, page.id, /^Summary$/));
    addEntity(db, page.id, 'talisman', name);
  },
};
