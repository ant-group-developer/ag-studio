import type { Command } from "commander";
import { registerPublishStage } from "./publish-stage.js";

/** `harness publish …`: only the built-in stage subcommands for now (Task 8). Task 9 adds the human-facing
 * subcommands (`publish status`, `publish reconcile`, …) under the same `publish` command. */
export function registerPublish(program: Command): void {
  const publish = program.command("publish").description("channel-publish commands");
  registerPublishStage(publish);
}
