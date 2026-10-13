import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * CORS of the API: any origin, as before (the web sends a bearer token, not cookies), and a preflight remembered
 * 2 hours (Chrome caps it there) instead of asked again before every call with an `Authorization` header.
 */
export const CORS_OPTIONS: CorsOptions = { maxAge: 7200 };
