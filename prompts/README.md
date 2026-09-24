# prompts/ — prompt dán sẵn cho agent

Mỗi file là một prompt hoàn chỉnh, dán nguyên vào Claude Code hoặc Codex mở trong thư mục repo. Tên file bắt đầu
bằng số thứ tự theo lúc dùng.

| File | Dùng khi |
|---|---|
| `00-may-moi-khoi-dong.txt` | Máy mới vừa `git clone`, chưa có kho, chưa có ops project. Agent sẽ hỏi ba nhóm thông tin (kho + ops project; số kênh và từng kênh; tài nguyên nạp kho) rồi dẫn theo `docs/runbooks/agent-bootstrap.md` tới tập đầu tiên. |

Nguồn sự thật của prompt là phụ lục cuối `docs/runbooks/agent-bootstrap.md`; sửa ở đó rồi chép sang đây.
