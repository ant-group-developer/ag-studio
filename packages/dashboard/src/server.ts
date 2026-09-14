import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read-only local server for the file-based dashboard (design §6.2). Deliberately limited to `node:http`,
 * `node:fs`, `node:path` -- no dependency on `@harness/contracts` or `@harness/core`, so this package never
 * opens the SQLite state store: it can only ever serve what `packages/core`'s snapshot writer already put on
 * disk under `<dataRoot>/dashboard/`.
 */
export interface DashboardServerOptions {
  dataRoot: string;
  port: number;
  host?: string;
  /** Overrides the hub.html path this server serves -- tests use this; `harness dashboard serve` does not. */
  hubHtml?: string;
}

export interface DashboardServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

/** `join(dirname(fileURLToPath(import.meta.url)), "..", "public", "hub.html")`: correct whether this module
 * runs from `src/server.ts` (tests, via the `@harness/dashboard` vitest alias) or the built `dist/server.js`
 * -- `public/hub.html` is never copied into `dist/`, and both locations sit one directory above it. */
export function hubHtmlPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "public", "hub.html");
}

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJsonError(res: ServerResponse, status: number, error: string): void {
  send(res, status, JSON.stringify({ error }), { "Content-Type": "application/json; charset=utf-8" });
}

/** This server never accepts writes (design §6.2: no `POST`) -- anything but `GET`/`HEAD` is `405` with an
 * `Allow: GET` header, before any route matching happens. */
function methodNotAllowed(res: ServerResponse): void {
  send(res, 405, JSON.stringify({ error: "method not allowed" }), { "Content-Type": "application/json; charset=utf-8", Allow: "GET" });
}

function serveHub(res: ServerResponse, hubHtml: string): void {
  if (!existsSync(hubHtml)) { sendJsonError(res, 404, "hub.html not found"); return; }
  send(res, 200, readFileSync(hubHtml), { "Content-Type": "text/html; charset=utf-8" });
}

function serveSnapshot(res: ServerResponse, dataRoot: string): void {
  const file = join(dataRoot, "dashboard", "snapshot.json");
  if (!existsSync(file)) { sendJsonError(res, 404, "no snapshot"); return; }
  send(res, 200, readFileSync(file), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
}

/** `name` is already `path.basename`d by the caller: a segment like `../snapshot.json` collapses to
 * `snapshot.json`, which is looked up inside `thumbnails/` (where it does not exist) rather than escaping it. */
function serveThumbnail(res: ServerResponse, dataRoot: string, name: string): void {
  if (!name) { sendJsonError(res, 404, "not found"); return; }
  const file = join(dataRoot, "dashboard", "thumbnails", name);
  if (!existsSync(file)) { sendJsonError(res, 404, "not found"); return; }
  const mime = IMAGE_MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
  send(res, 200, readFileSync(file), { "Content-Type": mime });
}

function handleRequest(req: IncomingMessage, res: ServerResponse, o: DashboardServerOptions, hubHtml: string): void {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") { methodNotAllowed(res); return; }

  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (path === "/" || path === "/hub") { serveHub(res, hubHtml); return; }
  if (path === "/api/snapshot") { serveSnapshot(res, o.dataRoot); return; }
  if (path.startsWith("/thumbnails/")) { serveThumbnail(res, o.dataRoot, basename(path.slice("/thumbnails/".length))); return; }
  sendJsonError(res, 404, "not found");
}

export function startDashboard(o: DashboardServerOptions): Promise<DashboardServerHandle> {
  const host = o.host ?? "127.0.0.1";
  const hubHtml = o.hubHtml ?? hubHtmlPath();

  const server: Server = createServer((req, res) => {
    try {
      handleRequest(req, res, o, hubHtml);
    } catch (e) {
      sendJsonError(res, 500, e instanceof Error ? e.message : String(e));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : o.port;
      resolve({
        port,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((res, rej) => {
            server.closeAllConnections?.();
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
