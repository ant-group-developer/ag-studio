import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffprobeBeside, httpDownload } from "../src/index.js";

describe("httpDownload", () => {
  let base = "";
  const server = createServer((req, res) => {
    if (req.url === "/ok.mp4") { res.writeHead(200, { "content-type": "video/mp4" }); res.end("frames"); return; }
    res.writeHead(403); res.end("expired");
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("streams the body to the file", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "dl-")), "a.mp4");
    await httpDownload(`${base}/ok.mp4`, dest);
    expect(readFileSync(dest, "utf8")).toBe("frames");
  });

  it("an HTTP error throws with its status and leaves no file behind", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "dl-")), "b.mp4");
    await expect(httpDownload(`${base}/gone.mp4`, dest)).rejects.toThrow(/403/);
    expect(() => readFileSync(dest)).toThrow();
  });
});

describe("ffprobeBeside", () => {
  it("names ffprobe next to the ffmpeg given, keeping the extension", () => {
    expect(ffprobeBeside("C:\\tools\\ffmpeg\\bin\\ffmpeg.exe")).toBe("C:\\tools\\ffmpeg\\bin\\ffprobe.exe");
    expect(ffprobeBeside("/usr/bin/ffmpeg")).toBe("/usr/bin/ffprobe");
    expect(ffprobeBeside("ffmpeg")).toBe("ffprobe");
  });
});
