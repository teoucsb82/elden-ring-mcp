import { findInfobox, type Infobox } from '../wikitext/infobox.js';
import { addEntity, num, text } from './common.js';
import type { Extractor, PageRow } from './types.js';

const SPELL_TYPES = new Set(['sorcery', 'incantation']);

function spellBox(page: PageRow): Infobox | null {
  const box = page.wikitext ? findInfobox(page.wikitext, ['Infobox Item']) : null;
  return box && SPELL_TYPES.has((text(box.params.type) ?? '').toLowerCase()) ? box : null;
}

export const spellExtractor: Extractor = {
  name: 'spell',
  matches: (page) => spellBox(page) !== null,
  write(db, page) {
    const f = spellBox(page)!.params;
    const name = text(f.title) ?? page.title;
    db.prepare(`INSERT INTO spells (page_id, name, spell_type, sub_type, fp_cost, stamina_cost, slots_used, int_req, fai_req, arc_req, effect)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      page.id, name, text(f.type), text(f.sub_type), text(f.fp_cost), num(f.stamina_cost), num(f.slots_used), num(f.int_req), num(f.fai_req), num(f.arc_req), text(f.item_effect),
    );
    addEntity(db, page.id, 'spell', name);
  },
};
