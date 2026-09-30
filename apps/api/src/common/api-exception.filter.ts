import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiErrorDto } from './dto/api-error.dto';
import { ApiResponseDto } from './dto/api-response.dto';
import { AgGoClientError } from '../ag-go/client';

type ErrorPayload = Record<string, unknown>;

/** Fields that are NestJS / HTTP metadata, not payload data. */
const META_FIELDS = new Set(['message', 'code', 'error', 'statusCode', 'fieldErrors', 'details']);

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const status = this.getStatus(exception);
    const error = this.toApiError(exception, status);
    const requestId = request.requestId ?? String(response.getHeader('x-request-id') ?? '');

    // A 5xx is ours (or an upstream's) to fix: keep what happened, the caller only sees the envelope.
    if (status >= 500) {
      const detail = exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
      this.logger.error(`${request.method} ${request.originalUrl} -> ${status} ${error.code} [${requestId}]: ${detail}`);
    }

    response.status(status).json(new ApiResponseDto(null, requestId, false, error));
  }

  private getStatus(exception: unknown): number {
    if (exception instanceof AgGoClientError) return this.agGoStatus(exception.status);
    return exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
  }

  /**
   * ag-go refusing the user (403) or not finding a thing (404, 422) passes through; anything else from ag-go
   * (its own 5xx, a service key it does not accept) is a bad gateway for Studio's caller.
   */
  private agGoStatus(upstream: number): number {
    return upstream === 403 || upstream === 404 || upstream === 422 ? upstream : HttpStatus.BAD_GATEWAY;
  }

  private toAgGoError(exception: AgGoClientError): ApiErrorDto {
    const body = this.isRecord(exception.body) ? exception.body : {};
    const inner = this.isRecord(body.error) ? body.error : body;
    const message = typeof inner.message === 'string' ? inner.message : `HTTP ${exception.status}`;
    return new ApiErrorDto('AG_GO_ERROR', `ag-go: ${message}`, {
      details: { upstreamStatus: exception.status, upstreamCode: typeof inner.code === 'string' ? inner.code : undefined },
    });
  }

  private toApiError(exception: unknown, status: number): ApiErrorDto {
    if (exception instanceof AgGoClientError) {
      return this.toAgGoError(exception);
    }
    if (!(exception instanceof HttpException)) {
      return new ApiErrorDto('INTERNAL_SERVER_ERROR', 'Internal server error');
    }

    const payload = exception.getResponse();
    if (typeof payload === 'string') {
      return new ApiErrorDto(this.defaultCode(status), payload);
    }

    const record = this.isRecord(payload) ? payload : {};
    const rawMessage = record.message;
    const isValidationError = Array.isArray(rawMessage);
    const message = isValidationError
      ? 'Request validation failed'
      : typeof rawMessage === 'string'
        ? rawMessage
        : this.defaultMessage(status);
    const fieldErrors = this.toFieldErrors(record.fieldErrors);

    // Collect any extra fields from the payload that aren't standard meta fields.
    // These carry domain data (e.g. currentRevision on a 409, problems/failed on a 422)
    // and must survive in `details` so nothing the caller threw is silently dropped.
    const extraFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (!META_FIELDS.has(k)) extraFields[k] = v;
    }
    const hasExtra = Object.keys(extraFields).length > 0;

    let details: unknown;
    if (isValidationError) {
      details = hasExtra ? { messages: rawMessage, ...extraFields } : { messages: rawMessage };
    } else if (hasExtra && record.details !== undefined) {
      details = this.isRecord(record.details)
        ? { ...extraFields, ...record.details }
        : { ...extraFields, details: record.details };
    } else if (hasExtra) {
      details = extraFields;
    } else {
      details = record.details;
    }

    return new ApiErrorDto(
      typeof record.code === 'string' ? record.code : this.defaultCode(status),
      message,
      { details, fieldErrors },
    );
  }

  private toFieldErrors(value: unknown): Record<string, string[]> | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }

    const fieldErrors: Record<string, string[]> = {};
    for (const [field, messages] of Object.entries(value)) {
      if (Array.isArray(messages) && messages.every((message) => typeof message === 'string')) {
        fieldErrors[field] = messages;
      }
    }

    return Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined;
  }

  private isRecord(value: unknown): value is ErrorPayload {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private defaultCode(status: number): string {
    return `HTTP_${status}`;
  }

  private defaultMessage(status: number): string {
    return status >= 500 ? 'Internal server error' : 'Request failed';
  }
}
