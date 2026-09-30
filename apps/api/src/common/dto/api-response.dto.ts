import { ApiErrorDto } from './api-error.dto';

export class ApiResponseDto<T> {
  data: T | null;
  requestId: string;
  timestamp: string;
  success: boolean;
  error: ApiErrorDto | null;

  constructor(
    data: T | null,
    requestId: string,
    success: boolean,
    error: ApiErrorDto | null = null,
    timestamp = new Date().toISOString(),
  ) {
    this.data = data;
    this.requestId = requestId;
    this.timestamp = timestamp;
    this.success = success;
    this.error = error;
  }
}
