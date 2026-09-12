import type { MediaProber } from "@harness/contracts";
/** Used until an ffprobe adapter is wired (plan 2B): no media metadata, mime from the file extension only. */
export class NullMediaProber implements MediaProber {
  async probe(_path: string): Promise<null> { return null; }
}
