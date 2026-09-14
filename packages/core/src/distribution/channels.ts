import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { ChannelConfigSchema, HarnessError, type Checksum, type ChannelConfig, type ProjectConfig, type PublisherChannel } from "@harness/contracts";
import { canonicalDigest } from "../artifacts/checksum.js";

export const CHANNELS_DIR = "channels";

export interface LoadedChannel {
  config: ChannelConfig;
  dir: string;
  /** sha256 canonical digest of the parsed `channel.yaml`. */
  config_revision: Checksum;
}

/** posix path: backslashes to forward slashes. */
export function posixPath(p: string): string {
  return p.split("\\").join("/");
}

/**
 * Reads `<projectDir>/channels/<id>/channel.yaml` for every subdirectory of `channels/`; `[]` when the
 * directory does not exist. A yaml parse error or a schema-validation failure throws `CONFIG_INVALID` with
 * the file's path in `details.path`; a `channel_id` that does not match its own directory name, or a
 * `portfolio_id` absent from `project.portfolios`, also throws `CONFIG_INVALID`.
 */
export function loadChannels(projectDir: string, project: Pick<ProjectConfig, "portfolios">): LoadedChannel[] {
  const channelsDir = join(projectDir, CHANNELS_DIR);
  if (!existsSync(channelsDir)) return [];
  const portfolioIds = new Set(project.portfolios.map((p) => p.portfolio_id));
  const dirNames = readdirSync(channelsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const channels: LoadedChannel[] = [];
  for (const dirName of dirNames) {
    const dir = join(channelsDir, dirName);
    const file = join(dir, "channel.yaml");
    let raw: unknown;
    try {
      raw = parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new HarnessError("CONFIG_INVALID", `${file} invalid: ${(e as Error).message}`, { path: file });
    }
    const parsed = ChannelConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HarnessError("CONFIG_INVALID", `${file} invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, { path: file, issues: parsed.error.issues });
    }
    const config = parsed.data;
    if (config.channel_id !== dirName) {
      throw new HarnessError("CONFIG_INVALID", `${file}: channel_id "${config.channel_id}" does not match directory "${dirName}"`, { path: file, channel_id: config.channel_id, dir: dirName });
    }
    if (!portfolioIds.has(config.portfolio_id)) {
      throw new HarnessError("CONFIG_INVALID", `${file}: portfolio_id "${config.portfolio_id}" is not in project.portfolios`, { path: file, portfolio_id: config.portfolio_id });
    }
    channels.push({ config, dir, config_revision: canonicalDigest(config) });
  }
  return channels;
}

export class ChannelRegistry {
  private readonly byId: Map<string, LoadedChannel>;

  constructor(channels: LoadedChannel[]) {
    this.byId = new Map(channels.map((c) => [c.config.channel_id, c]));
  }

  list(): LoadedChannel[] {
    return [...this.byId.values()];
  }

  get(id: string): LoadedChannel {
    const channel = this.byId.get(id);
    if (!channel) throw new HarnessError("NOT_FOUND", `channel not found: ${id}`, { channel_id: id });
    return channel;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  toPublisherChannel(id: string): PublisherChannel {
    const channel = this.get(id);
    return {
      channel_id: channel.config.channel_id,
      repo_dir: posixPath(resolve(channel.config.repo_dir)),
      legacy_project_id: channel.config.legacy_project_id,
      expected_channel_id: channel.config.youtube.expected_channel_id,
    };
  }
}
