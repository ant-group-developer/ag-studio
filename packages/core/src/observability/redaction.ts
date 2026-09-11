export class Redactor {
  constructor(private readonly secrets: () => string[]) {}
  redact<T>(value: T): T {
    const secrets = this.secrets().filter((s) => s.length > 0);
    if (secrets.length === 0) return value;
    return walk(value, secrets) as T;
  }
}
function walk(v: unknown, secrets: string[]): unknown {
  if (typeof v === "string") return secrets.reduce((acc, s) => acc.split(s).join("[REDACTED]"), v);
  if (Array.isArray(v)) return v.map((x) => walk(x, secrets));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, secrets)]));
  return v;
}
