import { Router } from "express";
import { query } from "../../shared/db.js";
import { asyncHandler, forbidden, notFound } from "../../shared/errors.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { config } from "../../config/index.js";
import {
  acceptRequests,
  activeRequestForPassenger,
  advanceRide,
  cancelRequest,
  advanceRider,
  createRequest,
  driverHistory,
  dropOffRider,
  driverState,
  eventsForRide,
  getRequestById,
  getRideById,
  joinRide,
  passengerHistory,
  pendingPoolGroups,
  rateRequest,
  requireVehicleForDriver,
  serializeRequestById,
} from "./rides.service.js";
import { param } from "../../shared/http.js";
import { TRIP_ACTIONS } from "./rides.constants.js";
import {
  acceptRequestsSchema,
  cancelRideSchema,
  dropOffSchema,
  joinRideSchema,
  rateRideSchema,
  requestRideSchema,
  setOnlineSchema,
} from "./rides.schema.js";

export const ridesRouter = Router();


// ---------- passenger ----------

ridesRouter.post(
  "/rides/request",
  authenticate,
  requireRole("passenger"),
  rateLimit({
    max: config.rateLimit.rideRequestsMax,
    windowMs: config.rateLimit.rideRequestsWindowMs,
    keyOf: (req) => `ride-req:${req.user.id}`,
  }),
  asyncHandler(async (req, res) => {
    const body = requestRideSchema.parse(req.body);
    const { request, replayed } = await createRequest({
      passengerId: req.user.id,
      pickupStopId: body.pickupStopId,
      dropStopId: body.dropStopId,
      routeId: body.routeId ?? null,
      seats: body.seats,
      waitAndSave: body.waitAndSave,
      paymentMethod: body.paymentMethod,
      idempotencyKey: body.idempotencyKey ?? null,
    });
    res.status(replayed ? 200 : 201).json({ request, replayed });
  }),
);

ridesRouter.get(
  "/me/active",
  authenticate,
  asyncHandler(async (req, res) => {
    // Polling endpoint: passenger's live ride state (or null).
    res.json(await activeRequestForPassenger(req.user.id));
  }),
);

ridesRouter.get(
  "/me/history",
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ requests: await passengerHistory(req.user.id) });
  }),
);

ridesRouter.get(
  "/rides/:id",
  authenticate,
  asyncHandler(async (req, res) => {
    const request = await getRequestById(param(req, "id"));
    if (!request) throw notFound("Ride request not found");

    // Ownership: the passenger themself, or the driver running the ride.
    let allowed = request.passenger_id === req.user.id;
    if (!allowed && req.user.role === "driver" && request.ride_id) {
      const ride = await getRideById(request.ride_id);
      const vehicle = ride ? await requireVehicleForDriver(req.user.id) : null;
      allowed = Boolean(ride && vehicle && ride.vehicle_id === vehicle.id);
    }
    if (!allowed) throw forbidden("You can only view your own ride");

    res.json({ request: await serializeRequestById(request.id) });
  }),
);

ridesRouter.post(
  "/rides/:id/cancel",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = cancelRideSchema.parse(req.body ?? {});
    const request = await cancelRequest({
      requestId: param(req, "id"),
      actorId: req.user.id,
      actorRole: req.user.role,
      reason: body.reason ?? null,
    });
    res.json({ request });
  }),
);

ridesRouter.post(
  "/rides/:id/rate",
  authenticate,
  requireRole("passenger"),
  asyncHandler(async (req, res) => {
    const body = rateRideSchema.parse(req.body);
    const request = await rateRequest({
      requestId: param(req, "id"),
      passengerId: req.user.id,
      rating: body.rating,
    });
    res.json({ request });
  }),
);

// ---------- driver ----------

ridesRouter.post(
  "/rides/accept",
  authenticate,
  requireRole("driver"),
  asyncHandler(async (req, res) => {
    const body = acceptRequestsSchema.parse(req.body);
    const result = await acceptRequests({ driverId: req.user.id, requestIds: body.requestIds });
    res.status(201).json(result);
  }),
);

ridesRouter.post(
  "/rides/:id/join",
  authenticate,
  requireRole("driver"),
  asyncHandler(async (req, res) => {
    const body = joinRideSchema.parse(req.body);
    res.json(
      await joinRide({ driverId: req.user.id, rideId: param(req, "id"), requestId: body.requestId }),
    );
  }),
);

// `complete` is also reachable by a passenger on the ride (see advanceRide),
// so this branch is registered without the driver role gate; every other
// transition still requires one.
for (const [action, next] of TRIP_ACTIONS) {
  const guards = action === "complete" ? [authenticate] : [authenticate, requireRole("driver")];
  ridesRouter.post(
    `/rides/:id/${action}`,
    ...guards,
    asyncHandler(async (req, res) => {
      const result = await advanceRide({
        rideId: param(req, "id"),
        actorId: req.user.id,
        actorRole: req.user.role,
        next,
      });
      res.json(result);
    }),
  );
}

// Advance one rider a single step, independent of the others on the trip.
ridesRouter.post(
  "/rides/:id/rider/advance",
  authenticate,
  requireRole("driver"),
  asyncHandler(async (req, res) => {
    const body = dropOffSchema.parse(req.body);
    res.json(
      await advanceRider({
        rideId: param(req, "id"),
        requestId: body.requestId,
        actorId: req.user.id,
      }),
    );
  }),
);

// Drop one rider off; the ride completes itself when the last one leaves.
ridesRouter.post(
  "/rides/:id/drop-off",
  authenticate,
  requireRole("driver"),
  asyncHandler(async (req, res) => {
    const body = dropOffSchema.parse(req.body);
    res.json(
      await dropOffRider({
        rideId: param(req, "id"),
        requestId: body.requestId,
        actorId: req.user.id,
      }),
    );
  }),
);

ridesRouter.get(
  "/rides/:id/events",
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ events: await eventsForRide(param(req, "id")) });
  }),
);

ridesRouter.get(
  "/driver/requests",
  authenticate,
  requireRole("driver"),
  asyncHandler(async (_req, res) => {
    res.json({ groups: await pendingPoolGroups() });
  }),
);

ridesRouter.get(
  "/driver/state",
  authenticate,
  requireRole("driver"),
  asyncHandler(async (req, res) => {
    // Polling endpoint: driver's online flag, active trip, pending poolable
    // groups and earnings, in one payload.
    res.json(await driverState(req.user.id));
  }),
);

ridesRouter.get(
  "/driver/history",
  authenticate,
  requireRole("driver"),
  asyncHandler(async (req, res) => {
    res.json({ trips: await driverHistory(req.user.id) });
  }),
);

ridesRouter.post(
  "/driver/online",
  authenticate,
  requireRole("driver"),
  asyncHandler(async (req, res) => {
    const { online } = setOnlineSchema.parse(req.body);
    await query("UPDATE users SET is_online = $2 WHERE id = $1", [req.user.id, online]);
    res.json({ online });
  }),
);
