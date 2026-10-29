import type { WorkspaceEntry } from "../../api/workspace-client";

/** What a document is, for its icon. */
export type DocKind = "doc" | "image" | "audio" | "video" | "data";

/** One document in the Documents tab: its path, and its name as words (`ws.docs.name.<key>`) or as written. */
export interface DocItem {
  path: string;
  /** A name the page words (`ws.docs.name.<key>` with `params`); absent: `name` as it is. */
  nameKey?: string;
  params?: Record<string, string | number>;
  name: string;
  kind: DocKind;
  mtime: string;
}

export interface DocGroup {
  /** `channel`, `research`, `context`, or `video:<id>`. */
  key: string;
  video?: { id: string; idx: number; title: string };
  items: DocItem[];
}

interface VideoRef { id: string; idx: number; title: string }

const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const VIDEO = /\.(mp4|mov|mkv|webm|m4v)$/i;
const DATA = /\.(json|jsonl|ndjson|csv)$/i;
const MD = /\.(md|markdown)$/i;

const kindOf = (path: string): DocKind => (IMAGE.test(path) ? "image" : AUDIO.test(path) ? "audio" : VIDEO.test(path) ? "video" : DATA.test(path) ? "data" : "doc");
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const bare = (name: string) => name.replace(MD, "");
const newestFirst = (a: DocItem, b: DocItem) => Date.parse(b.mtime) - Date.parse(a.mtime);

const CHANNEL: Record<string, string> = { "strategy.md": "strategy", "branding.md": "branding", "style.md": "style" };
const CHANNEL_ORDER = ["strategy", "branding", "style", "agentNotes"];
const VIDEO_DOC: Record<string, string> = {
  "brief.md": "brief", "scenes.md": "scenes", "edit-plan.md": "editPlan", "youtube-kit.md": "youtubeKit", "thumbnails/README.md": "thumbnails",
};
/** Renders, final or preview, share a place: newest first. */
const VIDEO_ORDER = ["brief", "scenes", "editPlan", "youtubeKit", "thumbnails", "thumbnail", "render"];
/** What a person never needs to open from the list: the agent's notes and what Studio keeps for the cut. */
const VIDEO_HIDDEN = /^(SUMMARY\.md|timeline\.json|survey\.json|sources\/|renders\/.+\/|renders\/frames\/)/;

/**
 * The project's files as a person working on videos reads them (plan 2026-10-28 P2): the channel's documents (with
 * `CLAUDE.md`, the notes every chat reads), each video's (this one first), research, and what people added — named
 * in words, without Studio's and the agent's own files (`.studio/`, `memory/`, `skills/`, `threads/`, `inputs/`,
 * a video's sources, timeline, survey).
 * `researchTitles` names research reports by their title (`GET /research`).
 */
export function docGroups(entries: WorkspaceEntry[], videos: VideoRef[], opts: { currentVideoId?: string | undefined; researchTitles?: Map<string, string> } = {}): DocGroup[] {
  const channel: DocItem[] = [];
  const research: DocItem[] = [];
  const context: DocItem[] = [];
  const byVideo = new Map<string, DocItem[]>(videos.map((v) => [v.id, []]));

  for (const e of entries) {
    if (e.kind !== "file") continue;
    const p = e.path;
    const item = (rest: Partial<DocItem>): DocItem => ({ path: p, name: bare(baseName(p)), kind: kindOf(p), mtime: e.mtime, ...rest });
    // what the agent reads in every chat of the project, written by the people of the channel
    if (p === "CLAUDE.md") channel.push(item({ nameKey: "agentNotes" }));
    else if (p.startsWith("channel/")) {
      const rest = p.slice("channel/".length);
      if (!MD.test(rest) || rest.includes("/")) continue;
      channel.push(CHANNEL[rest] ? item({ nameKey: CHANNEL[rest] }) : item({}));
    } else if (p.startsWith("research/")) {
      const rest = p.slice("research/".length);
      if (rest === "report.md") { research.push(item({ nameKey: "researchReport" })); continue; }
      const style = /^style-(\d{4}-\d{2}-\d{2})-(\d+)\/README\.md$/.exec(rest);
      if (style) { research.push(item({ nameKey: "styleWatch", params: { date: style[1]!, n: Number(style[2]) } })); continue; }
      if (!MD.test(rest) || rest.includes("/")) continue;
      const title = opts.researchTitles?.get(p);
      research.push(item(title ? { name: title } : {}));
    } else if (p.startsWith("context/")) {
      const rest = p.slice("context/".length);
      if (rest === "README.md") continue;
      context.push(item({ name: rest }));
    } else if (p.startsWith("videos/")) {
      const m = /^videos\/([^/]+)\/(.+)$/.exec(p);
      const list = m ? byVideo.get(m[1]!) : undefined;
      if (!m || !list) continue;
      const rest = m[2]!;
      if (VIDEO_HIDDEN.test(rest)) continue;
      if (VIDEO_DOC[rest]) { list.push(item({ nameKey: VIDEO_DOC[rest] })); continue; }
      // the plan reads as markdown when the agent wrote one; else its JSON is the plan
      if (rest === "edit-plan.json") { if (!entries.some((x) => x.path === `videos/${m[1]}/edit-plan.md`)) list.push(item({ nameKey: "editPlan" })); continue; }
      const thumb = /^thumbnails\/(\d+)\.(jpe?g|png|webp)$/i.exec(rest);
      if (thumb) { list.push(item({ nameKey: "thumbnail", params: { n: thumb[1]! } })); continue; }
      const render = /^renders\/[^/]*render-(preview|final)-r(\d+)[^/]*\.md$/.exec(rest);
      if (render) { list.push(item({ nameKey: render[1] === "final" ? "renderFinal" : "renderPreview", params: { n: Number(render[2]) } })); continue; }
      if (MD.test(rest) && !rest.includes("/")) list.push(item({}));
    }
  }

  const ordered = (items: DocItem[], order: string[]) => {
    const rank = (x: DocItem) => { const i = x.nameKey ? order.indexOf(x.nameKey.startsWith("render") ? "render" : x.nameKey) : -1; return i < 0 ? order.length : i; };
    // the named documents in their order; thumbnails by number; renders and anything else newest first
    return [...items].sort((a, b) => rank(a) - rank(b)
      || (a.nameKey === "thumbnail" && b.nameKey === "thumbnail" ? String(a.params?.n).localeCompare(String(b.params?.n), undefined, { numeric: true }) : newestFirst(a, b)));
  };
  const videoGroup = (v: VideoRef): DocGroup => ({ key: `video:${v.id}`, video: v, items: ordered(byVideo.get(v.id) ?? [], VIDEO_ORDER) });
  const current = videos.find((v) => v.id === opts.currentVideoId);
  const others = videos.filter((v) => v !== current).sort((a, b) => b.idx - a.idx);
  const groups: DocGroup[] = [
    ...(current ? [videoGroup(current)] : []),
    { key: "channel", items: ordered(channel, CHANNEL_ORDER) },
    ...(current ? [] : others.map(videoGroup)),
    { key: "research", items: [...research].sort((a, b) => (a.nameKey === "researchReport" ? -1 : b.nameKey === "researchReport" ? 1 : newestFirst(a, b))) },
    { key: "context", items: [...context].sort((a, b) => a.name.localeCompare(b.name, "vi", { numeric: true })) },
    ...(current ? others.map(videoGroup) : []),
  ];
  // a video's group shows even while empty (its documents come as work goes on); the others only with something in them
  return groups.filter((g) => g.items.length || (g.video && g.video === current) || g.key === "research");
}

/** Characters a path segment cannot hold (`normalizeRelPath` of the engine), and control characters. */
const NOT_IN_NAME = /[<>:"|?*\\/]|\p{Cc}/gu;

/**
 * Where a new document named `title` goes in `folder`: the name as written (accents kept, so the list shows it as
 * typed), without what a path cannot hold, as markdown (`Ghi chú khán giả` → `Ghi chú khán giả.md`); ` (2)`, ` (3)`…
 * when that name is `taken`.
 */
export function newDocPath(title: string, folder: string, taken: Set<string>): string {
  const name = title.normalize("NFC").replace(NOT_IN_NAME, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 80).trim() || "Tài liệu";
  for (let n = 1; ; n++) {
    const path = `${folder}/${name}${n > 1 ? ` (${n})` : ""}.md`;
    if (!taken.has(path)) return path;
  }
}
