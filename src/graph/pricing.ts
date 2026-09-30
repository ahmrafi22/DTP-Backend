/**
 * Leg pricing and the pool discount tiers (PRD §6).
 *
 * All money is integer paisa so summing many small amounts never accumulates
 * float error. `fare = baseFare + distanceCharge - poolDiscount`.
 */
import { BASE_FARE_PAISA, POOL_DISCOUNT_PCT } from "./data.js";
import type { Edge, RiderTier, RidersPerLeg } from "./data.js";

export { BASE_FARE_PAISA, POOL_DISCOUNT_PCT } from "./data.js";
export type { RiderTier, RidersPerLeg } from "./data.js";

export interface FareLineBreakdown {
  edgeId: string;
  from: string;
  to: string;
  riders: RiderTier;
  discountPct: number;
  /** Solo price of the leg before any discount. */
  pricePaisa: number;
  /** What this passenger actually pays for the leg. */
  paidPaisa: number;
}

/** fare = base + distanceCharge - poolDiscount, all integer paisa. */
export interface LegFare {
  baseFare: number;
  distanceCharge: number;
  poolDiscount: number;
  /** Extra discount from the Wait & Save promise; 0 when not used. */
  waitSaveDiscount: number;
  total: number;
  lines: FareLineBreakdown[];
}

/** Extra discount for promising to wait at pickup, on top of pool discounts. */
export const WAIT_SAVE_DISCOUNT_PCT = 5;

/** How long the driver may hold a Wait & Save passenger for, in minutes. */
export const WAIT_SAVE_MINUTES = 5;

/**
 * Fare for one passenger. `ridersPerLeg` maps a leg id to how many riders
 * share it (default 1 = solo). Integer paisa in, per-leg breakdown out.
 */
export function priceLegs(
  legs: readonly Edge[],
  ridersPerLeg: RidersPerLeg = {},
  waitAndSave = false,
): LegFare {
  let distanceCharge = 0;
  let poolDiscount = 0;
  const lines = legs.map((leg) => {
    // The clamp is what guarantees the index below is a valid RiderTier.
    const riders = Math.min(3, Math.max(1, ridersPerLeg[leg.id] ?? 1)) as RiderTier;
    const discountPct = POOL_DISCOUNT_PCT[riders];
    const discount = Math.round((leg.pricePaisa * discountPct) / 100);
    distanceCharge += leg.pricePaisa;
    poolDiscount += discount;
    return {
      edgeId: leg.id,
      from: leg.from,
      to: leg.to,
      riders,
      discountPct,
      pricePaisa: leg.pricePaisa,
      paidPaisa: leg.pricePaisa - discount,
    };
  });
  // Wait & Save is applied to the distance charge only — the base fare is a
  // flat boarding cost and is not something a rider can earn back by waiting.
  const waitSaveDiscount = waitAndSave
    ? Math.round((distanceCharge * WAIT_SAVE_DISCOUNT_PCT) / 100)
    : 0;

  return {
    baseFare: BASE_FARE_PAISA,
    distanceCharge,
    poolDiscount,
    waitSaveDiscount,
    total: BASE_FARE_PAISA + distanceCharge - poolDiscount - waitSaveDiscount,
    lines,
  };
}

