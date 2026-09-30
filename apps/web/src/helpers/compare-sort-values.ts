/** A value rows are sorted by: text, a number (timestamps as epoch ms) or missing. */
export type SortValue = string | number | null | undefined;
export type SortDirection = "asc" | "desc";

const collator = new Intl.Collator("vi", { numeric: true, sensitivity: "base" });

function isMissing(value: SortValue): value is null | undefined {
  return value === null || value === undefined || value === "" || Number.isNaN(value as number);
}

export function compareSortValues(a: SortValue, b: SortValue): number {
  if (isMissing(a) || isMissing(b)) {
    return isMissing(a) === isMissing(b) ? 0 : isMissing(a) ? 1 : -1;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

export function sortRows<T>(rows: readonly T[], getValue: (row: T) => SortValue, direction: SortDirection): T[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = getValue(a), bv = getValue(b);
    const r = compareSortValues(av, bv);
    return isMissing(av) !== isMissing(bv) ? r : r * sign;
  });
}
