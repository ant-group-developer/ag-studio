/** Codex image generation through the fake (`fixtures/fake-codex.mjs`): no network, no real Codex. */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyCodexFailure, codexChildEnv, codexImagePrompt, codexImager, parseCodexEvents, parseCodexLogin,
} from "../src/index.js";
import { ROOT } from "./helpers.js";

const FAKE = [process.execPath, join(ROOT, "fixtures", "fake-codex.mjs")];

function home(login?: "chatgpt" | "api_key"): string {
  const h = mkdtempSync(join(tmpdir(), "codex-home-"));
  if (login) writeFileSync(join(h, "fake-login"), login);
  return h;
}
const outPath = () => join(mkdtempSync(join(tmpdir(), "codex-out-")), "sub", "01.png");
const lastExec = (h: string) => JSON.parse(readFileSync(join(h, "last-exec.json"), "utf8")) as { args: string[]; envKeys: string[]; prompt: string };

describe("codex image: words and events", () => {
  it("reads how Codex is logged in", () => {
    expect(parseCodexLogin("Logged in using ChatGPT")).toBe("chatgpt");
    expect(parseCodexLogin("Logged in using an API key - sk-a***")).toBe("api_key");
    expect(parseCodexLogin("Not logged in")).toBe("none");
  });

  it("keeps the thread, the failure, the last words and the usage of a --json run", () => {
    const f = parseCodexEvents([
      "Reading prompt from stdin...",
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "DONE" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }),
    ].join("\n"));
    expect(f).toEqual({ threadId: "t-1", failure: null, lastMessage: "DONE", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } });
    expect(parseCodexEvents(JSON.stringify({ type: "turn.failed", error: { message: "boom" } })).failure).toBe("boom");
  });

  it("names a failure by what Codex said", () => {
    expect(classifyCodexFailure("You've hit your usage limit. Try again later.").code).toBe("rate_limited");
    expect(classifyCodexFailure("401 Unauthorized: refresh token expired").code).toBe("not_logged_in");
    expect(classifyCodexFailure("Your request was rejected by the safety system").code).toBe("refused");
    expect(classifyCodexFailure("something odd")).toMatchObject({ code: "other", reason: "Codex: something odd" });
  });

  it("tells Codex to call the tool once with the references and nothing else", () => {
    const p = codexImagePrompt({ prompt: "a lake at sunset", references: ["/a/f.jpg"], transparentBackground: false });
    expect(p).toContain("$imagegen tool exactly once");
    expect(p).toContain('referenced_image_paths: ["/a/f.jpg"], transparent_background: false');
    expect(p).toContain("a lake at sunset");
    expect(codexImagePrompt({ prompt: "logo", transparentBackground: true })).not.toContain("referenced_image_paths");
  });

  it("gives the child its CODEX_HOME and never an API key or a Studio secret", () => {
    const env = codexChildEnv("/srv/codex", { PATH: "/bin", OPENAI_API_KEY: "sk", CODEX_API_KEY: "sk", STUDIO_SECRET_KEY: "x", CODEX_HOME: "/elsewhere", AUTH0_SECRET: "y" });
    expect(env).toEqual({ PATH: "/bin", CODEX_HOME: "/srv/codex" });
  });
});

describe("codexImager (fake)", () => {
  it("says its version and login, or null when it cannot run", async () => {
    const c = codexImager({ argv: FAKE, codexHome: home("chatgpt") });
    expect(await c.version()).toBe("codex-cli 0.0.0-fake");
    expect(await c.login()).toBe("chatgpt");
    const none = codexImager({ argv: [join(ROOT, "no-such-codex")], codexHome: home() });
    expect(await none.version()).toBeNull();
    expect(await none.login()).toBeNull();
  });

  it("makes a picture: copies Codex's PNG out, removes Codex's copy, keeps the usage", async () => {
    const h = home("chatgpt");
    const ref = join(h, "frame.jpg");
    writeFileSync(ref, "jpg");
    const out = outPath();
    const r = await codexImager({ argv: FAKE, codexHome: h }).generate({ prompt: "a lake", references: [ref], out });
    expect(readFileSync(out).subarray(1, 4).toString()).toBe("PNG");
    expect(r).toMatchObject({ out, usage: { input_tokens: 65553, cached_input_tokens: 52992, output_tokens: 718 } });
    expect(readdirSync(join(h, "generated_images"))).toEqual([]);

    const exec = lastExec(h);
    expect(exec.args).toEqual(expect.arrayContaining(["--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "-i", ref, "-"]));
    expect(exec.args.slice(exec.args.indexOf("-s"), exec.args.indexOf("-s") + 2)).toEqual(["-s", "read-only"]);
    expect(exec.args.at(-1)).toBe("-");
    expect(exec.prompt).toContain("a lake");
    expect(exec.envKeys).not.toContain("OPENAI_API_KEY");
    expect(exec.envKeys).toContain("CODEX_HOME");
  });

  it("keeps the last picture when the tool was called twice", async () => {
    const h = home("chatgpt");
    const out = outPath();
    await codexImager({ argv: FAKE, codexHome: h }).generate({ prompt: "FAKE:twice", out });
    expect(readFileSync(out).toString("latin1").endsWith("#2")).toBe(true);
  });

  it("refuses to run when Codex is not on a ChatGPT login", async () => {
    await expect(codexImager({ argv: FAKE, codexHome: home() }).generate({ prompt: "x", out: outPath() })).rejects.toMatchObject({ code: "not_logged_in" });
    await expect(codexImager({ argv: FAKE, codexHome: home("api_key") }).generate({ prompt: "x", out: outPath() })).rejects.toMatchObject({ code: "api_key_login" });
    await expect(codexImager({ argv: [join(ROOT, "no-such-codex")], codexHome: home() }).generate({ prompt: "x", out: outPath() })).rejects.toMatchObject({ code: "not_installed" });
  });

  it("says why no picture came: quota, refusal, no image, crash", async () => {
    const c = codexImager({ argv: FAKE, codexHome: home("chatgpt") });
    await expect(c.generate({ prompt: "FAKE:rate", out: outPath() })).rejects.toMatchObject({ code: "rate_limited" });
    await expect(c.generate({ prompt: "FAKE:refuse", out: outPath() })).rejects.toMatchObject({ code: "refused" });
    await expect(c.generate({ prompt: "FAKE:noimage", out: outPath() })).rejects.toMatchObject({ code: "no_image", detail: "Here is a description instead." });
    await expect(c.generate({ prompt: "FAKE:crash", out: outPath() })).rejects.toMatchObject({ code: "other", detail: "Error: fake codex crashed" });
  });

  it("stops on a timeout or when cancelled", async () => {
    const h = home("chatgpt");
    await expect(codexImager({ argv: FAKE, codexHome: h, timeoutMs: 1500 }).generate({ prompt: "FAKE:slow", out: outPath() })).rejects.toMatchObject({ code: "timeout" });
    const ac = new AbortController();
    const p = codexImager({ argv: FAKE, codexHome: h }).generate({ prompt: "FAKE:slow", out: outPath(), signal: ac.signal });
    setTimeout(() => ac.abort(), 1000);
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
  }, 20_000);

  // The real Codex on this machine's ChatGPT login (`STUDIO_CODEX_HOME`, else ~/.codex): spends plan quota, so opt-in.
  it.skipIf(process.env.HARNESS_REAL_CODEX_TEST !== "1")("real Codex makes a picture on the ChatGPT login", async () => {
    const codexHome = process.env.STUDIO_CODEX_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex");
    const ref = process.env.HARNESS_REAL_CODEX_REF;
    const out = outPath();
    const r = await codexImager({ argv: [process.env.STUDIO_CODEX_PATH ?? "codex"], codexHome }).generate({
      prompt: "A wide 16:9 landscape photo of a calm green lake with lanterns, golden-hour light. No text, letters or logos.",
      ...(ref ? { references: [ref] } : {}), out,
    });
    expect(readFileSync(out).subarray(1, 4).toString()).toBe("PNG");
    console.log(`real codex image: ${out} in ${r.seconds}s`, r.usage);
  }, 11 * 60_000);

  it("checks what it is asked before starting Codex", async () => {
    const c = codexImager({ argv: FAKE, codexHome: home("chatgpt") });
    await expect(c.generate({ prompt: " ", out: outPath() })).rejects.toThrow(/empty prompt/);
    await expect(c.generate({ prompt: "x", references: ["relative.jpg"], out: outPath() })).rejects.toThrow(/reference not found/);
    await expect(c.generate({ prompt: "x", references: ["/a", "/b", "/c", "/d", "/e", "/f"], out: outPath() })).rejects.toThrow(/at most 5/);
    expect(existsSync(join(ROOT, "no-such-codex"))).toBe(false);
  });
});
