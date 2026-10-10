# Skills

Mỗi thư mục là một skill: `SKILL.md` là đề bài cho Claude ở một stage `executor: { type: agent }`. Executor đọc
skill theo tên (`stage_config.__skill`) từ thư mục này.

Skill của agent AG Studio **không** nằm ở đây mà ở `agent-skills/` (xem `agent-skills/README.md`). Các skill
`studio-*` của pipeline cũ (gate, chat theo bước) đã gỡ cùng pipeline (P8, spec 2026-10-10 agent-workspace).

## Skill của harness (đang nghỉ)

Dạng **file mode**: Claude đọc `brief.md`, `stage-request.json`, khung hình, rồi tự ghi `output/`. Các workflow dùng
chúng (`library-production@1.1.0`–`@1.3.0`, `style-study@1.1.0`, `channel-publish*`, `channel-planning@1.0.0`) vẫn
trong `workflows/` nhưng **không chạy được** trong AG Studio (ADR-0001 mục 127). Skill `scene-selection` và `edit-plan` của agent
Studio viết theo hai skill `source-survey`/`edit-plan` này, đầu ra là hợp đồng Studio.

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
