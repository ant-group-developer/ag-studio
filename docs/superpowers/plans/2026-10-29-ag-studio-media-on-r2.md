# Thư viện media cá nhân trên R2, một file cho nhiều video, phong cách cho cả dự án, làm gọn tab Nguồn / Tài liệu / Phong cách (2026-10-29)

Trạng thái: **đã duyệt 2026-10-29** (bản 2: gộp 5 yêu cầu), với ba đề xuất mặc định ở mục "Cần chốt". P0 mockup:
[`docs/superpowers/mockups/2026-10-29-media-library-tabs.html`](../mockups/2026-10-29-media-library-tabs.html),
chờ duyệt trước khi code P1.

## Yêu cầu

1. Audio và video không lưu trên VPS, chỉ trỏ tới R2.
2. Ai tải media/audio lên thì file vào **thư viện của người đó**; dự án khác chọn lại từ thư viện, không phải tải lại.
3. Trong một dự án, một file dùng được cho **nhiều video**, không bắt chọn đúng một video.
4. Phong cách (chữ, màu, tông hình) có thể **áp cho mọi video** của dự án.
5. Tab Tài liệu, Nguồn, Phong cách: tách section và nút cho rõ.

## Hiện trạng (đã đọc code)

| Thứ | Lưu ở đâu | Gắn với |
|---|---|---|
| Footage tải từ máy (video/ảnh) | R2 `library/studio/projects/<project>/footage/<uuid><ext>` | một video (`project_sources.video_id`, kind `upload_asset`) |
| Audio (tab Nguồn/Tài liệu) | đĩa VPS `workspaces/<project>/context/audio/` | dự án (`video_id` NULL) |
| Video tham khảo | đĩa VPS `…/context/references/` | dự án |
| Giọng/nhạc đã chuẩn hoá | R2 `…/projects/<id>/voice|music/<sha>` | dự án hoặc video |
| Kết quả chuẩn bị footage | đĩa VPS `…/inputs/<assetId>/` (shots.json, khung, tờ ghép, transcript) | dự án (`prepared_assets`) |
| Phong cách chữ/tông hình | cột `videos.text_look`, `look`, `color_match` | từng video; NULL → edit-plan → branding |

- Không có khái niệm thư viện cá nhân; kho nhạc (`music_track`) là của chung, admin quản lý.
- `project_sources` cho phép cùng một file ở nhiều video (unique theo dự án + video + kind + ref), nhưng UI tải lên và
  modal chỉ cho chọn **một** video.
- Video tham khảo có nút tải lên ở **cả** tab Nguồn lẫn tab Phong cách.
- File nhị phân không nằm trong Postgres (`project_file_versions` chỉ giữ text ≤ 1 MB).

## Thiết kế

### Thư viện media (yêu cầu 1, 2)
- Bảng mới `media_items`: `id` (uuid, cũng là asset id khi làm footage), `owner_id` (user), `kind`
  (`video | image | audio`), `key` R2, `name`, `bytes`, `sha256` (nếu có), `duration_s`, `width`, `height`,
  `created_at`, `deleted_at`.
- File mới ở `library/studio/users/<userId>/media/<uuid><ext>`. Trình duyệt PUT thẳng (như footage hiện nay).
  API không tải về, không ghi đĩa.
- `project_sources` thêm cột `media_id` (FK `media_items`, NULL cho ag-go). Footage, audio, video tham khảo đều là
  dòng nguồn trỏ tới một `media_items`. `ref` vẫn giữ (asset id cho footage, `context/audio/<tên>` /
  `context/references/<tên>` ảo cho audio/video mẫu) để agent và prompt không đổi cách gọi.
- Tải lên ở bất kỳ đâu = tạo `media_items` của người tải + dòng nguồn ở dự án đang mở. Lần sau, ở dự án khác: nút
  **"Từ thư viện của tôi"** → chọn → chỉ thêm dòng nguồn, không copy file.
- Footage từ thư viện vào dự án mới: nếu một dự án khác đã chuẩn bị xong asset đó thì **sao chép `inputs/<id>/`**
  sang (không chạy lại farm); chưa có thì chuẩn bị như thường.
- Render: `asset:<id>` tra `media_items.key` thay vì ghép `footagePrefix(project)`; clip ảnh (`<id>.mp4`) để cạnh file
  gốc trong thư viện.
- Nơi cần file thật (chuẩn hoá nhạc/giọng trên API, đo video mẫu trong worker) tải từ R2 xuống thư mục tạm rồi xoá.
  Nghe/xem thử bằng link GET ký sẵn.
- Xoá khỏi dự án = xoá dòng nguồn (file vẫn trong thư viện). Xoá khỏi thư viện = `deleted_at`; object R2 bị sweep xoá
  khi không còn dòng nguồn nào trỏ tới.

### Một file, nhiều video (yêu cầu 3)
- Dữ liệu đã cho phép; đổi UI và API:
  - modal tải lên / chọn từ thư viện: chọn **nhiều video** (hoặc "cả dự án" cho audio, video mẫu);
  - mỗi file footage trong danh sách có chip các video đang dùng + nút "Thêm vào video…" (chọn nhiều), gỡ từng video;
  - API `sources` nhận `videoIds: string[]`, tạo một dòng cho mỗi video trong một transaction.
- Chuẩn bị footage vẫn một lần cho cả dự án (`prepared_assets` theo dự án), nên dùng nhiều video không tốn farm thêm.

### Phong cách cho cả dự án (yêu cầu 4)
- `projects` thêm `text_look`, `look`, `color_match` (giống cột ở `videos`). Thứ tự áp: **video → dự án → edit-plan →
  branding**.
- Tab Phong cách khi đang mở dự án (không mở video): form chỉnh **phong cách chung**. Khi mở một video: form của video
  với dòng "Đang theo phong cách dự án" và hai nút **"Dùng riêng cho video này"** / **"Áp cho mọi video"**.
- "Áp cho mọi video" = lưu thành phong cách dự án, xoá phong cách riêng của các video khác (hỏi xác nhận, liệt kê số
  video bị đổi), rồi ghi lại vào timeline mới nhất của từng video (`videoLookToTimeline`). Bản render đã xong không đổi.
- Agent: tool đọc/ghi phong cách nhận `scope: project | video`.

### Giao diện ba tab (yêu cầu 5)
- Một khung section chung cho cả ba tab: **tiêu đề + số lượng bên trái, một nút chính bên phải**, mô tả ngắn một dòng,
  thân danh sách; section có nền/viền riêng và khoảng cách rõ. Nút phụ (gỡ, chuẩn bị lại…) vào menu ⋯ của từng dòng.
- Tab **Nguồn**: bốn section cố định theo thứ tự: Dự án ag-go → Footage → Âm thanh (file audio + giọng đọc + nhạc,
  hiện đang là hai thẻ to trên đầu) → Tài liệu tải lên. Bỏ `Segmented` hai nhóm.
- Video tham khảo **chỉ ở tab Phong cách** (bỏ bản trùng ở tab Nguồn).
- Tab **Phong cách**: Phong cách chữ & hình (form + xem trước) → Phong cách dựng (`channel/style.md`, học từ video mẫu)
  → Video tham khảo.
- Tab **Tài liệu**: nhóm theo loại với cùng khung section; audio/video trong thư viện hiện là mục chỉ xem.
- Làm mockup HTML trước (P0), duyệt rồi mới code.

## Các bước

### P0 — Mockup UI (duyệt trước khi code)
- Mockup ba tab với khung section mới, chỗ đặt nút "Từ thư viện của tôi", chọn nhiều video, phong cách dự án/video.

### P1 — Engine + DB: thư viện media (xong 2026-10-29, chưa commit)

Đã làm: migration `0006_media_library.sql`; `workspace/media-library.ts` (`newMediaKey`, `mediaAt`, `addMediaItem`,
`listMediaItems` kèm `usedIn`, `renameMediaItem`, `deleteMediaItem` chặn khi đang dùng, `addMediaToProject` cho
footage nhiều video / audio / video mẫu, `setFootageVideos`, `preparedElsewhere`); `addSource` nhận `mediaId`; clip ảnh
nằm cạnh file thư viện (`<id>.clip.mp4`) và ghi lên mọi nguồn của item; `prepare.ts` chép `inputs/<id>/` từ dự án đã
chuẩn bị; `projectAudioFiles` có file trên R2 (`key`), `importMusic`/`importProjectAudio` nhận `{ key }` và tải xuống
tạm; `style-watch` đọc video mẫu từ R2 (`referenceMedia`, worker truyền `bucket`); phong cách dự án
(`projectOwnLook`, `pickedLook`, `projectLookView`, `setProjectLook` có `everyVideo`), fit/thumbnail/agent dùng
`pickedLook`; `sweepMediaLibrary` (báo cáo `mediaObjects`). Test: `test/media-library.test.ts` (13).
Render qua farm không phải đổi: nguồn vẫn giữ `meta.key`/`clip_key`.

Kế hoạch ban đầu:
- Migration `0006_media_items.sql`: bảng `media_items`, cột `project_sources.media_id`, cột phong cách ở `projects`.
- `media-library.ts`: tạo item từ key đã PUT, liệt kê theo owner (lọc kind, tìm tên), thêm vào dự án/nhiều video,
  xoá mềm; `mediaFileTo(dir)` tải xuống tạm.
- Đổi `footage-upload.ts`, `project-audio.ts` (`projectAudioFiles` từ dòng nguồn), `style-watch.ts` (video mẫu từ R2),
  render (`asset:<id>` → key), sao chép `inputs/<id>/` giữa dự án.
- Cleanup: sweep object thư viện không còn ai dùng và đã xoá mềm.
- Test với `MemoryBucket`.

### P2 — API (xong 2026-10-29)

Đã làm:
- **Thư viện**: `GET/POST me/media`, `POST me/media/uploads` (ký PUT, `use` kiểm như lúc dùng), `PATCH`/`DELETE me/media/:id`
  (409 `media_in_use` kèm `projects`); mỗi item có `previewUrl` ký sẵn (1 giờ). `MediaLibraryService` dùng chung.
- **Tab Nguồn**: `POST projects/:id/uploads` ký vào thư viện cho footage, audio, video mẫu (tài liệu/ảnh vẫn khu tạm
  `uploads/`); `sources/footage` nhận `videoIds` (vẫn nhận `videoId` và key kiểu cũ theo dự án); `sources/upload`
  với audio/video mẫu (key thư viện hoặc multipart) thành item + nguồn, không ghi đĩa; mới: `POST sources/from-media`
  `{mediaIds, use, videoIds?, prepare?}` và `PUT footage/:assetId/videos {videoIds}`.
- **Tab Tài liệu**: `files/upload` với audio/video vào thư viện (video = video mẫu), trả `{path, size, mediaId, sourceId}`;
  `files/content` của file thư viện trả thông tin + `streamUrl`; `files/raw` và `files/stream` chuyển 302 tới link R2.
- **Giọng/nhạc**: `audio/:kind/from-file` và `music/from-files` đọc file thư viện từ R2 (kiểm dung lượng theo `bytes`).
- **Phong cách dự án**: `GET/PUT projects/:id/look` (`everyVideo` = áp cho mọi video), trả `cleared` và `timelines`.
- Test: `apps/api/src/workspace/media.spec.ts` (6); `inputs.spec.ts` cập nhật cho key thư viện.

Kế hoạch ban đầu:
- `POST /me/media/uploads` (ký PUT), `POST /me/media` (nhận key), `GET /me/media`, `DELETE /me/media/:id`.
- `POST /projects/:id/sources/from-media` `{mediaIds, videoIds | project}`; `PUT …/sources/:id/videos` để thêm/gỡ video.
- `sources/upload` cho audio/video chuyển qua thư viện; tài liệu/ảnh giữ như cũ (về đĩa).
- Phong cách: `GET/PUT /projects/:id/look`, `POST /videos/:id/look/apply-to-project`.
- Link nghe/xem: 302 tới GET ký sẵn.

### P3 — Web
- Khung section chung; dựng lại tab Nguồn, Phong cách, Tài liệu theo mockup P0.
- Drawer "Thư viện của tôi" (lọc loại, tìm, bảng/lưới như picker ag-go), chọn nhiều + chọn video đích.
- Modal tải lên chọn nhiều video; chip video trên từng footage.
- Form phong cách dự án/video.

### P4 — Agent
- `inputs_list`, `music_list`, `music_set`, `style_from_files` dùng ref như cũ, mô tả rõ file nằm trên R2 (không mở bằng
  Read/Glob); tool phong cách có `scope`.
- Chạy một lượt agent thật trên local: chọn nhạc từ file tải lên, học phong cách từ video mẫu, áp phong cách cho mọi video.

### P5 — Chuyển dữ liệu cũ (chạy tay trên VPS)
- Script `scripts/migrate-media-library.cjs --dry-run | --apply`:
  - footage đã trên R2 (`…/projects/<p>/footage/`): tạo `media_items` cho người đã tải, **không copy** object (key cũ
    giữ nguyên);
  - audio và video mẫu trên đĩa: `putFile` lên thư viện của người tải (`added_by`), gắn `media_id`, chuyển bản trên đĩa
    vào `.trash/`.
  - In số file và dung lượng đĩa giải phóng.
- Thứ tự deploy: migration DB → API + worker cùng lúc → script.

## Cần chốt

1. Thư viện là **của từng người** (người khác trong team chỉ thấy file khi nó đã được thêm vào dự án chung), hay
   **của cả team**? Đề xuất: của từng người, đúng như yêu cầu.
2. Xoá khỏi thư viện khi file đang được dự án dùng: **chặn và báo đang dùng ở đâu** (đề xuất), hay ẩn khỏi thư viện
   nhưng dự án vẫn dùng được?
3. "Áp cho mọi video" có ghi đè cả video đã chỉnh riêng không? Đề xuất: có, sau khi hỏi xác nhận và nêu số video bị đổi.
4. Ngoài phạm vi: tài liệu và ảnh trong `context/` (giữ trên đĩa), render cuối/mezz, kho nhạc chung của admin.
