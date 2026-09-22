import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { VoiceProfile } from "@harness/contracts";
import { hasFfmpeg } from "../media.js";
import { addVoice, cli, declareChannel, freshLibraryWorld } from "../integration/library-helpers.js";

/** Request ids currently in the kho -- the only place `createRequest` writes (file + DB mirror in one call),
 * so an unchanged listing proves a rejected `request create` left nothing behind. */
function requestFiles(lib: string): string[] {
  return existsSync(join(lib, "requests")) ? readdirSync(join(lib, "requests")).sort() : [];
}

function createTtsRequest(channel: string, extra: string[]): { code: number | null; out: string; err: string } {
  return cli(channel, ["library", "request", "create", "--portfolio", "portfolio-channel", "--channel", "channel-one", "--topic", "Cần giọng đọc", "--voice", "tts", "--json", ...extra]);
}

/** Copies the committed `channel-one` config into the temp channel project (which `freshLibraryWorld` leaves
 * without a `channels/` directory), with `repo_dir` repointed at the real fixture so the rest of the config
 * still loads, and `voice.voice_id` set to `voiceId`. Task 10 (5B) moved the body into `declareChannel`,
 * which acceptance 51 needs for the `channel:<id>:brand` doctor row; this wrapper keeps the name that reads
 * right here. */
function declareChannelVoice(channelProject: string, voiceId: string): void {
  declareChannel(channelProject, { voiceId });
}

// Acceptance 44 (sub-project 5A §7, spec §3.2): a `voice: tts` request is refused the moment it is created if
// there is no ACTIVE voice profile to read it with -- not at `intake`, and not after a studio has already
// spent a GPU slot on it. Both refusals are checked against the kho, which must stay byte-identical.
describe.skipIf(!hasFfmpeg())("acceptance 44: a tts request without an active voice is refused at creation", () => {
  it("rejects --voice tts with no voice id, and with a retired one, writing nothing to the kho", () => {
    const world = freshLibraryWorld({ media: false });
    const before = requestFiles(world.lib);

    // (1) no --voice-id at all
    const noVoice = createTtsRequest(world.channel, []);
    expect(noVoice.code, `expected a non-zero exit, got ${noVoice.code}: ${noVoice.out}`).not.toBe(0);
    expect(requestFiles(world.lib)).toEqual(before);

    // (2) a voice id that exists but has been retired
    const voiceId = addVoice(world);
    const retired = cli(world.channel, ["library", "voices", "retire", voiceId, "--json"]);
    expect(retired.code, retired.err).toBe(0);
    expect((JSON.parse(retired.out) as VoiceProfile).status).toBe("retired");

    const withRetired = createTtsRequest(world.channel, ["--voice-id", voiceId]);
    expect(withRetired.code, `expected a non-zero exit, got ${withRetired.code}: ${withRetired.out}`).not.toBe(0);
    expect(requestFiles(world.lib)).toEqual(before);

    // (3) the channel declaring that retired profile as its own (`channel.yaml` `voice.voice_id`) does not
    // make it usable either: `library request create` resolves `--voice-id` only -- the channel-config
    // fallback belongs to the 3B `create-requests` stage (spec §3.2) -- and `harness doctor` says why, from
    // the same store mirror `requireActiveVoice` reads, before any request is attempted.
    declareChannelVoice(world.channel, voiceId);
    const stillRejected = createTtsRequest(world.channel, []);
    expect(stillRejected.code, `expected a non-zero exit, got ${stillRejected.code}: ${stillRejected.out}`).not.toBe(0);
    expect(requestFiles(world.lib)).toEqual(before);

    const doctorRows = JSON.parse(cli(world.channel, ["doctor", "--json"]).out) as { check: string; ok: boolean; detail: string }[];
    const voiceRow = doctorRows.find((r) => r.check === "channel:channel-one:voice");
    expect(voiceRow, JSON.stringify(doctorRows.map((r) => r.check))).toBeDefined();
    expect(voiceRow!.ok).toBe(false);
    expect(voiceRow!.detail).toContain("retired");

    // ...while `voice: none` on the very same channel still works, so the refusals above are about the voice
    // profile and not about the command being broken.
    const ok = cli(world.channel, ["library", "request", "create", "--portfolio", "portfolio-channel", "--channel", "channel-one", "--topic", "Không cần giọng", "--voice", "none", "--json"]);
    expect(ok.code, ok.err).toBe(0);
    expect(requestFiles(world.lib)).toHaveLength(before.length + 1);
  }, 180_000);
});
