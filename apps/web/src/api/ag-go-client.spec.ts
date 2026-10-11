import { describe, expect, it, vi } from "vitest";
import { unwrapAgGoResponse } from "./ag-go-client";

describe("unwrapAgGoResponse", () => {
  it("returns data from ag-go-api's envelope and leaves other bodies alone", () => {
    const folders = [{ id: "f-1", name: "Test 1.1", parentId: null, usableVideos: 18 }];
    expect(unwrapAgGoResponse({ data: { folders }, requestId: "r", success: true, error: null, timestamp: "t" })).toEqual({ folders });
    expect(unwrapAgGoResponse({ folders })).toEqual({ folders });
    expect(unwrapAgGoResponse([1, 2])).toEqual([1, 2]);
  });
});

describe("ag-go project filters", () => {
  it("asks ag-go /projects with the picker's filters, sort and page, lists comma-joined", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_AG_GO_API_URL", "https://go.test/api");
    const { getAgGoProjects } = await import("./ag-go-client");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { urls.push(url); return new Response(JSON.stringify({ items: [], page: 2, pageSize: 20, total: 0, totalPages: 0 })); });
    await getAgGoProjects("t", {
      keyword: "hoa lư", page: 2, pageSize: 20, sortBy: "name", sortOrder: "asc", folderIds: ["f1", "f2"], categoryIds: ["c1"], tagIds: [],
      ownerUserIds: ["u1"], countryId: "vn", provinceId: "nb",
    });
    const u = new URL(urls[0]!);
    expect(u.origin + u.pathname).toBe("https://go.test/api/projects");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      keyword: "hoa lư", page: "2", pageSize: "20", sortBy: "name", sortOrder: "asc", folderIds: "f1,f2", categoryIds: "c1", ownerUserIds: "u1", countryId: "vn", provinceId: "nb",
    });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe("footage query", () => {
  it("joins lists with commas and leaves empty values out", async () => {
    const { footageQueryString } = await import("./workspace-client");
    expect(footageQueryString({ agGoProjectIds: ["p1", "p2"], tags: [], q: "", resolutions: ["4k"], minDurationMs: 0, page: 2, sortBy: "duration" }))
      .toBe("?agGoProjectIds=p1%2Cp2&resolutions=4k&minDurationMs=0&page=2&sortBy=duration");
  });
});
