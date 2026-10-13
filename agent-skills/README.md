# Skill của agent (spec 2026-10-10 agent-workspace)

Mỗi thư mục là một skill Claude Code (`SKILL.md` có frontmatter `name`, `description`). Mỗi lượt agent, Studio dựng một
plugin `studio` (`<STUDIO_DATA_ROOT>/agent-plugins/<dự án>/`) gồm các skill ở đây, skill của team đang bật cho dự án
(`team-<tên>`) và skill riêng của dự án (`skills/<tên>/SKILL.md` trong workspace, thành `project-<tên>`); agent gọi chúng
là `studio:<tên>`. Dưới `--restricted` CLI không đọc `.claude/skills` của workspace (spike, spec mục 9).

| Skill | Bước playbook | File |
|---|---|---|
| `research-report` | `research` | `research/report.md` |
| `channel-strategy` | `channel` | `channel/strategy.md` |
| `edit-style` | `style` | `channel/style.md` (số đo từ `style_from_files` / `reference_download`, hay lời người dùng tả) |
| `branding` | `branding` | `channel/branding.md` (frontmatter `text_look`, `music_mood`…) |
| `video-brief` | `brief` | `videos/<id>/brief.md` (frontmatter `title`, `target_seconds`, `narration`…) |
| `scene-selection` | `scenes` | `videos/<id>/scenes.md`, `survey.json` (một dòng mỗi cảnh của `sources/index.json`) |
| `edit-plan` | `edit-plan` | `videos/<id>/edit-plan.md`, `edit-plan.json` (shot, lời dẫn, chữ, nhạc) → `timeline_from_edit_plan` |
| `youtube-kit` | `youtube-kit` | `videos/<id>/youtube-kit.md` (frontmatter `titles`, `tags`, `thumbnails`…) |

Skill ở `skills/` (gốc repo) là của các workflow harness (CLI `harness`), không phải của agent Studio; các skill
`studio-*` của pipeline cũ đã gỡ ở P8.
