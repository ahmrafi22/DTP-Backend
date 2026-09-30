import type { RequestStatus, RideStatus } from "../../shared/types.js";

/**
 * The ride lifecycle, in one place (PRD §4).
 *
 * Both the service layer and anything that wants to predict the next state
 * read `ALLOWED_NEXT`; there is deliberately no second copy of this table.
 */

export const ACTIVE_REQUEST_STATUSES: readonly RequestStatus[] = [
  "REQUESTED",
  "MATCHED",
  "DRIVER_ARRIVED",
  "STARTED",
];

export const ACTIVE_RIDE_STATUSES: readonly RideStatus[] = [
  "MATCHED",
  "DRIVER_ARRIVED",
  "STARTED",
];

/** Legal transitions only; an empty list marks a terminal state. */
export const ALLOWED_NEXT: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  REQUESTED: ["MATCHED", "CANCELLED"],
  MATCHED: ["DRIVER_ARRIVED", "CANCELLED"],
  DRIVER_ARRIVED: ["STARTED", "CANCELLED"],
  STARTED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

/**
 * How far along each stage is, so the trip row can be re-synced to the
 * furthest point any individual rider has reached.
 */
export const STAGE_RANK: Record<RequestStatus, number> = {
  REQUESTED: -2,
  MATCHED: 0,
  DRIVER_ARRIVED: 1,
  STARTED: 2,
  COMPLETED: 3,
  CANCELLED: -1,
};

/** A passenger may cancel from REQUESTED up to and including DRIVER_ARRIVED. */
export const isCancellable = (status: RequestStatus): boolean =>
  status === "REQUESTED" || status === "MATCHED" || status === "DRIVER_ARRIVED";

/** The three driver-triggered transitions, in the order they happen. */
export const TRIP_ACTIONS: ReadonlyArray<readonly [action: string, next: RideStatus]> = [
  ["arrived", "DRIVER_ARRIVED"],
  ["start", "STARTED"],
  ["complete", "COMPLETED"],
];
