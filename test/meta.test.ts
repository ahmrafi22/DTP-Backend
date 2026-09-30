import "./env.js";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { pool } from "../src/shared/db.js";

const app = createApp();

describe("service meta", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("GET / returns service info (200, never a crash)", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: "dtp-backend" });
  });

  it("GET /health reports database reachability", async () => {
    const res = await request(app).get("/health");
    expect([200, 503]).toContain(res.status);
    expect(res.body.service).toBe("dtp-backend");
  });

  it("unknown routes still return the JSON 404 envelope", async () => {
    const res = await request(app).get("/nope-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
