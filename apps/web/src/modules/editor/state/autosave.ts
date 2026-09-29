/**
 * Autosave to `timeline_revisions` (plan 4.2): a change is saved `delayMs` after the last edit, on top of the
 * revision the editor holds. The server answers 409 when someone else saved first; autosave then stops and
 * the page asks the person to load the newer revision (or to overwrite it deliberately).
 */
import type { TimelineV2 } from "@harness/contracts";

export type SaveResult = { ok: true; revision: number } | { ok: false; conflict: true; currentRevision: number } | { ok: false; conflict: false; error: string };

export interface AutosaverOptions {
  save(baseRevision: number, timeline: TimelineV2): Promise<SaveResult>;
  onSaved(revision: number, timeline: TimelineV2): void;
  onConflict(currentRevision: number): void;
  onError(message: string): void;
  delayMs?: number;
  /** Test seam. */
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export type AutosaveStatus = "idle" | "pending" | "saving" | "conflict" | "error";

export class Autosaver {
  private handle: unknown = null;
  private inFlight: Promise<void> | null = null;
  private latest: { base: number; timeline: TimelineV2 } | null = null;
  private _status: AutosaveStatus = "idle";
  private readonly timers: NonNullable<AutosaverOptions["timers"]>;

  constructor(private readonly o: AutosaverOptions) {
    this.timers = o.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  get status(): AutosaveStatus { return this._status; }

  /** Call on every edit with the timeline to save and the revision it is based on. */
  schedule(baseRevision: number, timeline: TimelineV2): void {
    if (this._status === "conflict") return; // nothing is saved until the conflict is resolved
    this.latest = { base: baseRevision, timeline };
    if (this.handle !== null) this.timers.clear(this.handle);
    this._status = this.inFlight ? "saving" : "pending";
    this.handle = this.timers.set(() => { this.handle = null; void this.flush(); }, this.o.delayMs ?? 1500);
  }

  /** Save now (e.g. before "Hoàn tất" or "Render preview"); resolves once the latest edit is saved or refused. */
  async flush(): Promise<void> {
    if (this.handle !== null) { this.timers.clear(this.handle); this.handle = null; }
    while (this.inFlight) await this.inFlight;
    const job = this.latest;
    if (!job || this._status === "conflict") return;
    this.latest = null;
    this._status = "saving";
    this.inFlight = (async () => {
      const r = await this.o.save(job.base, job.timeline).catch((e: unknown): SaveResult => ({ ok: false, conflict: false, error: e instanceof Error ? e.message : String(e) }));
      if (r.ok) {
        this.o.onSaved(r.revision, job.timeline);
        // an edit that arrived meanwhile was based on the old revision: carry it onto the new one
        if (this.latest) this.latest = { base: r.revision, timeline: this.latest.timeline };
        this._status = this.latest ? "pending" : "idle";
      } else if (r.conflict) {
        this._status = "conflict";
        this.latest = null;
        this.o.onConflict(r.currentRevision);
      } else {
        this._status = "error";
        if (!this.latest) this.latest = job; // keep it for the next attempt
        this.o.onError(r.error);
      }
    })();
    try { await this.inFlight; } finally { this.inFlight = null; }
    if (this.latest && (this._status as AutosaveStatus) === "pending") await this.flush();
  }

  /** After the page reloaded the newer revision (or chose to overwrite from it). */
  resolveConflict(): void {
    this._status = "idle";
  }

  dispose(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
  }
}
