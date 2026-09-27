import { z } from "zod";
import { NODES } from "../../graph/index.js";

/**
 * Request bodies accepted by the auth endpoints.
 *
 * Parsed at the route edge; anything that survives `parse` is trusted by the
 * service layer. This is the only place the shape of an auth request is
 * defined.
 */

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[\d\s-]{6,20}$/, "Phone must be 6-20 digits, optionally starting with +");

export const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    phone: phoneSchema,
    password: z.string().min(6).max(72),
    role: z.enum(["passenger", "driver"]),
    homeStopId: z.string().refine((id) => id in NODES, "Unknown stop").nullish(),
    vehicleName: z.string().trim().min(1).max(40).optional(),
    vehicleCapacity: z.number().int().min(1).max(8).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.role === "driver" && !val.vehicleName) {
      ctx.addIssue({
        code: "custom",
        path: ["vehicleName"],
        message: "Drivers must name their vehicle",
      });
    }
  });

export const loginSchema = z.object({ phone: phoneSchema, password: z.string().min(1) });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
