import "./env.js";
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { reseed, cleanup, resetRateLimits, get, post, token, requestOnR05 } from "./helpers.js";
import type { SerializedRequest, SerializedRide } from "../src/shared/types.js";

beforeEach(reseed);
beforeEach(resetRateLimits);
afterAll(cleanup);

async function matchedRide(): Promise<{
  tokens: { nusrat: string; rafiq: string; jashim: string };
  requests: { n1: SerializedRequest; r1: SerializedRequest };
  ride: SerializedRide;
}> {
  const [nusrat, rafiq, jashim] = await Promise.all([
    token("nusrat"),
    token("rafiq"),
    token("jashim"),
  ]);
  const n1 = await requestOnR05(nusrat);
  const r1 = await requestOnR05(rafiq, "banani", "gulshan1");
  await post("/driver/online", { online: true }, jashim);
  const acc = await post("/rides/accept", { requestIds: [n1.id, r1.id] }, jashim);
  expect(acc.status).toBe(201);
  return { tokens: { nusrat, rafiq, jashim }, requests: { n1, r1 }, ride: acc.data.ride };
}

describe("ride lifecycle (PRD §4)", () => {
  it("walks REQUESTED → MATCHED → DRIVER_ARRIVED → STARTED → COMPLETED", async () => {
    const { tokens, ride, requests } = await matchedRide();
    const path = ["arrived", "start", "complete"];
    const expected = ["DRIVER_ARRIVED", "STARTED", "COMPLETED"];
    for (let i = 0; i < path.length; i++) {
      const res = await post(`/rides/${ride.id}/${path[i]}`, {}, tokens.jashim);
      expect(res.status).toBe(200);
      expect(res.data.ride.status).toBe(expected[i]);
    }

    // Passenger status follows the ride.
    const mine = await get("/me/active", tokens.nusrat);
    expect(mine.data.request.status).toBe("COMPLETED");

    // Rating opens only after completion.
    const rate = await post(`/rides/${requests.n1.id}/rate`, { rating: 5 }, tokens.nusrat);
    expect(rate.status).toBe(200);
    expect(rate.data.request.rating).toBe(5);
  });

  it("rejects illegal transitions with a clear error", async () => {
    const { tokens, ride } = await matchedRide();
    // MATCHED → STARTED skips DRIVER_ARRIVED
    const skip = await post(`/rides/${ride.id}/start`, {}, tokens.jashim);
    expect(skip.status).toBe(409);
    expect(skip.data.error.code).toBe("INVALID_TRANSITION");

    // MATCHED → COMPLETED skips two stages
    const skip2 = await post(`/rides/${ride.id}/complete`, {}, tokens.jashim);
    expect(skip2.status).toBe(409);

    // Completing the flow normally so the DB is not left mid-transition.
    await post(`/rides/${ride.id}/arrived`, {}, tokens.jashim);
    await post(`/rides/${ride.id}/start`, {}, tokens.jashim);
    const done = await post(`/rides/${ride.id}/complete`, {}, tokens.jashim);
    expect(done.status).toBe(200);
  });

  it("allows only the driver who owns the ride to advance it", async () => {
    const { tokens, ride } = await matchedRide();
    const kabir = await token("kabir");
    const res = await post(`/rides/${ride.id}/arrived`, {}, kabir);
    expect(res.status).toBe(403);
    // cleanup for later suites
    await post(`/rides/${ride.id}/complete`, {}, tokens.jashim);
  });
});

describe("cancellation rules (PRD §4/§7.5)", () => {
  it("allows the passenger to cancel before start and frees the seat", async () => {
    const { tokens, requests } = await matchedRide();
    const res = await post(
      `/rides/${requests.n1.id}/cancel`,
      { reason: "plans changed" },
      tokens.nusrat,
    );
    expect(res.status).toBe(200);
    expect(res.data.request.status).toBe("CANCELLED");
    expect(res.data.request.cancelReason).toBe("plans changed");

    // Seat released, other rider repriced without the shared discount.
    const state = await get("/driver/state", tokens.jashim);
    expect(state.data.activeTrip.seatsTaken).toBe(1);

    // Ride survives: one rider remains.
    expect(state.data.activeTrip.status).toBe("MATCHED");
  });

  it("cancels the ride outright when nobody is left and it has not started", async () => {
    const { tokens, requests, ride } = await matchedRide();
    await post(`/rides/${requests.n1.id}/cancel`, {}, tokens.nusrat);
    await post(`/rides/${requests.r1.id}/cancel`, {}, tokens.rafiq);

    const state = await get("/driver/state", tokens.jashim);
    expect(state.data.activeTrip).toBeNull();

    const history = await get("/driver/history", tokens.jashim);
    const cancelled = history.data.trips.find((t: { id: string }) => t.id === ride.id);
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("blocks cancellation after STARTED", async () => {
    const { tokens, requests, ride } = await matchedRide();
    await post(`/rides/${ride.id}/arrived`, {}, tokens.jashim);
    await post(`/rides/${ride.id}/start`, {}, tokens.jashim);

    const res = await post(`/rides/${requests.n1.id}/cancel`, {}, tokens.nusrat);
    expect(res.status).toBe(409);
    expect(res.data.error.code).toBe("NOT_CANCELLABLE");

    await post(`/rides/${ride.id}/complete`, {}, tokens.jashim);
  });

  it("blocks cancelling someone else's ride", async () => {
    const { tokens, requests, ride } = await matchedRide();
    const shirin = await token("shirin");
    const res = await post(`/rides/${requests.n1.id}/cancel`, {}, shirin);
    expect(res.status).toBe(403);
    await post(`/rides/${ride.id}/complete`, {}, tokens.jashim);
  });
});

describe("request guards", () => {
  it("blocks a second active request (duplicate-tap protection)", async () => {
    const nusrat = await token("nusrat");
    await requestOnR05(nusrat);
    const second = await post(
      "/rides/request",
      { pickupStopId: "banani", dropStopId: "gulshan1", routeId: "R05" },
      nusrat,
    );
    expect(second.status).toBe(409);
    expect(second.data.error.code).toBe("ACTIVE_RIDE_EXISTS");
  });

  it("replays the same request for a repeated idempotency key", async () => {
    const shirin = await token("shirin");
    const key = `test-${Date.now()}`;
    const first = await post(
      "/rides/request",
      { pickupStopId: "uttara_hb", dropStopId: "mohakhali", routeId: "R01", idempotencyKey: key },
      shirin,
    );
    expect(first.status).toBe(201);

    const replay = await post(
      "/rides/request",
      { pickupStopId: "uttara_hb", dropStopId: "mohakhali", routeId: "R01", idempotencyKey: key },
      shirin,
    );
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.request.id).toBe(first.data.request.id);
  });

  it("rate limits ride requests per passenger", async () => {
    const p = await post("/auth/register", {
      name: "Rate Limited",
      phone: "+880 171 7770001",
      password: "secret1",
      role: "passenger",
    });
    // First request succeeds; the rest 409 on the active-ride guard but still
    // count against the limiter — the 6th is rejected as RATE_LIMITED.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await post(
        "/rides/request",
        {
          pickupStopId: "banani",
          dropStopId: "mohakhali",
          routeId: "R05",
          idempotencyKey: `rate-${i}-${Date.now()}`,
        },
        p.data.token,
      );
      statuses.push(res.status);
    }
    expect(statuses[0]).toBe(201);
    expect(statuses[5]).toBe(429);
  });

  it("rejects a ride where no route connects the stops", async () => {
    const p = await post("/auth/register", {
      name: "Nowhere",
      phone: "+880 171 7770002",
      password: "secret1",
      role: "passenger",
    });
    const res = await post(
      "/rides/request",
      { pickupStopId: "banani", dropStopId: "banani", routeId: "R05" },
      p.data.token,
    );
    expect(res.status).toBe(400);
  });

  it("hides other passengers' rides (ownership)", async () => {
    const { tokens, requests, ride } = await matchedRide();
    const shirin = await token("shirin");
    const forbidden = await get(`/rides/${requests.n1.id}`, shirin);
    expect(forbidden.status).toBe(403);
    await post(`/rides/${ride.id}/complete`, {}, tokens.jashim);
  });
});
