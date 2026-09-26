import { config } from "./config/index.js";
import { createApp } from "./app.js";
import { logger } from "./shared/logger.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./shared/db.js";

// Ensure the schema exists before serving traffic.
await migrate();

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info("server_started", { port: config.port });
});

async function shutdown(signal: string): Promise<void> {
  logger.info("server_stopping", { signal });
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
