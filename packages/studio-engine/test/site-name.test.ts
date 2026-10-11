import { describe, expect, it } from "vitest";
import { createSiteNameCache, DEFAULT_SITE_NAME, fetchAgGoSiteName, withSiteName } from "../src/index.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ag-go site name", () => {
  it("reads siteName from GET /settings/public, with or without ag-go's envelope", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return json({ success: true, requestId: "r1", data: { siteName: "  Kho Footage ", logoUrl: null }, timestamp: "t" });
    }) as unknown as typeof fetch;
    expect(await fetchAgGoSiteName("https://go.example/api/", fetchImpl)).toBe("Kho Footage");
    expect(urls).toEqual(["https://go.example/api/settings/public"]);
    const plain = (async () => json({ siteName: "Go" })) as unknown as typeof fetch;
    expect(await fetchAgGoSiteName("https://go.example/api", plain)).toBe("Go");
  });

  it("refuses a missing, blank, multi-line or overlong name, and a failed answer", async () => {
    for (const body of [{}, { siteName: "" }, { siteName: "   " }, { siteName: "a\nb" }, { siteName: "x".repeat(61) }, { siteName: 7 }]) {
      await expect(fetchAgGoSiteName("https://go", (async () => json(body)) as unknown as typeof fetch)).rejects.toThrow();
    }
    await expect(fetchAgGoSiteName("https://go", (async () => json({}, 503)) as unknown as typeof fetch)).rejects.toThrow(/503/);
  });

  it("answers at once: the default until the first load, then the loaded name; refreshes in the background when stale", async () => {
    let t = 0;
    let calls = 0;
    const cache = createSiteNameCache({ load: async () => { calls++; return "Kho A"; }, ttlMs: 1000, now: () => t });
    expect(cache.current()).toBe(DEFAULT_SITE_NAME); // starts the first load
    expect(await cache.refresh()).toBe("Kho A"); // joins it
    expect(cache.current()).toBe("Kho A");
    expect(calls).toBe(1);
    t = 2000;
    expect(cache.current()).toBe("Kho A");
    await cache.refresh();
    expect(calls).toBe(2);
  });

  it("a load that never succeeded leaves the default", async () => {
    const cache = createSiteNameCache({ load: async () => { throw new Error("down"); } });
    expect(await cache.refresh()).toBe(DEFAULT_SITE_NAME);
    expect(cache.current()).toBe(DEFAULT_SITE_NAME);
  });

  it("shares one load between callers and keeps the last good name when a load fails", async () => {
    let t = 0;
    let calls = 0;
    let fail = false;
    const cache = createSiteNameCache({
      load: async () => { calls++; if (fail) throw new Error("down"); return `Kho ${calls}`; },
      ttlMs: 1000,
      now: () => t,
    });
    const [a, b] = await Promise.all([cache.refresh(), cache.refresh()]);
    expect([a, b, calls]).toEqual(["Kho 1", "Kho 1", 1]);
    t = 500;
    expect(cache.current()).toBe("Kho 1");
    expect(calls).toBe(1); // still fresh
    t = 1500;
    fail = true;
    expect(cache.current()).toBe("Kho 1"); // stale: starts a reload, answers with what it has
    expect(await cache.refresh()).toBe("Kho 1");
    expect(cache.current()).toBe("Kho 1");
  });

  it("fills {{site}} in text", () => {
    expect(withSiteName("Video từ {{site}}; mở {{site}}", "Kho")).toBe("Video từ Kho; mở Kho");
  });
});
