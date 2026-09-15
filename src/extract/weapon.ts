import { findInfobox } from '../wikitext/infobox.js';
import { addEntity, num, scale, text } from './common.js';
import type { Extractor } from './types.js';

const NAMES = ['Infobox Weapon'];

export const weaponExtractor: Extractor = {
  name: 'weapon',
  matches: (page) => !!page.wikitext && findInfobox(page.wikitext, NAMES) !== null,
  write(db, page) {
    const f = findInfobox(page.wikitext!, NAMES)!.params;
    const name = text(f.title) ?? page.title;
    db.prepare(`INSERT INTO weapons (page_id, name, weapon_type, weight, str_req, dex_req, int_req, fai_req, arc_req,
      str_scale, dex_scale, int_scale, fai_scale, arc_scale, sorcery_scaling, incant_scaling, skill, effects)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      page.id, name, text(f.type), num(f.weight), num(f.str_req), num(f.dex_req), num(f.int_req), num(f.fai_req), num(f.arc_req),
      scale(f.str_scale), scale(f.dex_scale), scale(f.int_scale), scale(f.fai_scale), scale(f.arc_scale),
      num(f.sorcery_scaling), num(f.incant_scaling), text(f.skills), text(f.effects),
    );
    addEntity(db, page.id, 'weapon', name);
  },
};
