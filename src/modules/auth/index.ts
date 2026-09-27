export { authRouter } from "./auth.routes.js";
export { registerSchema, loginSchema } from "./auth.schema.js";
export type { RegisterInput, LoginInput } from "./auth.schema.js";
export { signToken, withVehicle } from "./auth.service.js";
export { serializeUser, serializeVehicle } from "./auth.service.js";
