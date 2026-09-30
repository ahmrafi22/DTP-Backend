import { z } from "zod";
import { DEFAULT_TOPUP_PAISA, MAX_TOPUP_PAISA } from "./wallet.constants.js";

/**
 * The top-up takes an *optional* amount on purpose: the UI button is one tap
 * that always means ৳100, and letting the client mint an arbitrary balance is
 * not a capability a demo wallet needs. The parameter exists so the endpoint
 * is testable and a future "top up a different amount" screen would not need a
 * new route.
 */
export const topUpSchema = z.object({
  amountPaisa: z.number().int().positive().max(MAX_TOPUP_PAISA).optional(),
});

export type TopUpInput = z.infer<typeof topUpSchema>;

export { DEFAULT_TOPUP_PAISA };