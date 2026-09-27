import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

/**
 * Minimal structured JSON logger with a request id per call — good enough
 * for the MVP without pulling in a logging framework (documented trade-off).
 */

export type LogLevel = "info" | "error";

/** Free-form structured fields merged into the log line. */
export type LogMeta = Record<string, unknown>;

export function log(level: LogLevel, msg: string, meta: LogMeta = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  (level === "error" ? console.error : console.log)(line);
}

export const logger = {
  info: (msg: string, meta?: LogMeta) => log("info", msg, meta),
  error: (msg: string, meta?: LogMeta) => log("error", msg, meta),
};

/** Express middleware: attaches a request id and logs method/path/status/ms. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  const start = Date.now();
  res.on("finish", () => {
    logger.info("http_request", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - start,
    });
  });
  next();
}
