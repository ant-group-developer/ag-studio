import { HarnessError } from "@harness/contracts";
import type { AppContext } from "../composition.js";

/** Every library command needs `app.library`; a project.yaml without it is a contract problem for the command. */
export function requireLibrary(app: AppContext): NonNullable<AppContext["library"]> {
  if (!app.library) throw new HarnessError("CONFIG_INVALID", `project.yaml in ${app.projectDir} has no library configured`, { projectDir: app.projectDir });
  return app.library;
}
