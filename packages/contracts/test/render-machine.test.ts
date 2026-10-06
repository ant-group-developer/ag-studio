import { describe, expect, it } from "vitest";
import { RENDER_MACHINES, RenderMachineSchema, renderRequirements } from "../src/studio.js";

describe("render machine", () => {
  it("maps each machine type to the ag-farm requirements it stands for", () => {
    expect(renderRequirements("any")).toEqual({});
    expect(renderRequirements("nvenc")).toEqual({ nvenc: true });
    expect(renderRequirements("gpu")).toEqual({ gpu: true });
  });

  it("lists the three types, any first", () => {
    expect(RENDER_MACHINES).toEqual(["any", "nvenc", "gpu"]);
  });

  it("refuses a type it does not know", () => {
    expect(RenderMachineSchema.safeParse("render-01").success).toBe(false);
    expect(RenderMachineSchema.safeParse("gpu").success).toBe(true);
  });

  it("hands out a fresh object each time", () => {
    const a = renderRequirements("gpu");
    a.gpu = false;
    expect(renderRequirements("gpu")).toEqual({ gpu: true });
  });
});
