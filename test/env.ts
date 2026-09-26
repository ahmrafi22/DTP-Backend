/**
 * Test environment knobs. Must be imported BEFORE any src module so the
 * config sees these first (dotenv does not override existing vars).
 * Keep this file dependency-free.
 */
process.env.BCRYPT_ROUNDS = "4"; // fast hashing; tests register many users
process.env.RATE_LIMIT_REQUESTS_MAX = "5";
process.env.RATE_LIMIT_REQUESTS_WINDOW_MS = "60000";
process.env.JWT_SECRET = "test-secret";
