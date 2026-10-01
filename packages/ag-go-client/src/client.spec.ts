import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgGoClient } from "./client.js";
import { AgGoClientError } from "./error.js";
import type {
  GetFoldersResponse,
  FootageVideoResponse,
  SegmentMediaResponse,
  ResolveSegmentsResponse,
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

describe("AgGoClient - getSegmentMedia", () => {
  it("returns segment media on success", async () => {
    const payload: SegmentMediaResponse = {
      segmentId: "seg-1",
      assetId: "asset-1",
      keyframeUrls: ["https://cdn.example.com/kf1.jpg"],
      previewUrl: "https://cdn.example.com/preview.mp4",
      previewWidth: 1280,
      startMs: 0,
      endMs: 5000,
      durationMs: 5000,
    };
    const mockFetch = makeMockFetch(200, payload);
    const client = makeClient(mockFetch);

    const result = await client.getSegmentMedia(ACT_AS_USER, "seg-1");

    expect(result.segmentId).toBe("seg-1");
    expect(result.keyframeUrls).toHaveLength(1);
    expect(result.previewUrl).toBe("https://cdn.example.com/preview.mp4");
  });

  it("URL-encodes the segment ID", async () => {
    const mockFetch = makeMockFetch(200, {
      segmentId: "seg/with/slashes",
      keyframeUrls: [],
      previewUrl: null,
      startMs: 0,
      endMs: 1000,
    });
    const client = makeClient(mockFetch);

    await client.getSegmentMedia(ACT_AS_USER, "seg/with/slashes");

    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/footage/segments/seg%2Fwith%2Fslashes/media`,
      expect.anything()
    );
  });
});

describe("AgGoClient - resolveSegments", () => {
  it("returns resolved items on success", async () => {
    const resolvedItem = {
      segmentId: "seg-1",
      assetId: "asset-1",
      startMs: 0,
      endMs: 5000,
      url: "https://cdn.example.com/seg-1.mp4",
      sourceKind: "original" as const,
      watermarked: false,
      contentType: "video/mp4",
      sizeBytes: 1048576,
      cacheKey: "ck-abc",
      expiresAt: "2026-01-01T00:00:00Z",
    };
    const payload: ResolveSegmentsResponse = { items: [resolvedItem] };
    const mockFetch = makeMockFetch(200, payload);
    const client = makeClient(mockFetch);

    const result = await client.resolveSegments(ACT_AS_USER, {
      segmentIds: ["seg-1"],
      purpose: "final",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.segmentId).toBe("seg-1");
    expect(result.items[0]?.sourceKind).toBe("original");
    expect(result.items[0]?.watermarked).toBe(false);
  });

  it("throws AgGoClientError with status on non-2xx", async () => {
    const mockFetch = makeMockFetch(500, { error: "Internal Server Error" });
    const client = makeClient(mockFetch);

    let caught: AgGoClientError | undefined;
    try {
      await client.resolveSegments(ACT_AS_USER, {
        segmentIds: ["seg-1"],
        purpose: "preview",
      });
    } catch (err) {
      caught = err as AgGoClientError;
    }

    expect(caught).toBeInstanceOf(AgGoClientError);
    expect(caught?.status).toBe(500);
  });
});
