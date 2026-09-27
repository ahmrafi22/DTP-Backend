import { Router } from "express";
import { query, rowsAffected, withTransaction } from "../../shared/db.js";
import { asyncHandler, conflict, unauthorized } from "../../shared/errors.js";
import { authenticate } from "../../middleware/auth.js";
import type { UserRow } from "../../shared/types.js";
import { loginSchema, registerSchema } from "./auth.schema.js";
import {
  hashPassword,
  requireUser,
  signToken,
  verifyPassword,
  withVehicle,
} from "./auth.service.js";

export const authRouter = Router();

authRouter.post(
  "/auth/register",
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const existing = await query("SELECT 1 FROM users WHERE phone = $1", [body.phone]);
    if (rowsAffected(existing) > 0) {
      throw conflict("PHONE_TAKEN", "An account with this phone already exists");
    }

    const hash = await hashPassword(body.password);
    const user = await withTransaction(async (client) => {
      const { rows } = await client.query<UserRow>(
        `INSERT INTO users (name, phone, password_hash, role, home_stop_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [body.name, body.phone, hash, body.role, body.homeStopId ?? null],
      );
      const created = rows[0];
      if (!created) throw new Error("INSERT ... RETURNING produced no user row");

      if (body.role === "driver") {
        await client.query("INSERT INTO vehicles (driver_id, name, capacity) VALUES ($1, $2, $3)", [
          created.id,
          body.vehicleName,
          body.vehicleCapacity ?? 3,
        ]);
      }
      return created;
    });

    res.status(201).json({ token: signToken(user), user: await withVehicle(user) });
  }),
);

authRouter.post(
  "/auth/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const { rows } = await query<UserRow>("SELECT * FROM users WHERE phone = $1", [body.phone]);
    const user = rows[0];

    // Same message for unknown phone and wrong password (no account enumeration).
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      throw unauthorized("Invalid phone or password");
    }
    res.json({ token: signToken(user), user: await withVehicle(user) });
  }),
);

authRouter.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await requireUser(req.user.id);
    res.json({ user: await withVehicle(user) });
  }),
);
