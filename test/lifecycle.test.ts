import "./env.js";
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { reseed, cleanup, resetRateLimits, get, post, token, requestOnR05 } from "./helpers.js";
import { query } from "../src/shared/db.js";

beforeEach(async () => {
  await reseed();
  resetRateLimits();
});
afterAll(cleanup);

/**
 * The assessment lifecycle around the matched state:
 *   accept → (optional wait-and-save promise) → arrive → start → rider out.
 */
describe("decline, wait-and-save and passenger finish", () => {
  it("hides a declined request from that driver only", async () => {
    const [nusrat, jashim, kabir] = await Promise.all([
      token("nusrat"),
      token("jashim"),
      token("kabir"),
    ]);
    const n1 = await requestOnR05(nusrat);
    await post("/driver/online", { online: true }, jashim);
    await post("/driver/online", { online: true }, kabir);

    expect((await get("/driver/state", jashim)).data.pendingGroups.length).toBe(1);
    expect((await get("/driver/state", kabir)).data.pendingGroups.length).toBe(1);

    const declined = await post(`/rides/${n1.id}/decline`, {}, jashim);
    expect(declined.status).toBe(200);

    // Gone for Jashim, still open for Kabir.
    expect((await get("/driver/state", jashim)).data.pendingGroups.length).toBe(0);
    expect((await get("/driver/state", kabir)).data.pendingGroups.length).toBe(1);

    // And Kabir can still take it.
    const acc = await post("/rides/accept", { requestIds: [n1.id] }, kabir);
    expect(acc.status).toBe(201);
  });

  it("offers wait-and-save once and applies the extra 5% when the trip completes", async () => {
    const [nusrat, jashim] = await Promise.all([token("nusrat"), token("jashim")]);
    const n1 = await requestOnR05(nusrat);
    const acc = await post("/rides/accept", { requestIds: [n1.id] }, jashim);
    const rideId = acc.data.ride.id;

    const before = acc.data.requests[0].fare.total;

    const accepted = await post(`/rides/${n1.id}/wait-and-save`, { accept: true }, nusrat);
    expect(accepted.status).toBe(200);
    expect(accepted.data.request.waitAndSave).toBe(true);
    expect(accepted.data.request.waitDeadline).toBeTruthy();

    // Answerable only once.
    const again = await post(`/rides/${n1.id}/wait-and-save`, { accept: false }, nusrat);
    expect(again.status).toBe(409);
    expect(again.data.error.code).toBe("ALREADY_DECIDED");

    // Let the (30s) promise run out, then complete the trip.
    await query(`UPDATE ride_requests SET wait_deadline = now() - interval '1 second' WHERE id = $1`, [n1.id]);
    await post(`/rides/${rideId}/arrived`, {}, jashim);
    await post(`/rides/${rideId}/start`, {}, jashim);
    await post(`/rides/${rideId}/complete`, {}, jashim);

    const mine = (await get(`/rides/${n1.id}`, nusrat)).data.request;
    const expectedExtra = Math.round((mine.fare.distanceCharge * 5) / 100);
    expect(mine.fare.poolDiscount).toBeGreaterThan(0);
    expect(mine.fare.total).toBe(before - expectedExtra);

    // The audit trail explains the extra line.
    const events = (await get(`/rides/${rideId}/events`, jashim)).data.events.map((e: { event: string }) => e.event);
    expect(events).toContain("WAIT_AND_SAVE_ACCEPTED");
    expect(events).toContain("WAIT_AND_SAVE_APPLIED");
  });

  it("does not discount a wait that was declined", async () => {
    const [nusrat, jashim] = await Promise.all([token("nusrat"), token("jashim")]);
    const n1 = await requestOnR05(nusrat);
    const acc = await post("/rides/accept", { requestIds: [n1.id] }, jashim);
    const before = acc.data.requests[0].fare.total;

    const declined = await post(`/rides/${n1.id}/wait-and-save`, { accept: false }, nusrat);
    expect(declined.status).toBe(200);
    expect(declined.data.request.waitAndSave).toBe(false);
    expect(declined.data.request.waitDeadline).toBeNull();

    await post(`/rides/${acc.data.ride.id}/complete`, {}, jashim);
    const mine = (await get(`/rides/${n1.id}`, nusrat)).data.request;
    expect(mine.fare.total).toBe(before);
  });

  it("lets the passenger mark their own leg finished and completes an empty ride", async () => {
    const [nusrat, rafiq, jashim] = await Promise.all([
      token("nusrat"),
      token("rafiq"),
      token("jashim"),
    ]);
    const n1 = await requestOnR05(nusrat);
    const r1 = await requestOnR05(rafiq, "banani", "gulshan1");
    const acc = await post("/rides/accept", { requestIds: [n1.id, r1.id] }, jashim);
    const rideId = acc.data.ride.id;
    await post(`/rides/${rideId}/arrived`, {}, jashim);
    await post(`/rides/${rideId}/start`, {}, jashim);

    // Only your own leg.
    const foreign = await post(`/rides/${r1.id}/finish`, {}, nusrat);
    expect(foreign.status).toBe(403);

    const first = await post(`/rides/${n1.id}/finish`, {}, nusrat);
    expect(first.status).toBe(200);
    expect(first.data.request.status).toBe("COMPLETED");
    expect(first.data.ride.status).toBe("STARTED"); // Rafiq still riding

    const second = await post(`/rides/${r1.id}/finish`, {}, rafiq);
    expect(second.status).toBe(200);
    expect(second.data.ride.status).toBe("COMPLETED");

    // Both riders are done — nobody is "active" any more.
    const active = (await get("/me/active", nusrat)).data;
    expect(active === null || active.request.status === "COMPLETED").toBe(true);
  });
});
