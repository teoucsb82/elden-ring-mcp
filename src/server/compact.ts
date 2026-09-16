/**
 * Drops null, undefined, empty arrays and empty objects so results carry only fields with content.
 * `false`, `0` and `''` are content: a missable: false or an hp: 0 must survive.
 * Every lookup that can come back empty returns an explicit not_found instead of an empty shape,
 * so this can never flatten a whole answer to `{}`.
 */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== 'object') return value;
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const clean = compact(field);
    const empty = clean === null || clean === undefined
      || (Array.isArray(clean) && !clean.length)
      || (typeof clean === 'object' && !Array.isArray(clean) && !Object.keys(clean).length);
    if (!empty) kept[key] = clean;
  }
  return kept;
}
