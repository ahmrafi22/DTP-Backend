import { config } from "./config/index.js";
import { createApp } from "./app.js";
import { logger } from "./shared/logger.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./shared/db.js";
import { startShuttleScheduler, stopShuttleScheduler } from "./modules/map/shuttle.js";

// Ensure the schema exists before serving traffic.
await migrate();

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info("server_started", { port: config.port });
  // Auto-shuttles keep the map alive: always-running autos on their corridors.
  // SHUTTLE_SCHEDULER=off turns the heartbeat off (e.g. while the test suite
  // shares this database and wants a quiet, deterministic world).
  if (process.env.SHUTTLE_SCHEDULER !== "off") {
    startShuttleScheduler();
  }
});

async function shutdown(signal: string): Promise<void> {
  logger.info("server_stopping", { signal });
  stopShuttleScheduler();
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
