import { armorExtractor } from './armor.js';
import { bossExtractor } from './boss.js';
import { spellExtractor } from './spell.js';
import { talismanExtractor } from './talisman.js';
import type { Extractor } from './types.js';
import { weaponExtractor } from './weapon.js';

/** Order matters only for readability; extractors write to separate tables. Add new extractors here. */
export const EXTRACTORS: Extractor[] = [weaponExtractor, spellExtractor, talismanExtractor, armorExtractor, bossExtractor];
