# Thiết kế: AG Studio làm việc như Claude Code trong một dự án (Team → Dự án/kênh → Video)

**Ngày:** 2026-10-10 · **Trạng thái:** đã duyệt (kế hoạch tổng); spike CLI đã chạy (mục 9). Thay cho
`2026-10-06-ag-studio-local-chat-design.md` ở phần giao diện và luồng làm việc; phần render/farm/xuất Premiere giữ nguyên.

## 1. Bối cảnh và mục tiêu

Studio đang đi theo pipeline cố định (series plan 3.2.0 → R&D → branding → kế hoạch tập → tập cắt 1.1.0) với gate,
form từng ô, chat gắn từng bước, folder ag-go gán bằng `@`. Mục tiêu mới:

1. Chat tự do như làm việc với Claude Code trong một repo (CLAUDE.md, tài liệu, skills); bỏ giao diện cũ.
2. Team → **Dự án** (1 dự án = 1 kênh YouTube, nhiều video mỗi ngày) → **Video** thêm dần theo prompt, không lập
   series trước.
3. Dự án cấu hình ngữ cảnh (file nghiên cứu, markdown, skills) để agent biết đang làm gì và làm gì tiếp.
4. Chọn đầu vào (tài liệu, video, ảnh, audio) bằng giao diện chọn project ag-go; bỏ `@folder`.
5. Crawl theo chủ đề: 20–30 video xu hướng, video top kênh.
6. Render xem trước ưu tiên bản render **không watermark, 480p**, không có thì chất lượng gần nhất.
7. **Vẫn gợi ý các bước** (playbook mềm, không ép gate), chat để quay lại bước cũ; mọi kết quả là **file** người dùng
   sửa trực tiếp hoặc bảo agent sửa.
8. Việc nặng hiện rõ **ai/cái gì đang xử lý**, **ước tính bao lâu, đã trôi bao lâu**, và **dừng được** (như ứng dụng
   Claude/ChatGPT trên Windows).
9. Dự án giống **Claude Projects**: video mới → luồng chat mới (ngữ cảnh sạch), tuỳ chọn nạp dữ liệu các chat cũ cùng
   dự án để học hỏi.

### Quyết định đã chốt với người dùng

| Vấn đề | Quyết định |
|---|---|
| Dữ liệu cũ | Bỏ hẳn, làm lại sạch. Bảng cũ để nguyên trong DB, không code nào đọc; gỡ workflow/gate ở pha cuối |
| Quyền agent | Read/Write/Edit/Glob/Grep trong thư mục dự án + tool Studio qua MCP. Không Bash, không web |
| Hành động thật | Render bản cuối, xuất Premiere, xoá video, crawl lớn, tải video mẫu: agent đề xuất → thẻ xác nhận → người bấm |
| Crawl | Tool của agent + tab Nghiên cứu trong dự án. Không lịch định kỳ |
| 480p sạch | Sửa cả ag-go-v2 (nhánh riêng, không push khi chưa hỏi) và Studio; Studio chạy được với ag-go cũ |
| Thumbnail / Canva | Thumbnail thành tool của agent; gỡ Canva |

## 2. Sự thật từ khảo sát

- ag-go chỉ lưu **ảnh + video** (`assets.asset_type`) → tài liệu và audio tải lên Studio. Video chỉ đến từ ag-go (`asset:`
  chỉ resolve qua ag-go). Ảnh là ngữ cảnh/thumbnail; clip ảnh trên timeline cần đổi composition và render worker (để sau).
- ag-go `/projects`, `/projects/:id/media` chỉ nhận bearer người dùng → web gọi thẳng (như `/footage/folders`); server
  dùng `/footage/search?projectIds=` (service key + `X-Act-As-User`).
- `/footage/assets/resolve` không có tham số độ phân giải; profile render mặc định chỉ 270/540/1080p có watermark;
  `servablePreviews` ẩn bản sạch cả với người có quyền. `ValidationPipe` của ag-go `whitelist` không
  `forbidNonWhitelisted` → Studio gửi trường mới sớm cũng không lỗi.
- Chữ trên hình: ASS `PlayRes` = canvas, cỡ chữ tuyệt đối (`packages/core/src/media/ass.ts`) → giữ canvas đầu ra bản xem
  trước như cũ, chỉ đổi **nguồn** sang 480p sạch.
- `studio_farm_jobs.production_id NOT NULL REFERENCES productions` → cần bảng farm job riêng cho dự án.
- Tên trường `production_id`/`episode_id` trong payload `@ag-farm/protocol` và `TimelineV4Schema` **giữ nguyên** (dự án →
  `production_id`, video → `episode_id`); kiểu job farm không đổi. Không đổi hợp đồng ag-farm.

## 3. Kiến trúc

### 3.1 Workspace dự án = "repo" của kênh

`<STUDIO_WORKSPACES_ROOT>/<projectId>/` (phải nằm **ngoài mọi repo**):

```
CLAUDE.md                 kênh, khán giả, quy tắc (người dùng và agent sửa được; seed từ mẫu tiếng Việt)
memory/lessons.md         bài học chung (CLAUDE.md import bằng @memory/lessons.md)
context/                  tài liệu người dùng, uploads/, images/
research/                 report.md + <ngày>-<slug>.{md,json} từ crawl
channel/                  strategy.md, style.md(+json), branding.md (frontmatter text_look, music_mood…)
inputs/<assetId>/         README.md, shots.json, frames/, sheets/, transcript.{md,json}  (Studio ghi)
videos/<videoId>/         brief.md, scenes.md + survey.json, edit-plan.md + .json, timeline.json (bản soi),
                          youtube-kit.md, thumbnails/, renders/*.md, sources/index.json (Studio ghi), SUMMARY.md
threads/<threadId>/       SUMMARY.md của luồng tự do
skills/<slug>/SKILL.md    skill riêng của dự án
.studio/                  playbook.yaml (ghi đè), status.json, history/<threadId>.md (Studio ghi) — agent chỉ đọc
```

DB là nguồn sự thật cho team, dự án, video, nguồn, luồng, tin nhắn, job, revision timeline; file là nguồn sự thật cho
tài liệu. API và worker dùng chung `STUDIO_DATA_ROOT` và `STUDIO_WORKSPACES_ROOT` (kiểm file đánh dấu lúc khởi động).

### 3.2 Một lượt agent

Worker (`agent/runner.ts`, theo khuôn `chat-runner.ts` + `claude-slots.ts`) chạy:

```
claude -p --output-format stream-json --verbose --include-partial-messages --restricted
  --tools Read,Write,Edit,Glob,Grep,Skill --allowedTools Read,Write,Edit,Glob,Grep,Skill,mcp__studio__<tool>...
  --permission-mode acceptEdits --permission-prompts none
  --settings <turnDir>/settings.json           (deny Write/Edit .studio/** và .claude/**; tắt skill đi kèm CLI)
  --strict-mcp-config --mcp-config <turnDir>/mcp.json
  --plugin-dir <dataRoot>/agent-plugins/<projectId>   (skills: studio:<slug>)
  --system-prompt-snapshot off --append-system-prompt <quy tắc Studio + CLAUDE.md đã mở import>
  --max-turns N --model M (--session-id <uuid> | --resume <id>)
```

- cwd = workspace dự án; prompt qua stdin = khối `<studio_context>` (bảng playbook, bước gợi ý, job đang chạy, luồng cũ
  được tham chiếu, file đính kèm) + tin nhắn người dùng. Phần động nằm trong tin nhắn để system prompt ổn định (cache).
- `CLAUDE_CONFIG_DIR` riêng (`STUDIO_AGENT_CLAUDE_CONFIG_DIR`, bền qua deploy) — không nạp plugin/hook/skill của máy.
- Thư mục lượt `<dataRoot>/agent-runs/<msgId>/` (mcp.json, settings.json) nằm ngoài workspace, xoá sau lượt.
- Một lượt chạy mỗi luồng; tin nhắn đến trong lúc chạy gộp vào lượt sau. Dừng = kill cả cây (`taskkill /T /F` trên
  Windows, nhóm tiến trình trên Linux). Hết hạn mức chờ 5→60 phút. Mất session → phiên mới kèm tóm tắt từ DB. Lượt bị
  ngắt (worker tắt) thì `--resume` với ghi chú "lượt trước bị ngắt", không chạy lại từ đầu.
- Ghi `llm_calls` (`source='claude-agent'`, `run_id`=thread, `stage_key='agent'`, `attempt_id`=message,
  `production_id`=dự án, `episode_id`=video).

### 3.3 Tool Studio = MCP server stdio

Gói mới `packages/studio-mcp`: JSON-RPC 2.0 tự viết (~200 dòng; `initialize`, `tools/list`, `tools/call`, `ping`; trả
lỗi "method not found" cho phương thức lạ như `server/discover` mà CLI gửi). claude spawn theo `mcp.json`; env chỉ có
`STUDIO_AGENT_API_URL` + token HMAC theo lượt `{msg, thread, project, video?, sub, role, exp}` ký bằng
`STUDIO_AGENT_TOKEN_SECRET`. Mọi tool gọi API `/api/agent-tools/*` (`@Public()` + `AgentTokenGuard`: chữ ký, hạn,
message còn `running`, đúng phạm vi, vai trong team đọc lại từ DB). Chỉ API giữ secret R2/farm/ag-go. Server thoát khi
stdin đóng.

Bộ tool (theo pha): `project_info`, `video_list`, `video_create`, `suggest_replies`, `thread_history`,
`playbook_status`, `validate_file`, `inputs_list`, `input_describe`, `inputs_add`, `inputs_prepare`, `job_status`,
`job_cancel`, `youtube_trending`, `youtube_search`, `youtube_top_channels`, `youtube_channel_top_videos`,
`timeline_get`, `timeline_apply_ops`, `timeline_save`, `timeline_from_edit_plan`, `music_list`, `render_preview`,
`thumbnail_make`, `propose_action`.

### 3.4 Job nền

`project_jobs` (prepare_asset, transcribe_upload, tts, fit, render_preview, render_final, export_premiere, research,
style_watch, thumbnail, summarize_thread). API chỉ chèn dòng; worker (`workspace/job-runner.ts`) chạy ffmpeg / gửi
farm / poll / gọi YouTube; xong thì đăng tin hệ thống vào luồng và có thể tự chạy tiếp agent (≤3 lượt liên tiếp không có
tin người dùng).

### 3.5 Thẻ xác nhận

`agent_actions`: tool `propose_action` (render_final, export_premiere, delete_video, crawl_large, reference_download)
→ thẻ trong chat → người bấm (producer cho render/xuất/xoá, editor cho crawl) → API chạy, đăng tin hệ thống, kích một
lượt agent. Hết hạn khi revision đổi hoặc sau 24 h. Xoá video = lưu trữ mềm, thư mục chuyển vào `.trash/`.

## 4. Dự án như Claude Projects

- Dự án = kho kiến thức chung + nhiều luồng chat; mỗi luồng là một session Claude riêng.
- `agent_threads.kind`: `video` (luồng chính của mỗi video, tạo cùng video) | `project` (nhiều luồng tự do có tiêu đề;
  luồng đầu là "Kênh"). "Bắt đầu lại luồng" = luồng mới, luồng cũ giữ để đọc.
- Sau mỗi lượt Studio xuất `.studio/history/<threadId>.md` (tin người/agent, tool đã gọi tóm tắt, file đã đổi). Luồng nghỉ
  ≥10 phút hoặc video xong → job `summarize_thread` (structured, không tool, model rẻ) ghi `SUMMARY.md`: mục tiêu, quyết
  định, góp ý của người dùng, đã làm/chưa làm, **bài học đề xuất**.
- Bài học đề xuất hiện thẻ "Lưu vào bài học dự án?" → người bấm → thêm vào `memory/lessons.md` (kèm nguồn).
- Modal tạo video / chat mới có "Học từ chat cũ": `Không` | `Bài học chung` (mặc định) | `Chọn luồng cụ thể` (tóm tắt
  hoặc toàn bộ lịch sử), lưu ở `thread_refs`; `<studio_context>` liệt kê đường dẫn tương ứng. Giữa chừng thêm bằng nút
  "Đính kèm chat cũ". Tool `thread_history(thread_id, query?)` lấy đoạn cụ thể.

## 5. Hiển thị việc đang chạy và Dừng

- `ActivitySchema` (`packages/contracts/src/studio-workspace.ts`): `{ id, kind: agent_turn|tool_call|job, actor, phase,
  started_at, progress (0–1|null), eta_seconds|null, node, cancellable, parent_id }`. API `GET /projects/:id/activity` +
  sự kiện `activity` trên SSE.
- Lượt agent: parser stream-json cập nhật `phase` (đang nghĩ / đang viết / tool `Read x` / `mcp__studio__render_preview`),
  mỗi `tool_use` có `started_at`, `tool_result` chốt `ended_at`. Không đoán ETA cho lượt agent: chỉ thời gian đã trôi + số
  tool đã gọi.
- Job: `started_at`, `finished_at`, `phase`, `progress`, `eta_seconds`, `node_id`, `cancel_requested`. ffmpeg: `-progress`
  và bước i/n; farm: `JobView.progress_percent`, `progress_stage`, `node_id`, `queued`.
- ETA (`workspace/eta.ts`): có progress thì `elapsed × (1−p)/p`; không thì trung vị giây-trên-đơn-vị của job cùng loại đã
  xong; không có lịch sử thì mặc định theo loại.
- Dừng: lượt agent (nút Dừng thay nút Gửi) → kill cả cây, tin nhắn `cancelled`, giữ phần đã viết. Job → kill ffmpeg /
  `cancelJob` của farm / abort crawl; dọn file dở; tin hệ thống "Đã dừng …".
- Giao diện: dòng trạng thái sống dưới tin agent, chip tool có spinner + đồng hồ, thẻ job (máy, tiến độ, đã trôi, còn ≈,
  Dừng), chỉ báo "n việc đang chạy" ở header mở ngăn kéo việc đang chạy. Đồng hồ đếm ở client từ `started_at`.
- `rate_limit_event` của stream-json có mức dùng hạn mức 5 giờ/7 ngày → hiện ở chip Claude cho admin.

## 6. Playbook: gợi ý bước, không ép

- `StudioPlaybookSchema`; mặc định `DEFAULT_PLAYBOOK` (`packages/studio-engine/src/workspace/playbook.ts`); ghi đè theo
  dự án bằng `.studio/playbook.yaml` (sửa ở Cài đặt → Quy trình; sai thì báo lỗi và dùng mặc định).
- Một bước: `key, scope (project|video), title, description, skill, requires (mềm), optional, outputs[{path, role:
  doc|data|studio, validator?}], done_when, prompts{do, redo, revise}`.
- Bước dự án: `research` → `channel` → `style` (tuỳ chọn) → `branding`. Bước video: `brief` → `prepare` (Studio) →
  `scenes` → `edit-plan` → `timeline` → `preview` → `youtube-kit` → `thumbnail` → `final` (thẻ xác nhận).
- Trạng thái tính thuần từ file + DB: `missing | draft | invalid | done | skipped | stale | running`; `stale` khi bước
  phụ thuộc đổi sau khi xong (cache `step_marks`). Gợi ý = tối đa 3 bước đầu chưa xong mà điều kiện đủ. Chỉ chặn khi
  thiếu thật về kỹ thuật.
- Kiểm file dùng lại `validateStyle`, `validateStudioSurvey`, `validateEditPlan`, `validateYoutubeKit`, schema text look;
  chạy khi người lưu, khi agent gọi `validate_file`, và quét sau mỗi lượt (lỗi → ghi chú + tối đa 1 lượt tự sửa).
- UI: thanh bước, chip bước tiếp theo, bấm bước mở file với "Làm bước này / Làm lại / Sửa theo góp ý…", sửa markdown +
  frontmatter có lỗi tại chỗ, lịch sử phiên bản.

## 7. Nguồn 480p sạch cho bản xem trước

- Studio gửi `prefer: { short_edge: 480, clean: true }` khi resolve cho job **không phải** bản cuối và khi chuẩn bị đầu
  vào; xử lý `missing`; ghi width/height vào `sign_audit_log` khi có.
- ag-go (nhánh `feat/resolve-prefer`, hỏi trước khi push): `ResolveAssetsDto.prefer`; chọn trong variant `ready` +
  proxy phân tích + bản gốc; bản sạch chỉ cho người có quyền (`canViewUnwatermarked`); ưu tiên sạch, rồi short edge đúng
  480, không có thì gần nhất (nhỏ nhất ≥ mục tiêu, không có thì lớn nhất dưới mục tiêu); trả width/height; sửa
  `servablePreviews` theo quyền người xem. Thêm `{resolution: 480, watermark: false}` vào profile render và chạy lại
  variant cho asset cũ là việc vận hành ag-go (hỏi trước).
- Xuất bản xem trước 480p (đầu ra) là việc sau: cần render worker đặt ASS `PlayRes` theo canvas thiết kế.

## 8. Các pha

| Pha | Nội dung | Xong khi |
|---|---|---|
| P0 | Spike CLI, spec này, ADR 179–190 | Spike đạt (mục 9), người dùng duyệt |
| P1 | Bảng dự án/video/nguồn/phiên bản file, workspace + file an toàn, API, khung web mới | Tạo dự án, sửa CLAUDE.md, xem lịch sử trên stack local |
| P2 | Runtime stream-json, MCP server + token, runner, luồng + SSE, activity, chat web | Chat với agent thật trong workspace, Dừng được, không Bash |
| P3 | Playbook, kiểm file, plugin skills, tóm tắt + bài học | Đi research → channel → branding bằng chat; lỗi `text_look` hiện ở UI và lượt sau |
| P4 | Đầu vào: chọn ag-go, tải lên, chuẩn bị media, job runner + ETA + dừng | Chọn project ag-go, chuẩn bị 2 video, thấy tiến độ, dừng được |
| P5 | Crawl: trending, chủ đề, top kênh, video top kênh; tab Nghiên cứu | Crawl 30 video xu hướng vào `research/` |
| P6 | Làm video tới bản cuối: fit, timeline tools, preview, thẻ xác nhận, thumbnail, trang video, editor | Một video từ brief tới bản cuối |
| P7 | Nguồn 480p sạch (Studio + ag-go) | Log ký thấy nguồn 480p cho bản xem trước |
| P8 | Gỡ hệ thống cũ, Canva; cập nhật AGENTS.md, runbook, API doc, Docker | Test/build/typecheck sạch, không còn tham chiếu code cũ |

Chi tiết từng task: `docs/superpowers/plans/2026-10-10-ag-studio-agent-workspace.md`.

## 9. Kết quả spike CLI (Claude Code 2.1.285, Windows, 2026-10-10)

Mẫu stream-json đã làm sạch: `fixtures/agent-stream/{turn-tools,turn-killed,turn-max-turns,turn-plugin-skill}.jsonl`.

| # | Kiểm | Kết quả |
|---|---|---|
| 1 | Bộ tool | `init.tools` đúng `Edit, Glob, Grep, Read, Skill, Write` + `mcp__studio__*`; không có Bash/PowerShell/WebFetch |
| 2 | Đọc/ghi ngoài cwd | `--restricted` từ chối (`../`, đường tuyệt đối, `~/.claude/CLAUDE.md`), event `system/permission_denied`. **Không** `--restricted`: đọc ngoài và ghi `../escape.md` đều được → bắt buộc dùng `--restricted` |
| 3 | CLAUDE.md | Dưới `--restricted`, CLAUDE.md của cwd **không** tự nạp, CLAUDE.md thư mục cha cũng không → Studio chèn CLAUDE.md (mở `@import` trong workspace) vào `--append-system-prompt` |
| 4 | Skills | `.claude/skills` của cwd **không** nạp dưới `--restricted`; `--plugin-dir <dir>` (có `.claude-plugin/plugin.json`) nạp được, tên `studio:<slug>`; cần `Skill` trong `--tools` |
| 5 | Luật deny trong `--settings` | `Write/Edit(.studio/**)`, `Write/Edit(.claude/**)`, `Write/Edit(CLAUDE.md)` đều chặn; quyết định: **cho** agent sửa CLAUDE.md |
| 6 | MCP | `--mcp-config` + `--strict-mcp-config`: `mcp_servers[].status = connected`; env trong `mcp.json` tới server; `CLAUDE_CODE_OAUTH_TOKEN` **không** tới server; CLI gửi thêm `server/discover` |
| 7 | Event | `system/init`, `system/status`, `stream_event` (`message_start`, `content_block_start` text/thinking/tool_use, `content_block_delta` text_delta/thinking_delta/input_json_delta/signature_delta, `content_block_stop`, `message_delta`, `message_stop`), `system/thinking_tokens`, `assistant`, `user` (tool_result, ảnh base64), `system/permission_denied`, `rate_limit_event` (mức dùng 5 giờ/7 ngày), `result` |
| 8 | Session | `--session-id` rồi `--resume` giữ ngữ cảnh; resume từ cwd khác **vẫn được**; resume sau khi bị kill giữa tool call được (model biết tool bị ngắt) |
| 9 | System prompt đổi giữa lượt | Mặc định (`--system-prompt-snapshot on`) giữ bản đầu; `--system-prompt-snapshot off` dùng bản mới mỗi lượt |
| 10 | Kill trên Windows | `taskkill /PID <claude> /T /F` giết cả claude và server MCP con |
| 11 | Ảnh | Read JPG trả ảnh, model nhận đúng màu |
| 12 | `--max-turns` | `result.subtype = error_max_turns`, mã thoát 1 |
| 13 | Skill có sẵn của CLI | `init.skills` liệt kê skill đi kèm CLI (deep-research, schedule, run…). `--settings` với `"disableBundledSkills": true` + `"skillOverrides": {"design": "off", "doctor": "off"}` → chỉ còn `studio:*` |

## 10. Rủi ro

| Rủi ro | Cách chặn |
|---|---|
| Lọt CLAUDE.md/skill/hook của máy | `--restricted`, config dir riêng, `--strict-mcp-config`; workspace ngoài repo; worker kiểm thư mục cha |
| Agent ghi settings/hook để leo quyền | `--restricted` bỏ qua settings dự án; deny `.claude/**`, `.studio/**`; skill nằm ở plugin dir ngoài workspace |
| Skill đi kèm CLI gây nhiễu | `disableBundledSkills` + `skillOverrides` trong `--settings` (mục 9 #13); probe thật so `init.skills` khi nâng CLI |
| Lộ token | HMAC hạn = deadline lượt, thu hồi khi message hết `running`, ở thư mục ngoài workspace, không log |
| Kill sót tiến trình | Kill cả cây; MCP thoát khi stdin đóng / token hết hạn |
| Hai lượt cùng một session | Một lượt chạy mỗi luồng; không fork |
| Prompt injection từ crawl/transcript/tài liệu | Không Bash/web; ghi bị giới hạn; tác dụng thật chỉ qua thẻ người bấm |
| Hạn mức gói | Cap chung `claude`; `--max-turns` 40; deadline lượt 20 phút; tự chạy tiếp ≤3, tự sửa ≤1; crawl lớn cần xác nhận |
| Đầy đĩa | Dọn proxy, `.trash/`, session của luồng đã xoá, phiên bản file cũ |
