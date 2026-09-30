import express from "express";
import type { Express, Request, Response } from "express";
import cors from "cors";
import { config } from "./config/index.js";
import { requestLogger } from "./shared/logger.js";
import { errorHandler, notFoundHandler } from "./shared/errors.js";
import { authRouter } from "./modules/auth/index.js";
import { networkRouter } from "./modules/network/index.js";
import { openRidesRouter, ridesRouter } from "./modules/rides/index.js";
import { adminRouter, resetRouter } from "./modules/admin/index.js";
import { walletRouter } from "./modules/wallet/index.js";
import { pool } from "./shared/db.js";
import "./shared/express.js";

/** The Express app — exported for supertest, mounted by server.ts. */
export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use(cors({ origin: config.corsOrigin }));
  app.use(requestLogger);

  app.get("/health", async (_req: Request, res: Response) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, service: "dtp-backend", time: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false, service: "dtp-backend", db: "unreachable" });
    }
  });

  app.use(authRouter);
  app.use(networkRouter);
  // Mounted before ridesRouter: its GET /rides/:id would otherwise match
  // /rides/open and treat "open" as a request id.
  app.use(openRidesRouter);
  app.use(ridesRouter);
  app.use(adminRouter);
  app.use(resetRouter);
  app.use(walletRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
