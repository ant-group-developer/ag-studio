import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStateStore } from "@harness/core";
import { hasFfmpeg } from "../media.js";
import { SAMPLE_EDL, cli, freshFootageProject, planFootage, status, submitGate } from "../integration/footage-helpers.js";

const SECRET = "heygen-secret-KEY-42"; // matches footage-helpers.ts's cli() default for HARNESS_SECRET_HEYGEN_MAIN

function ingestAndCreateContent(dir: string, source: string): { source_id: string; content_id: string } {
  const ingest = JSON.parse(cli(dir, ["source", "ingest", source, "--rights", "cleared", "--json"]).out) as { source_id: string };
  const created = JSON.parse(cli(dir, ["content", "create", "--title", "Sample", "--source", ingest.source_id, "--json"]).out) as { content_id: string };
  return { source_id: ingest.source_id, content_id: created.content_id };
}

// Duplicated from footage-helpers.ts's private helper of the same name: converts a workspace file:// URI
// (as recorded on an Attempt) back into a filesystem path on this OS.
function workspacePathFromUri(uri: string): string {
  const u = new URL(uri);
  let p = decodeURIComponent(u.pathname);
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1); // file:///E:/... -> E:/...
  return p;
}

describe.skipIf(!hasFfmpeg())("18.3 #16 secret e2e: the resolved HeyGen key never leaks, and its appearance in a script's own log line is redacted", () => {
  it("no worker output, status, events, workspace file or artifact manifest contains the raw key; the worker's own log stream (stderr) shows [REDACTED] in its place", () => {
    const { dir, source } = freshFootageProject();
    const { source_id: sourceId, content_id: contentId } = ingestAndCreateContent(dir, source);
    const env = { HARNESS_LOG_LEVEL: "debug" }; // avatar.mjs's log lines are info-level; the default "error" level would hide them

    const run = planFootage(dir, contentId, ["voice=none", "avatar=heygen"]);

    const outputs: string[] = [];
    const errors: string[] = [];
    function drainCollect(max = 30): void {
      for (let i = 0; i < max; i++) {
        const r = cli(dir, ["worker", "--once"], env);
        outputs.push(r.out);
        errors.push(r.err);
        if (r.out.includes("idle")) return;
      }
      throw new Error("did not drain");
    }

    drainCollect(); // index-source runs; select-topic parks WAITING_HUMAN
    submitGate(dir, run, "select-topic", { "topic.md": "# Sample topic\n" });
    drainCollect();
    submitGate(dir, run, "write-script", { "narration.txt": "Line one.\nLine two.\nLine three.\n", "script.md": "# Script\n" });
    drainCollect();
    submitGate(dir, run, "edit-plan", { "edl.json": SAMPLE_EDL(sourceId) });
    drainCollect(); // avatar (and cut, assemble, thumbnail-render) dispatch here; thumbnail-qc parks

    const s = status(dir, run);
    expect(s.stages.find((st) => st.stage_key === "avatar")?.state).toBe("SUCCEEDED");

    const workerCombined = [...outputs, ...errors].join("\n");
    expect(workerCombined).not.toContain(SECRET);
    // packages/cli/src/composition.ts sinks the worker's logger to stderr; the script's raw stdout line
    // ("avatar: using api key ...") and its structured ctx.log.info({ key }) line are forwarded through
    // that same logger (packages/executors/src/script-executor.ts's forwardStdout), so both get redacted
    // there rather than dropped — proving the line made it through the Redactor instead of being swallowed.
    expect(errors.join("\n")).toContain("[REDACTED]");

    const statusOut = cli(dir, ["status", run, "--json"], env).out;
    expect(statusOut).not.toContain(SECRET);
    const eventsOut = cli(dir, ["events", "tail", "--run", run, "--json", "--limit", "1000"], env).out;
    expect(eventsOut).not.toContain(SECRET);

    const avatarStage = s.stages.find((st) => st.stage_key === "avatar")!;
    const lastAttempt = avatarStage.attempts.at(-1)!;
    const ws = workspacePathFromUri(lastAttempt.workspace_uri!);
    const stageRequest = readFileSync(join(ws, "stage-request.json"), "utf8");
    const stageResult = readFileSync(join(ws, "stage-result.json"), "utf8");
    expect(stageRequest).not.toContain(SECRET);
    expect(stageResult).not.toContain(SECRET);

    const store = new SqliteStateStore(join(dir, "data", "state", "harness.db"));
    try {
      const avatarArtifact = s.artifacts.find((a) => a.type === "avatar_clips" && a.status === "ACCEPTED")!;
      const full = store.getArtifact(avatarArtifact.artifact_id)!;
      const manifestPath = join(dirname(fileURLToPath(full.uri)), "manifest.json");
      const manifest = readFileSync(manifestPath, "utf8");
      expect(manifest).not.toContain(SECRET);
    } finally {
      store.close();
    }

    const projectYaml = readFileSync(join(dir, "project.yaml"), "utf8");
    const scriptsYaml = readFileSync(join(dir, "executors", "scripts.yaml"), "utf8");
    expect(projectYaml).not.toContain(SECRET);
    expect(scriptsYaml).not.toContain(SECRET);
    expect(scriptsYaml).toContain("secret://heygen/main");
  }, 300_000);
});
