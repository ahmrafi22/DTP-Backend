import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

/**
 * Consistent error envelope for every failure:
 *   { error: { code, message, details? } }
 * Services throw HttpError; the Express error middleware shapes the response.
 */

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError(400, "BAD_REQUEST", message, details);

export const unauthorized = (message = "Authentication required"): HttpError =>
  new HttpError(401, "UNAUTHORIZED", message);

export const forbidden = (message = "Not allowed"): HttpError =>
  new HttpError(403, "FORBIDDEN", message);

export const notFound = (message = "Not found"): HttpError =>
  new HttpError(404, "NOT_FOUND", message);

export const conflict = (code: string, message: string, details?: unknown): HttpError =>
  new HttpError(409, code, message, details);

export const tooMany = (message = "Too many requests, slow down"): HttpError =>
  new HttpError(429, "RATE_LIMITED", message);

/** Wrap async route handlers so rejections reach the error middleware. */
export const asyncHandler =
  <T>(fn: (req: Request, res: Response, next: NextFunction) => Promise<T>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.originalUrl}` },
  });
}

// Express identifies error middleware by arity, so `next` must stay in the
// signature even though it is unused — hence the underscore.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    const body: ErrorBody = { code: err.code, message: err.message };
    if (err.details !== undefined) body.details = err.details;
    res.status(err.status).json({ error: body });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request body",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }

  console.error(err);
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong" } });
}
