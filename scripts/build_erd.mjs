/**
 * Generates an Excalidraw (.excalidraw) entity-relationship diagram for the DTP
 * schema. Geometry is computed, not hand-typed, so boxes grow with their
 * longest column line and nothing overlaps.
 *
 * Source of truth is the live Postgres database — sql/*.sql has drifted
 * (vehicles.color, vehicles.corridor_route_id, ride_requests.settled_at,
 * ride_events, wallets cascade, ...).
 *
 *   node scripts/build_erd.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { C, TABLES, RELS } from "./erd_schema.mjs";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- constants

const FONT = 13;
const LINE_HEIGHT = 1.25;
const CHAR_W = FONT * 0.62; // monospace advance; measured generously so text
                             // never runs into the box border
const ROW_H = Math.ceil(FONT * LINE_HEIGHT); // 17
const PAD_X = 16;
const HEAD_H = 34;
const GAP_TOP = 11;
const GAP_BOT = 11;


// ------------------------------------------------------------------ helpers

let seed = 1000;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
let uid = 0;
const nextId = () => `el${(uid++).toString(36).padStart(4, "0")}`;

const base = (type, x, y, w, h, over = {}) => ({
  id: nextId(),
  type,
  x,
  y,
  width: w,
  height: h,
  angle: 0,
  strokeColor: C.ink,
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  strokeDasharray: "solid", // Excalidraw enum: solid | dashes | dots
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  seed: rand(),
  version: 1,
  versionNonce: rand(),
  isDeleted: false,
  boundElements: null,
  updated: 1717171717,
  link: null,
  locked: false,
  ...over,
});

function text(x, y, w, str, over = {}) {
  const fs = over.fontSize ?? FONT;
  const lines = str.split("\n").length;
  return base("text", x, y, w, lines * Math.ceil(fs * (over.lineHeight ?? LINE_HEIGHT)), {
    fontSize: fs,
    fontFamily: over.fontFamily ?? 3, // 3 = monospace
    text: str,
    originalText: str,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    lineHeight: over.lineHeight ?? LINE_HEIGHT,
    autoResize: true,
    baseline: Math.round(fs * 0.9), // legacy field; Excalidraw's renderer ignores it
    ...over,
  });
}

const rect = (x, y, w, h, over = {}) =>
  base("rectangle", x, y, w, h, { roundness: { type: 3 }, ...over });

/** Vertical centre of the header strip + column row `i` of a table box. */
const rowY = (b, i) => b.y + HEAD_H + GAP_TOP + i * ROW_H + ROW_H / 2;

/** Left edge of the text of column row `i` — where a top/bottom anchor sits. */
const rowX = (b, i) => b.x + PAD_X;

/**
 * Anchor a connector on the box edge at the row it actually refers to, so the
 * line leaves the foreign-key column and lands on the key it references.
 * `spread` nudges along the edge to keep several lines into one row readable.
 */
function anchor(b, side, row, spread = 0) {
  switch (side) {
    case "L": return [b.x, rowY(b, row) + spread];
    case "R": return [b.x + b.width, rowY(b, row) + spread];
    case "T": return [rowX(b, row) + spread, b.y];
    case "B": return [rowX(b, row) + spread, b.y + b.height];
    default: throw new Error(`bad side ${side}`);
  }
}

// ------------------------------------------------------------------- render

const elements = [];
const byName = new Map();

// Measure every table first, so the gutter pass below can keep them apart
// regardless of how wide the column lists make them.
const measured = TABLES.map((t) => {
  const nameW = Math.max(...t.cols.map((c) => c.n.length));
  const lines = t.cols.map((c) => c.n.padEnd(nameW) + "  " + c.t + (c.k ? `  ${c.k}` : ""));
  const maxLen = Math.max(...lines.map((l) => l.length));
  return {
    ...t, lines,
    width: Math.max(170, Math.ceil(PAD_X * 2 + 12 + maxLen * CHAR_W)),
    height: HEAD_H + GAP_TOP + t.cols.length * ROW_H + GAP_BOT,
  };
});

// Two tables overlap horizontally only if their vertical ranges meet. Slide
// each one right until it clears its left-hand neighbour by GUTTER, so there is
// always a corridor to route connectors through.
const GUTTER = 92;
const placed = [];
for (const t of [...measured].sort((a, b) => a.x - b.x)) {
  for (const o of placed) {
    const yOverlap = t.y < o.y + o.height && o.y < t.y + t.height;
    if (yOverlap && o.x + o.width + GUTTER > t.x) t.x = o.x + o.width + GUTTER;
  }
  placed.push(t);
}

for (const t of measured) {
  const { lines, width, height } = t;
  const gid = nextId();

  const body = rect(t.x, t.y, width, height, {
    strokeColor: t.c.s, backgroundColor: "#ffffff", strokeWidth: 2, groupIds: [gid],
  });
  const head = rect(t.x, t.y, width, HEAD_H, {
    strokeColor: t.c.s, backgroundColor: t.c.b, strokeWidth: 2, groupIds: [gid],
  });
  const name = text(t.x + PAD_X, t.y + 9, width - PAD_X * 2, t.name, {
    fontSize: 16, fontFamily: 2, strokeColor: t.c.s, groupIds: [gid],
  });
  const cols = text(t.x + PAD_X, t.y + HEAD_H + GAP_TOP, width - PAD_X * 2 + 24, lines.join("\n"), {
    groupIds: [gid],
  });

  elements.push(body, head, name, cols);
  byName.set(t.name, {
    x: t.x, y: t.y, width, height, gid, bodyId: body.id,
  });
}

/** Column row index by name, so connectors can name their FK and key. */
for (const t of measured) {
  byName.get(t.name).row = Object.fromEntries(t.cols.map((c, i) => [c.n, i]));
}

// node scripts/build_erd.mjs --geometry dumps resolved boxes and row centres so
// connector routes can be tuned against real numbers instead of guesses.
if (process.argv.includes("--geometry")) {
  const r = (n) => Math.round(n);
  for (const t of measured) {
    console.log(`${t.name.padEnd(20)} x ${String(r(t.x)).padStart(5)}-${r(t.x + t.width)}` +
      `  y ${String(r(t.y)).padStart(5)}-${r(t.y + t.height)}`);
    t.cols.forEach((c, i) => console.log(`   ${String(r(rowY(t, i))).padStart(5)}  ${c.n}`));
  }
  process.exit(0);
}

for (const [str, x, y, color] of [
  ["GEOGRAPHY  ·  stops, corridors, priced legs", 90, 140, C.blue.s],
  ["ACTORS  ·  people and their vehicles", 774, 140, C.purple.s],
  ["RIDES  ·  pooled trips and passenger requests", 1201, 140, C.teal.s],
  ["MONEY & AUDIT  ·  fare breakdown, ledger, trail", 1800, 140, C.green.s],
]) {
  elements.push(text(x, y, 560, str, { fontSize: 17, fontFamily: 2, strokeColor: color }));
}

// --------------------------------------------------------------- connectors

for (const r of RELS) {
  const src = byName.get(r.s);
  const dst = byName.get(r.t);
  if (!src || !dst) throw new Error(`unknown table in ${r.s} -> ${r.t}`);
  for (const [b, k] of [[src, r.sc], [dst, r.tc]]) {
    if (!(k in b.row)) throw new Error(`unknown column ${k} on ${b === src ? r.s : r.t}`);
  }

  // Anchors sit on the row of the foreign key and of the key it references.
  const p0 = anchor(src, r.ss, src.row[r.sc], r.sd ?? 0);
  const p1 = anchor(dst, r.ts, dst.row[r.tc], r.td ?? 0);
  const mids = r.via ?? [];

  const pts = [p0, ...mids, p1];
  const ax = Math.min(...pts.map((p) => p[0]));
  const ay = Math.min(...pts.map((p) => p[1]));
  const norm = pts.map((p) => [p[0] - ax, p[1] - ay]);

  elements.push(
    base("arrow", ax, ay,
      Math.max(...norm.map((p) => p[0])), Math.max(...norm.map((p) => p[1])), {
        strokeColor: C.line,
        strokeWidth: 2,
        strokeDasharray: r.opt ? "dashes" : "solid",
        points: norm,
        lastCommittedPoint: null,
        startBinding: { elementId: src.bodyId, focus: 0, gap: 4 },
        endBinding: { elementId: dst.bodyId, focus: 0, gap: 4 },
        startArrowhead: null,
        endArrowhead: "arrow",
        elbowed: false,
      }),
  );

  if (r.card) {
    // Park the cardinality label on the midpoint of the longest segment, which
    // is the stretch most likely to have open space beside it.
    let best = 1;
    const len = (i) => Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    for (let i = 2; i < pts.length; i++) {
      if (len(i) > len(best)) best = i;
    }
    const [fx, fy] = pts[best - 1];
    const [tx, ty] = pts[best];
    elements.push(
      text((fx + tx) / 2 - 13, (fy + ty) / 2 - 8, 46, r.card, {
        fontSize: 12, strokeColor: C.line, backgroundColor: "#ffffff", lineHeight: 1.1,
      }),
    );
  }
}

// ------------------------------------------------------------------- legend

const LEGEND = [
  "PK  primary key        UQ  unique constraint",
  "FK  required foreign key       FK?  optional / nullable",
  "[]  postgres array      []   arrowhead points at the parent table",
  "",
  "users.role            passenger | driver | admin",
  "rides.status          MATCHED | DRIVER_ARRIVED | STARTED",
  "                      COMPLETED | CANCELLED",
  "ride_requests.status  REQUESTED | MATCHED | DRIVER_ARRIVED",
  "                      STARTED | COMPLETED | CANCELLED",
  "payment_method        CASH | WALLET",
  "wallet kind           TOPUP | RIDE_CHARGE | RIDE_EARNING",
  "fare discount_pct     0 | 20 | 30",
  "",
  "ON DELETE   routes <-> route_stops .............. CASCADE",
  "              fare_legs, ride_events ......... CASCADE",
  "              wallets, wallet_transactions .... CASCADE",
  "              ride_requests.ride_id ........... SET NULL",
  "              wallet request_id / counterparty SET NULL",
];

// Both boxes sit below the tables and clear of the bottom routing corridors.
const LEGEND_BOX_Y = 1420;
const legendW = 620;
const legendH = HEAD_H + GAP_TOP + LEGEND.length * ROW_H + GAP_BOT;
elements.push(
  rect(90, LEGEND_BOX_Y, legendW, legendH, {
    strokeColor: C.muted, backgroundColor: "#f8f9fa", strokeWidth: 1,
  }),
  text(106, LEGEND_BOX_Y + 11, legendW - 32, "LEGEND", { fontSize: 16, fontFamily: 2, strokeColor: C.ink }),
  text(106, LEGEND_BOX_Y + HEAD_H + GAP_TOP, legendW - 32 + 24, LEGEND.join("\n")),
);

// --------------------------------------------------------------- invariants

const NOTES = [
  "Every amount is INTEGER PAISA — no",
  "float money anywhere, so no rounding",
  "drift can accumulate.",
  "",
  "seats_taken <= capacity and",
  "balance_paisa >= 0 are CHECK",
  "constraints in the database, not",
  "just application code.",
  "",
  "wallet_transactions is an append-only",
  "signed ledger; balance_after_paisa",
  "snapshots the balance per row, so any",
  "balance replays from history.",
];

const NOTES_BOX_Y = LEGEND_BOX_Y + legendH + 40;
const noteW = 440;
const noteH = HEAD_H + GAP_TOP + NOTES.length * ROW_H + GAP_BOT;
elements.push(
  rect(90, NOTES_BOX_Y, noteW, noteH, {
    strokeColor: C.green.s, backgroundColor: "#ffffff", strokeWidth: 2,
  }),
  text(106, NOTES_BOX_Y + 11, noteW - 32, "INVARIANTS", {
    fontSize: 16, fontFamily: 2, strokeColor: C.green.s,
  }),
  text(106, NOTES_BOX_Y + HEAD_H + GAP_TOP, noteW - 32 + 24, NOTES.join("\n")),
);

// -------------------------------------------------------------------- header

elements.push(
  text(90, 44, 1600, "Dhaka Tesla Pool — Entity Relationship Diagram", {
    fontSize: 30, fontFamily: 2, strokeColor: C.ink,
  }),
  text(90, 96, 1600, "Rideshare pooling app  ·  PostgreSQL (Neon)  ·  13 tables  ·  24 foreign keys", {
    fontSize: 15, fontFamily: 2, strokeColor: C.muted,
  }),
);

// --------------------------------------------------------------------- file

const file = {
  type: "excalidraw",
  version: 2,
  source: "https://github.com/excalidraw/excalidraw",
  elements,
  appState: {
    gridSize: null, gridStep: 5, gridModeEnabled: false,
    viewBackgroundColor: "#ffffff",
    scrollX: 0, scrollY: 0, zoom: { value: 0.4 },
    openMenu: null,
    activeTool: { type: "selection", customType: null, locked: false },
    showStats: false,
  },
  files: {},
};

const bad = elements.filter((e) =>
  ["x", "y", "width", "height"].some((k) => !Number.isFinite(e[k])),
);
if (bad.length) {
  throw new Error(`non-finite geometry on: ${bad.map((e) => `${e.type}:${e.id}`).join(", ")}`);
}

const outPath = join(outDir, "dtp-erd.excalidraw");

// Open the file already framed on the whole diagram. Excalidraw maps scene to
// screen as (scene - scroll) * zoom, so centring the canvas' midpoint in a
// typical 1440x900 viewport puts every table on screen without a manual fit.
const ZOOM = 0.42;
const VIEW_W = 1440;
const VIEW_H = 900;
const spanW = Math.max(...elements.map((e) => e.x + e.width));
const spanH = Math.max(...elements.map((e) => e.y + e.height));
file.appState.zoom = { value: ZOOM };
file.appState.scrollX = Math.round(spanW / 2 - VIEW_W / 2 / ZOOM);
file.appState.scrollY = Math.round(spanH / 2 - VIEW_H / 2 / ZOOM);

writeFileSync(outPath, JSON.stringify(file, null, 2) + "\n", "utf8");

const w = Math.max(...elements.map((e) => e.x + e.width));
const h = Math.max(...elements.map((e) => e.y + e.height));
console.log(`wrote ${outPath}`);
console.log(`${elements.length} elements · canvas ${Math.round(w)} x ${Math.round(h)}`);
console.log(`${TABLES.length} tables · ${RELS.length} foreign keys`);
