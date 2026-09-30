import "dotenv/config";

/** Parse an integer env var, falling back when unset or not a number. */
const int = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export interface Config {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  bcryptRounds: number;
  corsOrigin: string;
  rateLimit: {
    rideRequestsMax: number;
    rideRequestsWindowMs: number;
  };
}

export const config: Config = {
  port: int(process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "dtp-dev-secret",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 10),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  rateLimit: {
    rideRequestsMax: int(process.env.RATE_LIMIT_REQUESTS_MAX, 5),
    rideRequestsWindowMs: int(process.env.RATE_LIMIT_REQUESTS_WINDOW_MS, 60_000),
  },
};

if (!config.databaseUrl) {
  // Never exit at import time: on serverless (Vercel) this would kill the
  // function instance and surface as FUNCTION_INVOCATION_FAILED. Boot anyway
  // and let /health report 503 until DATABASE_URL is configured.
  console.error("DATABASE_URL is required — copy .env.example to .env and fill it in.");
}
