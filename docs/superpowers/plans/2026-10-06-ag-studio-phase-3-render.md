# Plan pha 3: chọn kiểu máy render, màn Hàng đợi

Spec: `docs/superpowers/specs/2026-10-06-ag-studio-local-chat-design.md` (mục 3.4; bảng pha, dòng 3).
Mockup: https://claude.ai/artifact/N6YHc1yrBvqc1Fv6ab8xZL, màn 11 (Render và xuất file) và màn 12 (Hàng đợi).
Nhánh: `feat/local-phase-3-render`, tách từ `feat/local-phase-2-chat`. Mỗi task một commit, test viết trước.

**Xong khi** (bảng pha): cùng một tập render được với hai lựa chọn máy khác nhau.

## Hiện trạng (đã kiểm trong code)

**ag-farm** (`E:\CODE\ag-farm`, chỉ đọc, không sửa):
- `RequirementsSchema` (`packages/protocol/src/capabilities.ts:33`) là strict object, mọi khoá tuỳ chọn: `gpu`, `min_vram_mb`,
  `nvenc`, `ollama_models`, `python`, `os`. `{}` khớp mọi máy. `{ nvenc: true }` và `{ gpu: true }` dùng được ngay.
- Hub ghép requirements của owner với `baseRequirements` theo loại job (`registry.ts:66`); `studio.render_final` có base `{}`.
- Máy tự khai khả năng trong heartbeat (worker-sdk dò một lần lúc khởi động). `nvenc` = `ffmpeg -encoders` có
  `h264_nvenc`, tức là **bản ffmpeg có encoder đó**, không phải driver chạy được nó.
- Job không máy nào khớp thì nằm `queued` **mãi**: không timeout, không báo lý do cho owner.
- Requirements **không đổi được** sau khi gửi. Gửi lại cùng `correlation_id` thì nhận lại job cũ.
- **Owner API không có danh sách node.** `@ag-farm/owner-client` có `submitJob`, `getJob`, `listJobs`, `ackJob`,
  `cancelJob`, `controlJobs`. Danh sách node chỉ có ở **admin API** (`GET /v1/admin/nodes`), cần JWT Auth0 của admin,
  không nhận owner key.
- `JobView` của owner có `status` (`queued|leased|paused|completed|failed|cancelled`), `progress_percent`,
  `progress_stage`, `attempt_count`, `node_id` (uuid). Không có tên node, không có `requirements`.

**Studio:**
- `FarmExecutor` (`packages/executors/src/farm-executor.ts:289`) gửi `requirements` = `stage_config.requirements ?? {}`.
  Không workflow nào khai, nên mọi job hiện là `{}`.
- `render-final` của tập 1.3.0 tự chạy sau khi duyệt `approve-youtube-kit`. Thẻ duyệt hiện chỉ có nút "Duyệt".
- `rerenderEpisode` với run 1.3.0 đã xong thì chạy lại từ `approve-timeline`, nên `youtube-kit` (một lượt Claude) và
  hai gate phải chạy lại, kể cả khi timeline không đổi.
- Run Studio không có variant, nên không bao giờ reuse theo cache: `resumeRunFrom` từ `render-final` sẽ render thật.
- `makeStudioFarmRecorder` không ghi `episode_id` cho job của workflow; bảng `studio_farm_jobs` không có cột requirements.

## Quyết định cần bạn duyệt

Plan đang viết theo cột "Đề xuất".

| # | Vấn đề | Đề xuất | Lý do |
|---|---|---|---|
| Q1 | Chỗ chọn máy | Thẻ duyệt **YouTube kit** (gate cuối trước render) có bộ chọn kiểu máy, nút đổi thành "Duyệt và render". Nút Duyệt ở cột phải của gate này cũng mở cùng bộ chọn. Menu ⋯ có "Render bản cuối…". | Duyệt kit là lúc render bản cuối bắt đầu. Không cần gate mới, tức không cần workflow 1.4.0. |
| Q2 | Lưu lựa chọn | Bảng mới `studio_render_choices` khoá theo `(run_id, stage_key)`. Worker đọc lúc gửi job. Không có dòng nào thì gửi `{}` như hiện nay. Mặc định trên giao diện là lựa chọn gần nhất trong production, chưa có thì "Bất kỳ máy". | Mỗi lần render là một run. Run cũ và màn cũ giữ đúng hành vi. Lưu tên kiểu máy (`any`, `nvenc`, `gpu`), không lưu requirements thô, nên API không nhận requirements tuỳ ý. |
| Q3 | Render lại khi timeline chưa đổi | Chạy lại **từ `render-final`**: không gọi Claude, không duyệt lại. Timeline đã sửa sau khi duyệt thì chạy lại từ `approve-timeline` như hiện nay. Áp dụng cho cả nút "Render lại" của màn cũ. | Đây là đường dùng để đạt "Xong khi". Duyệt lại kit cho một timeline không đổi chỉ tốn một lượt Claude. Đây là thay đổi hành vi duy nhất với màn cũ. |
| Q4 | Đổi máy khi job đang chờ | Không làm ở pha 3. Farm không cho đổi requirements, nên người dùng phải Huỷ rồi Render lại. Màn Hàng đợi cảnh báo khi job `queued` quá 10 phút: "Chưa máy nào nhận; có thể không có máy hợp yêu cầu". | Farm không báo lý do job nằm chờ. Ghi vào `deferred-items`. |
| Q5 | Máy rảnh trên màn Hàng đợi | **Chỉ hiện job.** Cột phải thay khối "Máy render" bằng ghi chú giải thích ba kiểu máy. | Owner API không có node (theo yêu cầu của bạn). Admin API `GET /v1/admin/nodes` có sẵn, web gọi được bằng token Auth0 của admin mà không đổi hợp đồng. Ghi vào `deferred-items`; làm nếu bạn muốn. |
| Q6 | Tên máy trên job | Không hiện. Hiện kiểu máy đã chọn và trạng thái farm. | `JobView` chỉ có `node_id` (uuid). Mockup ghi "render-01", không lấy được qua owner API. |
| Q7 | "Máy này" trong mockup (màn 11, 12) | Bỏ. | Spec 3.4: mọi render đi qua farm. |
| Q8 | Xem trước 720p và xuất Premiere | Giữ `{}`, không có bộ chọn. | Spec chỉ nói bản cuối. |
| Q9 | Chip ở header | Hai chip "Claude: n/max" và "Render: n job" mở `/queue`. Ô sửa số lượt Claude (pha 2 đặt trong popover) chuyển sang cột phải của màn Hàng đợi. | Theo mockup màn 12. |
| Q10 | "Chờ bạn duyệt" trên màn Hàng đợi | Dùng nhóm `waiting_you` và `needs_attention` của `GET studio/overview` sẵn có. Không thêm gate sau render. | Tập 1.3.0 không có gì chờ duyệt sau render. Muốn duyệt bản render thì cần workflow mới; đó không phải việc của pha 3. |

---

## Nhóm A: engine

### A1. Kiểu máy trong hợp đồng

- `packages/contracts/src/studio.ts`:
  - `RenderMachineSchema = z.enum(["any", "nvenc", "gpu"])`;
  - `renderRequirements(machine)`: `any` → `{}`, `nvenc` → `{ nvenc: true }`, `gpu` → `{ gpu: true }`.
- Chạy `pnpm gen:schemas` nếu schema mới vào danh sách sinh JSON Schema.

**Test:**
- bảng ánh xạ;
- `packages/executors/test`: mỗi kết quả qua được `RequirementsSchema` của `@ag-farm/protocol` (canh hợp đồng farm);
- enum từ chối giá trị lạ.

### A2. Lưu lựa chọn và job đã gửi (migration `0021_render_machine.sql`)

- Bảng `studio_render_choices(run_id, stage_key, machine, chosen_by, chosen_at, PRIMARY KEY (run_id, stage_key))`.
- `studio_farm_jobs` thêm cột `requirements` (JSON). Dòng cũ để `NULL`, đọc là "không rõ".
- `packages/studio-engine/src/render-choice.ts`:
  - `setRenderChoice(db, runId, stageKey, machine, by)` (upsert);
  - `renderChoiceFor(db, runId, stageKey)`;
  - `defaultRenderMachine(db, productionId)`: lựa chọn mới nhất của production, chưa có thì `any`.
- `makeStudioFarmRecorder` ghi thêm `requirements` và `episode_id` (tra `episodes.run_id`). Màn Hàng đợi cần cả hai.

**Test:**
- danh sách bảng trong `packages/core/test/state/sqlite-store.test.ts`;
- upsert ghi đè lựa chọn cũ của cùng run;
- `defaultRenderMachine` lấy dòng mới nhất của đúng production;
- recorder điền `episode_id` và `requirements`; job của plan run thì `episode_id` để `NULL`.

### A3. `FarmExecutor` nhận requirements theo từng lần chạy

- `FarmExecutorOptions.requirementsFor?(request): Record<string, unknown> | undefined`, cùng kiểu với `feedbackFor`.
- Thứ tự: kết quả `requirementsFor`, rồi `stage_config.requirements`, rồi `{}`.
- `SubmittedInfo.requirements` mang giá trị đã gửi; log `farm job submitted` có thêm requirements. `version` lên `0.4.0`.
- `packages/studio-engine/src/worker.ts` nối `requirementsFor`: có dòng `studio_render_choices` cho `(run_id, stage_key)`
  thì trả `renderRequirements(machine)`, không có thì `undefined`.
- `fakeFarm` (`packages/studio-engine/test/helpers.ts`) giữ `requirements` của từng job.

**Test:**
- `farm-executor.test.ts`:
  - không có callback thì gửi `{}` (như cũ);
  - callback trả `{ nvenc: true }` thì gửi đúng giá trị đó;
  - callback trả `undefined` thì dùng `stage_config.requirements`;
  - `onSubmitted` nhận requirements.
- Engine: tập 1.3.0 có lựa chọn `gpu` thì job `render-final` trong `fakeFarm` có `{ gpu: true }`; job xem trước vẫn là `{}`.

### A4. Duyệt YouTube kit kèm kiểu máy

- `approveChatScope` (`chat-actions.ts`) nhận thêm `renderMachine?`:
  - chỉ hợp lệ khi gate là `approve-youtube-kit`; gate khác thì lỗi `invalid`;
  - ghi `setRenderChoice(runId, "render-final", …)` **trước** khi nộp gate, để worker luôn thấy lựa chọn khi tới
    `render-final`. Nộp gate thất bại thì dòng lựa chọn vẫn còn, vô hại và bị ghi đè ở lần duyệt sau.
- Không truyền `renderMachine` thì không ghi dòng nào (giữ hành vi pha 2).

**Test:** duyệt kit với `nvenc` thì job render có `{ nvenc: true }`; truyền `renderMachine` ở `approve-rnd` thì bị từ
chối và không có gì được nộp.

### A5. Render lại bản cuối với kiểu máy khác

`rerenderEpisode(core, db, episodeId, { machine?, by? })` trả `{ runId, reused, from }`:

| Tình huống | Chạy lại từ | Ghi chú |
|---|---|---|
| Chưa có run | (run mới) | như cũ |
| Run đang chạy, `freeze-timeline` hỏng hoặc chờ | retry `freeze-timeline` | như cũ |
| Run đang chạy, trường hợp khác | 409 `episode_running` | như cũ |
| Run 1.3.0 đã xong, revision mới nhất **giống** timeline đã duyệt | **`render-final`** | mới (Q3) |
| Run 1.3.0 đã xong, timeline đã sửa sau khi duyệt | `approve-timeline` | như cũ |
| Run 1.2.0 đã xong | `freeze-timeline` | như cũ |

- So "giống": so JSON chuẩn hoá của revision mới nhất với `timeline.json` của `approve-timeline`.
- Có `machine` thì ghi lựa chọn cho run mới, khoá `(newRunId, "render-final")`. Khi chạy lại từ `approve-timeline`,
  thẻ duyệt kit sau đó lấy lựa chọn này làm mặc định.
- `episodeRenderInfo(core, db, episodeId)`:
  - `machine`: lựa chọn của run hiện tại;
  - `defaultMachine`;
  - `restartFrom`: bước mà Render lại sẽ chạy từ đó, hoặc `null` khi đang chạy;
  - `job`: job bản cuối mới nhất (`farm_job_id`, `machine`, `created_at`).

**Test** (`episode-render-machine.test.ts`, Claude giả + `fakeFarm`):
- timeline không đổi → `from = render-final`, Claude không được gọi thêm lần nào, job mới mang requirements mới;
- sửa timeline sau khi duyệt → `from = approve-timeline`, lựa chọn nằm trên run mới;
- tập 1.2.0 → `from = freeze-timeline`;
- run đang chạy → 409;
- `restartFrom` khớp từng trường hợp trên.

### A6. Dữ liệu màn Hàng đợi (`packages/studio-engine/src/queue.ts`)

`studioQueue(core, db, farm, { userId, isAdmin, now })` trả về:

- **`claude`**: `{ running, waiting, max, items }`.
  - Lấy từ các dòng `lease` giữ `claude`: `chat:<turn>` và `chat-wait:<turn>` (lượt chat), dòng của stage (bước tự chạy).
  - Mỗi item: production, tập, bước, `startedAt`, `waiting`, `source: "chat" | "stage"`.
  - Item của production người xem không thấy chỉ được đếm, không có tên (`hidden`).
- **`renders`**: các job farm chưa xong.
  - Một lần `farm.listJobs({ status: "queued,leased,paused", limit: 500 })`, đi theo `next_cursor` tối đa 4 trang.
  - Ghép với `studio_farm_jobs` và `episode_jobs` theo `farm_job_id`. Job lạ (không có trong `studio.db`) bị bỏ.
  - Mỗi item:
    - `kind`: `final`, `preview` hoặc `export_premiere`;
    - production, tập;
    - `machine`: suy từ cột `requirements`, `null` nếu không rõ;
    - `status`, `progress`, `progressStage`, `attempt`, `createdAt`;
    - `stuck`: `queued` lâu hơn 10 phút.
  - Lọc theo `team_members` như `studioOverview`.
- **`farm`**: `{ ok: true }` hoặc `{ ok: false, error }`. Farm không với tới thì `renders = []`, không ném lỗi.

**Test:**
- farm giả có `listJobs` phân trang;
- người dùng chỉ thấy job và lượt của team mình, admin thấy hết;
- lượt chat chờ có `waiting: true`;
- `stuck` sau 10 phút;
- farm lỗi thì `farm.ok = false`.

## Nhóm C: API (`apps/api`)

### C1. Route chọn máy

| Route | Vai | Thay đổi |
|---|---|---|
| `POST productions/:id/chat/approve` | producer | `ChatApproveDto` thêm `renderMachine?` (`IsIn(["any","nvenc","gpu"])`) |
| `POST productions/:id/episodes/:episodeId/rerender` | producer | body tuỳ chọn `{ renderMachine? }`; trả thêm `from` |
| `GET productions/:id/episodes/:episodeId` | viewer | thêm `render` (= `episodeRenderInfo`) |

**Test** (`realStudio()`, controller dựng tay, farm giả):
- `renderMachine` sai thì 400;
- truyền ở gate khác kit thì 422;
- rerender không body vẫn chạy và trả `from`;
- viewer gọi rerender nhận 403;
- `render.restartFrom` có trong chi tiết tập.

### C2. `GET studio/queue`

- Mọi người đã đăng nhập đều gọi được; lọc theo quyền ngay trong service (như `studio/overview`).
- `EngineService` cache kết quả `listJobs` 3 s, để nhiều tab polling không dồn lên farm.

**Test:** lọc theo team; farm lỗi vẫn trả 200 với `farm.ok = false`; hai lần gọi trong 3 s chỉ gọi farm một lần.

### C3. Tài liệu API

`docs/studio-api-v3.md`: `renderMachine`, body mới của `rerender`, trường `render` của chi tiết tập, `GET studio/queue`.

## Nhóm D: web (`apps/web`)

Mọi chuỗi giao diện đều vào `i18n/locales/vi.ts`/`en.ts` hoặc `chat.vi.ts`/`chat.en.ts` (`keys.spec.ts` kiểm).

### D1. `RenderMachinePicker`

- `modules/render/RenderMachinePicker.tsx`: ba lựa chọn dạng radio, mỗi lựa chọn có một dòng giải thích:
  - **Bất kỳ máy nào**: máy nào rảnh trước thì nhận;
  - **Máy có NVENC**: encode bằng GPU NVIDIA, nhanh hơn với 4K;
  - **Máy có GPU**: có card NVIDIA.
- Kèm ghi chú: "Nếu không máy nào hợp, job sẽ chờ tới khi có máy."

**Test:** chọn đổi giá trị; mặc định lấy từ prop.

### D2. Duyệt YouTube kit và render

- `ChatThread.tsx`, thẻ `approve` ở gate `approve-youtube-kit`:
  - câu hỏi: "Duyệt YouTube kit và render bản cuối?";
  - có picker, mặc định là `render.machine ?? render.defaultMachine`;
  - nút "Duyệt và render".
- `ResultPane`: nút Duyệt của gate này mở popover xác nhận có cùng picker.
- `ChatProductionPage` gửi `renderMachine` khi gọi `approveChat`.

**Test:** thẻ kit có picker còn thẻ gate khác thì không; bấm gửi đúng `renderMachine`; nút Duyệt ở cột phải không gọi API
khi chưa xác nhận.

### D3. Menu ⋯ "Render bản cuối…" và thẻ `render`

- Menu ⋯ của tập có "Render bản cuối…":
  - mở modal gồm picker và một dòng theo `restartFrom`:
    - `render-final`: "Chỉ render lại, giữ timeline và YouTube kit đã duyệt";
    - `approve-timeline`: "Timeline đã sửa sau khi duyệt: bạn sẽ duyệt lại timeline và YouTube kit trước khi render";
  - mục bị tắt khi `restartFrom = null` (đang chạy).
- Thẻ `render` trong chat của tập có hai nút: "Xem trước 720p" (như pha 2) và "Render bản cuối…" (mở cùng modal).

**Test:** mục menu tắt khi đang chạy; modal gửi `rerender` với máy đã chọn; dòng mô tả đổi theo `restartFrom`.

### D4. Cột kết quả hiện kiểu máy

- `EpisodeOutputs`, khối bản cuối:
  - "Farm · máy có NVENC · 62%" lúc đang chạy;
  - "Đang chờ máy phù hợp · 12 phút" khi `queued`, cảnh báo khi quá 10 phút;
  - "Render trên: máy có NVENC" khi đã xong.
- Bỏ dòng "phase 3" trong docstring.

**Test:** ba trạng thái hiện đúng chữ.

### D5. Màn Hàng đợi (`/queue`)

- `pages/QueuePage.tsx`, nằm trong `ChatShell` (giữ cột trái), theo màn 12:
  - **Lượt Claude:** "n / max lượt đang chạy · k lượt chờ", từng lượt (video · bước · thời gian · "bạn yêu cầu" hoặc
    "tự động"), dòng "và n lượt của video khác" cho các lượt bị ẩn;
  - **Render:** từng job (video · tập · loại · kiểu máy · trạng thái · thanh tiến độ), cảnh báo `stuck`; farm lỗi thì một
    dòng "Không đọc được hàng đợi farm";
  - **Chờ bạn duyệt:** chip từ `studio/overview` (`waiting_you`, `needs_attention` tô đỏ), bấm thì mở video.
- Cột phải:
  - form số lượt Claude: tách từ popover của `ClaudeChip` thành `ClaudeSettingsForm`; chỉ admin sửa được;
  - khối "Kiểu máy render" giải thích ba lựa chọn (Q5), không có danh sách máy.
- Header có chip "Claude: n/max" và "Render: n job", cả hai là link tới `/queue` (Q9). Cột trái có link "Hàng đợi" ở cuối.
- Polling 5 s. Khung trình duyệt nhúng của app báo trang luôn ẩn nên không polling; kiểm bằng khung đó thì tải lại trang.

**Test:**
- ba phần hiện đúng dữ liệu giả;
- dòng lượt bị ẩn;
- người không phải admin không thấy ô sửa;
- chip "Render" đếm đúng;
- bấm chip chuyển tới `/queue`.

## Nhóm E: kiểm thử tổng và tài liệu

### E1. Luồng "Xong khi" với Claude và farm giả

`tests/integration/render-machine.test.ts` chạy engine, worker pool và controller dựng tay trong cùng tiến trình:

1. Production tới tập 1, duyệt timeline.
2. Duyệt YouTube kit với `nvenc` → render xong; job có `{ nvenc: true }`.
3. `rerender` với `any` → `from = render-final`; không có lượt Claude mới; job mới có `{}`.
4. Tập có hai job bản cuối với requirements khác nhau, cả hai xong; `studio_farm_jobs.requirements` ghi đúng.
5. `GET studio/queue` trong lúc job đang chạy thấy job với đúng kiểu máy.

### E2. E2E với hub farm thật (`E2E=1`)

Thêm vào `tests/e2e/farm-render.e2e.test.ts`: gửi ba job `studio.render_final` với requirements của `any`, `nvenc`,
`gpu` tới hub thật, hub nhận cả ba (schema strict), rồi huỷ. Bước này canh hợp đồng với ag-farm, không phụ thuộc máy có
GPU hay không.

### E3. Kiểm tay trên stack local

1. `node scripts/local-stack.mjs up`, dùng Claude giả.
2. Mở web farm (3011) xem khả năng `local-render` khai: số GPU, `nvenc`.
3. Một tập đi tới gate kit, duyệt với "Bất kỳ máy" → render xong.
4. ⋯ → Render bản cuối… → chọn "Máy có GPU" (hoặc "Máy có NVENC" nếu node khai `nvenc`) → render xong.
5. Web farm: hai job có requirements khác nhau. Studio `/queue`: thấy job trong lúc chạy.
6. Chụp màn hình từng bước. Khung trình duyệt nhúng không polling, nên tải lại trang sau mỗi bước.

Lưu ý máy dev: Quadro P1000, driver 582 (< 610), nên `h264_nvenc` không chạy được. `ffmpeg-static` vẫn có encoder đó
trong bản build, vì vậy node có thể khai `nvenc: true` và nhận job "Máy có NVENC", rồi render bằng CPU (`encoder: auto`
tự lùi). Ghi vào ADR và runbook.

### E4. Tài liệu cuối pha

- `AGENTS.md`, mục Render: kiểu máy, `studio_render_choices`, `requirementsFor`, Render lại từ `render-final`, `/queue`.
- ADR-0001:
  - **148**: chọn kiểu máy bằng `requirements` sẵn có, lưu theo run, mặc định `{}`, không đổi hợp đồng farm;
  - **149**: Render lại chạy từ `render-final` khi timeline không đổi;
  - **150**: Hàng đợi đọc owner API, không có danh sách máy; NVENC khai theo bản ffmpeg.
- `docs/runbooks/studio-local.md`: màn Hàng đợi, kiểm khả năng node trên web farm, job nằm chờ mãi khi không máy nào hợp.
- `deferred-items.md`, mục "Sau pha 3":
  - danh sách máy qua admin API;
  - đổi máy cho job đang chờ;
  - tên máy trên job;
  - manifest render không ghi encoder thật đã dùng;
  - job không máy nào hợp chờ tới hết deadline 4 giờ × 2 lần thử;
  - "máy này" của mockup đã bỏ.

## Thứ tự và phụ thuộc

A1 → A2 → A3 → A4 → A5 → A6 → C1 → C2 → C3 → D1 → D2 → D3 → D4 → D5 → E1 → E2 → E3 → E4.

D chỉ cần hợp đồng của C (test dùng client giả). E1 cần A và C.

## Kiểm tra cuối pha

- `corepack pnpm -r run build && corepack pnpm -r typecheck && corepack pnpm test`, so với baseline trong
  `deferred-items.md`.
- `E2E=1 corepack pnpm vitest run tests/e2e/farm-render.e2e.test.ts`.
- Kịch bản E3 trên stack local, kèm ảnh chụp.
