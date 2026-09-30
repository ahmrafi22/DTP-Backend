import { createApp } from "../src/app.js";

/**
 * Vercel serverless entry. Exports the Express app — @vercel/node serves it.
 * No app.listen(), no migrate() here: a serverless function is not a
 * long-running server. Run migrations separately (`npm run migrate:prod`
 * against the prod database, or a Vercel deploy hook / job).
 */
const app = createApp();

export default app;
