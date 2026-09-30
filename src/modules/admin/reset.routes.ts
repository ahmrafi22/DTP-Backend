import { Router } from "express";
import { asyncHandler } from "../../shared/errors.js";
import { authenticate } from "../../middleware/auth.js";
import { resetUserData } from "../../db/reset.js";

export const resetRouter = Router();

/**
 * Wipe every rider and driver journey — rides, requests, fares, events and the
 * wallet ledger — while leaving the road network, the stops and the accounts
 * alone. Mounted at POST /admin/reset and reachable from the /reset screen.
 *
 * Destructive, so it still requires a signed-in session — but not a
 * particular role. On a demo build any rider can clear the shared demo data;
 * the moment this is pointed at real users, put `requireRole("admin")` back.
 */
resetRouter.post(
  "/admin/reset",
  authenticate,
  asyncHandler(async (_req, res) => {
    const result = await resetUserData();
    res.json({ ok: true, ...result });
  }),
);