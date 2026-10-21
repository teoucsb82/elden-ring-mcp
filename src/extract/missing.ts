import { missingData } from './common.js';
import type { Extractor } from './types.js';

export const missingDataExtractor: Extractor = {
  name: 'missing_data',
  matches: (page) => missingData(page.wikitext).length > 0,
  write(db, page) {
    db.prepare('INSERT INTO missing_data (page_id, fields) VALUES (?, ?)').run(page.id, JSON.stringify(missingData(page.wikitext)));
  },
};
