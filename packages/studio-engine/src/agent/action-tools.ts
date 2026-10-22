/**
 * The agent's tool for work with a real effect (spec 2026-10-10 agent-workspace §3.5): it never does such work, it
 * proposes it as a card a person confirms in the chat.
 */
import { z } from "zod";
import { StudioRunError } from "../errors.js";
import { referenceDownloadBlock, youtubeBlock } from "../settings.js";
import { ACTION_KINDS, ACTION_ROLE, proposeAction } from "./actions.js";
import type { AgentTool } from "./tools.js";

const tool = <I extends z.ZodTypeAny>(t: AgentTool<I>): AgentTool => t as unknown as AgentTool;
const VIDEO_KINDS = new Set(["render_final", "export_premiere", "delete_video"]);

export const ACTION_TOOLS: AgentTool[] = [
  tool({
    name: "propose_action",
    description: [
      "Đề xuất một việc có tác dụng thật để người dùng bấm xác nhận trên giao diện (bạn không tự làm được những việc này):",
      "render_final {video_id?, node_id?, resolution?: \"1080p\" | \"4k\"} render bản cuối của video từ timeline hiện tại, mặc định 1080p; 4k chỉ khi người dùng muốn (cần producer);",
      "export_premiere {video_id?, resolution?: \"1080p\" | \"4k\"} xuất file dựng Premiere, sequence mặc định 1080p (cần producer); delete_video {video_id} lưu trữ một video (cần producer);",
      "crawl_large {crawl: {kind, …}} một crawl YouTube lớn (> 500 đơn vị hoặc > 100 video);",
      "reference_download {video_ids: [id YouTube 11 ký tự, tối đa 5], purpose} tải video mẫu ≤480p để đo phong cách dựng (tải qua máy farm khi có; không được khi YouTube chặn máy chủ Studio mà không máy farm nào tải thay).",
      "video_id bỏ trống = video của luồng này. `title` là câu ngắn trên thẻ, `why` giải thích ngắn vì sao.",
      "Sau khi đề xuất, kết thúc lượt: Studio báo vào luồng khi người dùng quyết.",
    ].join(" "),
    input: z.object({
      kind: z.enum(ACTION_KINDS),
      title: z.string().trim().min(3).max(200),
      why: z.string().trim().min(1).max(2000),
      params: z.record(z.string(), z.unknown()).default({}),
    }).strict(),
    run: async (ctx, a) => {
      // YouTube blocking the Studio server refuses the card only when no farm machine can fetch instead (or the farm
      // is blocked too): through the farm it would work (`referenceDownloadBlock`)
      const studioBlock = a.kind === "reference_download" ? await youtubeBlock(ctx.db, ctx.now()) : null;
      const fetchers = studioBlock && ctx.referenceFetchers ? await ctx.referenceFetchers().catch(() => [] as string[]) : [];
      const blocked = studioBlock ? await referenceDownloadBlock(ctx.db, ctx.now(), fetchers.length) : null;
      if (blocked) {
        throw new StudioRunError("rejected", [
          blocked.where === "farm"
            ? "Chưa tạo thẻ: YouTube đang chặn tải từ máy chủ Studio và cả các máy farm (đòi đăng nhập để xác nhận không phải bot), nên tải video mẫu chắc chắn hỏng."
            : "Chưa tạo thẻ: YouTube đang chặn tải từ máy chủ Studio (đòi đăng nhập để xác nhận không phải bot) và không máy farm nào tải thay được, nên tải video mẫu chắc chắn hỏng.",
          "Studio không dùng cookie hay đăng nhập để lách. Hãy nói rõ với người dùng và đề nghị: tải video mẫu lên tab Đầu vào",
          "(mục Video mẫu) rồi học bằng style_from_files, hoặc tả phong cách dựng bằng lời.",
        ].join(" "), { code: "youtube_blocked", where: blocked.where, until: blocked.until });
      }
      const viaFarm = studioBlock && fetchers.length ? ` Video mẫu sẽ tải qua máy farm (${fetchers.join(", ")}) vì YouTube đang chặn máy chủ Studio.` : "";
      const params = { ...a.params };
      if (VIDEO_KINDS.has(a.kind) && params.video_id === undefined && ctx.video) params.video_id = ctx.video.id;
      const action = await proposeAction(ctx.db, {
        projectId: ctx.project.id, threadId: ctx.thread.id, messageId: ctx.message.id, kind: a.kind, title: a.title, summary: a.why, params,
        createdBy: ctx.claims.sub,
      }, ctx.now());
      return {
        text: `Đã hiện thẻ "${action.title}" cho người dùng (cần vai ${ACTION_ROLE[action.kind]} để xác nhận, hết hạn sau 24 giờ${action.revision ? `, gắn với timeline bản ${action.revision}` : ""}).${viaFarm} Kết thúc lượt; Studio báo vào luồng khi họ quyết.`,
      };
    },
  }),
];
