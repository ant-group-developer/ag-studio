import type { Command } from "commander";
import { HarnessError } from "@harness/contracts";
import { buildContext, type AppContext } from "../composition.js";

export function projectDirOf(cmd: Command): string { return cmd.optsWithGlobals().project as string; }
export async function withContext<T>(cmd: Command, extra: Partial<Parameters<typeof buildContext>[0]>, fn: (ctx: AppContext) => Promise<T> | T): Promise<T> {
  const ctx = buildContext({ projectDir: projectDirOf(cmd), ...extra });
  try { return await fn(ctx); } finally { ctx.close(); }
}
export function print(json: boolean, data: unknown, text: () => string): void {
  process.stdout.write((json ? JSON.stringify(data) : text()) + "\n");
}

/** Every `channel …`/`publish …` command below that resolves a specific channel needs `app.channels` to have
 * loaded cleanly first -- a broken `channels/` directory is a contract problem for the command, exactly like
 * `publish-stage.ts`'s own `requireChannel` treats it for the built-in stage scripts. */
export function requireChannelsLoaded(app: AppContext): void {
  if (app.channelErrors.length > 0) {
    throw new HarnessError("CONFIG_INVALID", `channels/ in ${app.projectDir} failed to load: ${app.channelErrors.join("; ")}`, { errors: app.channelErrors });
  }
}
