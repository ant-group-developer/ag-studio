import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { Checksum } from "@harness/contracts";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}
export function sha256String(s: string): Checksum {
  return `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
}
export function canonicalDigest(value: unknown): Checksum {
  return sha256String(canonicalJson(value));
}
export async function sha256File(path: string): Promise<{ checksum: Checksum; size_bytes: number }> {
  const { size } = await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on("data", (c) => hash.update(c)).on("end", resolve).on("error", reject);
  });
  return { checksum: `sha256:${hash.digest("hex")}`, size_bytes: size };
}

/** Synchronous sibling of `sha256File`, for the one caller with no `await` point available to it: `doctor`'s
 * `channel:<id>:voice` row (`runDoctor` is a plain synchronous function, like every other doctor check).
 * Reads the whole file into memory rather than streaming -- fine for a voice profile's `ref.wav`, which is
 * capped at 30s of mono 24kHz PCM (well under a couple MB), never a multi-minute episode file. */
export function sha256FileSync(path: string): { checksum: Checksum; size_bytes: number } {
  const size = statSync(path).size;
  const hash = createHash("sha256").update(readFileSync(path));
  return { checksum: `sha256:${hash.digest("hex")}`, size_bytes: size };
}
