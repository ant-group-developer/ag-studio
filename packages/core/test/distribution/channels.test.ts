import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError } from "@harness/contracts";
import { ChannelRegistry, loadChannels } from "../../src/index.js";

const PROJECT = { portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }] };

function channelYaml(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    channel_id: "a",
    portfolio_id: "portfolio-main",
    repo_dir: "D:/legacy-channel-a",
    ...overrides,
  };
  return [
    "schema_version: harness.channel-config/v1",
    `channel_id: ${fields.channel_id}`,
    "display_name: Channel A",
    `portfolio_id: ${fields.portfolio_id}`,
    `repo_dir: ${fields.repo_dir}`,
    "youtube:",
    "  expected_channel_id: UCxxxxxxxxxxxxxxxxxxxxxx",
    "  account_email_ref: secret://youtube/channel-a-email",
    "publication:",
    "  timezone: America/New_York",
    '  publish_times: ["13:00"]',
    "",
  ].join("\n");
}

function writeChannel(projectDir: string, dirName: string, yaml: string): void {
  const dir = join(projectDir, "channels", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "channel.yaml"), yaml);
}

function tempProject(prefix = "channels-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("loadChannels", () => {
  it("returns [] when the project has no channels/ directory", () => {
    const dir = tempProject("no-channels-");
    expect(loadChannels(dir, PROJECT)).toEqual([]);
  });

  it("loads a valid channel and computes config_revision", () => {
    const dir = tempProject();
    writeChannel(dir, "a", channelYaml());
    const channels = loadChannels(dir, PROJECT);
    expect(channels).toHaveLength(1);
    expect(channels[0]?.config.channel_id).toBe("a");
    expect(channels[0]?.config_revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(channels[0]?.dir).toBe(join(dir, "channels", "a"));
  });

  it("throws CONFIG_INVALID naming the directory when channel_id does not match the directory name", () => {
    const dir = tempProject();
    writeChannel(dir, "a", channelYaml());
    writeChannel(dir, "b", channelYaml({ channel_id: "c" }));
    const attempt = () => loadChannels(dir, PROJECT);
    expect(attempt).toThrow();
    try {
      attempt();
    } catch (e) {
      expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true);
      const message = (e as Error).message;
      expect(message).toContain("b");
    }
  });

  it("throws CONFIG_INVALID when portfolio_id is not in project.portfolios", () => {
    const dir = tempProject();
    writeChannel(dir, "a", channelYaml({ portfolio_id: "no-such-portfolio" }));
    const attempt = () => loadChannels(dir, PROJECT);
    expect(attempt).toThrow();
    try {
      attempt();
    } catch (e) {
      expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true);
    }
  });

  it("throws CONFIG_INVALID with the file path when channel.yaml fails schema validation", () => {
    const dir = tempProject();
    writeChannel(dir, "a", "schema_version: harness.channel-config/v1\nchannel_id: a\n");
    const attempt = () => loadChannels(dir, PROJECT);
    try {
      attempt();
      throw new Error("expected throw");
    } catch (e) {
      expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true);
      expect((e as { details?: { path?: string } }).details?.path).toContain("channel.yaml");
    }
  });
});

describe("ChannelRegistry", () => {
  it("list/get/has reflect the loaded channels", () => {
    const dir = tempProject();
    writeChannel(dir, "a", channelYaml());
    const registry = new ChannelRegistry(loadChannels(dir, PROJECT));
    expect(registry.has("a")).toBe(true);
    expect(registry.has("missing")).toBe(false);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("a").config.channel_id).toBe("a");
  });

  it("get throws NOT_FOUND for an unknown channel", () => {
    const registry = new ChannelRegistry([]);
    const attempt = () => registry.get("nope");
    expect(attempt).toThrow();
    try {
      attempt();
    } catch (e) {
      expect(isHarnessError(e, "NOT_FOUND")).toBe(true);
    }
  });

  it("toPublisherChannel resolves repo_dir to an absolute, forward-slashed path", () => {
    const dir = tempProject();
    writeChannel(dir, "a", channelYaml({ repo_dir: "D:/legacy-channel-a" }));
    const registry = new ChannelRegistry(loadChannels(dir, PROJECT));
    const pub = registry.toPublisherChannel("a");
    expect(pub).toEqual({
      channel_id: "a",
      repo_dir: "D:/legacy-channel-a",
      legacy_project_id: "project-01",
      expected_channel_id: "UCxxxxxxxxxxxxxxxxxxxxxx",
    });
    expect(pub.repo_dir).not.toContain("\\");
  });
});
