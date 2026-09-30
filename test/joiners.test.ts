import "./env.js";
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { reseed, cleanup, get, post, token, requestOnR05, resetRateLimits } from "./helpers.js";
import { query } from "../src/shared/db.js";
import type { SerializedRequest, SerializedRide } from "../src/shared/types.js";

// POST /rides/request is rate limited per passenger, and the buckets outlive
// a reseed — this file books more rides per cast member than any other, so
// they have to be cleared between tests or the sixth booking 429s.
beforeEach(async () => {
  resetRateLimits();
  await reseed();
});
afterAll(cleanup);

/**
 * A trip with Jashim driving, Nusrat aboard and Rafiq queued on an overlapping
 * route — the two-rider shape the driver console has to render.
 */
async function twoRiderTrip(): Promise<{
  jashim: string;
  nusrat: string;
  rafiq: string;
  ride: SerializedRide;
  nusratReq: SerializedRequest;
  rafiqReq: SerializedRequest;
}> {
  const [jashim, nusrat, rafiq] = await Promise.all([
    token("jashim"),
    token("nusrat"),
    token("rafiq"),
  ]);
  const nusratReq = await requestOnR05(nusrat, "banani", "mohakhali");
  const rafiqReq = await requestOnR05(rafiq, "banani", "gulshan1");
  await post("/driver/online", { online: true }, jashim);
  const acc = await post(
    "/rides/accept",
    { requestIds: [nusratReq.id, rafiqReq.id] },
    jashim,
  );
  expect(acc.status).toBe(201);
  return {
    jashim,
    nusrat,
    rafiq,
    ride: acc.data.ride as SerializedRide,
    nusratReq,
    rafiqReq,
  };
}

const statusOf = async (id: string): Promise<string | undefined> => {
  const { rows } = await query<{ status: string }>(
    "SELECT status FROM ride_requests WHERE id = $1",
    [id],
  );
  return rows[0]?.status;
};

const rideStatus = async (id: string): Promise<string | undefined> => {
  const { rows } = await query<{ status: string }>(
    "SELECT status FROM rides WHERE id = $1",
    [id],
  );
  return rows[0]?.status;
};

describe("a joining passenger starts from the beginning", () => {
  it("boards a STARTED trip at MATCHED, not at the trip's own stage", async () => {
    const { jashim, ride } = await twoRiderTrip();
    // Get the car moving before Rafiq is pulled in.
    await post(`/rides/${ride.id}/arrived`, {}, jashim);
    await post(`/rides/${ride.id}/start`, {}, jashim);
    expect(await rideStatus(ride.id)).toBe("STARTED");

    const late = await post("/auth/register", {
      name: "Late Joiner",
      phone: "+880 170 4440001",
      password: "secret1",
      role: "passenger",
    });
    const pending = await requestOnR05(late.data.token, "gulshan2", "gulshan1");

    const join = await post(
      `/rides/${ride.id}/join`,
      { requestId: pending.id },
      jashim,
    );
    expect(join.status).toBe(200);
    expect(join.data.request.status).toBe("MATCHED");
    expect(await statusOf(pending.id)).toBe("MATCHED");

    // The trip itself is untouched by the join — a new rider must not drag the
    // car backwards to "driver on the way".
    expect(await rideStatus(ride.id)).toBe("STARTED");
  });

  it("puts a hop-on rider at MATCHED too, with no wait-and-save discount", async () => {
    const { jashim, ride } = await twoRiderTrip();
    await post(`/rides/${ride.id}/arrived`, {}, jashim);
    await post(`/rides/${ride.id}/start`, {}, jashim);

    const shirin = await token("shirin");
    const hop = await post(
      `/rides/${ride.id}/hop-on`,
      // Gulshan 2 -> Gulshan 1 is still ahead of the car on R05.
      { pickupStopId: "gulshan2", dropStopId: "gulshan1", paymentMethod: "CASH" },
      shirin,
    );
    expect(hop.status).toBe(201);
    expect(hop.data.request.status).toBe("MATCHED");
    expect(hop.data.request.waitAndSave).toBe(false);
    expect(hop.data.request.fare.waitSaveDiscount).toBe(0);
  });

  it("walks a joining rider through arrived -> start -> drop off by hand", async () => {
    const { jashim, ride } = await twoRiderTrip();
    const late = await post("/auth/register", {
      name: "Stage Joiner",
      phone: "+880 170 4440002",
      password: "secret1",
      role: "passenger",
    });
    const pending = await requestOnR05(late.data.token, "gulshan2", "gulshan1");
    await post(`/rides/${ride.id}/join`, { requestId: pending.id }, jashim);

    // MATCHED -> the driver confirms they have arrived at the pickup stop.
    const arrived = await post(
      `/rides/${ride.id}/rider/advance`,
      { requestId: pending.id },
      jashim,
    );
    expect(arrived.status).toBe(200);
    expect(arrived.data.request.status).toBe("DRIVER_ARRIVED");

    const started = await post(
      `/rides/${ride.id}/rider/advance`,
      { requestId: pending.id },
      jashim,
    );
    expect(started.data.request.status).toBe("STARTED");

    // Reaching their own destination finishes that passenger's ride.
    const dropped = await post(
      `/rides/${ride.id}/rider/advance`,
      { requestId: pending.id },
      jashim,
    );
    expect(dropped.data.request.status).toBe("COMPLETED");
  });
});

describe("each passenger finishes at their own destination", () => {
  it("completes only the rider dropped off, then ends the trip on the last one", async () => {
    const { jashim, ride, nusratReq, rafiqReq } = await twoRiderTrip();
    await post(`/rides/${ride.id}/arrived`, {}, jashim);
    await post(`/rides/${ride.id}/start`, {}, jashim);

    // Rafiq gets out at Gulshan 1, well before Nusrat reaches Mohakhali.
    const first = await post(
      `/rides/${ride.id}/rider/advance`,
      { requestId: rafiqReq.id },
      jashim,
    );
    expect(first.status).toBe(200);
    expect(first.data.request.status).toBe("COMPLETED");
    // The other rider is still on board, so their ride is untouched and the
    // car has not finished.
    expect(await statusOf(nusratReq.id)).toBe("STARTED");
    expect(await rideStatus(ride.id)).toBe("STARTED");

    const second = await post(
      `/rides/${ride.id}/rider/advance`,
      { requestId: nusratReq.id },
      jashim,
    );
    expect(second.data.request.status).toBe("COMPLETED");
    expect(await rideStatus(ride.id)).toBe("COMPLETED");
  });
});

describe("TeslaCash settlement", () => {
  it("settles a wallet rider into a negative balance rather than leaving the fare unpaid", async () => {
    const [jashim, shirin] = await Promise.all([token("jashim"), token("shirin")]);

    // Shirin books on TeslaCash with a balance of 0.
    const before = await get("/wallet", shirin);
    expect(before.data.balancePaisa).toBe(0);

    const req = await post(
      "/rides/request",
      {
        pickupStopId: "banani",
        dropStopId: "mohakhali",
        routeId: "R05",
        paymentMethod: "WALLET",
      },
      shirin,
    );
    expect(req.status).toBe(201);
    const fare = req.data.request.fare.total as number;
    expect(fare).toBeGreaterThan(0);

    await post("/driver/online", { online: true }, jashim);
    await post("/rides/accept", { requestIds: [req.data.request.id] }, jashim);

    const ride = (await get("/driver/state", jashim)).data.activeTrip;
    expect(ride).toBeTruthy();
    await post(`/rides/${ride.id}/arrived`, {}, jashim);
    await post(`/rides/${ride.id}/start`, {}, jashim);
    await post(`/rides/${ride.id}/complete`, {}, jashim);

    // The debt is real and visible, not silently dropped.
    const after = await get("/wallet", shirin);
    expect(after.data.balancePaisa).toBe(-fare);

    const driver = await get("/wallet", jashim);
    expect(driver.data.balancePaisa).toBe(fare);

    const settled = await query<{ settled: boolean; payment_method: string }>(
      "SELECT settled_at IS NOT NULL AS settled, payment_method FROM ride_requests WHERE id = $1",
      [req.data.request.id],
    );
    expect(settled.rows[0]?.settled).toBe(true);
    expect(settled.rows[0]?.payment_method).toBe("WALLET");

    // The ledger still reconciles: one signed charge, one signed earning.
    const statement = await get("/wallet/transactions", shirin);
    const charge = statement.data.transactions.find(
      (t: { kind: string; requestId: string | null }) =>
        t.kind === "RIDE_CHARGE" && t.requestId === req.data.request.id,
    );
    expect(charge.amountPaisa).toBe(-fare);
    expect(charge.balanceAfterPaisa).toBe(-fare);
  });

  it("repays the debt on the next top-up", async () => {
    const [jashim, rafiq] = await Promise.all([token("jashim"), token("rafiq")]);
    const req = await post(
      "/rides/request",
      {
        pickupStopId: "banani",
        dropStopId: "mohakhali",
        routeId: "R05",
        paymentMethod: "WALLET",
      },
      rafiq,
    );
    await post("/driver/online", { online: true }, jashim);
    await post("/rides/accept", { requestIds: [req.data.request.id] }, jashim);
    const ride = (await get("/driver/state", jashim)).data.activeTrip;
    await post(`/rides/${ride.id}/arrived`, {}, jashim);
    await post(`/rides/${ride.id}/start`, {}, jashim);
    await post(`/rides/${ride.id}/complete`, {}, jashim);

    const owed = (await get("/wallet", rafiq)).data.balancePaisa;
    expect(owed).toBeLessThan(0);

    const topped = await post("/wallet/top-up", {}, rafiq);
    expect(topped.status).toBe(201);
    expect(topped.data.balancePaisa).toBe(owed + 10_000);
  });

  it("leaves a cash rider's wallet alone", async () => {
    const [jashim, rafiq] = await Promise.all([token("jashim"), token("rafiq")]);
    const req = await requestOnR05(rafiq); // default CASH
    await post("/driver/online", { online: true }, jashim);
    await post("/rides/accept", { requestIds: [req.id] }, jashim);
    const ride = (await get("/driver/state", jashim)).data.activeTrip;
    await post(`/rides/${ride.id}/arrived`, {}, jashim);
    await post(`/rides/${ride.id}/start`, {}, jashim);
    await post(`/rides/${ride.id}/complete`, {}, jashim);

    expect((await get("/wallet", rafiq)).data.balancePaisa).toBe(0);
    expect((await get("/wallet", jashim)).data.balancePaisa).toBe(0);
    const row = await query<{ settled_at: Date | null }>(
      "SELECT settled_at FROM ride_requests WHERE id = $1",
      [req.id],
    );
    expect(row.rows[0]?.settled_at).toBeNull();
  });
});

describe("wait and save stays with the first rider", () => {
  // This one books three rides and walks the whole lifecycle, so it has more
  // network round trips than a 30s budget allows against a pooled Postgres
  // over the internet. The assertions are what matter, not the latency.
  it("does not migrate to whoever is left when the first rider is dropped off", { timeout: 90_000 }, async () => {
    const [jashim, nusrat, rafiq, shirin] = await Promise.all([
      token("jashim"),
      token("nusrat"),
      token("rafiq"),
      token("shirin"),
    ]);
    // Both riders promise to wait, but only the one who booked first earns the
    // discount — she is the one the driver held the car for.
    const nReq = await post(
      "/rides/request",
      { pickupStopId: "banani", dropStopId: "gulshan1", routeId: "R05", waitAndSave: true },
      nusrat,
    );
    const rReq = await post(
      "/rides/request",
      { pickupStopId: "banani", dropStopId: "gulshan1", routeId: "R05", waitAndSave: true },
      rafiq,
    );
    await post("/driver/online", { online: true }, jashim);
    await post(
      "/rides/accept",
      { requestIds: [nReq.data.request.id, rReq.data.request.id] },
      jashim,
    );
    const ride = (await get("/driver/state", jashim)).data.activeTrip;
    await post(`/rides/${ride.id}/arrived`, {}, jashim);
    await post(`/rides/${ride.id}/start`, {}, jashim);

    // Read both discounts in one round trip rather than two HTTP GETs.
    const discounts = async () => {
      const { rows } = await query<{ id: string; wait: number; pool: number }>(
        `SELECT id, wait_save_discount_paisa AS wait, pool_discount_paisa AS pool
         FROM ride_requests WHERE id = ANY($1::text[])`,
        [[nReq.data.request.id, rReq.data.request.id]],
      );
      return new Map(rows.map((r) => [r.id, r]));
    };
    const before = await discounts();
    expect(before.get(nReq.data.request.id)?.wait).toBeGreaterThan(0);
    expect(before.get(rReq.data.request.id)?.wait).toBe(0);

    // Nusrat — the rider who actually waited — is dropped off first. Any
    // repricing from here on must not hand Rafiq the discount she earned.
    await post(`/rides/${ride.id}/rider/advance`, { requestId: nReq.data.request.id }, jashim);
    expect(await statusOf(nReq.data.request.id)).toBe("COMPLETED");

    // A later join reprices everyone still aboard — that is the moment the
    // discount would previously have migrated.
    const late = await post(
      "/rides/request",
      { pickupStopId: "gulshan2", dropStopId: "gulshan1", routeId: "R05" },
      shirin,
    );
    const join = await post(
      `/rides/${ride.id}/join`,
      { requestId: late.data.request.id },
      jashim,
    );
    expect(join.status).toBe(200);

    const after = await discounts();
    expect(after.get(rReq.data.request.id)?.wait).toBe(0);
    // The shared-leg discount still applies — that is pooling, not a promise.
    expect(after.get(rReq.data.request.id)?.pool).toBeGreaterThan(0);
  });
});