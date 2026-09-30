export class ApiErrorDto {
  code: string;
  message: string;
  details?: unknown;
  fieldErrors?: Record<string, string[]>;

  constructor(
    code: string,
    message: string,
    options?: {
      details?: unknown;
      fieldErrors?: Record<string, string[]>;
    },
  ) {
    this.code = code;
    this.message = message;
    this.details = options?.details;
    this.fieldErrors = options?.fieldErrors;
  }
}
