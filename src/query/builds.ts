import type { Db } from '../db/open.js';
import type { ListedAs } from '../extract/build.js';
import type { Dbs, DlcMode } from './dbs.js';
import { isDlcFiltered, resolveName, type Provenance } from './resolve.js';

/**
 * Builds come from the local Fextralife cache (npm run fetch-builds); their gear resolves against
 * the shipped Fandom snapshot, which is what knows each item's type.
 */

type Kind = 'weapon' | 'armor' | 'spell' | 'talisman' | 'item';

export interface ResolvedItem {
  kind: Kind | null;
  /** Where the item really belongs on a build sheet, from its type; null when the type does not say. */
  slot: ListedAs | null;
  /** "Uchigatana (Katana)", "Rellana's Armor (Chest Armor)", "Opaline Hardtear (Crystal Tear)". */
  display: string;
  resolved: boolean;
  /** The Fandom title it resolved to, when the build page spells it differently. */
  as?: string;
  dlc: boolean | null;
  provenance: Provenance | null;
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** The item's type from whichever item table holds its page. */
function typeOf(db: Db, pageId: number): { kind: Kind; type: string } | null {
  const weapon = db.prepare('SELECT weapon_type FROM weapons WHERE page_id = ?').get(pageId) as { weapon_type: string | null } | undefined;
  if (weapon) return { kind: 'weapon', type: weapon.weapon_type ?? 'Weapon' };
  const armor = db.prepare('SELECT slot FROM armor WHERE page_id = ?').get(pageId) as { slot: string | null } | undefined;
  if (armor) return { kind: 'armor', type: armor.slot ? `${titleCase(armor.slot)} Armor` : 'Armor' };
  const spell = db.prepare('SELECT spell_type FROM spells WHERE page_id = ?').get(pageId) as { spell_type: string | null } | undefined;
  if (spell) return { kind: 'spell', type: spell.spell_type ?? 'Spell' };
  if (db.prepare('SELECT 1 FROM talismans WHERE page_id = ?').get(pageId)) return { kind: 'talisman', type: 'Talisman' };
  const hasItems = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'items'").get();
  const item = hasItems ? db.prepare('SELECT item_type, sub_type FROM items WHERE page_id = ?').get(pageId) as { item_type: string | null; sub_type: string | null } | undefined : undefined;
  if (item) return { kind: 'item', type: item.sub_type ?? item.item_type ?? 'Item' };
  return null;
}

// The snapshot is read-only for the life of the process, so a name resolves the same way every call.
const memo = new WeakMap<Db, Map<string, ResolvedItem>>();
const titleIndex = new WeakMap<Db, Map<string, string>>();

/** Lower-case letters and digits only: "Flame Grant me Strength" and "Flame, Grant Me Strength" meet here. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function bySquashedTitle(db: Db, name: string): string | undefined {
  let index = titleIndex.get(db);
  if (!index) {
    index = new Map();
    for (const { title } of db.prepare('SELECT title FROM pages ORDER BY id').all() as { title: string }[]) {
      if (!index.has(squash(title))) index.set(squash(title), title);
    }
    titleIndex.set(db, index);
  }
  return index.get(squash(name));
}

/**
 * Spellings Fextralife uses that Fandom does not, tried in order after the name as written. Every one
 * is a fixed rewrite, never a search: a build item either names a real page or reports unresolved.
 */
function spellings(db: Db, name: string, skillFirst: boolean): string[] {
  const straight = name.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  // "Royal Knight's Resolve" is an Ash of War; "Contagious Fury" a unique skill. Golden Vow is both a
  // spell and an Ash of War, so a row the page lists as a skill tries the skill pages first.
  const skills = ['Ash of War: ', 'Unique Skill: ', 'Skill: '].map((prefix) => prefix + straight);
  const out = skillFirst ? [...skills, straight] : [straight, ...skills];
  // "Dragoncrest Shield Talisman 1" is the +1.
  const upgrade = /^(.*\S) (\d)$/.exec(straight);
  if (upgrade) out.push(`${upgrade[1]} +${upgrade[2]}`);
  const squashed = bySquashedTitle(db, straight);
  if (squashed) out.push(squashed);
  return [...new Set(out)];
}

export function resolveItem(shipped: Db | null, name: string, listedAs?: ListedAs): ResolvedItem {
  const unresolved: ResolvedItem = { kind: null, slot: null, display: `${name} (unresolved)`, resolved: false, dlc: null, provenance: null };
  if (!shipped) return unresolved;
  let cache = memo.get(shipped);
  if (!cache) memo.set(shipped, (cache = new Map()));
  const skillFirst = listedAs === 'skill';
  const key = `${skillFirst ? 'skill:' : ''}${name.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // First spelling whose page has an item type wins; a typeless hit ("Lion's Claw" redirects to the
  // Skill page) is kept only when no spelling reaches a typed page (the Ash of War page).
  let r = null;
  for (const spelling of spellings(shipped, name, skillFirst)) {
    const hit = resolveName({ shipped, local: null }, spelling, 'all', { noSearch: true });
    if (!hit || isDlcFiltered(hit)) continue;
    r ??= hit;
    if (typeOf(hit.db, hit.pageId)) { r = hit; break; }
  }
  let out = unresolved;
  if (r && !isDlcFiltered(r)) {
    // A "Skill: X" page has no item table row, but its title says what it is.
    const skillPage = /^(Unique Skill|Skill): /.exec(r.provenance.title);
    const type = typeOf(r.db, r.pageId) ?? (skillPage ? { kind: 'item' as const, type: skillPage[1] } : null);
    const label = type?.type ?? (/ Set$/.test(r.provenance.title) ? 'Armor Set' : null);
    out = {
      kind: type?.kind ?? null,
      slot: slotOf(type),
      display: label ? `${name} (${label})` : `${name} (type unknown)`,
      resolved: true,
      ...(r.provenance.title.toLowerCase() !== name.toLowerCase() ? { as: r.provenance.title } : {}),
      dlc: r.dlc,
      provenance: r.provenance,
    };
  }
  cache.set(key, out);
  return out;
}

function slotOf(type: { kind: Kind; type: string } | null): ListedAs | null {
  if (!type) return null;
  if (type.kind !== 'item') return type.kind;
  if (/^(ash of war|skill|unique skill)$/i.test(type.type)) return 'skill';
  if (/crystal tear/i.test(type.type)) return 'crystal_tear';
  return null;
}

/** Shields are weapons in the item data, so a shield row holding a weapon is not misfiled. */
const sameSlot = (listed: ListedAs, real: ListedAs) => listed === real || (listed === 'shield' && real === 'weapon');

interface BuildRow {
  page_id: number; name: string; tagline: string | null; class: string | null; level: number | null; journey: string | null;
  focus: string; playstyle: string | null; primary_stats: string; secondary_stats: string; flask: string | null;
  min_stats: string; summary: string | null; notes: string;
  title: string; url: string; fetched_at: string; license: string; source: string; revid: number | null;
}

interface ItemRow { page_id: number; ord: number; listed_as: ListedAs; name: string; alternate: number; affinity: string | null }

const STAT_NAMES: Record<string, string> = { str: 'Strength', dex: 'Dexterity', int: 'Intelligence', fai: 'Faith', arc: 'Arcane' };

function gear(shipped: Db | null, item: ItemRow) {
  const r = resolveItem(shipped, item.name, item.listed_as);
  // A unique skill shares or redirects to its weapon's name (Bolt of Gransax): the page is right to call it a skill.
  const weaponSkill = item.listed_as === 'skill' && r.slot === 'weapon';
  // Fextralife files Flamberge and Storm Blade under spells; the item data decides.
  const misfiled = r.slot !== null && !weaponSkill && !sameSlot(item.listed_as, r.slot);
  return {
    name: item.name,
    display: weaponSkill ? `${item.name} (Unique Skill of ${r.as ?? item.name})` : r.display,
    slot: misfiled ? r.slot : item.listed_as,
    ...(misfiled ? { listed_as: item.listed_as } : {}),
    resolved: r.resolved,
    ...(r.as ? { as: r.as } : {}),
    ...(item.alternate ? { alternate: true } : {}),
    ...(item.affinity ? { affinity: item.affinity } : {}),
    ...(r.dlc ? { dlc: true } : {}),
  };
}

export interface BuildFilter { name?: string; stat?: string; item?: string; weapon?: string; limit?: number }

const NO_BUILDS_HINT = 'No builds are cached. Run `npm run fetch-builds` once to cache the Fextralife build pages locally.';

export function buildInfo(dbs: Dbs, filter: BuildFilter, mode: DlcMode = 'base') {
  const local = dbs.local;
  const hasBuilds = local?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'builds'").get()
    && (local.prepare('SELECT count(*) AS n FROM builds').get() as { n: number }).n > 0;
  if (!local || !hasBuilds) return { not_found: true as const, query: JSON.stringify(filter), hint: NO_BUILDS_HINT };

  const builds = local.prepare(`SELECT b.*, p.title, p.url, p.fetched_at, p.license, p.source, p.revid FROM builds b JOIN pages p ON p.id = b.page_id ORDER BY b.name`).all() as BuildRow[];
  const items = local.prepare('SELECT * FROM build_items ORDER BY page_id, ord').all() as ItemRow[];
  const itemsOf = new Map<number, ItemRow[]>();
  for (const item of items) itemsOf.set(item.page_id, [...(itemsOf.get(item.page_id) ?? []), item]);
  const sote = new Set((local.prepare("SELECT title FROM build_lists WHERE list = 'SOTE Builds'").all() as { title: string }[]).map((r) => r.title));
  const listsKnown = (local.prepare('SELECT count(*) AS n FROM build_lists').get() as { n: number }).n > 0;

  /** DLC: the SOTE Builds index lists it, or one of its items is DLC content. Neither known: null. */
  const dlcOfBuild = (b: BuildRow) => {
    if (sote.has(b.title)) return { dlc: true, dlc_basis: 'listed on SOTE Builds' };
    const dlcItem = (itemsOf.get(b.page_id) ?? []).find((i) => resolveItem(dbs.shipped, i.name).dlc === true);
    if (dlcItem) return { dlc: true, dlc_basis: `uses DLC item ${dlcItem.name}` };
    return listsKnown ? { dlc: false, dlc_basis: 'not on SOTE Builds, no DLC items' } : { dlc: null, dlc_basis: 'unknown' };
  };
  const provenance = (b: BuildRow): Provenance => ({ source: b.source, title: b.title, url: b.url, revid: b.revid, fetched_at: b.fetched_at, license: b.license });
  const json = <T>(s: string): T => JSON.parse(s) as T;
  const full = (b: BuildRow) => ({
    name: b.name, tagline: b.tagline, class: b.class, level: b.level, journey: b.journey,
    focus: json<string[]>(b.focus), playstyle: b.playstyle,
    primary_stats: json<string[]>(b.primary_stats), secondary_stats: json<string[]>(b.secondary_stats),
    min_stats: json<Record<string, number>>(b.min_stats), flask: b.flask, summary: b.summary,
    notes: json<Record<string, string>>(b.notes),
    ...dlcOfBuild(b),
    items: (itemsOf.get(b.page_id) ?? []).map((i) => gear(dbs.shipped, i)),
    provenance: provenance(b),
  });

  if (filter.name) {
    const q = filter.name.trim().toLowerCase();
    const exact = builds.find((b) => b.name.toLowerCase() === q || b.title.toLowerCase() === q || b.title.toLowerCase() === `${q} build`);
    if (exact) return { match: 'exact' as const, build: full(exact) };
    const partial = builds.filter((b) => b.title.toLowerCase().includes(q));
    if (partial.length === 1) return { match: 'partial' as const, hint: `No build is named "${filter.name}"; this is the only one whose name contains it.`, build: full(partial[0]) };
    return {
      not_found: true as const, query: filter.name,
      hint: partial.length ? 'Several builds match; ask for one by name.' : 'No cached build has that name. Try a filter (stat, item, weapon) instead.',
      ...(partial.length ? { candidates: partial.map((b) => b.name) } : {}),
    };
  }

  const stat = filter.stat?.trim().toLowerCase();
  const statName = stat ? (STAT_NAMES[stat] ?? filter.stat!.trim()).toLowerCase() : null;
  const wanted = (filter.item ?? filter.weapon)?.trim().toLowerCase();
  const rows = [];
  for (const b of builds) {
    const d = dlcOfBuild(b);
    if (mode === 'base' && d.dlc === true) continue;
    if (mode === 'only' && d.dlc === false) continue;
    if (statName && ![...json<string[]>(b.focus), ...json<string[]>(b.primary_stats)].some((s) => s.toLowerCase() === statName)) continue;
    let matched: ReturnType<typeof gear>[] = [];
    if (wanted) {
      matched = (itemsOf.get(b.page_id) ?? []).filter((i) => i.name.toLowerCase() === wanted).map((i) => gear(dbs.shipped, i));
      if (filter.weapon) matched = matched.filter((g) => g.slot === 'weapon' || g.slot === 'shield');
      if (!matched.length) continue;
    }
    rows.push({
      name: b.name, level: b.level, focus: json<string[]>(b.focus), primary_stats: json<string[]>(b.primary_stats),
      ...d, ...(matched.length ? { matched } : {}), provenance: provenance(b),
    });
  }
  const limit = filter.limit ?? 25;
  if (!rows.length) {
    return {
      not_found: true as const, query: JSON.stringify(filter),
      hint: `No cached build matches. ${mode === 'base' ? 'dlc mode "base" hides DLC builds; try dlc: "all". ' : ''}Item names must match exactly as written on the build page.`,
    };
  }
  return { total: rows.length, rows: rows.slice(0, limit), ...(rows.length > limit ? { truncated: true } : {}) };
}
