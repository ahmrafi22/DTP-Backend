import { z } from "zod";

/** One priced corridor a passenger could take, as offered in the picker. */
export interface FareOption {
  routeId: string | null;
  title: string;
  sub: string;
  legIds: string[];
  stopIds: string[];
  fare: import("../../graph/index.js").LegFare;
}

export const estimateFareSchema = z.object({
  pickupStopId: z.string(),
  dropStopId: z.string(),
  routeId: z.string().nullish(),
});

export type EstimateFareInput = z.infer<typeof estimateFareSchema>;
