/**
 * Every Studio workflow release on disk stays runnable: an in-flight run keeps executing its own release, so each
 * release's scripts, payload builders, skills, checks and gates must stay registered under the names it uses. And
 * no stage may read two upstream stages that produce the same artifact type (`inputPath` takes the first one, so the
 * stage would silently read the wrong document, e.g. Claude's proposal instead of the approved one).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { STUDIO_SKILL_OUTPUTS } from "@harness/contracts";
import { BUILTIN_CHECKERS, studioCheckers } from "@harness/core";
import {
  cancelLegacyRuns, cutPayloadBuilders, MemoryBucket, STUDIO_GATES, STUDIO_WORKFLOWS, studioInProcessStages, studioPayloadBuilders, studioWorkflowRefs,
} from "../src/index.js";
import { ROOT, world } from "./helpers.js";

describe("Studio workflow releases", () => {
  const w = world();
  const refs = studioWorkflowRefs(ROOT);
  const scripts = new Set(Object.keys(studioInProcessStages({
    db: w.db, bucket: w.bucket, footage: { getCatalog: async () => ({ items: [], nextCursor: null }) },
    startEpisodeRun: async () => ({ runId: "run_x" }),
  })));
  const builders = new Set([
    ...Object.keys(studioPayloadBuilders({ db: w.db, bucket: new MemoryBucket() })),
    ...Object.keys(cutPayloadBuilders({ db: w.db, bucket: new MemoryBucket() })),
  ]);
  const checks = new Set([...BUILTIN_CHECKERS, ...studioCheckers()].map((c) => c.id));
  afterAll(() => w.core.close());

  it("finds every release, the current ones included", () => {
    for (const flow of Object.values(STUDIO_WORKFLOWS)) expect(refs).toContain(flow.workflow);
  });

  it.each(refs)("%s: every stage's executor, checks and inputs are wired", (ref) => {
    const { definition } = w.core.workflows(ref);
    const stages = new Map(definition.stages.map((s) => [s.key, s]));
    for (const stage of definition.stages) {
      const where = `${ref} ${stage.key}`;
      const ex = stage.executor as { type: string; script?: string; skill?: string };
      if (ex.type === "script") expect(scripts.has(ex.script!), `${where}: script ${ex.script}`).toBe(true);
      if (ex.type === "farm") {
        const builder = (stage.config as { payload_builder?: string } | undefined)?.payload_builder;
        expect(builder && builders.has(builder), `${where}: payload builder ${builder}`).toBe(true);
      }
      if (ex.type === "agent") {
        expect(ex.skill! in STUDIO_SKILL_OUTPUTS, `${where}: skill ${ex.skill}`).toBe(true);
        expect(existsSync(join(ROOT, "skills", ex.skill!, "SKILL.md")), `${where}: SKILL.md`).toBe(true);
      }
      if (ex.type === "gate") {
        expect(STUDIO_GATES[stage.key], `${where}: gate document`).toBeTruthy();
        expect(stage.outputs.map((o) => o.name), `${where}: gate output`).toContain(STUDIO_GATES[stage.key]);
      }
      for (const check of stage.required_checks) expect(checks.has(check), `${where}: check ${check}`).toBe(true);

      const producerOf = new Map<string, string>();
      for (const dep of [...stage.depends_on, ...(stage.depends_on_optional ?? [])]) {
        const upstream = stages.get(dep);
        expect(upstream, `${where}: depends on unknown ${dep}`).toBeTruthy();
        for (const type of new Set(upstream!.outputs.map((o) => o.type))) {
          const other = producerOf.get(type);
          expect(other, `${where}: ${type} comes from both ${other} and ${dep}`).toBeUndefined();
          producerOf.set(type, dep);
        }
      }
    }
  });

  it("does not cancel the runs of an older release at worker start", () => {
    const old = refs.find((r) => !Object.values(STUDIO_WORKFLOWS).some((f) => f.workflow === r));
    if (!old) return; // a single release on disk: nothing older to keep
    const run = w.core.planner.plan({
      workflow: w.core.workflows(old), profile: w.core.profiles("studio-production"),
      harness: w.core.harness, projectId: "ag-studio", portfolioId: "studio", reuse: false,
    });
    expect(cancelLegacyRuns(w.core)).not.toContain(run.run_id);
  });
});
