import { spawnSync } from "node:child_process";

/**
 * Stops a process and everything it started (the agent CLI and its MCP server): `taskkill /T /F` on Windows, where
 * `child.kill()` leaves grandchildren running; elsewhere the process group (spawned `detached`), then the process.
 */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { /* not a group leader */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/** Whether a process is still running. */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
