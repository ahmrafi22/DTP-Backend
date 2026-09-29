import "./env.js";
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { reseed, cleanup, api, get, post, token, requestOnR05, registerPassenger } from "./helpers.js";
import { query } from "../src/shared/db.js";
import type { SerializedRequest, SerializedRide } from "../src/shared/types.js";

beforeEach(reseed);
afterAll(cleanup);

interface SeatRow {
  seats_taken: number;
  capacity: number;
  status: string;
}

async function rideWithSeats(n: number): Promise<{
  jashim: string;
  ride: SerializedRide;
  requestIds: string[];
}> {
  // Nusrat + Rafiq always ride; add extra passengers to fill more seats.
  const [jashim, nusrat, rafiq] = await Promise.all([
    token("jashim"),
    token("nusrat"),
    token("rafiq"),
  ]);
  const requests: SerializedRequest[] = [await requestOnR05(nusrat)];
  if (n > 1) requests.push(await requestOnR05(rafiq, "banani", "gulshan1"));
  for (let i = 2; i < n; i++) {
    const p = await post("/auth/register", {
      name: `Extra ${i}`,
      phone: `+880 170 555000${i}`,
      password: "secret1",
      role: "passenger",
    });
    requests.push(await requestOnR05(p.data.token, "gulshan2", "gulshan1"));
  }
  await post("/driver/online", { online: true }, jashim);
  const acc = await post("/rides/accept", { requestIds: requests.map((r) => r.id) }, jashim);
  expect(acc.status).toBe(201);
  return {
    jashim,
    ride: acc.data.ride as SerializedRide,
    requestIds: requests.map((r) => r.id),
  };
}

describe("pool capacity (PRD §11/§14)", () => {
  it("rejects accepting a group larger than the vehicle", async () => {
    // Four riders on shared legs would need 4 seats; Bullet has 3.
    const jashim = await token("jashim");
    const tokens: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await post("/auth/register", {
        name: `Crowd ${i}`,
        phone: `+880 170 666000${i}`,
        password: "secret1",
        role: "passenger",
      });
      tokens.push(p.data.token);
      await requestOnR05(tokens[i] as string, "banani", "gulshan1");
    }
    await post("/driver/online", { online: true }, jashim);
    const state = await get("/driver/state", jashim);
    const all = state.data.pendingGroups.find((g: { seats: number }) => g.seats === 4);
    expect(all).toBeTruthy();
    expect(all.fits).toBe(false);

    const res = await post("/rides/accept", { requestIds: all.requestIds }, jashim);
    expect(res.status).toBe(409);
    expect(res.data.error.code).toBe("NOT_ENOUGH_SEATS");
  });

  it("lets exactly one of two concurrent joiners claim the last seat", async () => {
    const { jashim, ride } = await rideWithSeats(2); // 2/3 used, one seat left

    // Two riders request overlapping legs at the same time.
    const [pa, pb] = await Promise.all([
      post("/auth/register", {
        name: "Race A",
        phone: "+880 170 8880001",
        password: "secret1",
        role: "passenger",
      }),
      post("/auth/register", {
        name: "Race B",
        phone: "+880 170 8880002",
        password: "secret1",
        role: "passenger",
      }),
    ]);
    const [ra, rb] = await Promise.all([
      requestOnR05(pa.data.token, "gulshan2", "gulshan1"),
      requestOnR05(pb.data.token, "gulshan2", "gulshan1"),
    ]);

    // Both joins hit the server at the same instant.
    const [joinA, joinB] = await Promise.all([
      api("post", `/rides/${ride.id}/join`, { token: jashim, body: { requestId: ra.id } }),
      api("post", `/rides/${ride.id}/join`, { token: jashim, body: { requestId: rb.id } }),
    ]);

    expect([joinA.status, joinB.status].sort()).toEqual([200, 409]);
    const loser = joinA.status === 409 ? joinA : joinB;
    expect(loser.data.error.code).toBe("RIDE_FULL");

    // Database truth: never overbooked.
    const { rows } = await query<SeatRow>(
      "SELECT seats_taken, capacity, status FROM rides WHERE id = $1",
      [ride.id],
    );
    expect(rows[0]?.seats_taken).toBe(3);
    expect(rows[0]?.seats_taken).toBeLessThanOrEqual(rows[0]?.capacity as number);
  });

  it("lets exactly one driver win a contested request", async () => {
    const [nusrat, jashim, kabir] = await Promise.all([
      token("nusrat"),
      token("jashim"),
      token("kabir"),
    ]);
    const n1 = await requestOnR05(nusrat);

    await post("/driver/online", { online: true }, jashim);
    await post("/driver/online", { online: true }, kabir);

    const [fromJashim, fromKabir] = await Promise.all([
      api("post", "/rides/accept", { token: jashim, body: { requestIds: [n1.id] } }),
      api("post", "/rides/accept", { token: kabir, body: { requestIds: [n1.id] } }),
    ]);

    expect([fromJashim.status, fromKabir.status].sort()).toEqual([201, 409]);
    const loser = fromJashim.status === 409 ? fromJashim : fromKabir;
    expect(loser.data.error.code).toBe("REQUEST_NO_LONGER_AVAILABLE");
  });

  it("rejects a mid-trip joiner whose route does not overlap", async () => {
    const { jashim, ride } = await rideWithSeats(1);

    // Shirin rides the Airport Road corridor — no shared leg with R05.
    const shirin = await token("shirin");
    const s1 = await post(
      "/rides/request",
      { pickupStopId: "uttara_hb", dropStopId: "mohakhali", routeId: "R01" },
      shirin,
    );
    expect(s1.status).toBe(201);

    const join = await post(`/rides/${ride.id}/join`, { requestId: s1.data.request.id }, jashim);
    expect(join.status).toBe(409);

    const { rows } = await query<{ seats_taken: number }>(
      "SELECT seats_taken FROM rides WHERE id = $1",
      [ride.id],
    );
    expect(rows[0]?.seats_taken).toBe(1);
  });

  it("cannot join a ride that is not active", async () => {
    const { jashim, ride } = await rideWithSeats(1);
    await post(`/rides/${ride.id}/arrived`, {}, jashim);
    await post(`/rides/${ride.id}/start`, {}, jashim);
    await post(`/rides/${ride.id}/complete`, {}, jashim);

    const late = await post("/auth/register", {
      name: "Too Late",
      phone: "+880 170 8880009",
      password: "secret1",
      role: "passenger",
    });
    const req = await requestOnR05(late.data.token, "banani", "gulshan1");
    const join = await post(`/rides/${ride.id}/join`, { requestId: req.id }, jashim);
    expect(join.status).toBe(409);
    expect(join.data.error.code).toBe("RIDE_NOT_ACTIVE");
  });
});

describe("offline enforcement", () => {
  it("lets an offline driver see requests but not claim seats", async () => {
    const [nusrat, jashim] = await Promise.all([token("nusrat"), token("jashim")]);
    const n1 = await requestOnR05(nusrat);

    // Seed starts Jashim online; flip him off.
    await post("/driver/online", { online: false }, jashim);

    // Viewing is a demand preview and stays allowed while offline.
    const view = await get("/driver/state", jashim);
    expect(view.status).toBe(200);
    expect(view.data.pendingGroups.length).toBeGreaterThan(0);

    const acc = await post("/rides/accept", { requestIds: [n1.id] }, jashim);
    expect(acc.status).toBe(409);
    expect(acc.data.error.code).toBe("DRIVER_OFFLINE");

    // The same accept succeeds once the driver goes online.
    await post("/driver/online", { online: true }, jashim);
    const acc2 = await post("/rides/accept", { requestIds: [n1.id] }, jashim);
    expect(acc2.status).toBe(201);

    // Mid-trip joins are seat claims too — blocked while offline.
    await post("/driver/online", { online: false }, jashim);
    const p = await registerPassenger("Offline Joiner");
    const joiner = await requestOnR05(p.token, "gulshan2", "gulshan1");
    const join = await post(`/rides/${acc2.data.ride.id}/join`, { requestId: joiner.id }, jashim);
    expect(join.status).toBe(409);
    expect(join.data.error.code).toBe("DRIVER_OFFLINE");

    // The rejected claim left the ride untouched.
    const { rows } = await query<SeatRow>(
      "SELECT seats_taken FROM rides WHERE id = $1",
      [acc2.data.ride.id],
    );
    expect(rows[0]?.seats_taken).toBe(1);
  });
});
