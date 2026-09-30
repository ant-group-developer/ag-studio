import { describe, expect, it } from "vitest";
import { menuKeyFor } from "./menu";

describe("menuKeyFor", () => {
  it("puts the team list and team members under Nhóm, production pages under Production", () => {
    expect(menuKeyFor("/teams")).toBe("/teams");
    expect(menuKeyFor("/teams/t-1")).toBe("/teams");
    expect(menuKeyFor("/teams/t-1/productions")).toBe("/productions");
    expect(menuKeyFor("/productions")).toBe("/productions");
    expect(menuKeyFor("/productions/p-1")).toBe("/productions");
    expect(menuKeyFor("/productions/p-1/editor")).toBe("/productions");
  });
});
