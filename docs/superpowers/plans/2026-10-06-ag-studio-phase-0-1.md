# Plan pha 0–1: build trên Windows, số lượt Claude cấu hình được, bật stack local một lệnh

Spec: `docs/superpowers/specs/2026-10-06-ag-studio-local-chat-design.md` (mục 3.2, bảng pha 0–1).
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
- `scripts/local-stack.mjs up|down|status` (Node, không phụ thuộc shell):
  - đường dẫn lấy từ env, mặc định cạnh repo: `AG_GO_DIR=../ag-go-v2/ag-go-api`, `AG_FARM_DIR=../ag-farm`,
    `AG_LOCAL_DIR=E:/ag-local` (thư mục worker);
  - `up`: `docker compose up -d` cho ag-go rồi ag-farm, chờ health; Studio theo đúng thứ tự `deploy.sh` (api
    `--wait` → worker → web); chạy hai worker Windows ở chế độ tách, log vào `AG_LOCAL_DIR/*.log`;
  - `status`: in một bảng thành phần → ok/hỏng (health của ag-go `/api/health`, farm, Studio `/api/health`, tiến trình
    worker); **không in giá trị biến môi trường**;
  - `down`: dừng worker và các compose theo thứ tự ngược.
- Không đụng `E:\ag-local\setup` (sinh cấu hình là việc của script đó).
- Test: hàm thuần dựng danh sách lệnh và thứ tự (không chạy Docker trong test).

### 1.4 Tài liệu
- `docs/runbooks/studio-local.md`: mục "Bật hằng ngày" dùng `node scripts/local-stack.mjs up`; thêm
  `STUDIO_CLAUDE_MAX_CONCURRENT`.
- `AGENTS.md`: dòng số lượt Claude và lệnh `local-stack`.

## Kiểm tra cuối pha
- `corepack pnpm build && corepack pnpm -r typecheck && corepack pnpm test` (so với baseline 0.1).
- Trên stack local với Claude giả (`config-local.cjs claude fake`): tạo hai production gần như cùng lúc → cả hai
  tới gate `approve-rnd`, log worker cho thấy hai lượt Claude chạy song song.
- `node scripts/local-stack.mjs status` báo đủ thành phần.
