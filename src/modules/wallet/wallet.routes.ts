import { Router } from "express";
import { asyncHandler } from "../../shared/errors.js";
import { authenticate } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { getWallet, topUp, transactionsFor } from "./wallet.service.js";
import { topUpSchema } from "./wallet.schema.js";
import { STATEMENT_LIMIT } from "./wallet.constants.js";

export const walletRouter = Router();

/**
 * Every route here is about the caller's own money, so `authenticate` is the
 * only gate: a passenger tops up their own wallet exactly as a driver does.
 * There is deliberately no admin route that can move taka between wallets.
 */

walletRouter.get(
  "/wallet",
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await getWallet(req.user.id));
  }),
);

// One tap, ৳100 in. Rate limited so a stuck finger cannot spam the ledger.
walletRouter.post(
  "/wallet/top-up",
  authenticate,
  rateLimit({
    max: 30,
    windowMs: 60_000,
    keyOf: (req) => `topup:${req.user.id}`,
  }),
  asyncHandler(async (req, res) => {
    const body = topUpSchema.parse(req.body ?? {});
    res.status(201).json(await topUp(req.user.id, body.amountPaisa));
  }),
);

walletRouter.get(
  "/wallet/transactions",
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ transactions: await transactionsFor(req.user.id, STATEMENT_LIMIT) });
  }),
);