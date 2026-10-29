#!/usr/bin/env node
/**
 * One-off (plan 2026-10-29 P5): moves what was uploaded before the media library into it. See
 * `src/workspace/media-migrate.ts` for what moves where. Run after migration 0006 and the API and worker that read the
 * library are deployed:
 *
 *   node packages/studio-engine/scripts/migrate-media-library.mjs --dry-run   # says what it would do, changes nothing
 *   node packages/studio-engine/scripts/migrate-media-library.mjs --apply
 *
 * Environment: DATABASE_URL (and DATABASE_SCHEMA if not public), STUDIO_R2_ENDPOINT, STUDIO_R2_BUCKET,
 * STUDIO_R2_ACCESS_KEY_ID, STUDIO_R2_SECRET_ACCESS_KEY, and STUDIO_WORKSPACES_ROOT or STUDIO_DATA_ROOT (the workspaces
 * are `<STUDIO_DATA_ROOT>/workspaces`), the same as apps/api. Needs the built engine (dist/).
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const need = (name) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`thiếu biến môi trường ${name}`);
  return v;
};

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  if (apply === args.includes("--dry-run")) {
    process.stderr.write("usage: node migrate-media-library.mjs --dry-run | --apply\n");
    process.exit(2);
  }
  const workspacesRoot = process.env.STUDIO_WORKSPACES_ROOT?.trim() || join(need("STUDIO_DATA_ROOT"), "workspaces");
  const { migrateMediaLibrary, migrateStudioDb, S3Bucket, studioDbFromEnv } = await import("../dist/index.js");
  const bucket = new S3Bucket({
    endpoint: need("STUDIO_R2_ENDPOINT"), bucket: need("STUDIO_R2_BUCKET"),
    accessKeyId: need("STUDIO_R2_ACCESS_KEY_ID"), secretAccessKey: need("STUDIO_R2_SECRET_ACCESS_KEY"),
  });
  const db = studioDbFromEnv();
  try {
    const applied = await migrateStudioDb(db);
    if (applied.length) process.stdout.write(`schema: applied ${applied.join(", ")}\n`);
    process.stdout.write(`${apply ? "CHẠY THẬT" : "CHẠY THỬ (không đổi gì)"} · workspaces ${workspacesRoot}\n`);
    const r = await migrateMediaLibrary(db, bucket, { workspacesRoot, apply, log: (l) => process.stdout.write(`  ${l}\n`) });
    const mb = (r.files.bytes / 1024 / 1024).toFixed(1);
    process.stdout.write([
      "",
      `footage trên R2: ${r.footage.items} file vào thư viện (không copy), ${r.footage.sources} dòng nguồn`,
      `audio/video mẫu trên đĩa: ${r.files.items} file lên R2, ${r.files.sources} dòng nguồn, ${mb} MB ${apply ? "đã chuyển vào .trash/ (sweep xoá sau)" : "sẽ được giải phóng"}`,
      `bỏ qua: ${r.skipped.length}`,
      "",
    ].join("\n"));
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write(`migrate-media-library: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}
