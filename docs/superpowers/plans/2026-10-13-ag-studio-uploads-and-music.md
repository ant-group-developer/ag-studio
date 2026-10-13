# Tải file thẳng lên R2 và ghép nhạc nền (2026-10-13)

Vì sao: tải audio thỉnh thoảng lỗi **413**. File đi multipart qua nginx của aaPanel, rồi nginx trong container, rồi tới
API; nginx ngoài cùng chặn file lớn. Người dùng cũng muốn chọn **nhiều file audio** và **ghép thành một nhạc nền**, cho
cả dự án lẫn từng video.

Đã chốt với người dùng:
- chỉ ghép nhạc nền; giọng mẫu giữ 1 file;
- người dùng chọn số giây chuyển mờ giữa các bài (0 = nối thẳng);
- video có nhạc riêng thì ghi đè nhạc dự án. Thứ tự khi dựng timeline: video → dự án → Studio chọn theo mood.

Ghép **ngay lúc nhập** thành một file `.m4a`. Nhờ vậy timeline, composition, render worker, Premiere và farm không đổi,
không phải phát hành lại render worker.

## Commit (nhánh `dev-duc`)

| Commit | Nội dung |
|---|---|
| `7ae825d` | Web: chọn nhiều file audio một lần, tải lần lượt từng file, báo lỗi theo từng file (kể cả 413 của proxy) |
| `169cedc` | Engine: `signedPutUrl` của bucket (ký `Content-Type`), key `uploads/<scope>/<uuid>`, worker dọn bản bỏ dở sau 24 giờ |
| `d0726df` | API: `POST /projects/:id/uploads` và `POST /studio/music/uploads` ký link; ba route tải lên cũ nhận `{uploadKey, name}` (`raw-uploads.ts`) |
| `b9116db` | Web: tải lên đi thẳng R2 (XHR PUT) và hiện % ở tab Đầu vào, tab Tệp, giọng/nhạc, kho nhạc |
| `9591ea5` | Tài liệu: CORS của R2 (runbook studio-local mục 4, `.env.example`, AGENTS.md) |
| `61bd5fa` | Engine: `prepareMusicMix` (concat / acrossfade), `importMusic`, `ProductionMusicSchema.parts` + `crossfade_s` |
| `3eb9649` | Engine: nhạc riêng của video (migration 0039 `videos.music`), fit chọn video → dự án → mood, timeline mới nhất nhận nhạc mới (`videoMusicToTimeline`), dọn rác giữ file nhạc video, agent thấy `video_music` |
| `491b8c6` | API: `POST audio/music/from-files` cho dự án; `GET/POST/DELETE /videos/:id/audio/music…` cho video |
| `84795bf` | Web: hộp chọn nhạc tích nhiều file, xếp thứ tự, chuyển mờ; thẻ "Nhạc của video này" ở tab Đầu vào của video |

## Triển khai

1. **Trước tiên: bật CORS cho bucket R2** (dev và prod). Policy JSON ở `docs/runbooks/studio-local.md` mục 4: origin của
   web, `GET` + `PUT`, header `Content-Type`. Thiếu bước này thì mọi lần tải lên từ web báo "Không tải được lên kho lưu trữ (R2)".
2. Studio (API + web + worker) một lượt. Có migration `0039_video_music.sql`, API tự chạy khi khởi động.
3. Không đổi farm, render worker hay scan worker.
4. Không cần nâng `client_max_body_size` của nginx nữa (file không còn đi qua nginx).

## Cách kiểm

- Tab Đầu vào → Tài liệu: chọn 3 file một lần → nút hiện "Đang tải lên N%". DevTools → Network: `PUT` tới
  `*.r2.cloudflarestorage.com`, rồi `POST sources/upload` JSON `{uploadKey, name}`. Không còn request multipart.
- Video mẫu 250 MB tải được (trước đây 413).
- Giọng đọc và nhạc nền → Tải nhạc: chọn 3 file → hộp "Chọn file làm nhạc nền" mở, ba file đã tích sẵn → xếp lại thứ tự,
  chuyển mờ 2 giây → "Ghép 3 bài làm nhạc nền". Trạng thái ghi "Ghép 3 bài · <tổng − 4 giây> · chuyển mờ 2 giây".
- Trang một video → tab Đầu vào → "Nhạc của video này": ban đầu "Dùng nhạc dự án · …". Chọn 2 file, chuyển mờ 0 → báo
  "timeline lên bản N" (nếu video đã có timeline) → Render xem trước → nghe chỗ nối. "Dùng nhạc dự án" → timeline bản
  kế tiếp dùng lại nhạc dự án.
- Test: `pnpm vitest run packages/studio-engine apps/api apps/web`. Test ghép bằng ffmpeg thật cần `FFMPEG_PATH` và
  `FFPROBE_PATH` (máy dev: ffmpeg-static/ffprobe-static của ag-render-worker); thiếu thì tự bỏ qua.

## Còn để ngỏ

- Khi bỏ nhạc riêng của video mà dự án cũng chưa có nhạc, timeline giữ nhạc đang có cho tới lần dựng lại (lúc đó Studio
  chọn theo mood).
- Ghép chạy đồng bộ trong request (AAC mã hoá nhanh; 20 bài vẫn dưới `proxy_read_timeout` 300 giây). Nếu sau này cần ghép
  dài hơn nhiều thì chuyển thành job dự án.
