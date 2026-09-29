import type { Command } from "commander";
import { buildContext, type AppContext } from "../composition.js";

export function projectDirOf(cmd: Command): string { return cmd.optsWithGlobals().project as string; }
export async function withContext<T>(cmd: Command, extra: Partial<Parameters<typeof buildContext>[0]>, fn: (ctx: AppContext) => Promise<T> | T): Promise<T> {
  const ctx = buildContext({ projectDir: projectDirOf(cmd), ...extra });
  try { return await fn(ctx); } finally { ctx.close(); }
}
export function print(json: boolean, data: unknown, text: () => string): void {
  process.stdout.write((json ? JSON.stringify(data) : text()) + "\n");
}
