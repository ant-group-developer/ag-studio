import { describe, expect, it } from "vitest";
import { cli, freshLibraryWorld } from "../integration/library-helpers.js";

// Acceptance 20: the two roles of one kho are both healthy before anything is produced -- the studio with
// two workflows and six wrappers, the channel with no workflows and no `executors/` at all. No ffmpeg: this
// is the check an operator runs right after mounting the kho, so it must not depend on media tooling being
// installed (ffprobe missing is its own `ffprobe` row, not a library row).
describe("acceptance 20: doctor is green on both roles of a freshly mounted kho", () => {
  it("reports library:root/write/index ok for the studio and the channel project alike", () => {
    const world = freshLibraryWorld({ media: false });

    for (const project of [world.studio, world.channel]) {
      const doctor = cli(project, ["doctor", "--json"]);
      const rows: { check: string; ok: boolean; detail: string }[] = JSON.parse(doctor.out);
      const byCheck = new Map(rows.map((r) => [r.check, r]));
      for (const check of ["library:root", "library:write", "library:index"]) {
        expect(byCheck.get(check), `${project}: ${check} missing`).toBeDefined();
        expect(byCheck.get(check), `${project}: ${check} -> ${byCheck.get(check)?.detail}`).toMatchObject({ ok: true });
      }
      // every non-ffprobe row is ok too; ffprobe itself is allowed to fail on a machine without it
      const failed = rows.filter((r) => !r.ok && r.check !== "ffprobe");
      expect(failed.map((r) => `${r.check}: ${r.detail}`)).toEqual([]);
    }
  }, 120_000);
});
