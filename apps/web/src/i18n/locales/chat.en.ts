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
  thread: {
    step: "Step {{n}}",
    yourTurn: "your turn",
    needsAttention: "needs attention",
    done: "approved",
    show: "show",
    writing: "Claude is replying…",
    queued: "Waiting for a turn ({{n}} ahead)",
    rateLimited: "Claude plan limit reached, retrying at {{at}}",
    couldNotFix: "Claude could not fix it; the previous version stays:",
  },
  cards: {
    approve: { question: "Approve {{step}} and go to the next step?", button: "Approve" },
    start: { question: "That is enough to start. Research and plan now?", button: "Start" },
    apply: { question: "Apply this change to the timeline?", button: "Apply" },
    render: { question: "Render a 720p preview?", button: "Render" },
    export: { question: "Export a Premiere project?", button: "Export" },
    retry: { question: "Run this step again with your feedback?", button: "Run again" },
  },
  home: {
    title: "What video do you want to make?",
    lead: "Type what you want and tag footage with @. Claude asks when something is missing, then proposes the rest.",
  },
};
