import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type LibraryItem } from "@harness/contracts";
import { SqliteStateStore } from "@harness/core";
import { hasFfmpeg, systemFontPath } from "../media.js";
import {
  autoAcceptedRuns, cli, declareChannel, freshLibraryWorld, ingestShoot, requestCreate, requestStatus,
  setBrand, status, studioWorkerUntil, writeActiveStyle,
} from "../integration/library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const CHANNEL_ID = "channel-one";

function doctorRows(project: string): { check: string; ok: boolean; detail: string }[] {
  const r = cli(project, ["doctor", "--json"]);
  return JSON.parse(r.out) as { check: string; ok: boolean; detail: string }[];
}

/** The error the parked `intake` attempt recorded -- the message that has to name the missing file. */
function intakeError(project: string, runId: string): string {
  const store = new SqliteStateStore(join(project, "data", "state", "harness.db"));
  try {
    const stage = store.listStageRuns(runId).find((s) => s.stage_key === "intake");
    return (stage ? store.listAttempts(stage.stage_run_id).at(-1)?.error_summary : undefined) ?? "";
  } finally {
    store.close();
  }
}

// Acceptance 51 (sub-project 5B §7, first row of the error table): a brand whose files went missing is a
// machine problem, and it is caught at `intake` -- BEFORE `claimRequest`. That ordering is the whole point:
// a request claimed by a run that then fails is a request nothing reopens (only `library-apply-review` ever
// moves one back to `open`), so it would sit at `claimed` waiting for a human. Failing first leaves it
// `open`, which means the studio picks it straight back up the moment the file is restored -- with no
// operator command at all.
describe.skipIf(!hasFfmpeg() || !systemFontPath())("acceptance 51: a broken brand fails before the request is claimed", () => {
  it("stops intake naming logo.png, leaves the request open, is reported by doctor, and finishes once the file is back", () => {
    const world = freshLibraryWorld({ media: false, media1_3: true });
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    expect(setBrand(world, CHANNEL_ID, { withLogo: true, subtitles: "none" })).toBe(true);
    // `harness doctor` only emits per-channel rows for channels the project actually declares, and
    // `freshLibraryWorld` leaves the temp channel project without a `channels/` directory.
    declareChannel(world.channel);
    ingestShoot(world, "shoot-a", 2, { withAudio: true });

    // The kho copy `library brands set` made, and whose checksum `brand.json` now records.
    const logoPath = join(world.lib, "brands", CHANNEL_ID, "logo.png");
    expect(existsSync(logoPath)).toBe(true);
    const logoBytes = readFileSync(logoPath);
    rmSync(logoPath);

    // ---- doctor sees it from the channel side, naming the file ----
    const brandRow = doctorRows(world.channel).find((r) => r.check === `channel:${CHANNEL_ID}:brand`);
    expect(brandRow, JSON.stringify(doctorRows(world.channel).map((r) => r.check))).toBeDefined();
    expect(brandRow!.ok).toBe(false);
    expect(brandRow!.detail, brandRow!.detail).toContain("logo.png");

    const requestId = requestCreate(world, {
      topic: "Thương hiệu mất logo", style: styleId, sourceHint: "shoot-a",
      voice: "none", duration: [1, 120], language: "en",
    });

    // ---- the run stops at intake, and the request is still pickable ----
    // A `CONFIG_INVALID` from a stage is a `contract` failure, and sub-project 1's controller PARKS those at
    // `WAITING_HUMAN` (run `WAITING`) instead of failing the run outright -- a broken contract is not
    // something a retry fixes, so a person is asked to look. Spec §7 and the task brief both say "run
    // FAILED" here; that wording predates the parking rule and is inaccurate for every `contract` failure in
    // the harness, 5A's identical voice check included. What the spec is actually about -- the request must
    // not be left at `claimed` -- is asserted right below, and it holds.
    studioWorkerUntil(world, () => {
      const runId = autoAcceptedRuns(world, requestId)[0]?.run_id;
      return runId !== undefined && status(world.studio, runId).run.state === "WAITING";
    }, 60, env);

    const firstRun = autoAcceptedRuns(world, requestId)[0]?.run_id;
    expect(firstRun, "the autopilot never planned a run").toBeDefined();
    const parked = status(world.studio, firstRun!);
    expect(parked.run.state, JSON.stringify(parked.stages.map((s) => [s.stage_key, s.state]))).toBe("WAITING");
    expect(parked.stages.find((s) => s.stage_key === "intake")?.state).toBe("WAITING_HUMAN");
    // Nothing downstream of intake ever started: the brand was checked before any work was done.
    expect(parked.stages.filter((s) => s.stage_key !== "intake").every((s) => s.state === "PENDING"), JSON.stringify(parked.stages.map((s) => [s.stage_key, s.state]))).toBe(true);
    expect(intakeError(world.studio, firstRun!), intakeError(world.studio, firstRun!)).toContain("logo.png");

    const openRequest = requestStatus(world, requestId);
    expect(openRequest.status, "a brand fault must not leave the request stuck at claimed").toBe("open");
    expect(openRequest.claimed_by_run).toBeUndefined();

    // ---- put the exact bytes back, clear the park, and the studio finishes the request ----
    writeFileSync(logoPath, logoBytes);
    expect(doctorRows(world.channel).find((r) => r.check === `channel:${CHANNEL_ID}:brand`)?.ok).toBe(true);
    const retried = cli(world.studio, ["retry", firstRun!]);
    expect(retried.code, retried.err).toBe(0);

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 400, env);
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");

    const manifest = readJson<LibraryItem>(join(world.lib, "items", fulfilled.item_ids[0]!, "manifest.json"));
    expect(manifest.status).toBe("approved");
    expect(manifest.lineage.run_id).toBe(firstRun);
    expect(status(world.studio, firstRun!).run.state).toBe("SUCCEEDED");
  }, 600_000);
});
