import { CallHandler, ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import { ApiResponseDto } from './dto/api-response.dto';
import { RAW_RESPONSE_KEY } from './raw-response.decorator';

@Injectable()
export class ApiResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    return next.handle().pipe(
      map((data: unknown) => {
        if (raw || this.shouldSkip(request, response) || this.isApiResponse(data)) {
          return data;
        }

        return new ApiResponseDto(
          data ?? null,
          request.requestId ?? String(response.getHeader('x-request-id') ?? ''),
          true,
        );
      }),
    );
  }

  private shouldSkip(request: Request, response: Response): boolean {
    if (response.headersSent || response.statusCode === 204) {
      return true;
    }

    const contentType = response.getHeader('content-type');
    return typeof contentType === 'string' && !contentType.includes('json');
  }

  private isApiResponse(value: unknown): value is ApiResponseDto<unknown> {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.requestId === 'string' &&
      typeof candidate.timestamp === 'string' &&
      typeof candidate.success === 'boolean' &&
      'data' in candidate &&
      'error' in candidate
    );
  }
}
