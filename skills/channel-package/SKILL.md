# Skill: channel-package

## Mục tiêu

Từ một tập đã dựng xong, tạo `output/package.json` — gói metadata phát hành YouTube cho một tập
(tiêu đề, mô tả, tags, hashtag, playlist, ứng viên thumbnail) kèm `hypothesis`: giả thuyết có kiểm
chứng về vì sao gói này sẽ hoạt động, để đối chiếu lại sau 72 giờ.

## Input (đọc trong workspace, không sửa)

- `brief.md` — brief tập bằng văn xuôi (bối cảnh, góc nhìn, yêu cầu đặc biệt nếu có).
- `brief.json` — cùng nội dung ở dạng có cấu trúc (channel, ngách, kênh đối thủ nếu có).
- `edit-plan.json` — timeline dựng: các đoạn, mốc giây, mô tả từng đoạn (dùng để suy ra chapters).
- Thư mục ứng viên thumbnail (`inputs[].type === "thumbnail_set"`) — vài ảnh PNG/JPG đã render sẵn.
- `stage-request.json` — nguồn sự thật cho `expected_outputs`, `inputs`, `options`, `policy`.

## Quy trình 7 bước

1. Đọc hết `brief.md`, `brief.json`, `edit-plan.json`, và liệt kê các ứng viên thumbnail.
2. Tìm web 3–5 video cùng ngách đăng gần đây (qua `WebSearch`/`WebFetch`) để lấy mẫu tiêu đề và
   từ khóa đang hoạt động; mỗi phát hiện đáng kể ghi một mục `basis` kind `market` kèm `evidence_ref`
   (URL). Không tìm được web thì bỏ qua bước này — không bịa nguồn.
3. Đề xuất ≥3 tiêu đề ứng viên, chọn 1 làm `chosen.title`; phần còn lại ghi vào `rejected` kèm `why`
   (vì sao không chọn — yếu hơn, trùng kênh khác, sai kỳ vọng nội dung, …).
4. Viết mô tả theo mẫu: hook 1–2 dòng, chapters suy từ `edit-plan.json` (mốc giây → `m:ss`), rồi CTA.
   3 hashtag đứng đầu mô tả (`hashtags` cũng liệt kê lại). Tối đa 14 tags, tổng ký tự tags trong giới hạn.
5. Chọn 1 ứng viên thumbnail hợp với `chosen.title`; viết `overlay_text` ≤3 dòng, mỗi dòng ≤4 từ.
6. Đặt `expected`: `metric` mặc định `views_72h`; `target` lấy trung vị 72h của kênh nếu brief có số
   liệu, không thì suy từ đối thủ tìm được ở bước 2; `horizon_hours` là 72 trừ khi brief yêu cầu khác.
7. Ghi `output/package.json` đúng schema bên dưới, rồi tự kiểm (mục "Tự kiểm") trước khi kết thúc.

## Cấu trúc `output/package.json`

```json
{
  "schema_version": "harness.channel-package-draft/v1",
  "metadata": {
    "title": "Tiêu đề tập, ≤100 ký tự",
    "description": "Mô tả đầy đủ kèm chapters và CTA, ≤5000 ký tự",
    "tags": ["từ khóa 1", "từ khóa 2"],
    "playlists": ["Tên playlist"],
    "hashtags": ["#tag1", "#tag2", "#tag3"],
    "pinned_comment": "",
    "language": "vi"
  },
  "hypothesis": {
    "schema_version": "harness.hypothesis/v1",
    "hypothesis_id": "hyp_<ulid>",
    "basis": [{ "kind": "market", "note": "3 video cùng ngách dùng cấu trúc tiêu đề X", "evidence_ref": "https://..." }],
    "chosen": { "title": "...", "thumbnail_candidate": "inputs/thumbnails/thumb-02.png", "overlay_text": ["Dòng 1"], "angle": "..." },
    "rejected": [{ "title": "Tiêu đề khác", "angle": "...", "why": "Trùng cấu trúc kênh X tuần trước" }],
    "expected": { "metric": "views_72h", "target": 5000, "horizon_hours": 72 },
    "status": "open"
  }
}
```

`hypothesis_id` và `created_at` bạn **tự sinh, không được để trống** — harness không điền hộ, thiếu hoặc
sai định dạng là fail checker `schema-valid` ngay: `hypothesis_id` = `hyp_` + 26 ký tự Crockford base32
(`0-9A-HJKMNP-TV-Z`, ví dụ `hyp_01JBQ7YF3K8ZC4M6N9PRTVWXYZ`); `created_at` = thời điểm ghi file, ISO 8601
UTC có hậu tố `Z` (ví dụ `2026-09-15T08:30:00.000Z`).

## Giới hạn YouTube (tự áp trước khi ghi file)

- `title`: ≤100 ký tự.
- `description`: ≤5000 ký tự.
- `tags`: tổng độ dài tất cả tag (kể cả dấu phẩy ngăn cách) ≤500 ký tự.

## Quy tắc `hypothesis`

- `basis`: ít nhất 1 mục; ưu tiên `kind: "market"` nếu tìm được nguồn web thật, không thì `manual`
  kèm lý do rõ ràng — không được để trống `note`.
- `rejected`: ít nhất 1 mục, mỗi mục phải có `why`.
- `expected`: luôn có đủ `metric`, `target`, `horizon_hours` — đây là điều kiện đối chiếu 72h sau,
  không phải trang trí.

## Điều cấm

- Không upload hay gọi bất kỳ API YouTube nào — skill này chỉ tạo bản nháp metadata.
- Không đọc hay ghi bất kỳ giá trị `secret://` hay biến `HARNESS_SECRET_*` nào.
- Không ghi file ngoài `output/`; không sửa `brief.md`, `brief.json`, `edit-plan.json`, hay bất kỳ
  input nào khác.
- Không rời khỏi thư mục workspace hiện tại (không `cd`, không đọc đường dẫn tuyệt đối khác).

## Tự kiểm trước khi kết thúc

- [ ] `output/package.json` là JSON hợp lệ, đúng `schema_version`.
- [ ] `title` ≤100 ký tự, `description` ≤5000 ký tự, tổng ký tự `tags` ≤500.
- [ ] `hypothesis.basis` ≥1 mục, `hypothesis.rejected` ≥1 mục, `hypothesis.expected` đủ 3 trường.
- [ ] `chosen.thumbnail_candidate` trỏ đúng một file có thật trong thư mục ứng viên thumbnail.
- [ ] Không có giá trị bí mật nào lọt vào file.
