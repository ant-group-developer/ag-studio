/**
 * scripts/local-stack.mjs: which processes the local stack starts, from where, in what order, and what "up" means
 * for each. Pure planning only — nothing here spawns a process or opens a port.
 */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { planServices, selectServices } from "../../scripts/local-stack-lib.mjs";

type Service = { name: string; cwd: string; command: string; args: string[]; env: Record<string, string>; health: string | null; optional: boolean; log: string };

const REPO = resolve("E:/CODE/ag-studio");

describe("planServices", () => {
  const services = planServices({ repoRoot: REPO, env: {} }) as Service[];
  const byName = Object.fromEntries(services.map((s) => [s.name, s]));

  it("starts the dependencies before Studio, and the web last", () => {
    expect(services.map((s) => s.name)).toEqual([
      "go-api", "go-worker", "farm-api", "studio-api", "studio-worker", "render-worker", "scan-worker", "studio-web", "farm-web", "go-web",
    ]);
  });

  it("uses the sibling checkouts and E:/ag-local by default", () => {
    expect(byName["go-api"]!.cwd).toBe(resolve(REPO, "../ag-go-v2/ag-go-api"));
    expect(byName["farm-api"]!.cwd).toBe(resolve(REPO, "../ag-farm/apps/api"));
    expect(byName["render-worker"]!.cwd).toBe(resolve(REPO, "../ag-render-worker"));
    expect(byName["render-worker"]!.args).toEqual(["dist/main.js", "--config", "E:/ag-local/dev-run/render.yaml"]);
    expect(byName["scan-worker"]!.args).toEqual(["dist/main.js", "--config", "E:/ag-local/dev-run/scan.yaml"]);
    expect(byName["studio-api"]!.log).toBe(join("E:/ag-local/dev-run", "studio-api.log"));
  });

  it("lets every location be overridden by env", () => {
    const s = planServices({ repoRoot: REPO, env: { AG_GO_DIR: "D:/go", AG_FARM_DIR: "D:/farm", AG_LOCAL_DIR: "D:/local", AG_RENDER_WORKER_DIR: "D:/rw" } }) as Service[];
    const n = Object.fromEntries(s.map((x) => [x.name, x]));
    expect(n["go-api"]!.cwd).toBe(resolve("D:/go/ag-go-api"));
    expect(n["farm-web"]!.cwd).toBe(resolve("D:/farm/apps/web"));
    expect(n["render-worker"]!.cwd).toBe(resolve("D:/rw"));
    expect(n["render-worker"]!.args).toContain("D:/local/dev-run/render.yaml");
  });

  it("runs the Studio API on 3101 and the Studio web on 3100, where Auth0 and ag-go CORS expect it", () => {
    expect(byName["studio-api"]!.env).toEqual({ PORT: "3101" });
    expect(byName["studio-api"]!.health).toBe("http://localhost:3101/api/health");
    expect(byName["studio-web"]!.args).toEqual(expect.arrayContaining(["--port", "3100", "--strictPort"]));
    expect(byName["studio-worker"]!.args).toEqual(["--env-file=apps/api/.env", "apps/worker/dist/main.js"]);
    expect(byName["studio-worker"]!.cwd).toBe(REPO);
  });

  it("checks health by URL where there is one, by process otherwise", () => {
    expect(byName["go-api"]!.health).toBe("http://localhost:3738/api/health");
    expect(byName["farm-api"]!.health).toBe("http://localhost:3010/health");
    expect(byName["studio-worker"]!.health).toBeNull();
    expect(byName["render-worker"]!.health).toBeNull();
  });
});

describe("selectServices", () => {
  const services = planServices({ repoRoot: REPO, env: {} }) as Service[];

  it("leaves the optional ones (ag-go worker, farm web, ag-go web) out by default", () => {
    expect((selectServices(services, []) as Service[]).map((s) => s.name)).toEqual([
      "go-api", "farm-api", "studio-api", "studio-worker", "render-worker", "scan-worker", "studio-web",
    ]);
  });

  it("takes everything with 'all', or exactly the names given, in stack order", () => {
    expect(selectServices(services, ["all"])).toHaveLength(10);
    expect((selectServices(services, ["studio-web", "go-api"]) as Service[]).map((s) => s.name)).toEqual(["go-api", "studio-web"]);
  });

  it("refuses an unknown name", () => {
    expect(() => selectServices(services, ["studio"])).toThrow(/unknown service "studio"/);
  });
});
