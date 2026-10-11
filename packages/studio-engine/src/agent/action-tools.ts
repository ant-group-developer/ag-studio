/**
 * The agent's tool for work with a real effect (spec 2026-10-10 agent-workspace §3.5): it never does such work, it
 * proposes it as a card a person confirms in the chat.
 */
import { z } from "zod";
import { ACTION_KINDS, ACTION_ROLE, proposeAction } from "./actions.js";
import type { AgentTool } from "./tools.js";

const tool = <I extends z.ZodTypeAny>(t: AgentTool<I>): AgentTool => t as unknown as AgentTool;
const VIDEO_KINDS = new Set(["render_final", "export_premiere", "delete_video"]);

export const ACTION_TOOLS: AgentTool[] = [
  tool({
    name: "propose_action",
    description: [
      "Đề xuất một việc có tác dụng thật để người dùng bấm xác nhận trên giao diện (bạn không tự làm được những việc này):",
      "render_final {video_id?, node_id?} render bản cuối của video từ timeline hiện tại (cần producer);",
      "export_premiere {video_id?} xuất file dựng Premiere (cần producer); delete_video {video_id} lưu trữ một video (cần producer);",
      "crawl_large {crawl: {kind, …}} một crawl YouTube lớn (> 500 đơn vị hoặc > 100 video);",
      "reference_download {video_ids: [id YouTube 11 ký tự, tối đa 5], purpose} tải video mẫu ≤480p để đo phong cách dựng.",
      "video_id bỏ trống = video của luồng này. `title` là câu ngắn trên thẻ, `why` giải thích ngắn vì sao.",
      "Sau khi đề xuất, kết thúc lượt: Studio báo vào luồng khi người dùng quyết.",
    ].join(" "),
    input: z.object({
      kind: z.enum(ACTION_KINDS),
      title: z.string().trim().min(3).max(200),
      why: z.string().trim().min(1).max(2000),
      params: z.record(z.string(), z.unknown()).default({}),
    }).strict(),
    run: (ctx, a) => {
      const params = { ...a.params };
      if (VIDEO_KINDS.has(a.kind) && params.video_id === undefined && ctx.video) params.video_id = ctx.video.id;
      const action = proposeAction(ctx.db, {
        projectId: ctx.project.id, threadId: ctx.thread.id, messageId: ctx.message.id, kind: a.kind, title: a.title, summary: a.why, params,
        createdBy: ctx.claims.sub,
      }, ctx.now());
      return {
        text: `Đã hiện thẻ "${action.title}" cho người dùng (cần vai ${ACTION_ROLE[action.kind]} để xác nhận, hết hạn sau 24 giờ${action.revision ? `, gắn với timeline bản ${action.revision}` : ""}). Kết thúc lượt; Studio báo vào luồng khi họ quyết.`,
      };
    },
  }),
];
