// AgGoClientError - thrown on non-2xx responses

export class AgGoClientError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`ag-go-api error: HTTP ${status}`);
    this.name = "AgGoClientError";
    this.status = status;
    this.body = body;
  }
}

/**
 * ag-go-api answers `{ data, requestId, success, error, timestamp }` (its ApiResponseInterceptor); the payload
 * is `data`. A body without that envelope is returned as is.
 */
export function unwrapAgGoResponse<T>(body: unknown): T {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (typeof b.success === "boolean" && "data" in b && typeof b.requestId === "string") return b.data as T;
  }
  return body as T;
}
