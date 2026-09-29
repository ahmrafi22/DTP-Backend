/**
 * Shared domain and database types.
 *
 * Two families live here, and keeping them separate is the point:
 *
 *   `*Row`        exactly what a Postgres column hands back, per sql/001_init.sql.
 *                 Money columns are INT, so they arrive as numbers. NUMERIC
 *                 (km, congestion) and BIGINT (COUNT/SUM) arrive as *strings*,
 *                 which is why several rows below are typed `string` where a
 *                 number looks natural — that is the driver being honest, not
 *                 sloppiness. Call sites convert explicitly with Number().
 *
 *   `Serialized*` the camelCase shapes the API returns. Deriving these by hand
 *                 instead of `typeof row` means a column rename cannot silently
 *                 change the public API contract.
 */

import type { QueryResultRow } from "pg";

/** Roles a user can hold. Mirrors the CHECK on users.role. */
export type Role = "passenger" | "driver" | "admin";

/** Lifecycle of a ride. Mirrors the CHECK on rides.status (PRD §4). */
export type RideStatus =
  | "MATCHED"
  | "DRIVER_ARRIVED"
  | "STARTED"
  | "COMPLETED"
  | "CANCELLED";

/**
 * Lifecycle of one passenger's membership. A request starts at REQUESTED and
 * then shadows its ride's status. Mirrors the CHECK on ride_requests.status.
 */
export type RequestStatus = "REQUESTED" | RideStatus;

/** Who the caller is, attached to the request by the auth middleware. */
export interface AuthUser {
  id: string;
  role: Role;
}

/**
 * Narrow an untrusted string (a JWT claim, a form field) to a Role. Anything
 * outside the CHECK constraint on users.role is rejected rather than cast.
 */
export function isRole(value: unknown): value is Role {
  return value === "passenger" || value === "driver" || value === "admin";
}

// ---------------------------------------------------------------------------
// Database rows
// ---------------------------------------------------------------------------

export interface UserRow extends QueryResultRow {
  id: string;
  name: string;
  phone: string;
  password_hash: string;
  role: Role;
  home_stop_id: string | null;
  usual_drop_stop_id: string | null;
  is_online: boolean;
  created_at: Date;
}

export interface VehicleRow extends QueryResultRow {
  id: string;
  driver_id: string;
  name: string;
  capacity: number;
  base_stop_id: string | null;
  color: string | null;
  created_at: Date;
}

export interface RideRow extends QueryResultRow {
  id: string;
  vehicle_id: string;
  status: RideStatus;
  seats_taken: number;
  capacity: number;
  /** The path being driven — set by shuttles; rider paths derive from members. */
  stop_ids: string[] | null;
  created_at: Date;
  updated_at: Date;
}

export interface RideRequestRow extends QueryResultRow {
  id: string;
  passenger_id: string;
  ride_id: string | null;
  pickup_stop: string;
  drop_stop: string;
  route_id: string | null;
  leg_ids: string[];
  stop_ids: string[];
  seats: number;
  status: RequestStatus;
  base_fare_paisa: number;
  distance_charge_paisa: number;
  pool_discount_paisa: number;
  total_fare_paisa: number;
  idempotency_key: string | null;
  rating: number | null;
  cancel_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A request row joined with its passenger's display name. */
export interface RideRequestWithNameRow extends RideRequestRow {
  passenger_name: string;
}

export interface FareLegRow extends QueryResultRow {
  id: string;
  request_id: string;
  leg_no: number;
  leg_id: string;
  from_stop: string;
  to_stop: string;
  riders_on_leg: number;
  discount_pct: number;
  price_paisa: number;
  paid_paisa: number;
}

export interface RideEventRow extends QueryResultRow {
  event: string;
  actor_id: string | null;
  at: Date;
  meta: Record<string, unknown> | null;
}

export interface StopRow extends QueryResultRow {
  id: string;
  name: string;
  zone: string;
  lat: number;
  lng: number;
}

export interface LegRow extends QueryResultRow {
  id: string;
  from_stop: string;
  to_stop: string;
  /** NUMERIC — the pg driver returns these as strings. */
  km: string;
  duration_min: number;
  price_paisa: number;
}

export interface RouteRow extends QueryResultRow {
  id: string;
  name: string;
  corridor: string;
}

export interface RouteStopRow extends QueryResultRow {
  route_id: string;
  stop_id: string;
  position: number;
}

/** Vehicle joined with its driver, for the driver console. */
export interface VehicleWithDriverRow extends VehicleRow {
  driver_name: string;
}

/** Aggregates come back from pg as strings (numeric / bigint). */
export interface EarningsRow extends QueryResultRow {
  earned: string;
  trips: string;
}

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

export interface SerializedVehicle {
  id: string;
  driverId: string;
  name: string;
  capacity: number;
  baseStopId: string | null;
  color: string | null;
}

export interface SerializedUser {
  id: string;
  name: string;
  phone: string;
  role: Role;
  homeStopId: string | null;
  usualDropStopId: string | null;
  isOnline: boolean;
  /** Drivers only — a passenger never carries a vehicle. */
  vehicle?: SerializedVehicle | null;
}

/** One priced leg in a passenger's breakdown (PRD §6). */
export interface FareLine {
  edgeId: string;
  from: string;
  to: string;
  riders: number;
  discountPct: number;
  /** Solo price of the leg before any discount. */
  pricePaisa: number;
  /** What this passenger actually pays for the leg. */
  paidPaisa: number;
}

/** fare = base + distanceCharge − poolDiscount, all integer paisa. */
export interface Fare {
  baseFare: number;
  distanceCharge: number;
  poolDiscount: number;
  total: number;
  lines: FareLine[];
}

export interface SerializedRequest {
  id: string;
  passengerId: string;
  rideId: string | null;
  pickupStopId: string;
  dropStopId: string;
  routeId: string | null;
  legIds: string[];
  stopIds: string[];
  seats: number;
  status: RequestStatus;
  rating: number | null;
  cancelReason: string | null;
  fare: Fare;
  createdAt: Date;
  updatedAt: Date;
  /** Present only in the driver's own views. */
  passengerName?: string;
}

export interface SerializedRide {
  id: string;
  vehicleId: string;
  status: RideStatus;
  seatsTaken: number;
  capacity: number;
  /** The driven path when the ride defines one (shuttles); else null. */
  stopIds: string[] | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A co-rider, deliberately thinned out: first name and destination only, no
 * phone number and no fare (PRD §5). This is the privacy boundary.
 */
export interface SerializedCoRider {
  id: string;
  firstName: string;
  dropStopId: string;
  status: RequestStatus;
}

// ---------------------------------------------------------------------------
// Live map + hop-on joining
// ---------------------------------------------------------------------------

/** One passenger aboard a live ride. First name + get-off stop — never a fare. */
export interface MapLivePassenger {
  firstName: string;
  dropStopId: string;
  status: RequestStatus;
}

/** A running trip as the map sees it: path, progress, who is aboard. */
export interface MapLiveRide {
  id: string;
  status: RideStatus;
  /** Ordered stop ids of the primary rider — the path the auto is driving. */
  stopIds: string[];
  /** 0–1 along the path while STARTED (time-based, from the STARTED event). */
  progress: number;
  /** Expected total trip duration in seconds (sum of the path's legs). */
  totalSec: number;
  passengers: MapLivePassenger[];
}

/** One driver as rendered on the map — this is the whole sprite's state. */
export interface MapLiveDriver {
  driverId: string;
  driverName: string;
  vehicleId: string;
  vehicleName: string;
  color: string | null;
  online: boolean;
  /** offline = engine off at the base stop; waiting = free seats, no trip. */
  phase: "offline" | "waiting" | "onboard";
  baseStopId: string | null;
  seatsTaken: number;
  capacity: number;
  /** Present while phase = "onboard". */
  ride: MapLiveRide | null;
}

/** GET /map/live payload — one poll, one snapshot of the whole fleet. */
export interface MapLivePayload {
  drivers: MapLiveDriver[];
  serverTime: string;
}

/** GET /rides/:id/preview payload — what a hop-on passenger sees before joining. */
export interface JoinPreview {
  ride: SerializedRide;
  /** Ordered stop ids of the running trip; get-in must precede get-out. */
  stops: string[];
  /** Seats open right now. */
  seatsFree: number;
  /** The joiner's own fare at the current riders-per-leg, if they joined now. */
  fare: Fare;
}
