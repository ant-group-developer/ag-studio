import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStudioClient, StudioHttpError } from "./studio-client";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockGetToken = vi.fn().mockResolvedValue("test-token");
const client = createStudioClient(mockGetToken);

function envelope<T>(data: T) {
  return { data, success: true, error: null, requestId: "req-1", timestamp: new Date().toISOString() };
}

function errorEnvelope(status: number, code: string, message: string, details?: Record<string, unknown>) {
  return {
    data: null,
    success: false,
    error: { code, message, details },
    requestId: "req-err",
    timestamp: new Date().toISOString(),
  };
}

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
        status: 200,
        json: () => Promise.resolve(envelope(team)),
      });

      const result = await client.createTeam("Test Team");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/teams");
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body as string)).toEqual({ name: "Test Team" });
      // request() must unwrap the envelope and return data directly
      expect(result).toEqual(team);
    });

    it("includes Authorization header with token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(envelope({ id: "1", name: "Team", createdAt: "" })),
      });

      await client.createTeam("Team");

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-token");
    });
  });

  describe("listTeams", () => {
    it("sends GET to /api/teams with auth header and unwraps envelope", async () => {
      const teams = [{ id: "1", name: "Team A", createdAt: "2024-01-01" }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(envelope(teams)),
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

    it("throws StudioHttpError on HTTP error with envelope-normalised body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve(errorEnvelope(401, "HTTP_401", "Unauthorized")),
      });

      const err = await client.listTeams().catch((e) => e);
      expect(err).toBeInstanceOf(StudioHttpError);
      expect((err as StudioHttpError).status).toBe(401);
      expect((err as StudioHttpError).body?.code).toBe("HTTP_401");
      expect((err as StudioHttpError).body?.message).toBe("Unauthorized");
    });

    it("throws StudioHttpError on HTTP error with raw (non-envelope) body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ message: "Unauthorized" }),
      });

      await expect(client.listTeams()).rejects.toThrow("Unauthorized");
    });
  });

  describe("saveRevision", () => {
    it("unwraps 409 conflict details into body so useEditor can read currentRevision", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve(errorEnvelope(409, "revision_conflict", "stale", { currentRevision: 5, baseRevision: 3 })),
      });

      const err = await client.saveRevision("prod-1", 3, {} as never).catch((e) => e);
      expect(err).toBeInstanceOf(StudioHttpError);
      expect((err as StudioHttpError).status).toBe(409);
      expect((err as StudioHttpError).body?.code).toBe("revision_conflict");
      // details are spread into body so existing .currentRevision access works
      expect((err as StudioHttpError).body?.currentRevision).toBe(5);
    });
  });

  describe("submitGate", () => {
    it("flattens gate rejection details (missing, failed) into body", async () => {
      const errBody = errorEnvelope(422, "rejected", "Treatment invalid", {
        missing: ["beat-2"],
        failed: [{ check_id: "treatment-valid", evidence: {} }],
      });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 422, json: () => Promise.resolve(errBody) });

      const err = await client.submitGate("prod-1", "approve-treatment").catch((e) => e);
      expect(err).toBeInstanceOf(StudioHttpError);
      expect((err as StudioHttpError).body?.code).toBe("rejected");
      expect((err as StudioHttpError).body?.missing).toEqual(["beat-2"]);
      expect((err as StudioHttpError).body?.failed).toEqual([{ check_id: "treatment-valid", evidence: {} }]);
    });
  });

  describe("204 response", () => {
    it("returns undefined for 204 without parsing", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });
      const result = await client.removeMember("t1", "u1");
      expect(result).toBeUndefined();
    });
  });
});
