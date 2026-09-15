import { describe, expect, it } from "vitest";
import type { ContentRequest, ProjectConfig } from "@harness/contracts";
import { portfolioForRequest } from "../src/commands/worker.js";

// Final-review bundled minor (f): `autoAcceptDepsFor` used to hand `autoAccept` the project's first
// portfolio for every request, so on a studio serving more than one portfolio every auto-accepted run (and
// every `request.auto_*` event) was attributed to whichever portfolio happened to be listed first.
const project = (...ids: string[]): Pick<ProjectConfig, "portfolios"> => ({
  portfolios: ids.map((portfolio_id) => ({ portfolio_id, display_name: portfolio_id })),
});

const request = (portfolioId: string): ContentRequest => ({
  schema_version: "harness.content-request/v1",
  request_id: "req_01JBQ7YF3K8ZC4M6N9PRTVWXYZ",
  requested_by: { portfolio_id: portfolioId },
  topic: "topic",
  count: 1,
  status: "open",
  created_at: "2026-09-15T00:00:00.000Z",
  updated_at: "2026-09-15T00:00:00.000Z",
} as ContentRequest);

describe("portfolioForRequest", () => {
  it("uses the requesting portfolio when this project declares it", () => {
    expect(portfolioForRequest(project("portfolio-a", "portfolio-b"), request("portfolio-b"))).toBe("portfolio-b");
  });

  it("falls back to the project's first portfolio for a portfolio this project does not know", () => {
    // the kho is shared across machines: a request from a portfolio this studio never heard of is normal
    expect(portfolioForRequest(project("portfolio-a", "portfolio-b"), request("portfolio-elsewhere"))).toBe("portfolio-a");
  });

  it("is the single portfolio on a single-portfolio project either way", () => {
    expect(portfolioForRequest(project("only"), request("only"))).toBe("only");
    expect(portfolioForRequest(project("only"), request("other"))).toBe("only");
  });
});
