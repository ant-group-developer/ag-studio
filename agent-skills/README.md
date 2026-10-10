# Skill của agent (spec 2026-10-10 agent-workspace)

Mỗi thư mục là một skill Claude Code (`SKILL.md` có frontmatter `name`, `description`). Mỗi lượt agent, Studio dựng một
plugin `studio` (`<STUDIO_DATA_ROOT>/agent-plugins/<dự án>/`) gồm các skill ở đây, skill của team đang bật cho dự án
(`team-<tên>`) và skill riêng của dự án (`skills/<tên>/SKILL.md` trong workspace, thành `project-<tên>`); agent gọi chúng
là `studio:<tên>`. Dưới `--restricted` CLI không đọc `.claude/skills` của workspace (spike, spec mục 9).

| Skill | Bước playbook | File |
|---|---|---|
| `research-report` | `research` | `research/report.md` |
| `channel-strategy` | `channel` | `channel/strategy.md` |
| `branding` | `branding` | `channel/branding.md` (frontmatter `text_look`, `music_mood`…) |
| `video-brief` | `brief` | `videos/<id>/brief.md` (frontmatter `title`, `target_seconds`, `narration`…) |
| `youtube-kit` | `youtube-kit` | `videos/<id>/youtube-kit.md` (frontmatter `titles`, `tags`, `thumbnails`…) |

Skill ở `skills/` (gốc repo) là của pipeline cũ (gate), sẽ gỡ cùng pipeline.
