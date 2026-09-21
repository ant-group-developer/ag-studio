import { describe, expect, it } from "vitest";
import { buildShots, shotId } from "../../src/media/scene.js";

describe("buildShots", () => {
  it("with no cuts, splits the whole duration evenly when it exceeds max_shot_seconds", () => {
    const shots = buildShots([], 10, { min_shot_seconds: 1, max_shot_seconds: 4 });
    expect(shots).toHaveLength(3);
    expect(shots[0]!.in).toBe(0);
    expect(shots[2]!.out).toBe(10);
    // rounded to 3 decimals, so each part can be up to ~0.001s off from the exact 10/3 split
    for (const s of shots) expect(s.out - s.in).toBeCloseTo(10 / 3, 2);
  });

  it("merges a too-short first shot forward into the next one", () => {
    const shots = buildShots([0.4, 5], 10, { min_shot_seconds: 1, max_shot_seconds: 20 });
    expect(shots).toEqual([
      { in: 0, out: 5 },
      { in: 5, out: 10 },
    ]);
  });

  it("merges a too-short last shot into the previous one", () => {
    const shots = buildShots([9.7], 10, { min_shot_seconds: 1, max_shot_seconds: 20 });
    expect(shots).toEqual([{ in: 0, out: 10 }]);
  });

  it("drops cuts outside the open interval (0, duration)", () => {
    const shots = buildShots([-1, 0, 10, 15], 10, { min_shot_seconds: 1, max_shot_seconds: 20 });
    expect(shots).toEqual([{ in: 0, out: 10 }]);
  });

  it("returns [] when duration is 0 or negative, regardless of cuts", () => {
    expect(buildShots([1, 2], 0, { min_shot_seconds: 1, max_shot_seconds: 20 })).toEqual([]);
    expect(buildShots([], -5, { min_shot_seconds: 1, max_shot_seconds: 20 })).toEqual([]);
  });

  it("rounds in/out to 3 decimal places", () => {
    const shots = buildShots([], 10, { min_shot_seconds: 1, max_shot_seconds: 3 });
    for (const s of shots) {
      expect(s.in).toBe(Math.round(s.in * 1000) / 1000);
      expect(s.out).toBe(Math.round(s.out * 1000) / 1000);
    }
    // 10 / ceil(10/3)=4 parts -> 2.5s each
    expect(shots).toEqual([
      { in: 0, out: 2.5 },
      { in: 2.5, out: 5 },
      { in: 5, out: 7.5 },
      { in: 7.5, out: 10 },
    ]);
  });

  it("keeps a middle shot as-is when it is within [min, max]", () => {
    const shots = buildShots([3, 6], 10, { min_shot_seconds: 1, max_shot_seconds: 20 });
    expect(shots).toEqual([
      { in: 0, out: 3 },
      { in: 3, out: 6 },
      { in: 6, out: 10 },
    ]);
  });
});

describe("shotId", () => {
  it("pads source and shot index to 3 digits, joined with a dash", () => {
    expect(shotId(0, 0)).toBe("s000-000");
    expect(shotId(2, 15)).toBe("s002-015");
    expect(shotId(12, 345)).toBe("s012-345");
  });
});
