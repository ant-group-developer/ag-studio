-- Tuỳ chọn riêng của từng người dùng Studio (plan 2026-10-13 P5): đã xem tour nào, đã ẩn checklist "Bắt đầu" chưa. prefs
-- là JSON ({"tourSeen": {"projects": true, "project": true}, "checklistHidden": true}); thiếu dòng = mọi thứ mặc định.
CREATE TABLE user_prefs (
  user_id     TEXT PRIMARY KEY,
  prefs       TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL
);
