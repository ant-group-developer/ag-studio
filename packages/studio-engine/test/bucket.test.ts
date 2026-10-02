/**
 * Signed GET URLs: presigning is local (no request), so the URL can be checked offline. A download name makes the
 * browser save the file (Content-Disposition: attachment) instead of opening it.
 */
import { describe, expect, it } from "vitest";
import { attachmentDisposition, MemoryBucket, S3Bucket } from "../src/index.js";

const bucket = new S3Bucket({ endpoint: "https://r2.example.com", bucket: "studio", accessKeyId: "AKID", secretAccessKey: "secret" });

describe("signed GET URLs", () => {
  it("opens in the browser without a download name", async () => {
    const url = new URL(await bucket.signedGetUrl("productions/p/exports/run/video.mp4", 600));
    expect(url.searchParams.get("response-content-disposition")).toBeNull();
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
  });

  it("asks the browser to save the file under its name, Vietnamese included", async () => {
    const url = new URL(await bucket.signedGetUrl("productions/p/exports/run/video.mp4", 600, { downloadName: "Phở sáng Hà Nội.mp4" }));
    expect(url.searchParams.get("response-content-disposition")).toBe(attachmentDisposition("Phở sáng Hà Nội.mp4"));
  });

  it("writes an ASCII fallback and the UTF-8 name", () => {
    expect(attachmentDisposition("Phở sáng \"Hà Nội\".mp4")).toBe(
      "attachment; filename=\"Pho sang _Ha Noi_.mp4\"; filename*=UTF-8''Ph%E1%BB%9F%20s%C3%A1ng%20%22H%C3%A0%20N%E1%BB%99i%22.mp4",
    );
  });

  it("the memory bucket notes the download name", async () => {
    expect(await new MemoryBucket().signedGetUrl("k/a.jpg", 60, { downloadName: "a.jpg" })).toBe("memory://k/a.jpg?download=a.jpg");
  });
});
