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
  createRequest,
  declineRequest,
  driverHistory,
  driverState,
  eventsForRide,
  finishRideForPassenger,
  getRequestById,
  getRideById,
  admitRider,
  joinPreview,
  joinRideByStops,
  passengerHistory,
  pendingPoolGroups,
  rateRequest,
  requireVehicleForDriver,
  serializeRequestById,
  setWaitAndSave,
} from "./rides.service.js";
import { param } from "../../shared/http.js";
import { TRIP_ACTIONS } from "./rides.constants.js";
import {
  acceptRequestsSchema,
  cancelRideSchema,
  admitRiderSchema,
  joinByStopsSchema,
  previewSchema,
  rateRideSchema,
  requestRideSchema,
  setOnlineSchema,
  waitAndSaveSchema,
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

// Driver declines a pending request — it leaves THEIR list, stays open for
// the other drivers.
ridesRouter.post(
  "/rides/:id/decline",
  authenticate,
  requireRole("driver"),
  asyncHandler(async (req, res) => {
    res.json(await declineRequest({ driverId: req.user.id, requestId: param(req, "id") }));
  }),
);

// Wait-and-Save: the matched passenger holds their seat for the window to
// earn an extra 5% off (demo clock: 30 seconds).
ridesRouter.post(
  "/rides/:id/wait-and-save",
  authenticate,
  requireRole("passenger"),
  asyncHandler(async (req, res) => {
    const body = waitAndSaveSchema.parse(req.body);
    res.json({
      request: await setWaitAndSave({
        passengerId: req.user.id,
        requestId: param(req, "id"),
        accept: body.accept,
      }),
    });
  }),
);

// "I am out at my stop" — the passenger completes their own leg; the ride
// completes when nobody is left riding.
ridesRouter.post(
  "/rides/:id/finish",
  authenticate,
  requireRole("passenger"),
  asyncHandler(async (req, res) => {
    res.json(
      await finishRideForPassenger({ passengerId: req.user.id, requestId: param(req, "id") }),
    );
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

ridesRouter.get(
  "/rides/:id/preview",
  authenticate,
  requireRole("passenger"),
  asyncHandler(async (req, res) => {
    const query = previewSchema.parse({
      pickupStopId: req.query.pickupStopId,
      dropStopId: req.query.dropStopId,
    });
    res.json(
      await joinPreview({
        passengerId: req.user.id,
        rideId: param(req, "id"),
        pickupStopId: query.pickupStopId,
        dropStopId: query.dropStopId,
      }),
    );
  }),
);

// Driver admits a pre-booked (REQUESTED) rider into their own running trip.
ridesRouter.post(
  "/rides/:id/admit",
  authenticate,
  requireRole("driver"),
  asyncHandler(async (req, res) => {
    const body = admitRiderSchema.parse(req.body);
    res.json(
      await admitRider({ driverId: req.user.id, rideId: param(req, "id"), requestId: body.requestId }),
    );
  }),
);

// Hop-on joining: the passenger picks get-in/get-out stops on the running
// trip and claims a free seat themselves — no driver approval needed.
ridesRouter.post(
  "/rides/:id/join",
  authenticate,
  requireRole("passenger"),
  asyncHandler(async (req, res) => {
    const body = joinByStopsSchema.parse(req.body);
    const result = await joinRideByStops({
      passengerId: req.user.id,
      rideId: param(req, "id"),
      pickupStopId: body.pickupStopId,
      dropStopId: body.dropStopId,
      idempotencyKey: body.idempotencyKey ?? null,
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);

for (const [action, next] of TRIP_ACTIONS) {
  ridesRouter.post(
    `/rides/:id/${action}`,
    authenticate,
    requireRole("driver"),
    asyncHandler(async (req, res) => {
      const result = await advanceRide({ rideId: param(req, "id"), driverId: req.user.id, next });
      res.json(result);
    }),
  );
}

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
