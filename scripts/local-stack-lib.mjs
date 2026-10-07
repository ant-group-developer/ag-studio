// Planning half of scripts/local-stack.mjs: what to run, from where, and how to tell it is up. No side effects.
import { join, resolve } from "node:path";

/**
 * Every process of the local stack (docs/runbooks/studio-local.md), in start order. The infrastructure containers
 * (Postgres, Redis, MariaDB, RabbitMQ, Account API) are not here: they run in Docker Desktop and are left alone.
 * Locations default to checkouts next to this repo and `E:/ag-local`; override with AG_GO_DIR, AG_FARM_DIR,
 * AG_RENDER_WORKER_DIR, AG_SCAN_WORKER_DIR, AG_LOCAL_DIR.
 */
export function planServices({ repoRoot, env }) {
  const dir = (key, fallback) => resolve(env[key] ?? resolve(repoRoot, fallback));
  const goDir = dir("AG_GO_DIR", "../ag-go-v2");
  const farmDir = dir("AG_FARM_DIR", "../ag-farm");
  const localDir = env.AG_LOCAL_DIR ?? "E:/ag-local";
  const logDir = `${localDir}/dev-run`;
  const svc = (name, cwd, command, args, extra = {}) => ({
    name, cwd, command, args, env: extra.env ?? {}, health: extra.health ?? null, optional: extra.optional ?? false,
    log: join(logDir, `${name}.log`),
  });
  return [
    svc("go-api", join(goDir, "ag-go-api"), "yarn", ["start:dev"], { health: "http://localhost:3738/api/health" }),
    svc("go-worker", join(goDir, "ag-go-api"), "yarn", ["worker"], { optional: true }),
    svc("farm-api", join(farmDir, "apps/api"), "node", ["dist/main.js"], { health: "http://localhost:3010/health" }),
    svc("studio-api", join(repoRoot, "apps/api"), "node", ["dist/main.js"], { env: { PORT: "3101" }, health: "http://localhost:3101/api/health" }),
    svc("studio-worker", repoRoot, "node", ["--env-file=apps/api/.env", "apps/worker/dist/main.js"]),
    svc("render-worker", dir("AG_RENDER_WORKER_DIR", "../ag-render-worker"), "node", ["dist/main.js", "--config", `${logDir}/render.yaml`]),
    svc("scan-worker", dir("AG_SCAN_WORKER_DIR", "../ag-scan-worker"), "node", ["dist/main.js", "--config", `${logDir}/scan.yaml`]),
    svc("studio-web", join(repoRoot, "apps/web"), "corepack", ["pnpm", "exec", "vite", "--port", "3100", "--strictPort"], { health: "http://localhost:3100/" }),
    svc("farm-web", join(farmDir, "apps/web"), "yarn", ["dev", "--port", "3011", "--strictPort"], { optional: true, health: "http://localhost:3011/" }),
    svc("go-web", join(goDir, "ag-go-web"), "yarn", ["dev"], { optional: true, health: "http://localhost:5173/" }),
  ];
}

/** No names: every non-optional service. "all": every service. Otherwise exactly the named ones, in stack order. */
export function selectServices(services, names) {
  if (names.length === 0) return services.filter((s) => !s.optional);
  if (names.includes("all")) return services;
  for (const n of names) {
    if (!services.some((s) => s.name === n)) {
      throw new Error(`unknown service "${n}" (known: ${services.map((s) => s.name).join(", ")}, all)`);
    }
  }
  return services.filter((s) => names.includes(s.name));
}

/** Interfaces of a virtual switch (WSL, Hyper-V, Docker, VMs, VPNs): the farm does not reach this machine there. */
const VIRTUAL_NIC = /vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware|Loopback|Tailscale|ZeroTier/i;

/**
 * The LAN IPv4 address other machines (render workers on the farm) reach this one on, from `os.networkInterfaces()`:
 * not loopback, not link-local (169.254), not a virtual switch. `null` when there is none.
 */
export function lanAddress(interfaces) {
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (VIRTUAL_NIC.test(name)) continue;
    for (const a of addrs ?? []) {
      if ((a.family === "IPv4" || a.family === 4) && !a.internal && !a.address.startsWith("169.254.")) return a.address;
    }
  }
  return null;
}

/**
 * The farm signs each job's downloads at its owner's `sign_url` (table `farm_owners` of ag-farm). Run directly on this
 * machine, those are the Studio API (3101) and the ag-go API (3738) at the LAN address: a changed address (DHCP) makes
 * every render fail at its first download with `fetch failed`. Returns the rows to change.
 */
export function signUrlFixes(owners, ip) {
  const want = { studio: `http://${ip}:3101/api/farm/sign`, "ag-go": `http://${ip}:3738/api/analysis/farm/sign` };
  return owners.filter((o) => want[o.id] && o.sign_url !== want[o.id]).map((o) => ({ id: o.id, from: o.sign_url, to: want[o.id] }));
}
