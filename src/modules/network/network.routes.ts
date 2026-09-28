import { Router } from "express";
import { query } from "../../shared/db.js";
import { asyncHandler } from "../../shared/errors.js";
import { authenticate } from "../../middleware/auth.js";
import { findRoutes, getRoute, legsBetween, priceLegs, shortestPath } from "../../graph/index.js";

import { resolveTrip } from "../rides/rides.service.js";
import { estimateFareSchema } from "./network.schema.js";
import type { FareOption } from "./network.schema.js";
import type { LegRow, RouteRow, RouteStopRow, StopRow } from "../../shared/types.js";

export const networkRouter = Router();

/** Full predefined graph — stops, legs, routes — for pickers and the map. */
networkRouter.get(
  "/network",
  asyncHandler(async (_req, res) => {
    const stops = (await query<StopRow>("SELECT id, name, zone, lat, lng FROM stops ORDER BY name")).rows;
    const legs = (
      await query<LegRow>(
        "SELECT id, from_stop, to_stop, km, duration_min, price_paisa FROM legs ORDER BY id",
      )
    ).rows.map((l) => ({
      id: l.id,
      from: l.from_stop,
      to: l.to_stop,
      // km is NUMERIC, which pg hands back as a string.
      km: Number(l.km),
      durationMin: l.duration_min,
      pricePaisa: l.price_paisa,
    }));

    const { rows: routeStops } = await query<RouteStopRow>(
      "SELECT route_id, stop_id FROM route_stops ORDER BY route_id, position",
    );
    const { rows: routes } = await query<RouteRow>(
      "SELECT id, name, corridor FROM routes ORDER BY id",
    );

    res.json({
      stops,
      legs,
      routes: routes.map((r) => ({
        id: r.id,
        name: r.name,
        corridor: r.corridor,
        stopIds: routeStops.filter((rs) => rs.route_id === r.id).map((rs) => rs.stop_id),
      })),
    });
  }),
);

/**
 * Fare estimate (PRD passenger: "see the estimated fare before confirming").
 * With routeId: that corridor's legs. Without: every direct corridor option
 * plus a shortest-path fallback, each priced solo.
 */
networkRouter.post(
  "/fare/estimate",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = estimateFareSchema.parse(req.body);

    if (body.routeId) {
      const trip = resolveTrip(body);
      const route = getRoute(body.routeId);
      if (!route) {
        res.json({ options: [] });
        return;
      }
      const options: FareOption[] = [
        {
          routeId: body.routeId,
          title: route.name,
          sub: `${route.corridor} · ${trip.stopIds.length} stops`,
          legIds: trip.legs.map((l) => l.id),
          stopIds: trip.stopIds,
          fare: priceLegs(trip.legs),
        },
      ];
      res.json({ options });
      return;
    }

    const options: FareOption[] = [];
    for (const route of findRoutes(body.pickupStopId, body.dropStopId)) {
      const legs = legsBetween(route.id, body.pickupStopId, body.dropStopId);
      if (!legs) continue;
      const i = route.stops.indexOf(body.pickupStopId);
      const j = route.stops.indexOf(body.dropStopId);
      options.push({
        routeId: route.id,
        title: route.name,
        sub: `${route.corridor} · ${Math.abs(j - i) + 1} stops`,
        legIds: legs.map((l) => l.id),
        stopIds: route.stops.slice(Math.min(i, j), Math.max(i, j) + 1),
        fare: priceLegs(legs),
      });
    }

    if (options.length === 0) {
      const path = shortestPath(body.pickupStopId, body.dropStopId, "durationMin");
      if (path) {
        options.push({
          routeId: null,
          title: "Fastest path",
          sub: `Multi-corridor · ${path.legs.length} legs`,
          legIds: path.legs.map((l) => l.id),
          stopIds: path.stops,
          fare: priceLegs(path.legs),
        });
      }
    }

    res.json({ options });
  }),
);
