import type { Request } from "express";
import { badRequest } from "./errors.js";

/**
 * Read a single route parameter as a string.
 *
 * Express 5 types `req.params[key]` as `string | string[] | undefined`,
 * because wildcard and repeated params can produce either shape. Every `:id`
 * route in this API declares exactly one value, so anything else is a
 * programming error — surfaced as a 400 rather than silently stringified into
 * "[object Object]" and sent to the database.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`Missing route parameter: ${name}`);
  }
  return value;
}
