# Plan pha 2: giao diện chat là chính

Spec: `docs/superpowers/specs/2026-10-06-ag-studio-local-chat-design.md` (mục 2, 3.1, 3.2; bảng pha, dòng 2).
Mockup: https://claude.ai/artifact/N6YHc1yrBvqc1Fv6ab8xZL. Pha 2 dùng các màn 1–7, 10, 13, 14 và phần "Số lượt chạy
cùng lúc" của màn 12. Màn 8, 9 (cắt theo shot) thuộc pha 5. Phần chọn máy của màn 11 và 12 thuộc pha 3.
Nhánh: `feat/local-phase-2-chat`, tách từ `feat/local-phase-0-1`. Mỗi task một commit, test viết trước.

**Xong khi** (bảng pha): tạo video bằng một câu chat → chat sửa R&D → duyệt → branding tự chạy; chat sửa timeline
một tập; e2e với Claude giả; thử tải 20 lượt song song.

## Quyết định cần bạn duyệt

Các mục dưới đây lệch spec hoặc mockup, hoặc spec chưa nói rõ. Plan đang viết theo cột "Đề xuất".

| # | Vấn đề | Đề xuất | Lý do |
|---|---|---|---|
| Q1 | Lượt chat chạy ở tiến trình nào | **Worker**, một vòng chat riêng không qua `claim`. API chỉ ghi tin nhắn vào bảng. | API và worker là hai tiến trình nên semaphore trong bộ nhớ không phủ được cả hai. Chỉ worker có env Claude. Lượt chat chạy 30 s đến vài phút (có khi chờ hạn mức 60 phút), không nên giữ request HTTP. |
| Q2 | Semaphore dùng chung | Dùng **bảng `lease` sẵn có**: mỗi lượt chat giữ một dòng `chat:<turn>` với `resources ["claude"]`. Khi đầy, lượt chat chờ giữ dòng `chat-wait:<turn>`. `claim()` của worker đếm cả hai loại dòng nên slot vừa trống thuộc về chat. | Không phải sửa `claim()` trong core. Lượt chết thì reaper tự dọn. Đúng cả khi chạy nhiều worker. |
| Q3 | Intake qua chat | Không thêm stage mới. Chat intake chạy **trước** run, trên production nháp. "Bắt đầu" ghi các trường vào `productions` rồi `startPlanRun`. Stage `intake` (`studio-series-seed`) giữ nguyên. | Spec ghi "3.0.0 … intake qua chat"; cách này đạt được điều đó mà không đổi đường seed. |
| Q4 | Thứ tự gate của tập | `build-timeline` → **approve-timeline** → `youtube-kit` → **approve-youtube-kit** → freeze → render… (theo mockup: Timeline rồi mới đến YouTube kit). | Kit dựng từ timeline đã duyệt nên chương trong mô tả khớp. Vẫn đúng ý spec: cả hai gate đều đứng trước `freeze-timeline`. |
| Q5 | Màn 13 "Áp dụng và chạy lại" khi stage agent hỏng | Claude giải thích lỗi trong chat. "Chạy lại" = `retry` stage, đưa góp ý trong chat vào prompt (`# Góp ý của người dùng`). Claude **không** tự sửa tài liệu của một stage đã FAILED. | Ghi đè đầu ra của stage hỏng thì phải sửa core (artifact REJECTED). Chạy lại kèm góp ý giữ đúng checker. |
| Q6 | Chọn thumbnail ở bước YouTube kit (màn 10) | Không làm ở pha 2. Gate kit chỉ sửa tiêu đề, mô tả, tag và ý tưởng thumbnail. Thumbnail thật vẫn chọn sau render (ThumbnailPanel). | Thumbnail cắt từ `final.mp4`, mà file này chỉ có sau render. |
| Q7 | Nơi lưu cấu hình số lượt | Bảng `studio_settings`: giá trị lưu trên web thắng env; chưa lưu thì dùng `STUDIO_CLAUDE_MAX_CONCURRENT`, không có env thì 20. Chỉ admin Studio được sửa. | Cấu hình là của cả Studio, không của một team. |
| Q8 | Cập nhật trực tiếp | Vẫn polling (2 s khi có lượt đang chạy, 5 s khi không). Không làm SSE ở pha 2. | App hiện chỉ polling, ít rủi ro. SSE ghi vào `deferred-items`. |
| Q9 | Giao diện cũ | `/` thành trang chủ chat. Trang bảng cũ (`/productions`, `/teams`, editor) giữ nguyên, mở từ menu người dùng. Run v2 và tập 1.2.0 đang chạy vẫn hiện trong giao diện mới; chat ở các gate cũ vẫn dùng được. | Production đang chạy phải giữ hành vi cũ (spec mục 6). |
| Q10 | Render ở bước Timeline | Pha 2 chỉ có **xem trước 720p qua farm** (`editor/previews` sẵn có), gọi từ ⋯ hoặc từ thẻ xác nhận trong chat. Render trên "máy này" và chọn máy cho bản cuối thuộc pha 3. | Spec 3.4: mọi render đi qua farm. |

## Mô hình dữ liệu chat

- **Phạm vi (scope)** của một lượt chat:
  - `intake`: production chưa có run;
  - `gate`: một gate đang `WAITING_HUMAN`, gồm `approve-trend-report`, `approve-rnd`, `approve-branding`, `approve-plan`, `approve-timeline`, `approve-youtube-kit`;
  - `failed`: một stage agent `FAILED`;
  - `timeline`: timeline của một tập khi không có gate nào đang chờ, chẳng hạn tập 1.2.0 đã render.
- **Bản hiện tại** của một gate là đề xuất gần nhất trong chat chưa bị thay. Chưa có đề xuất thì là bản nháp Claude
  viết ở stage nguồn. Với timeline, bản hiện tại là revision mới nhất.
- **Duyệt** nộp đúng bản đang hiện ở cột phải (`submitStudioGate`), ghi `human_edits` với `before` = bản nháp và
  `after` = bản duyệt. Server lấy tài liệu theo `turnId`; web không gửi lại tài liệu.
- **Áp dụng** chỉ có ở intake (ghi các trường vào production nháp) và timeline (lưu một revision mới). Hai việc này
  đảo lại được: production chưa chạy, revision thì có lịch sử.

Bảng nối gate với stage nguồn (`GATE_SOURCES`, `packages/studio-engine/src/chat-context.ts`):

| Gate | Stage nguồn | Skill (prompt + validator) | Đầu vào validator |
|---|---|---|---|
| approve-trend-report | trend-report | studio-trend-report | không cần |
| approve-rnd | rnd | studio-rnd | seed |
| approve-branding | branding | studio-branding | không cần |
| approve-plan | plan-episodes | studio-plan-episodes | brief, catalog |
| approve-youtube-kit | youtube-kit | studio-youtube-kit | episode, branding |
| approve-timeline | build-timeline | studio-timeline (mới) | `timelineIssues` |

Ngữ cảnh của prompt lấy từ attempt `SUCCEEDED` gần nhất của stage nguồn (`stage-request.json` + `inputs/` trong
workspace đó). Nếu stage nguồn được reuse thì lần theo `reused_artifact_ids` về run gốc.

---

## Nhóm A — engine

### A1. Bảng `stage_chat_turns` (migration `0019_stage_chat.sql`)

**Cột:**
- Theo spec: `id`, `production_id`, `episode_id?`, `run_id?` (null ở intake), `stage_key`, `turn`, `role`, `text`, `proposal`, `action`, `llm_call_id`, `created_at`.
- Thêm so với spec:
  - `scope`;
  - `status` (`pending | running | done | failed | rate_limited`);
  - `not_before`;
  - `problems` (JSON);
  - `mentions` (JSON gồm folder id và tên);
  - `context` (JSON: ảnh chụp danh sách folder khi gửi);
  - `created_by`;
  - `applied_at` (đề xuất đã áp dụng hoặc đã duyệt);
  - `superseded_by`.
- Index theo `(production_id, episode_id, created_at)` và `(status, not_before)`.

**Code:** `packages/studio-engine/src/chat-db.ts` có các hàm:
- `insertUserTurn`: trong cùng một `immediate`, ghi tin của người dùng kèm một dòng assistant `pending`;
- `listTurns`;
- `nextPendingTurns`;
- `markTurn*`;
- `currentProposal(scope)`.

**Test:**
- `chat-db.test.ts`:
  - thứ tự `turn` tăng dần trong một production;
  - `currentProposal` bỏ qua đề xuất đã bị thay;
  - hai tin gửi gần như cùng lúc không trùng số `turn`.
- Sửa danh sách bảng trong `packages/core/test/state/sqlite-store.test.ts`.

### A2. Cấu hình số lượt cùng lúc trên web (migration `0020_studio_settings.sql`)

- Bảng `studio_settings(key PRIMARY KEY, value, updated_at, updated_by)`.
- `claudeMaxConcurrent(db, env)` đọc theo thứ tự: giá trị trong DB, rồi env, rồi 20. Giá trị sai trong DB ghi cảnh báo và dùng env.
- `packages/worker`: `resourceCapacity` nhận thêm dạng hàm `() => Record<string, number>`, đọc lại ở mỗi lần `claim`. Kiểu cũ (object) vẫn chạy như trước.
- `createStudioWorkerPool` đọc lại cấu hình mỗi 10 s:
  - số vòng ít hơn `claude + farm + cpu` thì thêm vòng;
  - nhiều hơn thì cho các vòng thừa dừng sau stage đang chạy.

**Test:**
- thứ tự ưu tiên của nguồn cấu hình;
- Worker với capacity dạng hàm;
- pool tăng từ 2 lên 4 vòng rồi giảm về 2 mà không cắt ngang stage đang chạy (dùng `barrier-claude.mjs`).

### A3. Slot Claude dùng chung giữa các tiến trình, chat được ưu tiên

`packages/studio-engine/src/claude-slots.ts` có các hàm `acquireChatSlot(store, turnId, cap, now)`,
`heartbeatChatSlot` và `releaseChatSlot`, chạy trên bảng `lease` (xem Q2).

**Thuật toán:**
- Đếm số slot đang chạy thật: `running = held(claude) − số dòng chat-wait`.
- Nếu `running < cap`: đổi dòng `chat-wait:<turn>` của mình (nếu có) thành `chat:<turn>`.
- Nếu không: giữ hoặc thêm dòng `chat-wait:<turn>`.

Không sửa `claim()` trong core.

**Test:**
- dòng chat đếm vào capacity của `claim()`;
- khi có lượt chat đang chờ, worker không claim stage agent mới dù vừa có slot trống;
- lease chat hết hạn được `reapExpiredLeases` xoá mà không ném lỗi.

### A4. Hợp đồng chat (`packages/contracts/src/studio-chat.ts`)

- `ChatAction = answer | revise | suggest_approve | render | export | retry`.
- `chatReplySchema(proposalSchema)` = `{ reply, action, proposal: proposalSchema | null }`.
- `IntakeDraftSchema`: title, folder_ids, channels, keywords, aspect, language, hints, music. Thêm `questions[]`: danh sách câu còn thiếu; Claude chỉ hỏi câu đầu tiên.
- `TimelineOpSchema`: union theo `op`, gồm `addClip | removeClip | moveClip | replaceClipAsset | setSectionTitle | addText | updateText | removeText | setMusic | setSourceMuted`. Trường khớp chữ ký trong `layout.ts`.
- Export `claudeJsonSchemaFor(zodSchema)`, tách từ `claudeOutputJsonSchema` (`stripForClaude` đang private).
- `TEAM_SKILL_STEPS` thêm `intake` và `timeline`.
- Kiểu `StudioChatSkill = "studio-intake" | "studio-timeline"` tách khỏi `StudioSkill`, để không bắt mọi `Record<StudioSkill, …>` phải có entry. `StudioLlmCall.skill` nới thành `StudioSkill | StudioChatSkill`.
- Chạy `pnpm gen:schemas` và commit JSON Schema sinh ra.

**Test:** parse và từ chối từng op; schema Claude của mỗi `chatReplySchema` không còn `z.record` hay min/max.

### A5. Tách `studioPrompt` thành phần đầu và phần cuối (không đổi hành vi)

- `studio-agent-executor.ts`: `studioPromptHead(request, ws, guides)` gồm brief, quy chuẩn nhóm và `# Dữ liệu vào`. `studioPromptTail(problems)` gồm `# Đầu ra` và phần sửa.
- `studioPrompt` = head + tail. Prompt phải giống từng byte so với bản hiện tại.
- Export `studioValidator(skill)`, bọc `VALIDATORS`, và `checkerInputFor(request, ws)`.

**Test:** snapshot prompt của cả 5 skill trước và sau khi tách phải bằng nhau. Toàn bộ test hiện có của executor xanh.

### A6. Dựng ngữ cảnh chat (`chat-context.ts`)

`chatContext(core, db, { productionId, episodeId?, stageKey? })` trả về scope, skill, `head`, bản hiện tại,
`validate(raw)` và lịch sử góp ý của scope.

- **Gate:** dùng `GATE_SOURCES`, workspace của stage nguồn, bản nháp lấy từ artifact ACCEPTED của stage nguồn.
- **Failed:** dùng stage hỏng, bản bị từ chối và các `problems` lấy từ `llm_calls` gần nhất.
- **Timeline:** revision mới nhất, `timelineIssues`, danh sách asset được phép dùng (clip và alternates của tập).
- **Intake:** production nháp và ảnh chụp folder trong `context` của turn.

Không có gì để chat (run đang chạy, tập đang render) thì ném `StudioRunError("conflict")`.

**Test:**
- dùng `world()` + Claude giả, chạy tới từng gate của plan@3.0.0 và kiểm skill, bản nháp, validator;
- stage được reuse lần về run gốc;
- tập 1.2.0 đã xong thì scope là `timeline`.

### A7. Một lượt chat (`chat.ts` → `runChatTurn`) và nhánh chat của Claude giả

**Prompt** = `# Skill` (SKILL.md của skill nguồn) + head + `# Bản hiện tại` (JSON) + `# Góp ý` (lịch sử chat của
scope, tin mới nhất ở cuối) + `# Đầu ra (chat)`.

`# Đầu ra (chat)`:
- trả lời bằng tiếng Việt, ngắn gọn;
- chỉ trả `proposal` khi có sửa;
- khi người dùng đồng ý thì trả `suggest_approve`, không tự duyệt.

**Gọi Claude:** `CliAgentRuntime` structured, schema `claudeJsonSchemaFor(chatReplySchema(...))`, chạy trong workspace
`<dataRoot>/chat/<turnId>/`. Request tổng hợp có `attempt_id` = turn id và deadline 15 phút.

**Kiểm và lưu:**
- Đề xuất được kiểm bằng validator của skill nguồn. Timeline thì áp từng op vào bản sao rồi chạy `timelineIssues`; op lỗi hoặc có issue `error` đều là problem.
- Có một vòng sửa. Vẫn sai sau vòng sửa thì giữ `reply`, bỏ `proposal`, lưu `problems`, và web hiện "Claude chưa sửa được: …".
- Mỗi lần gọi ghi `llm_calls`:
  - `source = 'claude-chat'` (thêm tham số cho `recordLlmCall`);
  - `run_id = 'intake'` khi chưa có run;
  - `stage_key` = gate.

**Hết hạn mức:** khi gặp `RATE_LIMITED`, trả slot, đặt `status = rate_limited` và `not_before` theo bậc 5→60 phút
(không tính là vòng sửa).

**Claude giả** (`fixtures/fake-studio-claude.mjs`): prompt có `# Góp ý` thì trả `{reply, action, proposal}`.
- Tin có "?" thì trả `answer`.
- Tin có "ok", "duyệt" hoặc "được" thì trả `suggest_approve`.
- Còn lại trả `revise`, kèm bản hiện tại đã sửa một trường dễ thấy (R&D đổi `summary`, timeline thêm một `addText`…).
- Thêm hai skill `studio-intake` và `studio-timeline`.
- Thêm `FAKE_STUDIO_MODE=chat-bad-once` và `chat-bad-always`.

**Test** (`chat.test.ts`):
- revise hợp lệ;
- sai một lần rồi sửa được;
- sai hai lần thì không có proposal;
- `answer`;
- `rate-limit-once`;
- `llm_calls` có đủ hai vòng;
- prompt chat bắt đầu bằng đúng head của stage nguồn.

### A8. Vòng chat trong worker

`createChatRunner({ core, db, bucket, claude, cap })` được `createStudioWorkerPool` khởi động.
- Mỗi giây lấy các lượt `pending` (và `rate_limited` đã tới `not_before`).
- Các scope khác nhau chạy song song. Trong một scope chạy tuần tự: tin mới gửi lúc Claude đang trả lời sẽ chờ lượt sau, và lượt sau thấy cả hai tin.
- Mỗi lượt chạy: xin slot (A3), heartbeat 30 s, chạy `runChatTurn`, trả slot trong `finally`.
- Lúc khởi động: lượt `running` không còn lease nào là do tiến trình cũ chết, nên đưa về `pending`.
- `apps/worker/src/main.ts` không cần env mới.

**Test:**
- hai scope chạy song song, một scope chạy tuần tự;
- lượt mồ côi được chạy lại;
- `stop()` chờ các lượt đang chạy xong.

### A9. Chạy lại stage kèm góp ý (scope `failed`, Q5)

- `StudioAgentExecutor` thêm tuỳ chọn `feedbackFor(request)`. Có góp ý thì chèn `# Góp ý của người dùng` giữa head và tail.
- Worker nối `feedbackFor` tới các lượt chat của scope `failed` trên stage đó, những lượt sau lần chạy trước.
- Engine thêm `retryStageWithFeedback`, bọc `retryStage`.

**Test:** stage `plan-episodes` hỏng với `plan-bad-always` → chat → retry thì prompt mới có góp ý. Dùng
`plan-bad-once` thì lần chạy lại pass.

## Nhóm B — workflow

### B1. `ag-studio-series-plan@3.0.0`

- Sao từ 2.0.0, thêm gate `approve-trend-report` sau `trend-report` (check `trend-report-valid`, output `trend-report.json`).
- `rnd`, `branding`, `plan-episodes` và `spawn-episodes` lấy `trend_report` từ gate thay vì từ `trend-report`. Mỗi kiểu artifact chỉ đến từ một nguồn.
- `STUDIO_GATES` thêm `approve-trend-report`. `STUDIO_WORKFLOWS.plan` → 3.0.0. `deriveStatus`/`APPROVAL_GATES` của API thêm gate mới.

**Test:**
- `workflow-wiring.test.ts` (tự phủ bản mới);
- `plan-v3.test.ts`: tạo production → dừng ở `approve-trend-report` → duyệt → dừng ở `approve-rnd`;
- một run 2.0.0 đang chờ `approve-rnd` vẫn duyệt được và đi tiếp đúng.

### B2. `ag-studio-episode@1.3.0`

Thứ tự stage (Q4):
1. episode-intake
2. build-timeline
3. **approve-timeline** (gate, `timeline.json`, check `timeline-valid`)
4. youtube-kit (phụ thuộc approve-timeline, episode-intake)
5. **approve-youtube-kit** (gate, `youtube-kit.json`, check `youtube-kit-valid`)
6. freeze-timeline: script mới **`studio-freeze-timeline-v2`**, đọc timeline đã duyệt từ input thay vì revision mới nhất
7. render-final, thumbnails, export: lấy `youtube_kit` từ gate

Thay đổi đi kèm:
- Tài liệu nộp cho `approve-timeline` do server dựng từ revision mới nhất.
- `STUDIO_GATES` thêm hai gate. `STUDIO_WORKFLOWS.episode` → 1.3.0.
- `episodeStatusOf`: tập đang chờ một gate trả về trạng thái mới **`waiting_approval`**; hiện nay `WAITING_HUMAN` bị coi là `failed`. Cập nhật `EpisodeStatus`, `deriveStatus` và enum trên web.
- Sửa timeline bằng editor sau khi đã duyệt thì API trả cảnh báo "đã duyệt; cần chạy lại từ approve-timeline".

**Test:**
- wiring;
- `episode-v13.test.ts`: tập dừng ở hai gate theo đúng thứ tự, và freeze dùng bản đã duyệt chứ không dùng revision sửa sau đó;
- tập 1.2.0 cũ vẫn chạy thẳng tới render.

## Nhóm C — API (`apps/api`)

### C1. Endpoint chat

Mọi route nằm dưới `productions/:id`, nên `RolesGuard` lấy được team từ `:id`.

| Route | Vai | Việc |
|---|---|---|
| `POST teams/:teamId/drafts` `{text}` | producer | Tạo production nháp (title "Video mới") và lượt intake đầu tiên → `{productionId}` |
| `GET productions/:id/chat?episodeId&after` | viewer | Danh sách lượt; kèm `scope` hiện tại, `canApprove` và `queue` (số lượt đứng trước) |
| `POST productions/:id/chat` `{text, episodeId?}` | editor | Tự xác định scope (A6); không có gì để chat thì 409 |
| `POST productions/:id/chat/:turnId/apply` | producer (intake), editor (timeline) | Áp dụng đề xuất intake hoặc timeline |
| `POST productions/:id/start` | producer | Áp dụng bản intake mới nhất rồi `startPlanRun` (3.0.0); thiếu trường bắt buộc thì 422 kèm danh sách |
| `POST productions/:id/chat/approve` `{stageKey, episodeId?, turnId?}` | producer | Duyệt bản đang hiện (xem "Mô hình dữ liệu chat"); ghi `human_edits` |
| `POST productions/:id/chat/retry` `{stageKey, episodeId?}` | producer | `retryStageWithFeedback` |

- Mention `@folder` trong `text` có dạng `@[tên](folder:<id>)`. API kiểm các folder id bằng `AgGoClient.getFolders(userId)` (sai thì 422, như `POST sources`). Ảnh chụp danh sách folder được ghi vào `context` của turn.

**Test:** theo kiểu `studio-run.spec.ts` (`realStudio()`, controller dựng bằng tay):
- quyền theo vai;
- 409 khi run đang chạy;
- approve theo turn ghi đúng `before`/`after`;
- apply timeline gặp 409 khi revision đã đổi.

### C2. Tổng quan, số lượt Claude, cài đặt

- `GET studio/overview`: một query nhẹ cho cột trái và trang chủ.
  - Gồm các production người dùng xem được, kèm các tập.
  - Mỗi mục có bước hiện tại và nhóm `waiting_you | needs_attention | running | done | draft`.
  - Không dựng `ProductionDto` đầy đủ.
  - Lọc theo `team_members` ngay trong service, không dùng `@Roles`.
- `GET studio/claude`: `{ running, waiting, max }`, đếm từ bảng `lease`.
- `PUT studio/settings` `{claudeMaxConcurrent}`: chỉ admin, giá trị nguyên 1–100.

**Test:** người dùng chỉ thấy production của team mình; admin thấy tất cả; người không phải admin nhận 403 khi `PUT`.

### C3. Tài liệu API

`docs/studio-api-v3.md` thêm các mục Chat, Overview, Settings, trạng thái tập `waiting_approval` và hai gate của tập.
Bổ sung luôn các route `llm-calls` và `human-edits` còn thiếu trong tài liệu.

## Nhóm D — web (`apps/web`)

Mọi chuỗi giao diện đều thêm vào `i18n/locales/vi.ts` và `en.ts` (`keys.spec.ts` kiểm). Test dùng vitest +
testing-library với client giả, giống `ProductionDetailPage.spec.tsx`.

### D1. Khung 3 cột và route

- `modules/chat/ChatShell.tsx`, theo màn 1–7:
  - Header: logo, chip "Claude: n/max lượt đang chạy" (`GET studio/claude`, 5 s), menu người dùng. Menu có thêm "Bảng production cũ" và "Team".
  - Cột trái: nút "Video mới", cây series → tập kèm nhãn trạng thái.
  - Cột giữa: chat.
  - Cột phải: kết quả.
  - Khung hẹp thì các cột xếp chồng.
- Route mới:
  - `/` (trang chủ);
  - `/v/:productionId`;
  - `/v/:productionId/e/:episodeId`.
- Route cũ giữ nguyên trong ProLayout (Q9).

**Test:** cây hiện đúng nhãn từng nhóm; bấm một tập thì đổi route.

### D2. Ô chat có `@folder`

- `ChatComposer.tsx`: gõ `@` thì mở danh sách folder ag-go (`useAgGoClient().getFolders()`, lọc theo chữ đã gõ, hiện số video).
- Chọn một folder thì chèn chip. Enter gửi, Shift+Enter xuống dòng.
- Trang chủ có thêm các chip gợi ý.

**Test:** chèn và xoá mention; nội dung gửi đúng dạng `@[tên](folder:id)`.

### D3. Luồng chat

- `ChatThread.tsx` hiện:
  - tin người dùng và tin Claude;
  - vạch ngăn theo bước (`Bước n · tên · chờ bạn/đã duyệt`);
  - các bước đã duyệt thu gọn kèm "xem lại".
- Lượt đang chờ hiện "Claude đang trả lời…", "Đang chờ lượt (n trước)" hoặc "Hết hạn mức, tự thử lại lúc HH:MM".
- Thẻ theo `action`:
  - `suggest_approve`: "Duyệt … và chuyển sang …?" với nút Duyệt;
  - `render`: "Render xem trước 720p?";
  - `export`: "Xuất project Premiere?" (proxy hoặc gốc);
  - `retry`: "Chạy lại bước này với góp ý?".
- Mọi hành động có tác dụng thật đều qua thẻ (spec 2.5).
- Polling 2 s khi còn lượt chưa xong.

**Test:** thứ tự và vạch ngăn; nút trên thẻ gọi đúng API; trạng thái chờ hạn mức.

### D4. Cột kết quả: tài liệu đọc được, tô phần đổi, Duyệt và menu ⋯

- `diffDoc(before, after)` liệt kê các đường dẫn đã đổi. View tô xanh phần thêm và gạch đỏ phần bỏ. Nhãn "Bản n · k thay đổi".
- View chỉ đọc cho từng bước:
  - `IntakeSummary` (màn 2);
  - `TrendReportView` (dùng lại `ResearchView`);
  - `RndView`;
  - `BrandingView` (dùng lại phần xem trước của `BrandingEditor`);
  - `PlanView`;
  - `TimelineResult` (player xem trước 720p, dải clip, "Thay đổi so với bản trước");
  - `YoutubeKitView`;
  - `EpisodeOutputs` (render, thumbnail, xuất file: dùng lại `EpisodeDrawer`, `ThumbnailPanel`, `PremiereExports`);
  - `FailedStageView` (màn 13: vấn đề và nút "Chạy lại").
- Nút chính có một nút duy nhất:
  - Bắt đầu (intake);
  - Duyệt (gate);
  - Áp dụng (đề xuất timeline chưa áp dụng);
  - Chạy lại (failed).
- Menu ⋯:
  - Làm lại bước này (`resume`);
  - Render xem trước;
  - Xuất Premiere;
  - Sửa tay;
  - Nhật ký Claude (`LlmLogPanel`);
  - Huỷ.

**Test:** `diffDoc` (bảng tình huống); mỗi view hiện đúng phần đổi; Duyệt gửi đúng `turnId`.

### D5. Trang chủ và luồng tạo video

- Trang chủ (màn 1): tiêu đề, ô chat, chip gợi ý. Cột phải chia thành "Đang chờ bạn duyệt", "Cần xử lý", "Đang chạy" (thanh tiến độ render) và "Xong gần đây".
- Gửi tin đầu tiên → `POST drafts` → chuyển sang `/v/:id`.
  - Có hơn một team thì chọn team ngay trên ô chat (nhớ team cuối như hiện nay).
- Màn 2: cột phải là tóm tắt yêu cầu, có nhãn "còn n câu hỏi". Câu hỏi có lựa chọn hiện thành chip trả lời nhanh. Nút "Bắt đầu" bật khi đủ trường bắt buộc.

**Test:** gửi tin đầu → chuyển trang; Bắt đầu tắt khi còn thiếu trường và bật khi đủ.

### D6. Sửa tay (màn 14)

- ⋯ → Sửa tay:
  - gate R&D, branding, kế hoạch: mở `RndEditor`/`BrandingEditor`/`PlanEditor` trong một drawer;
  - timeline: mở editor sẵn có, header có "Quay lại chat".
- Lưu ở drawer tạo một lượt `role=user` có `proposal`, tức một bản mới, nên Duyệt sẽ lấy bản này. Lưu ở editor timeline thì thêm một dòng hệ thống "Bạn đã sửa tay timeline (bản n)".
- `PlanEditor` hiện đang tự gọi `submitApprovePlan`. Thêm chế độ `mode="draft"` để chỉ trả tài liệu về.

**Test:** lưu bản sửa tay thì cột phải hiện "Bản n+1"; `PlanEditor` ở `mode="draft"` không gọi API duyệt.

### D7. Cài đặt số lượt Claude

Bấm chip ở header mở popover:
- hiện số lượt đang chạy và đang chờ;
- admin có thêm ô số 1–100 và nút Lưu, kèm lời nhắc về hạn mức (lấy từ màn 12).

**Test:** người không phải admin không thấy ô sửa.

## Nhóm E — kiểm thử tổng và tài liệu

### E1. Luồng chat đầy đủ với Claude giả

`tests/integration/chat-flow.test.ts`: engine, worker pool và vòng chat chạy trong cùng tiến trình, gọi controller API
dựng bằng tay. Không cần Docker hay farm. Kịch bản:
1. Gửi "Làm series vlog Kyoto từ @[Kyoto 2025](folder:f1) giống @meitime" → intake hỏi khung hình → trả lời "Ngang 16:9" → Bắt đầu.
2. Dừng ở `approve-trend-report` → duyệt.
3. Dừng ở `approve-rnd` → chat "gộp tập 3 và 4" → có đề xuất (Bản 2) → duyệt.
4. `branding` tự chạy tới `approve-branding` → duyệt → kế hoạch → duyệt → tập được tạo.
5. Tập 1 dừng ở `approve-timeline` → chat "nhạc nhỏ lại, thêm chữ ở clip 2" → Áp dụng → revision mới → duyệt → tới `approve-youtube-kit`.

Thêm bản E2E (`E2E=1`, `tests/e2e/chat-flow.e2e.test.ts`) chạy API và worker bản `dist` thật, dùng Claude giả và
ag-go giả, dừng trước `render-final`, nên không cần farm.

### E2. Thử tải 20 lượt song song

`packages/studio-engine/test/chat-load.test.ts` dùng `barrier-claude.mjs` với cap 20, tạo 12 stage agent và 20 lượt
chat. Phải thấy:
- số lượt cùng lúc tối đa là 20, không bao giờ quá;
- mọi lượt chat đã chờ đều chạy trước các stage agent xếp hàng sau chúng;
- hết sạch lease khi xong.

Kiểm tay trên stack local với `config-local.cjs claude fake`: mở 5 production, gửi tin ở cả 5 cùng lúc, đặt cap 3 →
header hiện 3/3 và 2 đang chờ.

### E3. Tài liệu cuối pha

- `AGENTS.md`: chat, `stage_chat_turns`, slot chat trên `lease`, `studio_settings`, workflow 3.0.0/1.3.0, `waiting_approval`.
- ADR-0001, mục mới 144–147:
  - chat chạy ở worker, slot qua lease;
  - gate sau mọi stage agent;
  - intake trước run;
  - chạy lại kèm góp ý.
- `docs/runbooks/studio-local.md` và `studio-production.md`: dùng giao diện chat.
- `skills/README.md`: `studio-intake`, `studio-timeline`.
- `deferred-items.md`: SSE, chọn thumbnail ở bước kit, Claude sửa thẳng tài liệu của stage hỏng.

## Thứ tự và phụ thuộc

A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 → A9 → B1 → B2 → C1 → C2 → C3 → D1 → D2 → D3 → D4 → D5 → D6 → D7 → E1 → E2 → E3.

B1 và B2 làm được ngay sau A1; A6 cần B1 và B2 để có đủ gate cho test. D chỉ cần hợp đồng của C, test dùng client giả.

## Kiểm tra cuối pha

- `corepack pnpm -r run build && corepack pnpm -r typecheck && corepack pnpm test`, so với baseline trong `deferred-items.md`.
- `E2E=1` cho `chat-flow.e2e.test.ts`.
- Trên stack local (`node scripts/local-stack.mjs up`, Claude giả): làm đủ kịch bản E1 bằng tay trên `http://localhost:3100` và chụp màn hình từng bước.
- Một lần với Claude thật cho một production nhỏ, kèm số lượt gọi và hạn mức đã dùng. Chỉ chạy khi bạn đồng ý.
