# GĐ3 — Studio web (and the API it needs) spec

Approved plan: `C:\Users\AG-89\.claude\plans\lively-riding-sunrise.md` (Vietnamese; sections 2.7 and 3.x). The
backend of the series (GĐ2) is done: read `docs/series-gd2-spec.md`, `packages/contracts/src/studio.ts`,
`packages/core/src/studio/*` (layout/ops/issues for Timeline v3 — the editor reducer must reuse these pure
functions, imported by alias as today) and the API controllers under `apps/api/src/studio` for the routes.

Reference UI conventions: ag-go-web (`E:\CODE\ag-go-v2\ag-go-web\src`): `nuqs` URL state, antd `ProTable`
server-side pagination, `SortDropdown` on the toolbar (no column sorters), `table-refresh-button`,
`use-debounced-value`, `compare-sort-values`, sticky headers (already in Studio). Farm web (`E:\CODE\ag-farm`,
branch `feat/gd4-farm-ui` once merged) follows the same conventions — reuse its components where they fit.

## 3.1 Foundation (apps/web)

- Add `lucide-react` and `nuqs` (with the react-router adapter), remove `@ant-design/icons` everywhere. CSS so an
  icon inside `.ant-btn-icon` is centred (copy what farm/ag-go did).
- Copy `sort-dropdown`, `compare-sort-values`, `table-refresh-button`, `use-debounced-value` from ag-go-web.
- QueryClient defaults `staleTime: 30_000`, `retry: 1`. Routes lazy-loaded; a 404 page. Errors through
  `App.useApp().message` (no bare `message` import). Internal links are `<Link>`.
- Buttons: each screen has at most one primary button with icon + text; every other button is icon-only with a
  Tooltip and `aria-label`; groups of actions go in `Dropdown trigger={['click']}` (a "…" / MoreHorizontal icon
  button). Tables: default font size, every column has `width` and `ellipsis` + Tooltip with the full value, the
  action column is fixed right.
- i18n: every string in vi and en (complete), Vietnamese with diacritics.

## 3.2 API (apps/api)

- Admin: Studio admin = Account API `user_type = ADMIN`. `getUserProfile` (see `auth/account-api.service.ts`)
  cached 5 min per user -> `authContext.isAdmin`. `RolesGuard`: ADMIN passes every role check (acts as owner).
  `GET /api/me` -> `{userId, name, email, avatar, isAdmin}`.
- Lists with `page`, `pageSize` (default 20, max 100), `sortBy`, `sortOrder`, `q`, response `{items, total, page,
  pageSize}`: `GET /productions` (all productions the user can see — an admin sees all, with team name;
  filters `teamId`, `status`), `GET /teams`, `GET /teams/:teamId/members`. Keep `GET teams/:teamId/productions`
  as a filtered alias if the web still needs it.
- `PATCH /teams/:id` (name), `DELETE /teams/:id` (owner or admin; refuse when it still has productions with an
  active run). Removing or demoting the last owner of a team -> 409.
- Creating a production is atomic (production + sources + owner in one transaction). A missing production -> 404
  (not 403) for members and admins; non-members get 403 as today.
- `DELETE /productions/:id` (owner/producer or admin): cancel its plan run and episode runs first.
- DTO validation: description ≤ 4000, folders 1..50, channels ≤ 20, keywords ≤ 20 (each ≤ 100), max_episodes
  1..30, episode_target_seconds 10..3600.
- Production status shown in lists is derived: `draft` (no plan run), `planning` (plan run active before
  approve-plan), `waiting_approval` (approve-plan waiting), `producing` (some episode producing), `done` (all
  episodes ready), `failed` (plan failed or any episode failed and none producing), `archived`.

## 3.3 Tables

Productions (menu "Production" + for admins "Tất cả production"), teams, team members: ProTable + nuqs +
SortDropdown + refresh button, columns with widths/ellipsis, fixed action column (icon buttons: open, edit
(drawer), delete (Popconfirm) — edit/delete only when allowed). Creating a production opens a drawer/modal form
(the same form as "Thông tin" below). Admins can edit and delete any production.

## 3.4 Page `/productions/:id`

antd `Steps` for the production: Thông tin -> Nghiên cứu thị trường -> Kế hoạch tập -> Duyệt -> Sản xuất các tập.
The current step follows the plan run (intake/research/trend-report = Nghiên cứu, catalog/plan-episodes = Kế hoạch,
approve-plan waiting = Duyệt, spawn-episodes done = Sản xuất). Finished steps are clickable to view their output.

- **Thông tin**: editable form — title, description, goal, audience, tone, notes, episode target (seconds, shown as
  mm:ss), max episodes, aspect, language, source folders (the existing ag-go folder tree picker), YouTube channel
  links (tags input, validated with a light client-side check), keywords (tags input), music (optional). Shows the
  estimated YouTube quota (`channels*3 + keywords*201` units, "hạn mức ngày 10.000"). Primary button: "Lập kế
  hoạch" (starts the plan run) — or, when a plan exists, "Lưu & lập lại kế hoạch" with a confirm (refused by the
  API while an episode is producing; show that reason).
- **Nghiên cứu thị trường**: the trend report (`documents/trend-report/trend-report.json`) — summary, angles,
  title/hook/thumbnail patterns, recommended length, schedule, recommendations — and a table of the top research
  videos (`documents/research/research.json`): channel, title (link to YouTube), views, views/day, duration,
  outlier badge; per-channel stats cards. When skipped: show `skipped_reason`.
- **Kế hoạch tập / Duyệt**: the series plan (`plan-episodes` output, or the `approve-plan` gate document). One card per
  episode: title, hook, logline, target vs actual duration (sum of item durations from the catalog; ±20% -> amber
  warning, never blocking), items list (thumbnail from `GET productions/:id/assets/:assetId/media` posterUrl,
  title, duration, reason, section title editable), drag-and-drop reorder (`@dnd-kit/sortable`), remove item,
  add item from the catalog (searchable picker over `GET productions/:id/catalog`), swap with an alternate. Add /
  remove / merge episodes (merge = append items of the next episode, dedupe). Primary button "Duyệt & tạo tập"
  submits the gate (`POST productions/:id/run/gates/approve-plan` with the edited plan); show the checker's
  problems (Vietnamese) inline when refused. While the plan run is still working, show the stage progress.
- **Sản xuất các tập**: episodes table (`GET productions/:id/episodes`, server paging + SortDropdown): #, thumbnail,
  title, duration, current step, render progress (`Progress`), status tag. Row actions: open editor (icon), render
  lại (icon), download video (icon), Dropdown "Xuất" with "Gói YouTube (zip)" and — GĐ6, render disabled items for
  now — "Premiere (proxy 720p)" / "Premiere (bản gốc)". Poll every 5 s only while some episode is producing.
  Clicking a row opens the **episode drawer**: episode Steps (from its run view), YouTube kit editor (pick one of
  the 3 titles or edit, description textarea with the chapter list preview, tags (tags input with the 500-char
  counter), hashtags, playlist, copy buttons per field) saved with `PATCH`, pick 1 of 3 thumbnails (images),
  video player of the final render, download links (mp4, thumbnails, youtube.json, zip), `cost_usd` of the run.
  Buttons are shown per role (viewer read-only; editor edits kit/timeline; producer runs/approves/re-renders).

## 2.7 Editor per episode (`/productions/:id/episodes/:episodeId/editor`)

Rewrite `apps/web/src/modules/editor/*` for Timeline v3 (the reducer = the core ops + undo/redo, autosave with
`base_revision` and 409 handling as today):
- Timeline: a video row of clips (width ∝ duration), drag-and-drop reorder (`@dnd-kit/sortable`), remove, insert
  from the video panel, swap with an alternate; a text row (select/move/resize, add/remove); section markers.
  Music and source-audio toggles in the properties panel.
- Video panel: search the production catalog (title/summary/tags) with poster thumbnails; drag or click "+" to add.
- Player: plays the clips' preview files one after another (`GET productions/:id/assets/:assetId/media`
  previewUrl), next slot preloaded (`preload="auto"`), clock driven by the playing video
  (`requestVideoFrameCallback` when available, `waiting`/`stalled` pause the clock), playhead in its own store
  read with `useSyncExternalStore`, panels `React.memo` so playback does not re-render the whole editor. Texts
  overlay drawn over the player at their times.
- Fixes from the review: show operation errors; "Render preview" renders the revision saved after the last
  change (wait for autosave first); save when leaving the page + `beforeunload` prompt when unsaved; stop polling
  when unmounted/done; Ctrl/Cmd+Z not captured while typing in an input/textarea.
- "Render lại" button in the editor header (producer) = `POST .../rerender` after saving.
- Keep `playground.html` working with a fake client for v3 (used for manual checks).

## Tests / done

- vitest for: the reducer (v3 ops, undo/redo), autosave conflict, episodes table query state <-> URL, plan editor
  (reorder/remove/merge produce a valid plan), YouTube kit form validation (tags ≤ 500 chars), role-based buttons.
- API tests for admin, list pagination/sort, team PATCH/DELETE rules, production DELETE cascade.
- `corepack pnpm -r run typecheck`, the full test suite (with and without ffmpeg), and the web build must pass.
