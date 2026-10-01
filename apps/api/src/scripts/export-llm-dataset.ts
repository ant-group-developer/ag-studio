/**
 * Xuất dataset huấn luyện (JSONL, mỗi dòng một bản ghi) từ nhật ký gọi Claude và phần người sửa (migration 0013).
 *
 * Chạy trong container api (đọc STUDIO_DB_PATH và STUDIO_R2_* như api):
 *   docker compose exec api node apps/api/dist/scripts/export-llm-dataset.js --out /data/exports/llm.jsonl
 *   docker compose cp api:/data/exports/llm.jsonl .
 *
 * Tuỳ chọn:
 *   --out <file>          ghi ra file (mặc định: stdout)
 *   --kind calls|edits    chỉ lần gọi model, hoặc chỉ phần người sửa (mặc định: cả hai)
 *   --include-rejected    giữ cả câu trả lời bị bộ kiểm tra từ chối / lỗi (mặc định: chỉ câu được nhận)
 *   --since <ISO>         chỉ bản ghi từ thời điểm này
 *   --production <id>     chỉ một production
 *
 * Dòng `kind: llm_call` có `messages` (system = skill, user = brief, assistant = JSON trả lời).
 * Dòng `source: human` có `rejected` (bản model soạn) và `chosen` (bản người chốt), `changed` cho biết người có sửa không.
 * Lưu ý: đầu ra của Claude chịu điều khoản của Anthropic (không dùng để huấn luyện model cạnh tranh); lọc theo `source`.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { exportLlmDataset, S3Bucket, StudioDb, type DatasetOptions } from '@ag-studio/engine';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Thieu bien moi truong ${name}`);
  return v;
}

async function main(): Promise<void> {
  const kind = arg('--kind');
  if (kind && kind !== 'calls' && kind !== 'edits') throw new Error(`--kind phai la calls hoac edits, khong phai ${kind}`);
  const since = arg('--since');
  if (since && Number.isNaN(Date.parse(since))) throw new Error(`--since khong phai thoi diem ISO: ${since}`);
  const production = arg('--production');
  const options: DatasetOptions = {
    includeRejected: process.argv.includes('--include-rejected'),
    ...(kind ? { kinds: [kind as 'calls' | 'edits'] } : {}),
    ...(since ? { since: new Date(since).toISOString() } : {}),
    ...(production ? { productionId: production } : {}),
  };

  const db = new StudioDb(env('STUDIO_DB_PATH'));
  const bucket = new S3Bucket({
    endpoint: env('STUDIO_R2_ENDPOINT'),
    bucket: env('STUDIO_R2_BUCKET'),
    accessKeyId: env('STUDIO_R2_ACCESS_KEY_ID'),
    secretAccessKey: env('STUDIO_R2_SECRET_ACCESS_KEY'),
  });

  const outPath = arg('--out');
  if (outPath) mkdirSync(dirname(outPath), { recursive: true });
  const out = outPath ? createWriteStream(outPath, 'utf8') : process.stdout;
  const counts = await exportLlmDataset(db, bucket, options, (line) => { out.write(line + '\n'); });
  if (outPath) await new Promise<void>((res, rej) => (out as ReturnType<typeof createWriteStream>).end((e?: Error | null) => (e ? rej(e) : res())));
  db.db.close();

  // Báo cáo ra stderr để stdout chỉ còn JSONL khi không dùng --out.
  process.stderr.write(
    `Da xuat ${counts.calls} lan goi model, ${counts.edits} lan nguoi sua, ${counts.timelines} timeline da sua` +
    (counts.missingPayloads ? `; ${counts.missingPayloads} lan goi thieu noi dung tren R2 (bo qua)` : '') +
    (outPath ? ` -> ${outPath}` : '') + '\n',
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`Loi: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
