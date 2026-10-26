import { NextResponse } from 'next/server';
import { AppError } from './rbac';

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
        },
      },
      { status: err.statusCode }
    );
  }
  const message = err instanceof Error ? err.message : 'An unexpected server error occurred.';
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message,
      },
    },
    { status: 500 }
  );
}
