/**
 * UEP-API-001 — Universal Service Interface types (v36.2).
 * External to UEP CORE. No consensus dependency.
 */

export const UEP_API_VERSION = "1.0.0";

export type ApiErrorCode =
  | "INVALID_REQUEST"
  | "VERSION_MISMATCH"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "CONTENT_INTEGRITY_ERROR"
  | "PAYLOAD_TOO_LARGE"
  | "PATH_TRAVERSAL"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ERROR"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "INTERNAL";

export class UepApiError extends Error {
  readonly code: ApiErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ApiErrorCode,
    message: string,
    httpStatus = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "UepApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export type ApiRequestMeta = {
  requestId: string;
  apiVersion: string;
  /** Optional client idempotency key */
  idempotencyKey?: string;
  /** ISO-8601 or unix ms string */
  timestamp: string;
  /** Auth hook placeholder — never stores secrets */
  authTokenPresent?: boolean;
  callerId?: string;
};

export type ApiResponseMeta = {
  requestId: string;
  apiVersion: string;
  timestamp: string;
  providerId?: string;
};

export type ApiSuccess<T> = {
  ok: true;
  meta: ApiResponseMeta;
  data: T;
};

export type ApiFailure = {
  ok: false;
  meta: ApiResponseMeta;
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export function newRequestId(): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 1e9).toString(36);
  return `req_${t}_${r}`;
}

export function makeMeta(
  requestId: string,
  providerId?: string,
): ApiResponseMeta {
  return {
    requestId,
    apiVersion: UEP_API_VERSION,
    timestamp: new Date().toISOString(),
    providerId,
  };
}

export function fail<T = never>(
  requestId: string,
  err: UepApiError,
  providerId?: string,
): ApiResult<T> {
  return {
    ok: false,
    meta: makeMeta(requestId, providerId),
    error: {
      code: err.code,
      message: err.message,
      details: err.details,
    },
  };
}

export function ok<T>(
  requestId: string,
  data: T,
  providerId?: string,
): ApiResult<T> {
  return {
    ok: true,
    meta: makeMeta(requestId, providerId),
    data,
  };
}
