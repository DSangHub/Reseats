/**
 * Stripe-style error envelope so merchant integrators get a stable contract:
 *   { "error": { "type": "invalid_request_error", "code": "...", "message": "...", "param": "..." } }
 */
export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'conflict_error'
  | 'rate_limit_error'
  | 'provider_error'
  | 'api_error';

export class ApiError extends Error {
  readonly statusCode: number;
  readonly type: ErrorType;
  readonly code: string;
  readonly param: string | undefined;
  readonly details: unknown;

  constructor(opts: {
    statusCode: number;
    type: ErrorType;
    code: string;
    message: string;
    param?: string;
    details?: unknown;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.statusCode = opts.statusCode;
    this.type = opts.type;
    this.code = opts.code;
    this.param = opts.param;
    this.details = opts.details;
  }

  toJSON() {
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
        ...(this.param ? { param: this.param } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const badRequest = (code: string, message: string, param?: string, details?: unknown) =>
  new ApiError({ statusCode: 400, type: 'invalid_request_error', code, message, param, details });

export const unauthorized = (message = 'Missing or invalid API key.', code = 'unauthorized') =>
  new ApiError({ statusCode: 401, type: 'authentication_error', code, message });

export const forbidden = (message = 'Not permitted.', code = 'forbidden') =>
  new ApiError({ statusCode: 403, type: 'permission_error', code, message });

export const notFound = (resource: string) =>
  new ApiError({
    statusCode: 404,
    type: 'not_found_error',
    code: 'resource_missing',
    message: `No such ${resource}.`,
  });

export const conflict = (code: string, message: string, details?: unknown) =>
  new ApiError({ statusCode: 409, type: 'conflict_error', code, message, details });

export const providerError = (message: string, details?: unknown) =>
  new ApiError({
    statusCode: 502,
    type: 'provider_error',
    code: 'provider_failure',
    message,
    details,
  });
