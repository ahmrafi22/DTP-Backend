/**
 * Layout sanity check for the generated ERD: flags connector polylines that
 * cross a table box they do not start or end on, and near-collinear overlaps
 * between two connectors (which read as a single broken line).
 *
 *   node scripts/check_erd.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "dtp-erd.excalidraw");
const { elements } = JSON.parse(readFileSync(file, "utf8"));

// One entry per table. The coloured header strip is exactly HEAD_H tall and
// sits at the table's top-left, which makes it an unambiguous anchor; the body
// rectangle shares its x and width.
const HEAD_H = 34;
const NAMES = new Set([
  "stops", "legs", "routes", "route_stops", "users", "vehicles", "rides",
  "ride_requests", "fare_legs", "wallets", "wallet_transactions",
  "ride_events", "schema_migrations",
]);
const boxes = [];
for (const e of elements) {
  if (e.type !== "text" || !NAMES.has(e.text)) continue;
  const hx = Math.round(e.x) - 16;
  const hy = Math.round(e.y) - 9;
  const head = elements.find(
    (r) => r.type === "rectangle" && r.height === HEAD_H &&
      Math.round(r.x) === hx && Math.round(r.y) === hy,
  );
  if (!head) throw new Error(`no header strip found for ${e.text}`);
  const body = elements.find(
    (r) => r.type === "rectangle" && r !== head &&
      Math.round(r.x) === hx && r.width === head.width && r.height > HEAD_H,
  );
  if (!body) throw new Error(`no body rect found for ${e.text}`);
  boxes.push({ name: e.text, id: body.id, x: body.x, y: body.y, w: body.width, h: body.height });
}
if (boxes.length !== 13) throw new Error(`found ${boxes.length} table boxes, expected 13`);
if (boxes.length !== 13) throw new Error(`found ${boxes.length} table boxes, expected 13`);

const arrows = elements.filter((e) => e.type === "arrow");
// Arrows are emitted in RELS order, so the arrow index names the relationship.
const relName = (a) => {
  const src = boxes.find((b) => b.id === a.startBinding?.elementId)?.name ?? "?";
  const dst = boxes.find((b) => b.id === a.endBinding?.elementId)?.name ?? "?";
  return `${arrows.indexOf(a)}: ${src} -> ${dst}`;
};

const abs = (a) => a.points.map((p) => [a.x + p[0], a.y + p[1]]);

/**
 * Does segment a->b actually intersect the box interior? Liang-Barsky clipping,
 * so a long diagonal is not flagged just because its bounding box overlaps. The
 * inset keeps an arrow that merely lands on the border from counting as a hit.
 */
function segHitsBox(a, b, box, inset = 2) {
  const x0 = box.x + inset, x1 = box.x + box.w - inset;
  const y0 = box.y + inset, y1 = box.y + box.h - inset;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]]) {
    if (p === 0) {
      if (q < 0) return false; // parallel and outside this slab
      continue;
    }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

let problems = 0;

for (const arrow of arrows) {
  const pts = abs(arrow);
  for (const box of boxes) {
    if (box.id === arrow.startBinding?.elementId || box.id === arrow.endBinding?.elementId) continue;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (segHitsBox(pts[i], pts[i + 1], box)) {
        console.log(`CROSS  [${relName(arrow)}] seg${i} through ${box.name}`);
        problems++;
      }
    }
  }
}

/** Two segments that share a direction and sit within 6px of each other. */
function overlapLen(a0, a1, b0, b1) {
  const dx1 = a1[0] - a0[0], dy1 = a1[1] - a0[1];
  const dx2 = b1[0] - b0[0], dy2 = b1[1] - b0[1];
  const l1 = Math.hypot(dx1, dy1), l2 = Math.hypot(dx2, dy2);
  if (l1 < 1 || l2 < 1) return 0;
  const cross = Math.abs((dx1 / l1) * (dy2 / l2) - (dy1 / l1) * (dx2 / l2));
  if (cross > 0.02) return 0; // not parallel
  const vertical = Math.abs(dx1) < 1;
  const off = vertical
    ? Math.abs(a0[0] - b0[0])
    : Math.abs(a0[1] - b0[1]);
  if (off > 6) return 0;
  // Project both segments onto the axis they share, then intersect.
  const span = (p, q) => vertical
    ? [Math.min(p[1], q[1]), Math.max(p[1], q[1])]
    : [Math.min(p[0], q[0]), Math.max(p[0], q[0])];
  const sa = span(a0, a1);
  const sb = span(b0, b1);
  return Math.max(0, Math.min(sa[1], sb[1]) - Math.max(sa[0], sb[0]));
}

for (let i = 0; i < arrows.length; i++) {
  for (let j = i + 1; j < arrows.length; j++) {
    const pa = abs(arrows[i]), pb = abs(arrows[j]);
    for (let u = 0; u + 1 < pa.length; u++) {
      for (let v = 0; v + 1 < pb.length; v++) {
        const len = overlapLen(pa[u], pa[u + 1], pb[v], pb[v + 1]);
        if (len > 24) {
          console.log(`OVERLAP [${relName(arrows[i])}] x [${relName(arrows[j])}] parallel ${Math.round(len)}px`);
          problems++;
        }
      }
    }
  }
}

console.log(problems === 0 ? "OK — no crossings through boxes, no parallel overlaps" : `${problems} issue(s)`);