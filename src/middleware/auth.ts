import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { forbidden, unauthorized } from "../shared/errors.js";
import { isRole } from "../shared/types.js";

/**
 * Require a valid Bearer token; attaches req.user = { id, role }.
 *
 * The claims are validated rather than cast: a token signed with our secret
 * but missing a well-formed `sub`/`role` is a forged or malformed token, and
 * should be rejected the same as an expired one.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    next(unauthorized());
    return;
  }

  try {
    const payload: unknown = jwt.verify(token, config.jwtSecret);
    if (typeof payload === "string" || payload === null) {
      next(unauthorized("Invalid or expired token"));
      return;
    }
    const { sub, role } = payload as Record<string, unknown>;
    if (typeof sub !== "string" || !isRole(role)) {
      next(unauthorized("Invalid or expired token"));
      return;
    }
    req.user = { id: sub, role };
    next();
  } catch {
    next(unauthorized("Invalid or expired token"));
  }
}

/** Restrict a route to one role (e.g. driver-only endpoints). */
export const requireRole =
  (...roles: readonly string[]): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(forbidden(`Requires role: ${roles.join(" or ")}`));
      return;
    }
    next();
  };
