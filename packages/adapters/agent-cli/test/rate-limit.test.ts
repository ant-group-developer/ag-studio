import { describe, expect, it } from "vitest";
import { isRateLimitMessage } from "../src/cli-agent-runtime.js";

describe("isRateLimitMessage", () => {
  it.each([
    "You've hit your 5-hour limit · resets 3pm (Asia/Ho_Chi_Minh)",
    "You’ve hit your weekly limit · resets Mon 9am",
    "you have hit your usage limit",
    "Claude AI usage limit reached|1759730400",
    "Error: Usage limit reached. Try again later.",
    "You've reached your usage limit",
  ])("recognises %j", (text) => {
    expect(isRateLimitMessage(text)).toBe(true);
  });

  it.each([
    "agent CLI exited with code 1",
    "Error: ENOENT spawn claude",
    "the output exceeded the token limit for this field",
    "rate of change is limited by the hit points",
  ])("does not mistake %j for the subscription limit", (text) => {
    expect(isRateLimitMessage(text)).toBe(false);
  });
});
