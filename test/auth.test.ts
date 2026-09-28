import "./env.js";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { reseed, cleanup, get, post } from "./helpers.js";

beforeAll(reseed);
afterAll(cleanup);

describe("auth", () => {
  it("registers a passenger and returns a usable token", async () => {
    const res = await post("/auth/register", {
      name: "Test Passenger",
      phone: "+880 171 1110001",
      password: "secret1",
      role: "passenger",
      homeStopId: "banani",
    });
    expect(res.status).toBe(201);
    expect(res.data.token).toBeTruthy();
    expect(res.data.user).toMatchObject({
      name: "Test Passenger",
      role: "passenger",
      phone: "+880 171 1110001",
    });
    expect(res.data.user.password_hash).toBeUndefined();

    const me = await get("/me", res.data.token);
    expect(me.status).toBe(200);
    expect(me.data.user.id).toBe(res.data.user.id);
  });

  it("registers a driver with a vehicle", async () => {
    const res = await post("/auth/register", {
      name: "Test Driver",
      phone: "+880 181 1110001",
      password: "secret1",
      role: "driver",
      vehicleName: "Zephyr",
      vehicleCapacity: 2,
    });
    expect(res.status).toBe(201);
    expect(res.data.user.vehicle).toMatchObject({ name: "Zephyr", capacity: 2 });
  });

  it("rejects duplicate phone, short passwords and bad input", async () => {
    const dup = await post("/auth/register", {
      name: "Nusrat Two",
      phone: "+880 171 0001001",
      password: "secret1",
      role: "passenger",
    });
    expect(dup.status).toBe(409);
    expect(dup.data.error.code).toBe("PHONE_TAKEN");

    const weak = await post("/auth/register", {
      name: "Weak",
      phone: "+880 171 1110002",
      password: "123",
      role: "passenger",
    });
    expect(weak.status).toBe(400);

    const noVehicle = await post("/auth/register", {
      name: "No Vehicle",
      phone: "+880 181 1110002",
      password: "secret1",
      role: "driver",
    });
    expect(noVehicle.status).toBe(400);
  });

  it("logs in the seeded cast and rejects bad credentials", async () => {
    const ok = await post("/auth/login", { phone: "+880 171 0001001", password: "demo1234" });
    expect(ok.status).toBe(200);
    expect(ok.data.user).toMatchObject({ id: "nusrat", role: "passenger" });

    const wrong = await post("/auth/login", { phone: "+880 171 0001001", password: "nope" });
    expect(wrong.status).toBe(401);
    expect(wrong.data.error.message).toBe("Invalid phone or password");

    const ghost = await post("/auth/login", { phone: "+880 170 9999999", password: "nope" });
    expect(ghost.status).toBe(401);
  });

  it("requires and validates tokens", async () => {
    expect((await get("/me")).status).toBe(401);
    expect((await get("/me", "not.a.token")).status).toBe(401);
  });

  it("gates role-only endpoints", async () => {
    const passenger = await post("/auth/login", {
      phone: "+880 171 0001001",
      password: "demo1234",
    });
    const driver = await post("/auth/login", { phone: "+880 181 0002001", password: "demo1234" });

    expect((await get("/driver/state", passenger.data.token)).status).toBe(403);
    expect((await get("/driver/state", driver.data.token)).status).toBe(200);
  });
});
