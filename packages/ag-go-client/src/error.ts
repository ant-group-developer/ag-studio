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
