/**
 * Pathfinding and the pooling criterion over the road graph in `data.ts`.
 */
import { ADJACENCY, NODES, ROUTES, getRoute } from "./data.js";
import type { Edge, Path, Route } from "./data.js";

// ---------- helpers ----------

/** Legs a passenger rides on a route, in travel order (works either direction). */
export function legsBetween(routeId: string, fromId: string, toId: string): Edge[] | null {
  const route = getRoute(routeId);
  if (!route) return null;
  const i = route.stops.indexOf(fromId);
  const j = route.stops.indexOf(toId);
  if (i === -1 || j === -1 || i === j) return null;
  return i < j ? route.legs.slice(i, j) : route.legs.slice(j, i).reverse();
}

/** Routes that contain both stops. */
export const findRoutes = (fromId: string, toId: string): Route[] =>
  ROUTES.filter((r) => r.stops.includes(fromId) && r.stops.includes(toId) && fromId !== toId);

/** Legs two trips have in common (pooling criterion). */
export function sharedLegs(legsA: readonly Edge[], legsB: readonly Edge[]): Edge[] {
  const ids = new Set(legsB.map((l) => l.id));
  return legsA.filter((l) => ids.has(l.id));
}

/** Poolable if they share at least one leg. */
export const isPoolable = (legsA: readonly Edge[], legsB: readonly Edge[]): boolean =>
  sharedLegs(legsA, legsB).length > 0;

/** The edge measures a shortest path can minimise. */
export type EdgeWeight = "km" | "durationMin" | "pricePaisa";

/** Shortest path by 'km', 'durationMin' or 'pricePaisa' (Dijkstra). */
export function shortestPath(
  fromId: string,
  toId: string,
  weight: EdgeWeight = "km",
): Path | null {
  if (!NODES[fromId] || !NODES[toId]) return null;

  const dist = new Map<string, number>();
  const prev = new Map<string, { node: string; edge: Edge }>();
  const queue = new Set(Object.keys(NODES));
  dist.set(fromId, 0);

  while (queue.size > 0) {
    let u: string | null = null;
    let best: number | undefined;
    for (const n of queue) {
      const d = dist.get(n);
      if (d !== undefined && (best === undefined || d < best)) {
        u = n;
        best = d;
      }
    }
    if (u === null || best === undefined || u === toId) break;

    queue.delete(u);
    for (const { to, edge } of ADJACENCY.get(u) ?? []) {
      const alt = best + edge[weight];
      const current = dist.get(to);
      if (current === undefined || alt < current) {
        dist.set(to, alt);
        prev.set(to, { node: u, edge });
      }
    }
  }

  const total = dist.get(toId);
  if (total === undefined) return null;

  const stops: string[] = [toId];
  const legs: Edge[] = [];
  for (let n = toId; ; ) {
    const step = prev.get(n);
    if (!step) break;
    stops.unshift(step.node);
    legs.unshift(step.edge);
    n = step.node;
  }
  return { stops, legs, total: Math.round(total * 10) / 10 };
}

