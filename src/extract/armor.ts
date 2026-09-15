import { findInfobox } from '../wikitext/infobox.js';
import { addEntity, num, text } from './common.js';
import type { Extractor } from './types.js';

const NAMES = ['Infobox Armor'];

export const armorExtractor: Extractor = {
  name: 'armor',
  matches: (page) => !!page.wikitext && findInfobox(page.wikitext, NAMES) !== null,
  write(db, page) {
    const f = findInfobox(page.wikitext!, NAMES)!.params;
    const name = text(f.title) ?? page.title;
    db.prepare('INSERT INTO armor (page_id, name, slot, weight, poise, effects) VALUES (?, ?, ?, ?, ?, ?)')
      .run(page.id, name, text(f.type), num(f.weight), num(f.poise), text(f.effects));
    addEntity(db, page.id, 'armor', name);
  },
};
