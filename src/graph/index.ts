/**
 * The road graph and its pricing, split by concern:
 *
 *   data.ts     stops, legs, corridors and the adjacency list
 *   pricing.ts  what a leg costs and the pool discount tiers (PRD §6)
 *   routing.ts  pathfinding (Dijkstra) and the pooling criterion
 *
 * Everything is re-exported here so callers can keep importing from
 * `graph/index.js` without knowing the split.
 */
export {
  BASE_FARE_PAISA,
  POOL_DISCOUNT_PCT,
  NODES,
  EDGES,
  EDGE_MAP,
  ADJACENCY,
  ROUTES,
  ROUTE_MAP,
  edgeKey,
  getEdge,
  edgeByLegId,
  getRoute,
} from "./data.js";
export type {
  Node,
  Edge,
  Route,
  Path,
  RiderTier,
  RidersPerLeg,
} from "./data.js";

export { priceLegs } from "./pricing.js";
export type { LegFare, FareLineBreakdown } from "./pricing.js";

export {
  legsBetween,
  findRoutes,
  sharedLegs,
  isPoolable,
  shortestPath,
} from "./routing.js";
export type { EdgeWeight } from "./routing.js";
