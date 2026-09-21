import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@harness/contracts";
import { mediaChildEnv } from "@harness/adapter-media-python";
import { hasFfmpeg } from "../media.js";
import { addVoice, cli, freshLibraryWorld, ingestShoot, requestCreate, requestStatus, studioWorkerUntil, writeActiveStyle } from "../integration/library-helpers.js";

const SECRET_VALUE = "s3cret";
const SECRET_NAME = "HARNESS_SECRET_X_Y";

/** Every file under `root`, recursively (mirrors acceptance 25/31's own `allFiles`). */
function allFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[]).map((rel) => join(root, rel)).filter((p) => statSync(p).isFile());
}

/** The text-shaped files a leak could hide in: every log, every JSON artifact/stage file, every prompt and
 * every markdown/yaml the run wrote. The binaries (mp4/png/wav) are skipped deliberately -- nothing writes
 * text into them and reading them all would dominate this test's runtime. */
const TEXT_SUFFIXES = [".log", ".json", ".md", ".txt", ".yaml", ".yml", ".csv"];
function textFiles(root: string): string[] {
  return allFiles(root).filter((p) => TEXT_SUFFIXES.some((s) => p.toLowerCase().endsWith(s)));
}

// Acceptance 45 (sub-project 5A §7, spec §6): the media engine's child process never sees `HARNESS_SECRET_*`,
// and nothing the media stages write ever carries one.
//
// Design note (task 10): the first half is asserted at the ADAPTER BOUNDARY rather than by spawning a fake
// Python. `PythonMediaEngine` resolves its interpreter from `project.yaml`'s `media.python` but always runs
// the harness-owned scripts under `<harnessRoot>/engines/python`, and its `dryRun` option is not reachable
// from `project.yaml` -- so there is no seam for a stand-in script that does not also mean adding a
// production flag purely for a test. `mediaChildEnv` IS the single gate every spawn in that adapter goes
// through (`spawn(..., { env: mediaChildEnv(process.env) })`, twice, for the probe and for each job), so it
// is asserted directly, with the secret really present in this process' env. The second half then proves the
// same guarantee end to end on the engine CI actually runs (`adapters.media: fake`), the way acceptance 31
// does for agent stages: a full `library-production@1.2.0` run with the secret in the ambient env of every
// `worker --once`, and not a byte of it in any workspace file, log, artifact or event.
describe("acceptance 45: no secret reaches the media engine or anything it writes", () => {
  it("mediaChildEnv strips HARNESS_SECRET_* from a parent env that has one", () => {
    const parent = { ...process.env, [SECRET_NAME]: SECRET_VALUE, harness_secret_lower: SECRET_VALUE, PATH: process.env.PATH ?? "", CUDA_VISIBLE_DEVICES: "0" };
    const child = mediaChildEnv(parent);

    expect(Object.keys(child).some((k) => k.toUpperCase().startsWith("HARNESS_SECRET_")), JSON.stringify(Object.keys(child))).toBe(false);
    expect(Object.values(child)).not.toContain(SECRET_VALUE);
    // ...and the allow-list itself still works, so the assertion above is not passing on an empty env
    expect(child.PATH).toBe(parent.PATH);
    expect(child.CUDA_VISIBLE_DEVICES).toBe("0");
    expect(child.PYTHONUTF8).toBe("1");
  });

  it.skipIf(!hasFfmpeg())("a full library-production@1.2.0 run leaks neither the value nor the name", () => {
    const world = freshLibraryWorld({ media: false, media1_2: true });
    const env = { FAKE_REVIEW_MODE: "approve", [SECRET_NAME]: SECRET_VALUE };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const voiceId = addVoice(world);
    ingestShoot(world, "shoot-a", 2, { withAudio: true });

    const requestId = requestCreate(world, {
      topic: "Không rò rỉ secret qua media", style: styleId, sourceHint: "shoot-a",
      voice: "tts", voiceId, duration: [1, 120], language: "en",
    });
    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 400, env);
    expect(requestStatus(world, requestId).status).toBe("fulfilled");

    const files = [
      ...textFiles(join(world.studio, "data", "workspaces")),
      ...textFiles(join(world.studio, "data", "artifacts")),
      ...textFiles(world.lib),
    ];
    expect(files.length, "nothing to scan -- the loop below would be vacuous").toBeGreaterThan(0);
    // the media stages really did write into that set
    expect(files.some((f) => f.endsWith("narration-timing.json")), "no narration-timing.json among the scanned files").toBe(true);
    expect(files.some((f) => f.endsWith("transcript.json")), "no transcript.json among the scanned files").toBe(true);

    for (const f of files) {
      const content = readFileSync(f, "utf8");
      expect(content, `${f} contains the secret value`).not.toContain(SECRET_VALUE);
      expect(content, `${f} contains ${SECRET_NAME}`).not.toContain(SECRET_NAME);
    }

    const events = cli(world.studio, ["events", "tail", "--limit", "2000", "--json"], env);
    expect(events.code, events.err).toBe(0);
    expect(events.out).not.toContain(SECRET_VALUE);
    expect(events.out).not.toContain(SECRET_NAME);
  }, 300_000);
});
