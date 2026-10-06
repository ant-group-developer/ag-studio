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
    // claude 2.x in JSON mode (2026-10): no "hit your limit" line, the envelope says it after ~3 min of retries
    "API Error: Request rejected (429) · Subscription limit exceeded (request id: 2026100620550983)",
    '{"type":"result","is_error":true,"api_error_status":429,"terminal_reason":"api_error","result":"API Error: Request rejected (429)"}',
  ])("recognises %j", (text) => {
    expect(isRateLimitMessage(text)).toBe(true);
  });

  it.each([
    "agent CLI exited with code 1",
    "Error: ENOENT spawn claude",
    "the output exceeded the token limit for this field",
    "rate of change is limited by the hit points",
    '{"type":"result","is_error":true,"api_error_status":500,"result":"API Error: 500"}',
    "the plan says 429 shots",
  ])("does not mistake %j for the subscription limit", (text) => {
    expect(isRateLimitMessage(text)).toBe(false);
  });
});
