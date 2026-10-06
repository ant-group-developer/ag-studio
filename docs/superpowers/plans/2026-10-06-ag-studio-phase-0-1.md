# Plan pha 0–1: build trên Windows, số lượt Claude cấu hình được, bật stack local một lệnh

Spec: `docs/superpowers/specs/2026-10-06-ag-studio-local-chat-design.md` (mục 3.2, bảng pha 0–1).

**Cập nhật khi làm:** tăng capacity `claude` là chưa đủ — mỗi tiến trình worker chỉ có một vòng chạy stage, nên
việc 1.1 thêm pool vòng lặp (`createStudioWorkerPool`, ADR mục 143).
Nhánh: tách từ `docs/sync-ag-studio` sau khi pha D được duyệt. Mỗi task một commit; test viết trước.

## Pha 0 — build và test chạy được trên máy dev Windows

### 0.1 Baseline
1. Build `../ag-farm/packages/protocol` và `owner-client` (ag-studio link tới chúng).
2. `corepack pnpm install && corepack pnpm build && corepack pnpm -r typecheck && corepack pnpm test`.
3. Ghi kết quả vào `docs/operations/deferred-items.md` (mục AG Studio): test đỏ có sẵn, kèm lý do (thiếu ffmpeg trên
   PATH, cần Docker…). Không sửa test để cho xanh.

### 0.2 Spawn `claude` trên Windows
- Vấn đề: `CliAgentRuntime` gọi `spawn("claude", …)` không qua shell; cài bằng npm chỉ có `claude.cmd`.
- **Kiểm trước khi code:** cấu trúc thật của bản cài trên máy (`%APPDATA%\npm\claude.cmd` trỏ tới đâu; có
  `claude.exe` native không).
- Hướng sửa: hàm thuần `resolveClaudeCommand(argv0, { platform, pathEnv, exists })` trong
  `packages/adapters/agent-cli/src/`: trên `win32` tìm `claude.exe` trong PATH; nếu chỉ có `claude.cmd` thì gọi thẳng
  `node <cli.js>` mà `.cmd` trỏ tới. **Không** dùng `shell: true` (đối số `--json-schema` chứa dấu nháy, cmd.exe sẽ
  làm hỏng). Ngoài Windows giữ nguyên.
- Test: bảng tình huống của `resolveClaudeCommand` (exe có sẵn, chỉ có cmd, không có gì → lỗi `contract` như hiện
  nay, nền tảng khác). Test hiện có của runtime phải xanh nguyên.

## Pha 1 — chạy nhiều video cùng lúc trên stack local

### 1.1 `STUDIO_CLAUDE_MAX_CONCURRENT` (mặc định 20)
- `packages/studio-engine/src/core.ts`: thay hằng `STUDIO_RESOURCES` bằng `studioResources(env)` → `{ claude: n,
  farm: 8, cpu: 2 }`, `n` đọc từ `STUDIO_CLAUDE_MAX_CONCURRENT` (số nguyên 1–100, mặc định 20; giá trị sai →
  `CONFIG_INVALID` lúc khởi động, không âm thầm rơi về mặc định).
- Dùng ở `packages/studio-engine/src/worker.ts` (cả `resources` của project lẫn `resourceCapacity`) và mọi chỗ khác
  đang import `STUDIO_RESOURCES` (grep).
- `.env.example` thêm khoá kèm chú thích; `docker-compose.yml` không cần đổi (`env_file`).
- Test: giá trị mặc định, giá trị hợp lệ, giá trị sai; một test engine với Claude giả cho thấy hai stage agent của
  hai production được claim cùng lúc khi `n ≥ 2` (hiện tại chỉ một).
- ADR: mục mới ghi việc đổi `claude: 1` thành cấu hình, mặc định 20, và rủi ro hạn mức.

### 1.2 Nhận đủ các câu báo hết hạn mức
- `RATE_LIMIT_PATTERN` (`cli-agent-runtime.ts`): khớp cả `you’ve` (nháy cong) và `usage limit reached`.
- Test: bảng câu mẫu khớp / không khớp. Gỡ mục tương ứng trong `deferred-items.md`.

### 1.3 Bật/tắt cả stack local một lệnh
- Người dùng chọn chạy **trực tiếp trên máy, không Docker** (chỉ hạ tầng và Account API ở trong Docker).
- `scripts/local-stack.mjs up|down|status [tên…|all]` + phần lập kế hoạch thuần `scripts/local-stack-lib.mjs`
  (`planServices`, `selectServices`): ag-go-api 3738 → (ag-go worker) → farm hub 3010 → Studio API 3101 → Studio
  worker → render worker → scan worker → Studio web 3100 → (farm web 3011, ag-go web 5173). Đợi health từng dịch vụ có
  cổng; dịch vụ đã lên thì bỏ qua; log và pid ở `AG_LOCAL_DIR/dev-run`; `down` chỉ tắt tiến trình script đã bật.
- Đường dẫn qua env, mặc định cạnh repo: `AG_GO_DIR`, `AG_FARM_DIR`, `AG_RENDER_WORKER_DIR`, `AG_SCAN_WORKER_DIR`,
  `AG_LOCAL_DIR=E:/ag-local`.
- Test (`tests/integration/local-stack.test.ts`): thứ tự, thư mục, cổng, ghi đè bằng env, chọn dịch vụ — không
  spawn gì trong test.

### 1.4 Tài liệu
- `docs/runbooks/studio-local.md`: mục "Bật hằng ngày" dùng `node scripts/local-stack.mjs up`; thêm
  `STUDIO_CLAUDE_MAX_CONCURRENT`.
- `AGENTS.md`: dòng số lượt Claude và lệnh `local-stack`.

## Kiểm tra cuối pha
- `corepack pnpm build && corepack pnpm -r typecheck && corepack pnpm test` (so với baseline 0.1).
- Trên stack local với Claude giả (`config-local.cjs claude fake`): tạo hai production gần như cùng lúc → cả hai
  tới gate `approve-rnd`, log worker cho thấy hai lượt Claude chạy song song.
- `node scripts/local-stack.mjs status` báo đủ thành phần.
