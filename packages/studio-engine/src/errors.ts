/** Errors the API maps to HTTP: not_found 404, conflict 409, invalid/rejected 422 (with `details`). */
export type StudioRunErrorCode = "not_found" | "conflict" | "invalid" | "rejected";
export class StudioRunError extends Error {
  constructor(readonly code: StudioRunErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "StudioRunError";
  }
}
