/**
 * Express request augmentation.
 *
 * Kept in a normal module rather than a bare `.d.ts` so TypeScript carries it
 * into the emitted declarations in `dist/` — a `.d.ts` *input* file is never
 * copied to outDir, which would silently drop the augmentation for anything
 * reading the built types.
 *
 * `user` is declared non-optional on purpose: `authenticate` is the gate, and
 * every route that reads `req.user` lists it in its middleware chain. If a
 * route ever reads it without the gate, that is a bug the review should catch.
 */
import type { AuthUser } from "./types.js";

declare module "express-serve-static-core" {
  interface Request {
    user: AuthUser;
    requestId: string;
  }
}

export {};
