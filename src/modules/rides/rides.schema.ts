import { z } from "zod";

/**
 * Request bodies accepted by the ride endpoints.
 *
 * Parsed at the route edge; anything that survives `parse` is trusted by the
 * service layer. This is the only place the shape of a ride request is
 * defined.
 */

export const requestRideSchema = z.object({
  pickupStopId: z.string().min(1),
  dropStopId: z.string().min(1),
  routeId: z.string().nullish(),
  seats: z.number().int().min(1).max(3).default(1),
  // Promise to wait at pickup for a discount (PRD §5).
  waitAndSave: z.boolean().default(false),
  // WALLET moves the fare from the rider's TeslaPay balance to the
  // driver when the trip ends; CASH is settled by hand.
  paymentMethod: z.enum(["CASH", "WALLET"]).default("CASH"),
  idempotencyKey: z.string().min(8).max(100).nullish(),
});

export const cancelRideSchema = z.object({ reason: z.string().max(200).nullish() });

export const acceptRequestsSchema = z.object({ requestIds: z.array(z.string()).min(1).max(8) });

export const joinRideSchema = z.object({ requestId: z.string().min(1) });

export const dropOffSchema = z.object({ requestId: z.string().min(1) });

export const rateRideSchema = z.object({ rating: z.number().int().min(1).max(5) });

export const setOnlineSchema = z.object({ online: z.boolean() });

export type RequestRideInput = z.infer<typeof requestRideSchema>;
export type AcceptRequestsInput = z.infer<typeof acceptRequestsSchema>;
