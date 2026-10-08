/**
 * What changed between two versions of a document (spec local-chat §2.3: changes are highlighted). Paths are
 * dotted (`direction.episode_count`, `episodes.1.title`); arrays of plain values compare as a whole field, arrays of
 * objects item by item.
 */
export type DocChange =
  | { path: string; kind: "changed"; before: unknown; after: unknown }
  | { path: string; kind: "added"; after: unknown }
  | { path: string; kind: "removed"; before: unknown };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const plainArray = (v: unknown): v is unknown[] => Array.isArray(v) && v.every((x) => !x || typeof x !== "object");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffDoc(before: unknown, after: unknown, path = ""): DocChange[] {
  const at = (k: string | number) => (path ? `${path}.${k}` : String(k));
  if (same(before, after)) return [];
  if (before === undefined) return [{ path, kind: "added", after }];
  if (after === undefined) return [{ path, kind: "removed", before }];
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((k) => diffDoc(before[k], after[k], at(k)));
  }
  if (Array.isArray(before) && Array.isArray(after) && !plainArray(before) && !plainArray(after)) {
    return Array.from({ length: Math.max(before.length, after.length) }, (_, i) => diffDoc(before[i], after[i], at(i))).flat();
  }
  return [{ path, kind: "changed", before, after }];
}

/** The changes at `path` or inside it. */
export function changesUnder(changes: readonly DocChange[], path: string): DocChange[] {
  return changes.filter((c) => c.path === path || c.path.startsWith(`${path}.`));
}

/** Items of a plain list added and removed (a keyword list, a tag list). */
export function listDiff(before: readonly unknown[] | undefined, after: readonly unknown[] | undefined): { added: Set<string>; removed: string[] } {
  const b = (before ?? []).map(String);
  const a = (after ?? []).map(String);
  return { added: new Set(a.filter((x) => !b.includes(x))), removed: b.filter((x) => !a.includes(x)) };
}
