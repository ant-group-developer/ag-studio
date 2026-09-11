export const ERROR_CODES = [
  "INVALID_TRANSITION",
  "STALE_STATE",
  "FENCING_REJECTED",
  "LEASE_LOST",
  "NOT_FOUND",
  "SCHEMA_INVALID",
  "CONFIG_INVALID",
  "UNKNOWN_CONFIG_KEY",
  "SECRET_UNRESOLVED",
  "CHECKSUM_MISMATCH",
  "WORKFLOW_INVALID",
  "EXECUTOR_FAILED",
  "EXECUTOR_TIMEOUT",
  "CONNECTION_LOST",
  "RECONCILE_FAILED",
  "IO_ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class HarnessError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.details = details;
  }
}

export function isHarnessError(e: unknown, code?: ErrorCode): e is HarnessError {
  return e instanceof HarnessError && (code === undefined || e.code === code);
}
