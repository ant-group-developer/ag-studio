# Runbook: kho nội dung (content library, sub-project 2C)

Đích: một máy **studio** dựng episode từ nguồn thô theo một *edit style* đã học, xuất vào một **kho** (thư
mục chia sẻ) ở trạng thái `pending_review`; một máy **channel** đọc kho, xin nội dung (content request), rồi
`pick` một item đã duyệt thành `ContentItem` local để lên kế hoạch phát hành (sub-project 3). Không có service
trung gian nào cả — kho là filesystem, đồng bộ bằng cách đọc lại file.

Đọc code trước khi tin tài liệu này lệch: `packages/core/src/library/{files,sync,requests,review,export}.ts`,
`packages/cli/src/commands/{library,library-stage}.ts`, `packages/contracts/src/library.ts`.

## 1. Mount kho

Kho có ba thư mục cấp một: `styles/`, `requests/`, `items/`, cộng `index.json` (chỉ studio ghi, sau lần
`sync` đầu tiên). Cả hai máy trỏ `project.yaml.library.root` vào **cùng một** đường dẫn đã mount — SMB, NAS,
hay một client đồng bộ kiểu Google Drive/rclone đều được, với hai lưu ý:

- **Ghi nguyên tử dựa vào rename cùng thư mục.** Mọi ghi của kho (`LibraryFs.writeJsonAtomic`,
  `copyFileWithChecksum`) viết vào `<file>.tmp-<uuid>` rồi `renameSync` đè lên đường dẫn thật — an toàn trên
  đĩa cục bộ và hầu hết SMB/NAS. Một client đồng bộ kiểu Drive/rclone có thể không coi rename là nguyên tử
  (tự nó đồng bộ file tạm rồi mới đồng bộ file đích, lệch nhịp), nhưng `library sync` vẫn an toàn nhờ đối
  chiếu checksum: máy kia chỉ thấy bản cũ trễ hơn một nhịp đồng bộ của client, không bao giờ thấy file nửa
  vời (JSON dở dang) trở thành bản chính thức. Client nào chưa thử qua thì coi là chưa kiểm chứng — ghi lại ở
  đây khi đã thử.
- **So khớp đường dẫn phân biệt hoa/thường** (`LibraryFs.assertWritable` so tiền tố `root` bằng string thô,
  không chuẩn hoá case) — trên Windows, đặt `library.root` trong `project.yaml` của cả hai máy giống hệt nhau
  về hoa/thường (và về `/` hay `\`) với đường dẫn mount thật; lệch case có thể khiến một ghi hợp lệ bị từ
  chối `CONFIG_INVALID: path ... is outside the library root`.

Trên một bản clone repo mới, `fixtures/ops-project-studio/library` và tương tự cho `ops-project-channel`
**không tồn tại** — `library:` trong `project.yaml` của hai fixture trỏ `./library`, thư mục này bị
git-ignore và bộ test tạo một thư mục tạm riêng cho mỗi lần chạy (`freshLibraryWorld()` trong
`tests/integration/library-helpers.ts`). Tự thử tay thì tạo `styles/`, `requests/`, `items/` trước (xem
Quick-start ở README) hoặc trỏ `library.root` sang kho thật đã mount.

## 2. Khai `library` trong `project.yaml`

```yaml
library: { root: ./library, role: studio, sync_seconds: 10 }   # máy studio
library: { root: ./library, role: channel }                    # máy channel (sync_seconds mặc định 300)
```

- `root`: đường dẫn tới kho đã mount (tương đối so với thư mục project, hoặc tuyệt đối).
- `role`: `studio` hoặc `channel` — quyết định `LibraryFs` cho phép ghi gì (mục 4).
- `sync_seconds`: chu kỳ tối thiểu (giây, ≥ 10, mặc định 300) giữa hai lần `worker` tự đồng bộ kho khi rảnh
  việc (mục 7). `sync_seconds: 10` trong `fixtures/ops-project-studio` là **giá trị cho bộ test** (để test
  không phải chờ 5 phút) — máy thật cứ để mặc định 300. Không bắt buộc — thiếu `library` trong `project.yaml` thì toàn bộ lệnh `library *` báo
  `CONFIG_INVALID: project.yaml ... has no library configured`, và `doctor`/`worker` bỏ qua phần kho.

`workflows:` cũng nên khai kèm để `harness doctor` chỉ kiểm những workflow máy này thật sự chạy — xem mục 6.
Hai fixture tham khảo: `fixtures/ops-project-studio/project.yaml` (`workflows: [style-study@1.0.0,
library-production@1.0.0]`), `fixtures/ops-project-channel/project.yaml` (`workflows: []` — channel không
chạy workflow nào, chỉ tạo request/sync/pick).

## 3. Chu trình studio: học style rồi dựng episode

### 3a. Học style (`workflows/style-study`, chạy một lần mỗi style, không cần request)

```sh
harness --project <studio-dir> content create --title "Học style X" --source <source_id> --json
harness --project <studio-dir> plan --workflow style-study@1.0.0 --profile studio --content <content_id> --json
harness --project <studio-dir> enqueue <run_id>
harness --project <studio-dir> worker --once   # lặp lại tới khi cần gate hoặc "idle"
```

4 stage: `collect-samples` (script, chụp mẫu từ nguồn) → gate `analyze-style` (viết `style.json` nháp
`status: draft` + `evidence/`) → gate `style-review` (sửa rồi đặt `status: active` — **chỉ nộp khi đồng ý
dùng style này**) → `style-export` (built-in, script `library-style-export`, ghi `styles/<id>/style.json` +
`evidence/` vào kho). `style-export` luôn lấy style **đã duyệt** (`status: active`) trong số các input nó
nhận được, không phải bản nháp của `analyze-style` — style chưa qua `style-review` không bao giờ lọt vào kho.

```sh
harness --project <studio-dir> stage submit <stage_run_id>   # sau khi viết output/ theo brief.md của mỗi gate
```

### 3b. Dựng một episode theo request (`workflows/library-production`, 11 stage)

```sh
# 1. đồng bộ request/style mới nhất từ kho
harness --project <studio-dir> library sync --json

# 2. build library_brief từ một request đang open (hoặc thủ công --topic/--style); KHÔNG claim gì ở bước này
harness --project <studio-dir> library accept --request <request_id> --source <source_id> --json
#   hoặc: harness --project <studio-dir> library accept --topic "..." --style <style_id> --source <src_id>...

# 3. plan + enqueue variant, option voice quyết định có chạy tts hay không
harness --project <studio-dir> plan --workflow library-production@1.0.0 --profile studio \
  --content <content_id> --option voice=none --json
harness --project <studio-dir> enqueue <run_id>

# 4. worker chạy tới khi cần gate hoặc hết việc
harness --project <studio-dir> worker --once

# 5. ba gate lần lượt: survey-source, plan-edit, library-review — viết output/ theo brief.md rồi submit
harness --project <studio-dir> stage submit <stage_run_id>
```

Thứ tự 11 stage: `intake` (script, built-in) → `index-source` → gate `survey-source` → gate `plan-edit` →
(`tts` nếu `option voice=tts`) → `cut` → `assemble` → `thumbnail-candidates` → `library-export` (script,
built-in) → gate `library-review` → `library-apply-review` (script, built-in).

- **`intake` là nơi duy nhất** một `content_request` chuyển `open → claimed`. `library accept` ở bước 2 chỉ
  build `library_brief`/`ContentItem` cục bộ — **không** tiền-kiểm trạng thái của request; accept một request
  không còn `open` (đã `claimed` bởi run khác, `fulfilled`, hay `rejected`) vẫn thành công, chỉ lộ ra ở
  `intake` của run vừa `plan`: `WAITING_HUMAN` với lỗi `INVALID_TRANSITION` (mục 6, "request kẹt `claimed`").
  Cùng một run chạy lại `intake` (idempotent) không sao.
- `library-export` copy episode + thumbnail (+ captions nếu có tts) + edit-plan vào `items/<item_id>/`, probe
  duration/media, ghi `manifest.json` với `status: pending_review`. Chạy lại `library-export` của **cùng một
  run** (ví dụ sau `retry`) ghi đè cùng thư mục và xoá mọi file lẻ không còn nằm trong bộ output mới (chỉ file
  thường ngay trong thư mục item — không đụng `claims/`).
- Gate `library-review` cần `review.json { decision: "approved"|"rejected", note }`. Có thể duyệt qua gate
  (`stage submit`) hoặc trực tiếp không qua gate: `harness library review <item_id> --approve|--reject
  [--note "..."]` — cả hai đường đều gọi đúng một hàm (`applyReview`) là nơi duy nhất ghi kết quả duyệt vào
  kho. `approved` gọi `fulfillRequest` (đẩy `item_id` vào request; vì `count` ghim ở 1, item đầu tiên làm
  request `fulfilled`); `rejected` gọi `reopenRequest` (request về `open`, ghi chú được nối vào `notes`,
  `claimed_by_run` bị xoá). Trạng thái của request được **kiểm trước khi ghi item**, nên một request không
  nhận được transition (chưa ai claim, hay đã `fulfilled`) làm lệnh dừng lại với item còn nguyên
  `pending_review` — không có nửa vời. Chạy lại cùng một quyết định là idempotent (xem mục 8).
- **Run bị `rejected` vẫn kết thúc `SUCCEEDED`** — từ chối là một kết quả bình thường của workflow, không
  phải lỗi. Mọi stage của run đó đã `SUCCEEDED`, nên `harness retry <run_id> --stage plan-edit` không có gì
  để retry (`retry` chỉ đưa stage `FAILED`/`WAITING_HUMAN` về `READY`) — in `nothing to retry`. Cách làm lại:
  request đã về `open`, `library accept --request <cùng id>` lần nữa rồi `plan` một **run mới**.

## 4. Chu trình channel: xin nội dung rồi lấy dùng

```sh
# 1. tạo yêu cầu nội dung trong kho
harness --project <channel-dir> library request create --portfolio <portfolio_id> --channel <channel_id> \
  --topic "chợ nổi Cái Răng" --style <style_id> --voice none --duration 60,300 --json

# 2. đợi studio dựng xong rồi duyệt; định kỳ đồng bộ để thấy tiến độ
harness --project <channel-dir> library sync --json
harness --project <channel-dir> library list requests --json
harness --project <channel-dir> library list items --status approved --json

# 3. nhận một item đã duyệt thành ContentItem cục bộ
harness --project <channel-dir> library pick <item_id> --channel <channel_id> --json
```

`pick` chỉ nhận item đang `approved` cho một claim **mới**; `pending_review`, `rejected`, `withdrawn` đều bị
từ chối `INVALID_TRANSITION`, không để lại file claim nào. Một claim đã tồn tại (channel này đã `pick` item
này trước đó) luôn được tôn trọng và trả lại đúng `ContentItem` cũ — kể cả khi item sau đó chuyển
`withdrawn`/bị studio sửa lại; chỉ claim **mới** mới đòi `approved`. `ContentItem` sinh ra mang
`library_item_id` trỏ về kho, `source_ids: []` (nội dung không đi qua source catalog của channel) — dùng
`content_id` in ra cho `harness plan` của workflow phát hành (sub-project 3, chưa có ở nhánh này).

Một request đổi lấy đúng **một** item: `count` ghim ở 1 trong `ContentRequestSchema`, `--count` khác 1 bị từ
chối `CONFIG_INVALID`. Item đầu tiên được duyệt `approved` đóng request thành `fulfilled`. Cần thêm tập nữa
thì tạo request mới — chưa có cơ chế cho một run claim lại một request đã `claimed` (xem ghi chú cuối spec 2C).

Item đã `approved` mà kênh không dùng nữa: `harness --project <studio-dir> library withdraw <item_id> --note
"..."` (vai `studio`) đưa nó về `withdrawn` — cách kho biểu diễn "coi như đã xoá", **không có đường quay
lại**. Claim đã tồn tại vẫn được tôn trọng (channel đã `pick` trước đó giữ nguyên `ContentItem` của nó); chỉ
`pick` **mới** mới bị từ chối.

## 5. Ai được ghi gì (`LibraryFs.assertWritable`)

| Vai | Được ghi | Không được ghi |
| --- | --- | --- |
| `studio` | `styles/**`; `items/**` trừ mọi đường có đoạn `claims`; `index.json`; `requests/<id>.json` **chỉ khi file đã tồn tại** (không bao giờ tạo request mới) | tạo mới `requests/<id>.json`; bất cứ gì dưới `items/<id>/claims/` |
| `channel` | tạo/ghi đè `requests/<id>.json`; `items/<id>/claims/<channel_id>.json` | `styles/**`; phần còn lại của `items/**`; `index.json` |

Ghi ngoài các đường trên, hoặc ngoài `library.root`, ném `CONFIG_INVALID` ngay tại `LibraryFs`, trước khi
chạm đĩa. `doctor` không bao giờ tự tạo thư mục kho còn thiếu (mục 6) — mount trước, doctor chỉ kiểm tra.

## 6. `harness doctor`

Khi `project.yaml` có `library`, `doctor` thêm ba dòng:

| check | ok khi | FAIL khi |
| --- | --- | --- |
| `library:root` | `library.root` tồn tại và là thư mục | chưa mount, hoặc đường dẫn sai |
| `library:write` | ghi rồi xoá được một file thử trong thư mục vai này được phép ghi (`styles/` cho studio, `requests/` cho channel) | thư mục đích (`styles/`/`requests/`) chưa tồn tại, hoặc không ghi được (quyền, mount read-only) — **không** tự tạo thư mục |
| `library:index` | `index.json` chưa tồn tại (chưa `sync` lần nào — không phải lỗi), hoặc tồn tại và parse được | tồn tại nhưng JSON hỏng |

Dòng `workflows` (không riêng của kho) báo phạm vi: `project.yaml.workflows` không khai → `doctor` quét mọi
`workflow.yaml`/`profile.yaml` cài trong harness; khai `[]` → không quét workflow/profile nào (đúng cho
channel, không có `executors/`); khai danh sách → chỉ quét đúng các release đó (và profile có
`workflow_release` nằm trong danh sách) — một ref không nạp được thành dòng `workflow:<ref>` FAIL riêng thay
vì làm chết lệnh `doctor`.

## 7. Đồng bộ (`library sync`) và worker tự động

`harness library sync --json` đọc lại `styles/`, `requests/`, `items/` từ kho, đối chiếu với bảng mirror
(`edit_style`, `content_request`, `library_item` — migration `0003_library.sql`, **không** đi qua
`transition()`, `state` chỉ phản ánh trạng thái đọc từ file), rồi báo:

- `imported`/`updated`/`unchanged` theo từng loại — quyết định bằng `updated_at` rồi `canonicalDigest` (nội
  dung y hệt thì không ghi lại dù `updated_at` khác, tránh nhiễu do đồng hồ hai máy lệch nhau).
- `corrupt`: file không đọc được (JSON hỏng, thiếu trường) hoặc một file dữ liệu của item không khớp checksum
  trong manifest — **cô lập vào đúng item đó**, các style/request/item khác vẫn đồng bộ bình thường.
  Lưu ý chi phí: file dữ liệu chỉ được hash lại cho item **mới hoặc đã đổi** (so manifest với mirror). Một
  file bị sửa **sau** khi item đã import không bị phát hiện ở lần sync thường — chạy `harness library sync
  --verify` (audit, đọc lại toàn bộ kho, chậm) khi cần chắc chắn, ví dụ trước một đợt phát hành lớn hay sau
  một sự cố mount.
- `missing`: có trong DB mirror nhưng không còn thấy trên kho (đã bị xoá thủ công/mount rớt) — chỉ báo, không
  tự xoá khỏi mirror.

`sync` thoát mã 1 khi `corrupt.length > 0` (để script/cron phát hiện), 0 nếu không. Chỉ `studio` ghi lại
`index.json` sau mỗi lần sync (channel không ghi được `index.json`, xem mục 5).

`harness worker` tự gọi `syncLibrary` mỗi khi rảnh việc (không stage nào để claim), tối đa một lần mỗi
`sync_seconds`; lỗi đồng bộ chỉ ghi log (`logger.error`), không làm worker dừng, và worker **không bao giờ tự
plan run** từ một request mới thấy — đó vẫn là việc của người chạy `library accept` + `plan`.

## 8. Sự cố thường gặp

| Triệu chứng | Nguyên nhân / xử lý |
| --- | --- |
| `library sync --json` thoát mã 1, một vài item nằm trong `corrupt` | Xem `reason` của từng mục — JSON hỏng (`manifest.json` không parse được) hay `checksum mismatch` (file dữ liệu bị sửa/mất sau khi manifest được ghi). Sửa/ghi lại file đó ở máy studio (hoặc chờ `library-export` chạy lại cùng run), `sync` lần sau chỉ còn báo phần thật sự chưa sửa; các item khác không bị ảnh hưởng. |
| `missing` liệt kê một style/request/item vẫn tưởng còn | Mirror có nhưng kho không thấy file tương ứng nữa — kiểm tra mount còn sống không, file có bị xoá nhầm không. `sync` không tự xoá khỏi mirror; sửa xong ở kho rồi `sync` lại. |
| Request kẹt `claimed` không ai `fulfilled`/`rejected` | Xem `claimed_by_run` trong `requests/<id>.json` (hoặc `library list requests --json`) — run nào đang giữ; `harness status <run_id>` của máy studio đó xem stage nào chưa xong. Nếu run đó đã chết (crash, hủy): `harness cancel <run_id>` rồi `harness library review <item_id> --reject --note "run huỷ, làm lại"` nếu đã có item, hoặc trực tiếp sửa `requests/<id>.json` (ít khuyến khích, chỉ khi không còn run nào giữ) về `open`. |
| `intake` của một run mới `WAITING_HUMAN`, lỗi `INVALID_TRANSITION ... already claimed` | Một run khác đã `claimRequest` request này trước (accept-hai-lần trên cùng request đang `open`, hoặc accept một request không còn `open`). Đây là kết quả đúng, không phải lỗi hệ thống — `cancel` run thua cuộc (xem acceptance test #19); request vẫn `claimed` đúng bởi run thắng. |
| `library pick <item_id>` báo `INVALID_TRANSITION ... withdrawn`/`rejected`/`pending_review` | Item chưa (hoặc không còn) ở trạng thái `approved`. `withdrawn` là cách kho biểu diễn "coi như đã xoá" (kho không bao giờ xoá thật) — không có đường đưa một item `withdrawn` trở lại `approved`; cần một item mới (dựng lại từ request đã mở lại, hoặc studio `library review` một item khác). |
| `library sync` (hay một stage kho) ném `IO_ERROR: library root not available: ...` | Kho chưa mount (hoặc mount vừa rớt). Đây là lỗi cố ý: không lệnh nào tự tạo thư mục kho, và không có gì được ghi vào đĩa cục bộ đóng vai kho. Mount lại rồi chạy lại; với một run đang chạy, `IO_ERROR` là `transient` nên stage sẽ tự retry trong hạn attempt. |
| `harness library review` ném lỗi có `item_written: true` (item đã ghi, request chưa) | Manifest item đã sang `approved`/`rejected` nhưng file request chưa kịp cập nhật (mount rớt giữa hai lần ghi). Chạy **lại đúng lệnh cũ** — `harness library review <item_id> --approve\|--reject [--note ...]` là idempotent: item đã mang quyết định đó thì không ghi lại, và nửa request còn thiếu được áp nốt. Nếu run cũ đã bị `cancel` và request đã được run khác claim thì lệnh chạy lại chỉ trả về nguyên trạng, không đụng vào claim mới. |
| `doctor` báo `library:root` FAIL | `library.root` (đã resolve từ `project.yaml`) không tồn tại hoặc không phải thư mục — mount kho trước. |
| `doctor` báo `library:write` FAIL, `directory missing: .../styles` (hay `.../requests`) | Thư mục con vai này cần ghi chưa có trên kho — `doctor` cố ý không tự tạo; tạo `styles/`, `requests/`, `items/` một lần khi thiết lập kho (xem README quick-start) hoặc kiểm tra mount. |
| `doctor` báo `library:index` FAIL | `index.json` tồn tại nhưng hỏng — chạy lại `library sync` ở máy `studio` để ghi lại. |
| Ghi vào kho ném `CONFIG_INVALID: role <role> may not write ...` | Vai (`studio`/`channel`) không được ghi đường dẫn đó (mục 5) — kiểm tra lại lệnh đang chạy trên đúng máy/vai chưa, hoặc case của `library.root` giữa hai máy có khớp không (mục 1). |

Xem thêm `docs/runbooks/reconcile-and-retry.md` cho sự cố chung của control plane (gate quá hạn, submit bị
từ chối, vượt ngân sách, worker chết giữa chừng) — không riêng cho kho.
