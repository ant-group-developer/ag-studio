import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStudioClient } from "./studio-client";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockGetToken = vi.fn().mockResolvedValue("test-token");
const client = createStudioClient(mockGetToken);

beforeEach(() => {
  mockFetch.mockReset();
  mockGetToken.mockResolvedValue("test-token");
});

describe("createStudioClient", () => {
  describe("createTeam", () => {
    it("sends POST to /api/teams with correct body", async () => {
      const team = { id: "1", name: "Test Team", createdAt: "2024-01-01" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(team),
      });

      const result = await client.createTeam("Test Team");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/teams");
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body as string)).toEqual({ name: "Test Team" });
      expect(result).toEqual(team);
    });

    it("includes Authorization header with token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "1", name: "Team", createdAt: "" }),
      });

      await client.createTeam("Team");

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-token");
    });
  });

  describe("listTeams", () => {
    it("sends GET to /api/teams with auth header", async () => {
      const teams = [{ id: "1", name: "Team A", createdAt: "2024-01-01" }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(teams),
      });

      const result = await client.listTeams();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/teams");
      expect(options.method).toBe("GET");
      const headers = options.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-token");
      expect(result).toEqual(teams);
    });

    it("throws on HTTP error response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      await expect(client.listTeams()).rejects.toThrow("HTTP 401");
    });
  });
});
