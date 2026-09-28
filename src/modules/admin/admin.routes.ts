import { Router } from "express";
import { asyncHandler } from "../../shared/errors.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { query } from "../../shared/db.js";
import { serializeRide, serializeRideMembers } from "../rides/rides.service.js";
import type { RideRow, SerializedRequest, SerializedRide } from "../../shared/types.js";

export const adminRouter = Router();

interface AdminRideRow extends RideRow {
  vehicle_name: string;
  driver_name: string;
}

type AdminRide = SerializedRide & {
  vehicleName: string;
  driverName: string;
  requests: SerializedRequest[];
};

/** Read-only demo/debug view of every active ride and its seat count. */
adminRouter.get(
  "/admin/rides",
  authenticate,
  requireRole("admin"),
  asyncHandler(async (_req, res) => {
    const { rows } = await query<AdminRideRow>(
      `SELECT r.*, v.name AS vehicle_name, u.name AS driver_name
       FROM rides r
       JOIN vehicles v ON v.id = r.vehicle_id
       JOIN users u ON u.id = v.driver_id
       WHERE r.status IN ('MATCHED', 'DRIVER_ARRIVED', 'STARTED')
       ORDER BY r.created_at`,
    );

    const rides: AdminRide[] = [];
    for (const row of rows) {
      rides.push({
        ...serializeRide(row),
        vehicleName: row.vehicle_name,
        driverName: row.driver_name,
        requests: await serializeRideMembers(row.id),
      });
    }
    res.json({ rides });
  }),
);
