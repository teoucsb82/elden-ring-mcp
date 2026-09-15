import { openDb, type Db } from '../src/db/open.js';
export const memoryDb = (): Db => openDb(':memory:');
