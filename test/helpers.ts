import "./env.js";
import request from "supertest";
import { createApp } from "../src/app.js";
import { seed } from "../src/db/seed.js";
import { pool } from "../src/shared/db.js";
import { resetRateLimits } from "../src/middleware/rateLimit.js";
import type { SerializedRequest } from "../src/shared/types.js";

export const app = createApp();

/** Fresh demo world before each suite (files run sequentially). */
async function reseed(): Promise<void> {
  await seed();
}

export { reseed, resetRateLimits };

export interface ApiResult<T = any> {
  status: number;
  data: T;
}

export async function api<T = any>(
  method: "get" | "post",
  path: string,
  { token, body }: { token?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const res = await request(app)[method](path)
    .set(token ? { Authorization: `Bearer ${token}` } : {})
    .send(body ?? {});
  return { status: res.status, data: res.body as T };
}

export const get = (path: string, token?: string): Promise<ApiResult> => api("get", path, { token });

export const post = (path: string, body?: unknown, token?: string): Promise<ApiResult> =>
  api("post", path, { token, body });

/** Register a fresh passenger/driver and return { token, user }. */
export async function registerPassenger(
  name: string,
  i = 0,
): Promise<{ token: string; user: unknown }> {
  const res = await post("/auth/register", {
    name,
    phone: `+880 170 00${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}${i}`,
    password: "test1234",
    role: "passenger",
    homeStopId: "banani",
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.data)}`);
  return res.data as { token: string; user: unknown };
}

/** Login as one of the seeded cast. */
export const loginAs = (id: string): string | null =>
  ({
    nusrat: "+880 171 0001001",
    rafiq: "+880 171 0001002",
    shirin: "+880 171 0001003",
    jashim: "+880 181 0002001",
    kabir: "+880 181 0002002",
    admin: "+880 191 0009001",
  })[id] ?? null;

export async function token(id: string): Promise<string> {
  const res = await post("/auth/login", { phone: loginAs(id), password: "demo1234" });
  if (res.status !== 200) throw new Error(`login ${id} failed`);
  return (res.data as { token: string }).token;
}

/** Passenger requests a ride on the demo Gulshan corridor (R05). */
export async function requestOnR05(
  passengerToken: string,
  from = "banani",
  to = "mohakhali",
): Promise<SerializedRequest> {
  const res = await post(
    "/rides/request",
    { pickupStopId: from, dropStopId: to, routeId: "R05" },
    passengerToken,
  );
  if (res.status !== 201) throw new Error(`request failed: ${JSON.stringify(res.data)}`);
  return (res.data as { request: SerializedRequest }).request;
}

export async function cleanup(): Promise<void> {
  await pool.end();
}
