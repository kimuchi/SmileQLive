import { NextResponse } from 'next/server';
import { AppError, toAppError, type AppErrorCode } from '@/lib/errors/app-error';

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
};

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

export function jsonOk<T>(data: T, init: { status?: number; headers?: HeadersInit } = {}) {
  return NextResponse.json(data, {
    status: init.status ?? 200,
    headers: { ...NO_STORE, ...(init.headers ?? {}) },
  });
}

export function jsonCreated<T>(data: T) {
  return jsonOk(data, { status: 201 });
}

export function jsonError(
  error: AppError | AppErrorCode | unknown,
  requestId: string,
  details?: unknown,
): NextResponse<ApiError> {
  const appError =
    typeof error === 'string'
      ? new AppError(error as AppErrorCode, { details })
      : toAppError(error);

  const body: ApiError = {
    error: {
      code: appError.code,
      message: appError.userMessage,
      requestId,
      ...(appError.details !== undefined || details !== undefined
        ? { details: appError.details ?? details }
        : {}),
    },
  };

  return NextResponse.json(body, { status: appError.status, headers: NO_STORE });
}
