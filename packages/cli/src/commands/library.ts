import type { Command } from "commander";
import { HarnessError, type LibraryBrief } from "@harness/contracts";
import { applyReview, claimItem, createRequest, syncLibrary } from "@harness/core";
import { registerLibraryStage, requireLibrary } from "./library-stage.js";
import { print, withContext } from "./shared.js";

function parseDuration(raw: string | undefined): [number, number] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n < 0)) throw new HarnessError("CONFIG_INVALID", '--duration must be "min,max" (non-negative numbers)', { value: raw });
  return [parts[0]!, parts[1]!];
}

export function registerLibrary(program: Command): void {
  const library = program.command("library").description("kho nội dung: sync, requests, styles, items (spec §4.2)");
  registerLibraryStage(library);

  library.command("sync").option("--json", "machine output", false)
    .description("pull styles/requests/items from the kho filesystem into the local DB mirror")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        const lib = requireLibrary(ctx);
        const report = await syncLibrary({ store: ctx.store, fs: lib.fs, role: lib.role, clock: ctx.clock });
        print(o.json, report, () =>
          [
            `imported: styles=${report.imported.styles.length} requests=${report.imported.requests.length} items=${report.imported.items.length}`,
            `updated:  styles=${report.updated.styles.length} requests=${report.updated.requests.length} items=${report.updated.items.length}`,
            `corrupt: ${report.corrupt.length}`, ...report.corrupt.map((c) => `  ! ${c.path}: ${c.reason}`),
            `missing: ${report.missing.length}`, ...report.missing.map((m) => `  ? ${m.kind} ${m.id}`),
          ].join("\n"));
        if (report.corrupt.length > 0) process.exitCode = 1;
      });
    });

  library.command("list <kind>").option("--status <status>").option("--json", "machine output", false)
    .description("list items|requests|styles from the local DB mirror (run `library sync` first)")
    .action(async (kind: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireLibrary(ctx);
        const filter = o.status ? { status: o.status } : {};
        if (kind === "items") { const rows = ctx.store.listLibraryItems(filter); print(o.json, rows, () => rows.map((r) => `${r.item_id} ${r.status.padEnd(14)} ${r.title_hint}`).join("\n") || "no items"); }
        else if (kind === "requests") { const rows = ctx.store.listContentRequests(filter); print(o.json, rows, () => rows.map((r) => `${r.request_id} ${r.status.padEnd(10)} ${r.topic}`).join("\n") || "no requests"); }
        else if (kind === "styles") { const rows = ctx.store.listEditStyles(filter); print(o.json, rows, () => rows.map((r) => `${r.style_id} rev${r.revision} ${r.status.padEnd(8)} ${r.name}`).join("\n") || "no styles"); }
        else throw new HarnessError("CONFIG_INVALID", `unknown list kind "${kind}", expected items|requests|styles`, { kind });
      });
    });

  const request = library.command("request").description("content requests (channel role)");
  request.command("create")
    .requiredOption("--portfolio <id>").option("--channel <id>").requiredOption("--topic <topic>").option("--style <style_id>")
    .option("--duration <min,max>").option("--voice <voice>", "none|tts|original").option("--language <code>").option("--count <n>").option("--due <date>")
    .option("--json", "machine output", false)
    .description("create an open content request in the kho")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const lib = requireLibrary(ctx);
        const target_duration_seconds = parseDuration(o.duration);
        const r = createRequest({ store: ctx.store, fs: lib.fs, clock: ctx.clock }, {
          requested_by: { portfolio_id: o.portfolio, ...(o.channel ? { channel_id: o.channel } : {}) },
          topic: o.topic,
          ...(o.style ? { style_id: o.style } : {}),
          ...(target_duration_seconds ? { target_duration_seconds } : {}),
          ...(o.voice ? { voice: o.voice } : {}),
          ...(o.language ? { language: o.language } : {}),
          ...(o.count ? { count: Number(o.count) } : {}),
          ...(o.due ? { due_at: o.due } : {}),
        });
        print(o.json, r, () => `${r.request_id} ${r.status}`);
      });
    });

  library.command("accept")
    .option("--request <id>", "accept from an existing open request").option("--topic <topic>", "manual topic (with --style)").option("--style <style_id>", "manual style (with --topic)")
    .option("--source <src_id>", "source id (repeatable, at least one)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--title <title>").option("--json", "machine output", false)
    .description("build a library_brief (from a request, or by hand) and create the ContentItem library-production plans against; does not claim the request")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireLibrary(ctx);
        if (o.source.length === 0) throw new HarnessError("CONFIG_INVALID", "--source is required (repeatable, at least one)", {});
        const manual = Boolean(o.topic || o.style);
        if (Boolean(o.request) === manual) throw new HarnessError("CONFIG_INVALID", "pass exactly one of --request or (--topic and --style)", { request: o.request, topic: o.topic, style: o.style });

        let topic: string; let style_id: string; let request_id: string | undefined;
        let voice: "none" | "tts" | "original" = "none"; let language = "vi"; let target_duration_seconds: [number, number] | undefined;
        if (o.request) {
          const req = ctx.store.getContentRequest(o.request);
          if (!req) throw new HarnessError("NOT_FOUND", `content request not found: ${o.request}; run library sync first`, { request_id: o.request });
          if (!req.style_id) throw new HarnessError("CONFIG_INVALID", `content request ${o.request} has no style_id`, { request_id: o.request });
          topic = req.topic; style_id = req.style_id; request_id = req.request_id; voice = req.voice; language = req.language;
          target_duration_seconds = req.target_duration_seconds;
        } else {
          if (!o.topic || !o.style) throw new HarnessError("CONFIG_INVALID", "both --topic and --style are required without --request", {});
          topic = o.topic; style_id = o.style;
        }

        const style = ctx.store.getEditStyle(style_id);
        if (!style || style.status !== "active") throw new HarnessError("CONFIG_INVALID", `edit style ${style_id} not found or not active; run library sync first`, { style_id });

        const library_brief: LibraryBrief = { topic, style_id, style_revision: style.revision, voice, language, ...(target_duration_seconds ? { target_duration_seconds } : {}), ...(request_id ? { request_id } : {}) };
        const content = ctx.catalog.createContent({ source_ids: o.source, title: o.title ?? topic, library_brief });
        print(o.json, { content_id: content.content_id }, () => content.content_id);
      });
    });

  library.command("review <item_id>")
    .option("--approve", "approve the item", false).option("--reject", "reject the item", false).option("--note <note>")
    .option("--json", "machine output", false)
    .description("apply a review decision to a pending_review item without going through a gate (studio role)")
    .action(async (itemId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const lib = requireLibrary(ctx);
        if (Boolean(o.approve) === Boolean(o.reject)) throw new HarnessError("CONFIG_INVALID", "pass exactly one of --approve or --reject", {});
        const decision = o.approve ? "approved" : "rejected";
        const { item, request } = applyReview({ store: ctx.store, fs: lib.fs, clock: ctx.clock }, { item_id: itemId, decision, by: "cli", ...(o.note ? { note: o.note } : {}) });
        print(o.json, { item_id: item.item_id, status: item.status, request_id: request?.request_id, request_status: request?.status },
          () => `${item.item_id} ${item.status}`);
      });
    });

  library.command("pick <item_id>")
    .requiredOption("--channel <channel_id>").option("--portfolio <id>", "portfolio to attribute the picked content to (defaults to project.yaml's first portfolio)").option("--json", "machine output", false)
    .description("claim an approved item into a local ContentItem (channel role); prints content_id for `plan --content`")
    .action(async (itemId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const lib = requireLibrary(ctx);
        const portfolio_id = o.portfolio ?? ctx.project.portfolios[0]?.portfolio_id;
        if (!portfolio_id) throw new HarnessError("CONFIG_INVALID", "no --portfolio given and project.yaml declares no portfolios", { projectDir: ctx.projectDir });
        const { content } = claimItem({ store: ctx.store, fs: lib.fs, clock: ctx.clock, catalog: ctx.catalog }, { item_id: itemId, channel_id: o.channel, portfolio_id });
        print(o.json, { content_id: content.content_id }, () => content.content_id);
      });
    });

  const styles = library.command("styles").description("edit styles");
  styles.command("show <style_id>").option("--json", "machine output", false)
    .description("print a synced edit style")
    .action(async (styleId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireLibrary(ctx);
        const style = ctx.store.getEditStyle(styleId);
        if (!style) throw new HarnessError("NOT_FOUND", `edit style not found: ${styleId}; run library sync first`, { style_id: styleId });
        print(o.json, style, () => `${style.style_id} rev${style.revision} ${style.status} "${style.name}"`);
      });
    });
}
