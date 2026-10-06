import type { chatVi } from "./chat.vi";

/** Chat UI strings (spec local-chat), merged into `en.chat`. */
export const chatEn: typeof chatVi = {
  newVideo: "New video",
  yourVideos: "Your videos",
  noVideos: "No videos yet.",
  episodeTitle: "Episode {{idx}} · {{title}}",
  oldScreens: "Old production screens",
  backToChat: "Chat screens",
  claudeChip: "Claude: {{running}}/{{max}} calls running",
  claudeWaiting: "{{n}} waiting",
  groups: { waiting_you: "your turn", needs_attention: "needs attention", running: "running", done: "done" },
  steps: {
    intake: "Questions", research: "Market research", rnd: "R&D", branding: "Branding", plan: "Episode plan",
    episodes: "Build episodes", draft: "Draft", timeline: "Timeline", kit: "YouTube kit", render: "Render", export: "Export",
  },
  composer: {
    label: "Message to Claude",
    placeholder: "Message Claude, tag footage with @…",
    attach: "Tag footage",
    send: "Send",
    folders: "Footage folders on ag-go",
    videos: "{{n}} videos",
    removeFolder: "Remove {{name}}",
  },
  home: {
    title: "What video do you want to make?",
    lead: "Type what you want and tag footage with @. Claude asks when something is missing, then proposes the rest.",
  },
};
