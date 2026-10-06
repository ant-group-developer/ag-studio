# Skills

Mỗi thư mục là một skill: `SKILL.md` là đề bài cho Claude ở một stage `executor: { type: agent }`. Executor đọc
skill theo tên (`stage_config.__skill`) từ thư mục này.

## Skill AG Studio (đang dùng)

Gọi bằng `StudioAgentExecutor` ở **dạng structured**: skill + brief + quy chuẩn nhóm + input inline đi qua stdin,
câu trả lời là một tài liệu JSON theo `--json-schema` (`claudeOutputJsonSchema(skill)` trong
`packages/contracts/src/studio.ts`), kiểm bằng `VALIDATORS` của `packages/executors/src/studio-agent-executor.ts`.
Không có tool, không đọc/ghi file.

| Skill | Workflow | Stage | Đầu ra | Model mặc định | Người duyệt |
|---|---|---|---|---|---|
| `studio-trend-report` | `ag-studio-series-plan@1.0.0`, `@2.0.0` | `trend-report` | `TrendReport` | Sonnet | Không (chỉ xem) |
| `studio-rnd` | `ag-studio-series-plan@2.0.0` | `rnd` | `StudioRnd` | Opus | Gate `approve-rnd` |
| `studio-branding` | `ag-studio-series-plan@2.0.0` | `branding` | `StudioBranding` | Sonnet | Gate `approve-branding` |
| `studio-plan-episodes` | `ag-studio-series-plan@1.0.0`, `@2.0.0` | `plan-episodes` | `SeriesPlan` | Opus | Gate `approve-plan` |
| `studio-youtube-kit` | `ag-studio-episode@1.0.0`–`@1.2.0` | `youtube-kit` | `YoutubeKit` | Sonnet | Không (sửa sau trong `EpisodeDrawer`) |

Model ghi đè bằng `STUDIO_CLAUDE_MODEL` hoặc `STUDIO_CLAUDE_MODEL_<SKILL>` (`packages/studio-engine/src/worker.ts`).
Claude giả cho test: `fixtures/fake-studio-claude.mjs` (có nhánh cho từng skill ở trên).

Quy chuẩn của nhóm (`team_skills`, sửa trên web ở trang team) **không** nằm ở đây: chúng được chèn vào prompt lúc gọi
(`teamGuidesForRun`, `packages/studio-engine/src/team-skills.ts`) theo bước mà chúng khai `appliesTo`.

## Skill của harness (đang nghỉ)

Dạng **file mode**: Claude đọc `brief.md`, `stage-request.json`, khung hình, rồi tự ghi `output/`. Các workflow dùng
chúng (`library-production@1.1.0`–`@1.3.0`, `style-study@1.1.0`, `channel-publish*`, `channel-planning@1.0.0`) vẫn
trong `workflows/` nhưng **không chạy được** trong AG Studio (ADR-0001 mục 127). Giữ lại vì kiểu tập "cắt theo shot"
(spec `docs/superpowers/specs/2026-10-06-ag-studio-local-chat-design.md`, pha 5) sẽ dùng lại `source-survey` và
`edit-plan`.

| Skill | Stage gốc | Đầu ra |
|---|---|---|
| `source-survey` | `survey-source` | `survey.md`, `survey.json` (`harness.survey-index/v2`) |
| `edit-plan` | `plan-edit` | `edl.json`, `edit-plan.json`, `narration.json`, `overlays.json` |
| `library-review` | `library-review` | `review.json` |
| `style-analyze` | `analyze-style` | `style.json` (draft), `evidence/` |
| `style-review` | `style-review` | `style.json`, `review-notes.md` |
| `channel-package` | `package` | `package.json` (metadata + hypothesis) |
| `channel-plan` | `propose-topics` | `topics.json` |

## Thêm hoặc sửa skill

- Sửa nội dung một skill đang dùng làm thay đổi câu trả lời của Claude nhưng **không** đổi digest workflow: ghi rõ
  trong commit, và chạy lại test của executor với Claude giả.
- Skill mới cho Studio cần: thư mục ở đây, schema đầu ra trong `studio.ts` (`STUDIO_SKILL_OUTPUTS`), validator trong
  `VALIDATORS`, nhánh trong `fake-studio-claude.mjs`, và một stage trong một **phiên bản workflow mới**.
