import { describe, expect, it } from "vitest";
import { readSse, type SseEvent } from "./use-chat-events";

const stream = (...chunks: string[]) => new ReadableStream<Uint8Array>({
  start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); },
});

describe("readSse", () => {
  it("reads named events as Nest writes them, across chunk boundaries and CRLF", async () => {
    const got: SseEvent[] = [];
    const chunks = [
      'id: 1\nevent: changed\ndata: {"fingerprint":"a"}\n\n',
      "event: ping\r\ndata: \r\n\r",
      "\nevent: chan",
      'ged\ndata: {"fingerprint":"b"}\n\n',
    ];
    for await (const e of readSse(stream(...chunks))) got.push(e);
    expect(got).toEqual([
      { event: "changed", data: '{"fingerprint":"a"}' },
      { event: "ping", data: "" },
      { event: "changed", data: '{"fingerprint":"b"}' },
    ]);
  });
});
