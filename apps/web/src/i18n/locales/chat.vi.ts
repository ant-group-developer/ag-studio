/** Chuỗi của giao diện chat (spec local-chat), gộp vào `vi.chat`. */
export const chatVi = {
  newVideo: "Video mới",
  yourVideos: "Video của bạn",
  noVideos: "Chưa có video nào.",
  episodeTitle: "Tập {{idx}} · {{title}}",
  oldScreens: "Bảng production cũ",
  backToChat: "Giao diện chat",
  claudeChip: "Claude: {{running}}/{{max}} lượt đang chạy",
  claudeWaiting: "{{n}} lượt chờ",
  groups: { waiting_you: "chờ bạn", needs_attention: "cần xử lý", running: "đang chạy", done: "xong" },
  steps: {
    intake: "Hỏi thông tin", research: "Nghiên cứu thị trường", rnd: "R&D", branding: "Branding", plan: "Kế hoạch tập",
    episodes: "Dựng các tập", draft: "Dựng nháp", timeline: "Timeline", kit: "YouTube kit", render: "Render", export: "Xuất file",
  },
  composer: {
    label: "Yêu cầu cho Claude",
    placeholder: "Nhắn cho Claude, gắn footage bằng @…",
    attach: "Gắn footage",
    send: "Gửi",
    folders: "Folder footage trên ag-go",
    videos: "{{n}} video",
    removeFolder: "Bỏ {{name}}",
  },
  home: {
    title: "Bạn muốn làm video gì?",
    lead: "Gõ yêu cầu và gắn footage bằng @. Claude hỏi thêm khi còn thiếu thông tin, rồi tự đề xuất phần còn lại.",
  },
};
