# Skill: channel-plan

## Mục tiêu

Cho một kênh cần thêm tập vào lịch phát hành, đề xuất chủ đề tập tiếp theo dựa trên chuẩn kênh
đã học, giả thuyết đã đối chiếu, số liệu gần đây và thị trường — ghi `output/topics.json`, để
stage `create-requests` (script, không phải agent) biến thành content request thật trong kho.

## Input (đọc trong workspace, không sửa)

- `channel-brief.json` — bối cảnh kênh: SEO (`channel.seo`: ngách, đối tượng, từ khóa), chuẩn đã
  học (`learned.standard`: angle/title_pattern/overlay_lines), giả thuyết gần đây kèm kết quả
  (`hypotheses[]`: `chosen.title`, `status` supported/refuted/open/void, `metric_value` nếu có),
  số liệu gần đây (`recent_metrics[]`), request đang mở của kênh (`open_requests[].topic`).
- `demand.json` — `needed`: số chủ đề còn thiếu để phủ lịch phát hành; `topics_per_run`: trần trên
  mỗi lần chạy (`channel.yaml`'s `planning.topics_per_run`). Số chủ đề đề xuất tối đa là
  `min(needed, topics_per_run)` — `create-requests` sau đó còn áp thêm giới hạn `max_open_requests`
  của kênh, nên đề xuất càng đúng số càng tốt, không cần dư ra.
- `stage-request.json` — nguồn sự thật cho `expected_outputs`, `inputs`, `options`, `policy`.

## Quy trình 7 bước

1. Đọc `channel-brief.json`: ghi nhớ `learned.standard` (nếu có) và tách giả thuyết theo
   `status` — `supported` là điều nên lặp lại, `refuted` là điều nên tránh, `open` chưa có kết luận.
2. Đọc `demand.json.needed` và `demand.json.topics_per_run` — trần trên số chủ đề sẽ đề xuất là
   `min(needed, topics_per_run)`, không phải mục tiêu bắt buộc phải đạt đủ.
3. Tìm web 3–5 video cùng ngách (theo `channel.seo.niche`/`keywords`) đăng gần đây (qua
   `WebSearch`/`WebFetch`) để nắm chủ đề đang được khai thác và tránh trùng góc nhìn đã có; mỗi
   phát hiện đáng kể dùng để lập luận trong `why`. Không tìm được web thì bỏ qua bước này — không
   bịa nguồn.
4. Phác ý tưởng chủ đề: ưu tiên hướng mà `hypotheses[].status === "supported"` đã chứng minh hiệu
   quả, hoặc bù đắp khoảng trống `recent_metrics` chưa khai thác; tránh hướng đã `refuted`.
5. Loại bỏ ý tưởng trùng: so khớp (lowercase + trim + gộp khoảng trắng liên tiếp) với
   `open_requests[].topic` và với mọi `hypotheses[].chosen.title` — trùng thì bỏ, không sửa nhẹ
   rồi giữ lại.
6. Với mỗi chủ đề còn lại (tối đa `min(demand.needed, demand.topics_per_run)` chủ đề, dừng ngay khi
   đủ): viết `why` nêu rõ căn cứ (số liệu nào trong `recent_metrics`, giả thuyết nào trong
   `hypotheses`, hay video thị trường nào ở bước 3); `angle` ưu tiên theo `learned.standard.angle`
   khi có, không thì tự đề xuất theo `channel.seo`. Nếu không đủ ý tưởng không trùng để đạt mức đó,
   đề xuất ít hơn — không lặp một chủ đề chỉ để đủ số lượng.
7. Ghi `output/topics.json` đúng schema bên dưới, rồi tự kiểm (mục "Tự kiểm") trước khi kết thúc.

## Cấu trúc `output/topics.json`

```json
{
  "schema_version": "harness.topic-proposal/v1",
  "topics": [
    {
      "topic": "Chủ đề tập tiếp theo, mô tả đủ rõ để dựng ngay (≥8 ký tự)",
      "angle": "Góc nhìn/khác biệt so với video cùng ngách đã tìm được",
      "why": "recent_metrics tập 12 đạt 8000 views/72h nhờ hook số liệu; giả thuyết hyp_... đã supported cùng angle",
      "style_id": "style_<ulid> (tùy chọn -- bỏ trống để create-requests tự chọn style active mới nhất)",
      "voice": "none",
      "target_duration_seconds": [180, 420],
      "source_hint": { "collection": "ten-collection" }
    }
  ]
}
```

`style_id`/`voice`/`target_duration_seconds`/`source_hint` đều tùy chọn — chỉ ghi khi có căn cứ rõ
ràng từ `channel-brief.json` hay yêu cầu đặc biệt; bỏ trống thì `create-requests` tự điền mặc định
(`style_id` = style active mới nhất, `voice` = `"none"`).

## Quy tắc

- `topic`: tối thiểu 8 ký tự, đủ rõ để người dựng hiểu ngay không cần hỏi lại — không viết mơ hồ
  kiểu "video mới cho kênh".
- `why`: không được để trống, phải nêu căn cứ cụ thể (số liệu/giả thuyết/thị trường) — không viết
  chung chung kiểu "vì chủ đề này sẽ hot".
- Số lượng `topics`: tối thiểu 1 khi `demand.needed` ≥ 1, tối đa `min(demand.needed,
  demand.topics_per_run)`.
- Không đề xuất trùng `open_requests[].topic` hay bất kỳ `hypotheses[].chosen.title` nào trong
  `channel-brief.json` — kể cả những cái đã `refuted`, vì đã thử rồi thì không lặp lại nguyên văn.

## Điều cấm

- Không tạo content request hay gọi bất kỳ lệnh `harness` nào — skill này chỉ đề xuất chủ đề;
  `create-requests` (script riêng, chạy sau) mới ghi request thật vào kho.
- Không đọc hay ghi bất kỳ giá trị `secret://` hay biến `HARNESS_SECRET_*` nào.
- Không ghi file ngoài `output/`; không sửa `channel-brief.json`, `demand.json`, hay bất kỳ input
  nào khác.
- Không rời khỏi thư mục workspace hiện tại (không `cd`, không đọc đường dẫn tuyệt đối khác).

## Tự kiểm trước khi kết thúc

- [ ] `output/topics.json` là JSON hợp lệ, đúng `schema_version`.
- [ ] Mỗi `topic` ≥8 ký tự; mỗi `why` khác trống và nêu căn cứ cụ thể.
- [ ] Không có `topic` nào trùng (lowercase/trim/gộp khoảng trắng) với `open_requests[].topic` hay
      `hypotheses[].chosen.title`.
- [ ] Số lượng `topics` không vượt `min(demand.json.needed, demand.json.topics_per_run)`.
- [ ] Không có giá trị bí mật nào lọt vào file.
