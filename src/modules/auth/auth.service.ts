import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { config } from "../../config/index.js";
import { firstOrNull, query } from "../../shared/db.js";
import { notFound } from "../../shared/errors.js";
import type {
  SerializedUser,
  SerializedVehicle,
  UserRow,
  VehicleRow,
} from "../../shared/types.js";

/** Shape a user row for API responses (never the password hash). */
export function serializeUser(row: UserRow, vehicle: VehicleRow | null = null): SerializedUser {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    role: row.role,
    homeStopId: row.home_stop_id,
    usualDropStopId: row.usual_drop_stop_id,
    isOnline: row.is_online,
    ...(row.role === "driver" ? { vehicle: vehicle ? serializeVehicle(vehicle) : null } : {}),
  };
}

export function serializeVehicle(row: VehicleRow): SerializedVehicle {
  return {
    id: row.id,
    driverId: row.driver_id,
    name: row.name,
    capacity: row.capacity,
    baseStopId: row.base_stop_id,
    color: row.color,
  };
}

/** Sign a session token carrying the user id and role as claims. */
export function signToken(user: Pick<UserRow, "id" | "role">): string {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as SignOptions["expiresIn"],
  });
}

/** Drivers carry their vehicle on every user payload; passengers never do. */
export async function withVehicle(user: UserRow): Promise<SerializedUser> {
  if (user.role !== "driver") return serializeUser(user);
  const vehicle = await getVehicleByDriver(user.id);
  return serializeUser(user, vehicle);
}

/** Compare a candidate password against the stored bcrypt hash. */
export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

/** Hash a password with the configured cost factor. */
export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, config.bcryptRounds);

export async function getUserById(id: string): Promise<UserRow | null> {
  return firstOrNull(await query<UserRow>("SELECT * FROM users WHERE id = $1", [id]));
}

export async function requireUser(id: string): Promise<UserRow> {
  const user = await getUserById(id);
  if (!user) throw notFound("User not found");
  return user;
}

export async function getVehicleByDriver(driverId: string): Promise<VehicleRow | null> {
  return firstOrNull(
    await query<VehicleRow>("SELECT * FROM vehicles WHERE driver_id = $1", [driverId]),
  );
}

export async function getVehicleById(id: string): Promise<VehicleRow | null> {
  return firstOrNull(await query<VehicleRow>("SELECT * FROM vehicles WHERE id = $1", [id]));
}
