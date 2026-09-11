import { HarnessError, type SecretResolver } from "@harness/contracts";

const REF_RE = /^secret:\/\/([a-z0-9-]+)\/([a-z0-9-]+)$/;

export class EnvSecretResolver implements SecretResolver {
  private readonly seen: string[] = [];
  constructor(private readonly env: Record<string, string | undefined> = process.env as Record<string, string | undefined>) {}

  static envName(ref: string): string | undefined {
    const m = REF_RE.exec(ref);
    if (!m) return undefined;
    return `HARNESS_SECRET_${m[1]!.toUpperCase().replace(/-/g, "_")}_${m[2]!.toUpperCase().replace(/-/g, "_")}`;
  }
  resolve(ref: string): string {
    const name = EnvSecretResolver.envName(ref);
    const value = name ? this.env[name] : undefined;
    if (!name || value === undefined) throw new HarnessError("SECRET_UNRESOLVED", `cannot resolve ${ref}`, { ref, env: name ?? null });
    if (!this.seen.includes(value)) this.seen.push(value);
    return value;
  }
  resolvedValues(): string[] { return [...this.seen]; }
}
