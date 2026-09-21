import { describe, expect, it } from "vitest";
import { mediaChildEnv } from "../src/child-env.js";

describe("mediaChildEnv", () => {
  it("allow-lists media env vars, strips HARNESS_SECRET_* (case-insensitive) and other keys, and always sets PYTHONUTF8", () => {
    const env = mediaChildEnv({
      HARNESS_SECRET_X: "s3cret",
      harness_secret_y: "s3cret2",
      OPENAI_API_KEY: "nope",
      PATH: "/bin",
      CUDA_VISIBLE_DEVICES: "0",
      HF_HOME: "/home/.cache/hf",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.CUDA_VISIBLE_DEVICES).toBe("0");
    expect(env.HF_HOME).toBe("/home/.cache/hf");
    expect(env.PYTHONUTF8).toBe("1");
    expect(env).not.toHaveProperty("HARNESS_SECRET_X");
    expect(env).not.toHaveProperty("harness_secret_y");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("passes through any CUDA_* var, not just CUDA_VISIBLE_DEVICES", () => {
    const env = mediaChildEnv({ CUDA_DEVICE_ORDER: "PCI_BUS_ID", PATH: "/bin" });
    expect(env.CUDA_DEVICE_ORDER).toBe("PCI_BUS_ID");
  });

  it("matches the fixed allow-list case-insensitively but emits the canonical key", () => {
    const env = mediaChildEnv({ Path: "C:\\Windows", Temp: "C:\\Temp" });
    expect(env.PATH).toBe("C:\\Windows");
    expect(env.TEMP).toBe("C:\\Temp");
    expect(env).not.toHaveProperty("Path");
    expect(env).not.toHaveProperty("Temp");
  });

  it("always sets PYTHONUTF8=1 even when the host env has no such var", () => {
    const env = mediaChildEnv({});
    expect(env.PYTHONUTF8).toBe("1");
    expect(Object.keys(env)).toEqual(["PYTHONUTF8"]);
  });
});
