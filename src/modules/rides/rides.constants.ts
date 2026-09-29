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

/** A passenger may cancel from REQUESTED up to and including DRIVER_ARRIVED. */
export const isCancellable = (status: RequestStatus): boolean =>
  status === "REQUESTED" || status === "MATCHED" || status === "DRIVER_ARRIVED";

/** The three driver-triggered transitions, in the order they happen. */
export const TRIP_ACTIONS: ReadonlyArray<readonly [action: string, next: RideStatus]> = [
  ["arrived", "DRIVER_ARRIVED"],
  ["start", "STARTED"],
  ["complete", "COMPLETED"],
];

/**
 * Wait-and-Save window in seconds. The PRD promises 5 minutes of waiting for
 * an extra 5% off; the demo runs it on a 30-second clock so the promise is
 * watchable in a conversation (WAIT_AND_SAVE_SECONDS=300 for the real thing).
 */
export const WAIT_AND_SAVE_SECONDS = Number(process.env.WAIT_AND_SAVE_SECONDS ?? 30);

/** Extra discount a honoured wait earns, as a percentage of distance charge. */
export const WAIT_AND_SAVE_EXTRA_PCT = 5;
