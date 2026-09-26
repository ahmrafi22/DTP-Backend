import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { forbidden, unauthorized } from "../shared/errors.js";

/** Require a valid Bearer token; attaches req.user = { id, role }. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    next(unauthorized());
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string; role: string };
    req.user = { id: payload.sub, role: payload.role as never };
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
