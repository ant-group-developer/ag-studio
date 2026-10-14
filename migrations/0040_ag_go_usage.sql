-- Studio báo ag-go cách footage được dùng (plan 2026-10-13 P4, hợp đồng H3): thêm/bỏ project hay video ag-go vào dự
-- án, và mỗi video ag-go trong bản cuối / file Premiere đã xong. Sự kiện ghi vào hộp thư đi này cùng lúc với việc nó
-- ghi lại; worker gửi `POST /usage/studio-events` theo lô 200, lỗi thì lùi dần (next_at, tối đa 1 giờ), ag-go tắt không
-- mất gì. event_key duy nhất (`src:<sourceId>:added|removed`, `job:<jobId>:<assetId>`): ghi lại hay gửi lại không đếm
-- trùng. payload: JSON đúng một sự kiện của H3 (eventKey, kind, occurredAt, assetId, agGoProjectId, studioProjectId,
-- studioProjectName, studioVideoId, studioVideoTitle, studioUserId).
CREATE TABLE ag_go_usage_outbox (
  event_key   TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  sent_at     TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     TEXT NOT NULL,
  last_error  TEXT
);
CREATE INDEX ag_go_usage_outbox_due_idx ON ag_go_usage_outbox(sent_at, next_at);

-- Chạy bù: nguồn ag-go đang có trong các dự án (sự kiện "đã thêm" lúc added_at; nguồn đã bỏ trước đây không còn dấu).
INSERT OR IGNORE INTO ag_go_usage_outbox (event_key, payload, created_at, next_at)
SELECT 'src:' || s.id || ':added',
       json_object(
         'eventKey', 'src:' || s.id || ':added',
         'kind', 'source_added',
         'occurredAt', s.added_at,
         'assetId', CASE WHEN s.kind = 'ag_go_asset' THEN s.ref END,
         'agGoProjectId', CASE WHEN s.kind = 'ag_go_project' THEN s.ref
                               WHEN json_valid(s.meta) THEN json_extract(s.meta, '$.agGoProjectId') END,
         'studioProjectId', p.id,
         'studioProjectName', substr(p.name, 1, 500),
         'studioVideoId', s.video_id,
         'studioVideoTitle', substr(v.title, 1, 500),
         'studioUserId', s.added_by),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM project_sources s
  JOIN projects p ON p.id = s.project_id
  LEFT JOIN videos v ON v.id = s.video_id
 WHERE s.kind IN ('ag_go_asset', 'ag_go_project');

-- Chạy bù: mỗi video ag-go (clips[].asset_id của đúng bản timeline đã render, lấy từ result rồi request của job) trong
-- bản cuối và file Premiere đã xong.
INSERT OR IGNORE INTO ag_go_usage_outbox (event_key, payload, created_at, next_at)
SELECT DISTINCT
       'job:' || j.id || ':' || json_extract(c.value, '$.asset_id'),
       json_object(
         'eventKey', 'job:' || j.id || ':' || json_extract(c.value, '$.asset_id'),
         'kind', CASE j.kind WHEN 'render_final' THEN 'final_render' ELSE 'premiere_export' END,
         'occurredAt', COALESCE(j.finished_at, j.updated_at),
         'assetId', json_extract(c.value, '$.asset_id'),
         'agGoProjectId', NULL,
         'studioProjectId', p.id,
         'studioProjectName', substr(p.name, 1, 500),
         'studioVideoId', v.id,
         'studioVideoTitle', substr(v.title, 1, 500),
         'studioUserId', j.created_by),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM project_jobs j
  JOIN projects p ON p.id = j.project_id
  JOIN videos v ON v.id = COALESCE(j.video_id, CASE WHEN json_valid(j.request) THEN json_extract(j.request, '$.video_id') END)
  JOIN video_revisions r ON r.video_id = v.id
   AND r.revision = COALESCE(CASE WHEN json_valid(j.result) THEN json_extract(j.result, '$.revision') END,
                             CASE WHEN json_valid(j.request) THEN json_extract(j.request, '$.revision') END)
  JOIN json_each(CASE WHEN json_valid(r.data) THEN r.data ELSE '{}' END, '$.clips') c
 WHERE j.kind IN ('render_final', 'export_premiere')
   AND j.status = 'done'
   AND json_extract(c.value, '$.asset_id') IS NOT NULL;
