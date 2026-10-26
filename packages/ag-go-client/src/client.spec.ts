import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgGoClient } from "./client.js";
import { AgGoClientError } from "./error.js";
import type {
  GetFoldersResponse,
  FootageVideoResponse,
} from "./types.js";

const SERVICE_KEY = "test-service-key";
const ACT_AS_USER = "user-123";
const BASE_URL = "https://api.example.com";

function makeMockFetch(status: number, body: unknown): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

function makeClient(mockFetch: typeof globalThis.fetch): AgGoClient {
  return new AgGoClient({
    baseUrl: BASE_URL,
    serviceKey: SERVICE_KEY,
    fetch: mockFetch,
  });
}

describe("AgGoClient - getFolders", () => {
  it("returns folders on success", async () => {
    const payload: GetFoldersResponse = {
      folders: [
        {
          id: "f1",
          parentId: null,
          name: "Root",
          path: "/root",
          analyzedVideos: 10,
          usableVideos: 8,
        },
      ],
    };
    const mockFetch = makeMockFetch(200, payload);
    const client = makeClient(mockFetch);

    const result = await client.getFolders(ACT_AS_USER);
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0]?.id).toBe("f1");
  });

  it("throws AgGoClientError on non-2xx", async () => {
    const mockFetch = makeMockFetch(403, { error: "Forbidden" });
    const client = makeClient(mockFetch);

    await expect(client.getFolders(ACT_AS_USER)).rejects.toBeInstanceOf(AgGoClientError);
    await expect(client.getFolders(ACT_AS_USER)).rejects.toMatchObject({ status: 403 });
  });

  it("unwraps ag-go-api's { data, requestId, success, error, timestamp } envelope", async () => {
    const folders = [{ id: "f-1", name: "Test 1.1", parentId: null, usableVideos: 18 }];
    const mockFetch = makeMockFetch(200, { data: { folders }, requestId: "req-1", success: true, error: null, timestamp: "2026-09-30T00:00:00Z" });
    const client = makeClient(mockFetch);

    await expect(client.getFolders(ACT_AS_USER)).resolves.toEqual({ folders });
  });

  it("sends X-Service-Key and X-Act-As-User headers", async () => {
    const mockFetch = makeMockFetch(200, { folders: [] });
    const client = makeClient(mockFetch);

    await client.getFolders(ACT_AS_USER);

    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/footage/folders`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Service-Key": SERVICE_KEY,
          "X-Act-As-User": ACT_AS_USER,
        }),
      })
    );
  });
});

describe("AgGoClient - getCatalog", () => {
  it("returns footage video items on success (v3 whole-asset)", async () => {
    const item = {
      assetId: "asset-1",
      name: "Phở bò Hà Nội",
      durationMs: 8000,
      orientation: "landscape",
      titleVi: "Phở bò buổi sáng",
      summaryVi: "Cảnh phở bò tại Hà Nội",
      tags: ["pho", "hanoi"],
      topics: ["ẩm thực"],
      quality: 4,
      usable: true,
      approved: false,
    };
    const payload: FootageVideoResponse = { items: [item], nextCursor: null };
    const mockFetch = makeMockFetch(200, payload);
    const client = makeClient(mockFetch);

    const result = await client.getCatalog(ACT_AS_USER, {
      folderIds: ["f1"],
      limit: 10,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.assetId).toBe("asset-1");
    expect(result.items[0]?.durationMs).toBe(8000);
    expect(result.nextCursor).toBeNull();
  });

  it("sends request body correctly", async () => {
    const mockFetch = makeMockFetch(200, { items: [], nextCursor: null });
    const client = makeClient(mockFetch);

    await client.getCatalog(ACT_AS_USER, {
      folderIds: ["f1", "f2"],
      usableOnly: true,
      minQuality: 4,
      limit: 20,
      cursor: "abc123",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/footage/catalog`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          folderIds: ["f1", "f2"],
          usableOnly: true,
      minQuality: 4,
          limit: 20,
          cursor: "abc123",
        }),
      })
    );
  });
});

describe("AgGoClient - searchFootage", () => {
  it("GETs /footage/search with comma-joined project ids, acting as the user", async () => {
    const payload = { items: [{ assetId: "a1", name: "Hoa Lư 03.mp4", durationMs: 61_000, score: 1 }], nextCursor: null, total: 1 };
    const mockFetch = makeMockFetch(200, payload);
    const client = makeClient(mockFetch);
    const result = await client.searchFootage(ACT_AS_USER, { projectIds: ["p1", "p2"], q: "chùa", limit: 50 });
    expect(result).toEqual(payload);
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/footage/search?projectIds=p1%2Cp2&q=ch%C3%B9a&limit=50`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["X-Act-As-User"]).toBe(ACT_AS_USER);
  });
});

describe("AgGoClient - resolveAssets prefer", () => {
  it("sends the preferred rendition with the body (older ag-go ignores it)", async () => {
    const mockFetch = makeMockFetch(200, { items: [], missing: ["a1"] });
    const client = makeClient(mockFetch);
    await client.resolveAssets(ACT_AS_USER, { assetIds: ["a1"], purpose: "preview", prefer: { short_edge: 480, clean: true } });
    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ assetIds: ["a1"], purpose: "preview", prefer: { short_edge: 480, clean: true } });
  });
});

describe("AgGoClient - preps", () => {
  const item = {
    assetId: "a1", state: "running", phase: "transcribing", progress: 0.4, error: null, prep: null,
  };

  it("reads the preps of footage as the user", async () => {
    const mockFetch = makeMockFetch(200, { success: true, requestId: "r", data: { items: [item] }, error: null, timestamp: "t" });
    const client = makeClient(mockFetch);
    await expect(client.getAssetPreps(ACT_AS_USER, ["a1"])).resolves.toEqual({ items: [item] });
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/footage/assets/prep`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ assetIds: ["a1"] });
    expect((init.headers as Record<string, string>)["X-Act-As-User"]).toBe(ACT_AS_USER);
  });

  it("asks ag-go to run them", async () => {
    const mockFetch = makeMockFetch(200, { items: [item] });
    const client = makeClient(mockFetch);
    await client.runAssetPreps(ACT_AS_USER, ["a1", "a2"]);
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/footage/assets/prep/run`);
    expect(JSON.parse(init.body as string)).toEqual({ assetIds: ["a1", "a2"] });
  });
});

describe("AgGoClient - trusted mode for Studio", () => {
  const call = (f: typeof globalThis.fetch) => (f as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];

  it("resolves videos of the project's ag-go projects with the service key alone", async () => {
    const mockFetch = makeMockFetch(200, { items: [], missing: ["a2"] });
    const client = makeClient(mockFetch);
    await expect(client.studioResolveAssets({ projectIds: ["p1"], assetIds: ["a2"], purpose: "final" })).resolves.toEqual({ items: [], missing: ["a2"] });
    const [url, init] = call(mockFetch);
    expect(url).toBe(`${BASE_URL}/footage/studio/assets/resolve`);
    expect(JSON.parse(init.body as string)).toEqual({ projectIds: ["p1"], assetIds: ["a2"], purpose: "final" });
    expect(init.headers).not.toHaveProperty("X-Act-As-User");
  });

  it("reads and runs preps within the projects, saying who asked", async () => {
    const read = makeMockFetch(200, { items: [] });
    await makeClient(read).studioAssetPreps(["p1"], ["a1"]);
    expect(call(read)[0]).toBe(`${BASE_URL}/footage/studio/assets/prep`);
    expect(JSON.parse(call(read)[1].body as string)).toEqual({ projectIds: ["p1"], assetIds: ["a1"] });
    const run = makeMockFetch(200, { items: [] });
    await makeClient(run).studioRunAssetPreps(["p1"], ["a1"], "auth0|u");
    expect(call(run)[0]).toBe(`${BASE_URL}/footage/studio/assets/prep/run`);
    expect(JSON.parse(call(run)[1].body as string)).toEqual({ projectIds: ["p1"], assetIds: ["a1"], requestedBy: "auth0|u" });
    expect(call(run)[1].headers).not.toHaveProperty("X-Act-As-User");
  });
});

describe("AgGoClient - sendUsageEvents", () => {
  it("POSTs the events with the service key alone (no act-as user)", async () => {
    const mockFetch = makeMockFetch(200, { success: true, requestId: "r", data: { accepted: 1, duplicates: 0 }, error: null, timestamp: "t" });
    const client = makeClient(mockFetch);
    const event = {
      eventKey: "src:s1:added", kind: "source_added" as const, occurredAt: "2026-10-13T00:00:00.000Z", assetId: "a1", agGoProjectId: null,
      studioProjectId: "p1", studioProjectName: "Du lịch", studioVideoId: null, studioVideoTitle: null, studioUserId: "auth0|u",
    };
    await expect(client.sendUsageEvents([event])).resolves.toEqual({ accepted: 1, duplicates: 0 });
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/usage/studio-events`);
    expect(JSON.parse(init.body as string)).toEqual({ events: [event] });
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Service-Key"]).toBe(SERVICE_KEY);
    expect(headers).not.toHaveProperty("X-Act-As-User");
  });

  it("throws the status ag-go answered (a key without usage:write)", async () => {
    const client = makeClient(makeMockFetch(403, { message: "Forbidden" }));
    await expect(client.sendUsageEvents([])).rejects.toMatchObject({ status: 403 });
  });
});
