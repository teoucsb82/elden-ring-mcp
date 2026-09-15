import { acquisitionExtractor } from './acquisition.js';
import { armorExtractor } from './armor.js';
import { bossExtractor } from './boss.js';
import { questExtractor } from './quest.js';
import { spellExtractor } from './spell.js';
import { talismanExtractor } from './talisman.js';
import type { Extractor } from './types.js';
import { weaponExtractor } from './weapon.js';

/** Each extractor writes its own table(s). Add new extractors here. */
export const EXTRACTORS: Extractor[] = [
  weaponExtractor, spellExtractor, talismanExtractor, armorExtractor, bossExtractor, acquisitionExtractor, questExtractor,
];
