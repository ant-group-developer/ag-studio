import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { HARNESS_ROOT } from "@harness/core";
import { hasFfmpeg, makeWav } from "../../../tests/media.js";

const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");

function cli(project: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error" } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

function freshProject(edit?: (cfg: Record<string, unknown>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-lib-voices-"));
  cpSync(join(HARNESS_ROOT, "fixtures", "ops-project-minimal"), dir, { recursive: true });
  if (edit) {
    const path = join(dir, "project.yaml");
    const cfg = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    edit(cfg);
    writeFileSync(path, stringify(cfg));
  }
  return dir;
}

function libraryProject(root: string, role: "studio" | "channel", idSuffix: string): string {
  return freshProject((cfg) => { cfg.project_id = `${cfg.project_id}-${idSuffix}`; cfg.library = { root, role }; });
}

function makeClip(seconds: number): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-lib-voices-clip-"));
  const path = join(dir, "ref.src.wav");
  makeWav(path, seconds);
  return path;
}

describe.skipIf(!hasFfmpeg())("harness library voices CLI", () => {
  it("adds a voice on the channel role, lists it, and refuses the same add on the studio role", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-voices-"));
    const channelDir = libraryProject(root, "channel", "voices-channel");
    const studioDir = libraryProject(root, "studio", "voices-studio");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);
    expect(cli(studioDir, "db", "migrate").code).toBe(0);

    const clip = makeClip(5);
    const added = cli(channelDir, "library", "voices", "add", "--display-name", "Narrator A", "--ref", clip, "--ref-text", "hello there", "--origin", "own", "--json");
    expect(added.code, added.err).toBe(0);
    const voice = JSON.parse(added.out);
    expect(voice.voice_id).toMatch(/^voice_/);
    expect(voice.revision).toBe(1);
    expect(voice.status).toBe("active");

    const listed = cli(channelDir, "library", "voices", "list", "--json");
    expect(listed.code, listed.err).toBe(0);
    const voices = JSON.parse(listed.out);
    expect(voices).toHaveLength(1);
    expect(voices[0].voice_id).toBe(voice.voice_id);

    // studio may never write voices/**
    const refused = cli(studioDir, "library", "voices", "add", "--display-name", "Nope", "--ref", clip, "--ref-text", "hi", "--origin", "own", "--json");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("CONFIG_INVALID");
  });

  it("bumps the revision when the same --voice-id is added again", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-voices-bump-"));
    const channelDir = libraryProject(root, "channel", "voices-bump");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);

    const first = cli(channelDir, "library", "voices", "add", "--display-name", "Narrator A", "--ref", makeClip(5), "--ref-text", "hello there", "--origin", "own", "--json");
    expect(first.code, first.err).toBe(0);
    const voiceId = JSON.parse(first.out).voice_id;

    const second = cli(channelDir, "library", "voices", "add", "--voice-id", voiceId, "--display-name", "Narrator A v2", "--ref", makeClip(5), "--ref-text", "hello again", "--origin", "own", "--json");
    expect(second.code, second.err).toBe(0);
    const bumped = JSON.parse(second.out);
    expect(bumped.voice_id).toBe(voiceId);
    expect(bumped.revision).toBe(2);
  });

  it("rejects a reference clip outside 3-30 seconds without touching the kho", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-voices-tooshort-"));
    const channelDir = libraryProject(root, "channel", "voices-tooshort");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);

    const refused = cli(channelDir, "library", "voices", "add", "--display-name", "Too short", "--ref", makeClip(1), "--ref-text", "hi", "--origin", "own", "--json");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("CONFIG_INVALID");

    const listed = cli(channelDir, "library", "voices", "list", "--json");
    expect(listed.code, listed.err).toBe(0);
    expect(JSON.parse(listed.out)).toEqual([]);
  });

  it("retires a voice on the channel role and refuses on the studio role", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-voices-retire-"));
    const channelDir = libraryProject(root, "channel", "voices-retire");
    const studioDir = libraryProject(root, "studio", "voices-retire-studio");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);
    expect(cli(studioDir, "db", "migrate").code).toBe(0);

    const added = cli(channelDir, "library", "voices", "add", "--display-name", "Narrator A", "--ref", makeClip(5), "--ref-text", "hello there", "--origin", "own", "--json");
    const voiceId = JSON.parse(added.out).voice_id;

    const refused = cli(studioDir, "library", "voices", "retire", voiceId, "--json");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("CONFIG_INVALID");

    const retired = cli(channelDir, "library", "voices", "retire", voiceId, "--json");
    expect(retired.code, retired.err).toBe(0);
    expect(JSON.parse(retired.out).status).toBe("retired");
  });

  it("`request create --voice tts` without an active voice fails, naming voice in the error", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-voices-request-"));
    const channelDir = libraryProject(root, "channel", "voices-request");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);

    const refused = cli(channelDir, "library", "request", "create", "--portfolio", "portfolio-main", "--topic", "t", "--voice", "tts", "--json");
    expect(refused.code).toBe(1);
    expect(refused.err.toLowerCase()).toContain("voice");
  });

  it("`request create --voice tts --voice-id` succeeds once the voice profile is active", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-voices-request-ok-"));
    const channelDir = libraryProject(root, "channel", "voices-request-ok");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);

    const added = cli(channelDir, "library", "voices", "add", "--display-name", "Narrator A", "--ref", makeClip(5), "--ref-text", "hello there", "--origin", "own", "--json");
    expect(added.code, added.err).toBe(0);
    const voiceId = JSON.parse(added.out).voice_id;

    const created = cli(channelDir, "library", "request", "create", "--portfolio", "portfolio-main", "--topic", "t", "--voice", "tts", "--voice-id", voiceId, "--json");
    expect(created.code, created.err).toBe(0);
    const request = JSON.parse(created.out);
    expect(request.voice_id).toBe(voiceId);

    const onDisk = JSON.parse(readFileSync(join(root, "requests", `${request.request_id}.json`), "utf8"));
    expect(onDisk.voice_id).toBe(voiceId);
  });
});
