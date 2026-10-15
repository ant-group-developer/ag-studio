# Chuyển DB của Studio từ SQLite sang Postgres, giữ dữ liệu hiện tại

**Trạng thái:** đã duyệt 2026-10-14, có sửa: dùng Postgres có sẵn trên VPS (không thêm vào docker compose), đổi
**hết** kiểu dữ liệu sang kiểu Postgres thật, Studio không còn dính tới SQLite, bảng không dùng thì không đưa sang.
Làm trong ngày 2026-10-14 để 2026-10-15 môi trường test chạy trên database mới.

Nhánh `dev-duc`, chỉ repo ag-studio. Không push khi chưa hỏi.

## Đã chốt với người dùng

- **Postgres**, server có sẵn trên VPS (cùng chỗ ag-farm dùng, `host.docker.internal:5432`), database và user riêng
  `ag_studio`. Không thêm service Postgres vào `docker-compose.yml`. Cấu hình: `DATABASE_URL` (+ `STUDIO_DB_POOL_MAX`).
- **Kiểu Postgres thật**: thời gian `timestamptz`, JSON `jsonb`, cờ `boolean`, số thực `double precision`, kích thước
  file `bigint`. Thứ tự ghi trước đây dựa vào `rowid` của SQLite nay là cột identity (`project_file_versions.seq`,
  `ag_go_usage_outbox.seq`, `music_track.ord`).
- **Studio runtime không còn SQLite**: `StudioDb` async trên `pg`, schema riêng `packages/studio-engine/migrations/`,
  `createStudioEngineCore` thôi dùng `SqliteStateStore`. Harness CLI cũ (`packages/core`, `cli`, `dashboard`,
  `migrations/` ở root) không thuộc Studio, giữ nguyên.
- **Giữ dữ liệu**: `packages/studio-engine/scripts/migrate-sqlite-to-pg.mjs` chép 27 bảng từ `studio.db` sang (bảng
  `lease` — slot Claude đang giữ — bắt đầu trống). File `studio.db` cũ giữ làm bản lưu trữ.
- **Bind mount** `/data` (`STUDIO_DATA_VOLUME`) để xem workspace và transcript agent bằng file manager aaPanel.
- **Test** chạy trên PGlite (Postgres thật trong tiến trình test, không cần server).

## Bảng đưa sang Postgres (28)

teams, team_members, team_skills, projects, videos, video_revisions, project_sources, prepared_assets,
project_file_versions, step_marks, agent_threads, thread_refs, thread_summaries, agent_messages, agent_actions,
lesson_proposals, project_jobs, project_farm_jobs, sign_audit_log, lease, llm_calls, audit_log, ag_go_usage_outbox,
studio_settings, user_prefs, music_track, studio_voice_lines, youtube_cache (+ schema_migrations).

## Bảng không đưa sang (34, không code Studio nào đọc)

| Nhóm | Bảng |
|---|---|
| Harness gốc (run/stage/attempt) | run, stage_run, attempt, artifact, check_result, event, external_operation |
| Catalog, thư viện, phân phối, học kênh | source_item, content_item, content_variant, content_request, library_item, edit_style, channel_package, channel_sequence, publication_job, channel_learned, video_metrics |
| Media cũ | voice_profile, brand_profile |
| Studio đời trước (production/episode, chat theo bước) | productions, production_sources, studio_farm_jobs, episodes, episode_jobs, episode_revisions, episode_thumbnails, studio_render_choices, stage_chat_turns, studio_agent_sessions, human_edits |
| Canva (đã gỡ) | canva_connections, canva_oauth_states, thumbnail_canva_designs |

(comments, studio_editor_jobs, timeline_revisions đã bị migration cũ xoá.) Dữ liệu của chúng vẫn nằm trong
`studio.db` lưu trữ; `stage_chat_turns` và `studio_agent_sessions` là chat của đời Studio trước.

## Đã làm

1. Nền: `studio-db.ts` (`StudioDb`, `PgStudioDb`, `?`→`$n`, parser timestamptz→ISO, bigint→number, `tx()` với
   `pg_advisory_xact_lock` và AsyncLocalStorage), `migrate.ts`, `migrations/0001_baseline.sql`, `testing.ts`
   (PGlite), `StudioDbService` / `EngineService` / `real-studio.ts` của API, `world()` của test engine.
2. Chuyển toàn bộ code Studio sang async + kiểu mới + phương ngữ Postgres; bọc `tx()` cho các chỗ đọc-rồi-ghi.
3. Script chép dữ liệu (kiểm số dòng và so mẫu từng cột sau khi chép), test, chạy thử trên `studio.db` local.
4. Dockerfile (bỏ `STUDIO_DB_PATH`), `.env.example` (`DATABASE_URL`), compose/deploy/README/AGENTS/runbook.

## Môi trường local đã sửa (máy dev, 2026-10-14)

Postgres local: container `postgres16` (localhost:5432), database + role `ag_studio` (mật khẩu ngẫu nhiên, chỉ nằm
trong các file .env dưới đây). Dữ liệu chép từ snapshot của `E:\ag-local\studio-data\studio.db` lúc 18:00 (662 dòng,
27 bảng); `studio.db` không bị sửa. Mỗi file sửa có bản cũ cạnh nó, đuôi `.bak-20261014-postgres`.

| File | Sửa gì |
|---|---|
| `E:\CODE\ag-studio\apps\api\.env` | Bỏ `STUDIO_DB_PATH`, thêm `DATABASE_URL=postgresql://ag_studio:…@localhost:5432/ag_studio`. Worker local đọc cùng file (`--env-file=apps/api/.env` trong `scripts/local-stack-lib.mjs`). |
| `E:\CODE\ag-studio\.env` (docker compose local) | Thêm `DATABASE_URL=postgresql://ag_studio:…@host.docker.internal:5432/ag_studio`. |
| `E:\ag-local\setup\config-local.cjs` | Bước `studio` (sinh lại `ag-studio/.env` từ `.env.example`) giữ `DATABASE_URL` đang có. |

`DATABASE_SCHEMA` (thêm 2026-10-15, mặc định public) chưa đặt ở máy local: bảng Studio local đang ở schema public.

Ngoài ra (để test): database + role `ag_studio_pgtest` trong `postgres16`, dùng cho
`STUDIO_PG_TEST_URL=… npx vitest run test/pg-server.test.ts` (test tự xoá sạch schema của nó mỗi lần chạy).

## Cắt chuyển trên VPS (người dùng chạy)

Tạo database + user trên Postgres có sẵn → dừng api/worker → sao lưu `studio.db` → deploy bản mới với `DATABASE_URL`
(api tự tạo schema) → chạy script chép dữ liệu trong container → bật lại → kiểm tra. Lùi lại: deploy tag cũ, bỏ
`DATABASE_URL`; `studio.db` không bị đụng tới.

## Rủi ro

- Race sau khi async: đã rà và bọc `tx()`, có test chạy song song cho các chỗ nhạy (seq tin nhắn, slot Claude, nhận
  job, bản lưu timeline). Chỗ nào sót sẽ lộ ra khi nhiều người dùng cùng lúc.
- Mỗi câu lệnh giờ là một round-trip mạng; danh sách lớn có truy vấn theo từng dòng có thể chậm hơn.
- PGlite khác Postgres thật ở vài chỗ nhỏ (đồng thời nhiều kết nối): khoá ghi chỉ kiểm được thật trên server.
