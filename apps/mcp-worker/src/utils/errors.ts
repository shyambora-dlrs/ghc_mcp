/** Errors carry a safe public message; detail stays in protected logs only. */
export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "CONFLICT"
  | "UPSTREAM_ERROR"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly publicMessage: string,
    readonly status: number = 400,
    readonly detail?: unknown,
  ) {
    super(publicMessage);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError("NOT_FOUND", `${what} was not found.`, 404);
export const invalid = (msg: string) => new AppError("INVALID_INPUT", msg, 400);

export function toPublicError(err: unknown): { code: ErrorCode; message: string; status: number } {
  if (err instanceof AppError) return { code: err.code, message: err.publicMessage, status: err.status };
  return { code: "INTERNAL", message: "An internal error occurred. Please try again later.", status: 500 };
}
