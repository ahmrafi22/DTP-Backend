/**
 * In-memory fixed-window rate limiter — demo-grade (per instance, lost on
 * restart). At scale this moves to Redis with a sliding window (PRD §17).
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { tooMany } from "../shared/errors.js";

interface RateLimitOptions {
  /** Requests allowed per window. */
  max: number;
  windowMs: number;
  /** Derives the bucket key, e.g. one bucket per passenger. */
  keyOf: (req: Request) => string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit({ max, windowMs, keyOf }: RateLimitOptions): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = keyOf(req);
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > max) {
      next(tooMany());
      return;
    }
    next();
  };
}

/** Test helper: clear all buckets between tests. */
export function resetRateLimits(): void {
  buckets.clear();
}
