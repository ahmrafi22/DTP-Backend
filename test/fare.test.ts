import "./env.js";
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { priceLegs } from "../src/graph/index.js";
import type { Edge } from "../src/graph/index.js";
import { reseed, cleanup, get, post, token, requestOnR05 } from "./helpers.js";
import type { SerializedRequest } from "../src/shared/types.js";

beforeEach(reseed);
afterAll(cleanup);

/**
 * PRD §6 reference example: route A→F, five legs of ৳100 each, base fare 0.
 * User1 rides A→F, User2 B→D, User3 C→F.
 * Expected per-line payments: User1 410, User2 150, User3 230 (base 0).
 * The real base fare (3000 paisa) shifts totals by a constant; the per-leg
 * math and savings are what the PRD pins down.
 */
const TAKA = 10000; // ৳100 per leg, per the PRD example
const mkLeg = (id: string, from: string, to: string): Edge =>
  ({ id, from, to, km: 1, congestion: 1, durationMin: 2, pricePaisa: TAKA });

const legs: Record<string, Edge> = {
  ab: mkLeg("ab", "a", "b"),
  bc: mkLeg("bc", "b", "c"),
  cd: mkLeg("cd", "c", "d"),
  de: mkLeg("de", "d", "e"),
  ef: mkLeg("ef", "e", "f"),
};

function fareFor(userLegs: string[], allUsers: string[][]) {
  const ridersPerLeg: Record<string, number> = {};
  for (const id of userLegs) {
    ridersPerLeg[id] = allUsers.filter((l) => l.includes(id)).length;
  }
  return priceLegs(
    userLegs.map((id) => legs[id]).filter((l): l is Edge => l !== undefined),
    ridersPerLeg,
  );
}

describe("fare engine (PRD §6 worked example)", () => {
  const u1 = ["ab", "bc", "cd", "de", "ef"];
  const u2 = ["bc", "cd"];
  const u3 = ["cd", "de", "ef"];
  const all = [u1, u2, u3];

  it("charges 0/20/30% discount tiers by riders on a leg", () => {
    expect(priceLegs([legs.ab as Edge]).poolDiscount).toBe(0);
    const shared2 = fareFor(["ab", "bc"], [["ab", "bc"], ["bc"]]);
    // bc has 2 riders → 20%
    expect(shared2.lines.find((l) => l.edgeId === "bc")?.paidPaisa).toBe(8000);
    expect(shared2.lines.find((l) => l.edgeId === "ab")?.paidPaisa).toBe(10000);
  });

  it("produces 410, 150 and 230 for the reference example (base 0)", () => {
    const f1 = fareFor(u1, all);
    const f2 = fareFor(u2, all);
    const f3 = fareFor(u3, all);

    expect(f1.lines.map((l) => l.paidPaisa)).toEqual([10000, 8000, 7000, 8000, 8000]);
    expect(f2.lines.map((l) => l.paidPaisa)).toEqual([8000, 7000]);
    expect(f3.lines.map((l) => l.paidPaisa)).toEqual([7000, 8000, 8000]);

    // 410/150/230 plus the real base fare of ৳30 each
    expect(f1.total).toBe(3000 + 41000);
    expect(f1.distanceCharge - f1.poolDiscount).toBe(41000);
    expect(f2.distanceCharge - f2.poolDiscount).toBe(15000);
    expect(f3.distanceCharge - f3.poolDiscount).toBe(23000);

    // Savings: 90, 50 and 70 taka
    expect(50000 - (f1.distanceCharge - f1.poolDiscount)).toBe(9000);
    expect(20000 - (f2.distanceCharge - f2.poolDiscount)).toBe(5000);
    expect(30000 - (f3.distanceCharge - f3.poolDiscount)).toBe(7000);
  });

  it("every rider pays less than solo (the reason to pool)", () => {
    for (const userLegs of [u1, u2, u3]) {
      const solo = priceLegs(userLegs.map((id) => legs[id]).filter((l): l is Edge => l !== undefined));
      const pooled = fareFor(userLegs, all);
      expect(pooled.distanceCharge - pooled.poolDiscount).toBeLessThan(solo.distanceCharge);
    }
  });
});

describe("seeded demo fares (Nusrat + Rafiq pooled on R05)", () => {
  it("reprices both riders when pooled: shared legs get 20% off", async () => {
    const [nusrat, rafiq, jashim] = await Promise.all([
      token("nusrat"),
      token("rafiq"),
      token("jashim"),
    ]);

    const soloEstimate = await post(
      "/fare/estimate",
      { pickupStopId: "banani", dropStopId: "mohakhali", routeId: "R05" },
      nusrat,
    );
    expect(soloEstimate.status).toBe(200);
    const solo = soloEstimate.data.options[0].fare;
    expect(solo.baseFare).toBe(3000);
    expect(solo.poolDiscount).toBe(0);

    const n1 = await requestOnR05(nusrat); // banani → mohakhali (3 legs)
    const r1 = await requestOnR05(rafiq, "banani", "gulshan1"); // banani → gulshan1 (2 legs)

    await post("/driver/online", { online: true }, jashim);
    const acc = await post("/rides/accept", { requestIds: [n1.id, r1.id] }, jashim);
    expect(acc.status).toBe(201);

    const members = acc.data.requests as SerializedRequest[];
    const nFare = members.find((r) => r.id === n1.id)?.fare;
    const rFare = members.find((r) => r.id === r1.id)?.fare;
    expect(nFare).toBeDefined();
    expect(rFare).toBeDefined();
    if (!nFare || !rFare) throw new Error("accepted pool did not contain both riders");

    // First two legs shared (2 riders, 20%), last leg solo (0%).
    const nShared = nFare.lines.slice(0, 2);
    expect(nShared.every((l) => l.riders === 2 && l.discountPct === 20)).toBe(true);
    expect(nFare.lines[2]).toMatchObject({ riders: 1, discountPct: 0 });
    expect(nFare.total).toBe(solo.total - nFare.poolDiscount);

    // Rafiq rides only shared legs: pays base + both legs at 20% off.
    expect(rFare.lines.every((l) => l.riders === 2 && l.discountPct === 20)).toBe(true);
    expect(rFare.total).toBe(rFare.baseFare + rFare.distanceCharge - rFare.poolDiscount);

    // Nusrat's own estimate is her solo fare, never anyone else's (PRD §5).
    const mine = await get(`/rides/${n1.id}`, nusrat);
    expect(mine.data.request.fare.total).toBe(nFare.total);
  });

  it("stores money as integer paisa", async () => {
    const nusrat = await token("nusrat");
    const req = await requestOnR05(nusrat);
    expect(Number.isInteger(req.fare.total)).toBe(true);
    expect(Number.isInteger(req.fare.baseFare)).toBe(true);
  });
});
