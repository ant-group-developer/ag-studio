import { describe, expect, it } from "vitest";
import { mediaChildEnv } from "@harness/adapter-media-python";

const SECRET_VALUE = "s3cret";
const SECRET_NAME = "HARNESS_SECRET_X_Y";

// Acceptance 45 (sub-project 5A §7, spec §6): the media engine's child process never sees `HARNESS_SECRET_*`.
//
// Design note (task 10): asserted at the ADAPTER BOUNDARY rather than by spawning a fake Python.
// `PythonMediaEngine` resolves its interpreter from `project.yaml`'s `media.python` but always runs the
// harness-owned scripts under `<harnessRoot>/engines/python`, and its `dryRun` option is not reachable from
// `project.yaml` -- so there is no seam for a stand-in script that does not also mean adding a production flag
// purely for a test. `mediaChildEnv` IS the single gate every spawn in that adapter goes through
// (`spawn(..., { env: mediaChildEnv(process.env) })`, twice, for the probe and for each job), so it is
// asserted directly, with the secret really present in this process' env. (The end-to-end half, a full
// `library-production@1.2.0` run scanned for the secret, went with that pipeline in GĐ3.)
describe("acceptance 45: no secret reaches the media engine", () => {
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
});
