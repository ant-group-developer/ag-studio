import { describe, expect, it } from "vitest";
import { unwrapAgGoResponse } from "./ag-go-client";

describe("unwrapAgGoResponse", () => {
  it("returns data from ag-go-api's envelope and leaves other bodies alone", () => {
    const folders = [{ id: "f-1", name: "Test 1.1", parentId: null, usableVideos: 18 }];
    expect(unwrapAgGoResponse({ data: { folders }, requestId: "r", success: true, error: null, timestamp: "t" })).toEqual({ folders });
    expect(unwrapAgGoResponse({ folders })).toEqual({ folders });
    expect(unwrapAgGoResponse([1, 2])).toEqual([1, 2]);
  });
});
