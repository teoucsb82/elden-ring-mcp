CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  revid INTEGER,
  fetched_at TEXT NOT NULL,
  license TEXT NOT NULL,
  patch TEXT,
  wikitext TEXT,
  UNIQUE (source, title)
);
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  heading TEXT NOT NULL,
  markdown TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sections_page ON sections (page_id, ord);
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5 (title, heading, markdown, tokenize = 'porter unicode61');
CREATE TABLE IF NOT EXISTS redirects (
  source TEXT NOT NULL,
  from_title TEXT NOT NULL,
  to_title TEXT NOT NULL,
  fragment TEXT,
  PRIMARY KEY (source, from_title)
);
CREATE TABLE IF NOT EXISTS entities (
  page_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (page_id, type)
);
CREATE INDEX IF NOT EXISTS entities_name ON entities (name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS weapons (
  page_id INTEGER PRIMARY KEY, name TEXT NOT NULL, weapon_type TEXT, weight REAL,
  str_req INTEGER, dex_req INTEGER, int_req INTEGER, fai_req INTEGER, arc_req INTEGER,
  str_scale TEXT, dex_scale TEXT, int_scale TEXT, fai_scale TEXT, arc_scale TEXT,
  sorcery_scaling INTEGER, incant_scaling INTEGER, skill TEXT, effects TEXT
);
CREATE TABLE IF NOT EXISTS spells (
  page_id INTEGER PRIMARY KEY, name TEXT NOT NULL, spell_type TEXT, sub_type TEXT,
  fp_cost TEXT, stamina_cost INTEGER, slots_used INTEGER,
  int_req INTEGER, fai_req INTEGER, arc_req INTEGER, effect TEXT
);
CREATE TABLE IF NOT EXISTS talismans (
  page_id INTEGER PRIMARY KEY, name TEXT NOT NULL, weight REAL, effect TEXT, summary TEXT
);
CREATE TABLE IF NOT EXISTS armor (
  page_id INTEGER PRIMARY KEY, name TEXT NOT NULL, slot TEXT, weight REAL, poise REAL, effects TEXT
);
CREATE TABLE IF NOT EXISTS bosses (
  page_id INTEGER PRIMARY KEY, name TEXT NOT NULL, location TEXT, hp TEXT, runes TEXT, drops TEXT
);
CREATE TABLE IF NOT EXISTS acquisition (
  page_id INTEGER PRIMARY KEY, method TEXT NOT NULL, location_text TEXT NOT NULL,
  nearest_grace TEXT, prereqs TEXT NOT NULL DEFAULT '[]', missable INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quests (
  page_id INTEGER NOT NULL, npc TEXT NOT NULL, step_ord INTEGER NOT NULL,
  location TEXT, action TEXT NOT NULL, breaks_quest TEXT,
  PRIMARY KEY (page_id, step_ord)
);
CREATE TABLE IF NOT EXISTS extract_failures (
  page_id INTEGER NOT NULL, extractor TEXT NOT NULL, error TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT PRIMARY KEY, last_run TEXT NOT NULL, pages INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dlc_report (
  signal TEXT NOT NULL,
  hits INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dlc_categories (
  title TEXT PRIMARY KEY
);
