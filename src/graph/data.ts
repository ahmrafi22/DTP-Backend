/**
 * The predefined Dhaka road graph: stops, legs and named corridors.
 *
 * Structure
 *   NODES   stops (id -> name, zone, lat, lng)
 *   EDGES   legs between adjacent stops with distance, congestion, time, price
 *   ROUTES  named routes = ordered stop lists
 *
 * Notes
 *   - Leg distance = straight-line km x ROAD_FACTOR.
 *   - Leg price = km x rate x congestion factor, rounded to whole taka.
 *   - All money is integer paisa (100 paisa = 1 taka).
 *   - Edges are undirected: a route can be travelled in either direction.
 *
 * This module is data and topology only. What a leg costs lives in
 * `pricing.ts`; pathfinding over this topology lives in `routing.ts`.
 */

export const BASE_FARE_PAISA = 3000; // ৳30 flat, once per passenger
const RATE_PER_KM_PAISA = 1800; // ৳18 per km before congestion
const MIN_LEG_PAISA = 1000; // no leg cheaper than ৳10
const ROAD_FACTOR = 1.35;
const BASE_SPEED_KMH = 28;

/** Pool discount by how many riders share a leg (PRD §6). */
export const POOL_DISCOUNT_PCT = { 1: 0, 2: 20, 3: 30 } as const;

/** The rider counts that have a discount tier: 1, 2 or 3. */
export type RiderTier = keyof typeof POOL_DISCOUNT_PCT;

/** How many riders share each leg id, e.g. { "banani~gulshan2": 2 }. */
export type RidersPerLeg = Record<string, number>;

export interface Node {
  id: string;
  name: string;
  zone: string;
  lat: number;
  lng: number;
}

export interface Edge {
  /** 'a~b' with sorted endpoint ids. */
  id: string;
  from: string;
  to: string;
  km: number;
  congestion: number;
  durationMin: number;
  pricePaisa: number;
}

export interface Route {
  id: string;
  code: string;
  name: string;
  corridor: string;
  stops: string[];
  legs: Edge[];
  totalKm: number;
  totalMin: number;
  totalPricePaisa: number;
}

export interface Path {
  stops: string[];
  legs: Edge[];
  total: number;
}

/** Array element at `index`, or a RangeError, for loop-bounded indexes. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`Index ${index} is out of range (length ${items.length})`);
  }
  return item;
}

// ---------- nodes ----------
type RawNode = readonly [name: string, zone: string, lat: number, lng: number];

const RAW_NODES: Readonly<Record<string, RawNode>> = {
  uttara_sec18: ["Uttara Sector 18", "north", 23.891979, 90.402534],
  abdullahpur: ["Abdullahpur", "north", 23.879735, 90.402068],
  uttara_hb: ["Uttara House Building", "north", 23.872963, 90.397517],
  rajlakshmi: ["Uttara Rajlakshmi", "north", 23.863847, 90.404981],
  airport: ["Airport", "north", 23.853712, 90.381518],
  kurmitola: ["Kurmitola", "north", 23.816, 90.400189],
  khilkhet: ["Khilkhet", "north", 23.830509, 90.416589],
  kuril: ["Kuril", "north", 23.821067, 90.420964],
  bashundhara: ["Bashundhara R/A", "north", 23.815209, 90.428087],
  purbachal: ["Purbachal", "north", 23.776065, 90.500594],
  banani: ["Banani", "north-central", 23.793995, 90.404263],
  gulshan2: ["Gulshan 2", "north-central", 23.794397, 90.41435],
  gulshan1: ["Gulshan 1", "north-central", 23.778854, 90.416705],
  baridhara: ["Baridhara", "north-central", 23.805154, 90.419351],
  notun_bazar: ["Notun Bazar", "north-central", 23.797281, 90.425579],
  badda: ["Badda", "north-central", 23.779669, 90.426002],
  mohakhali: ["Mohakhali", "north-central", 23.776569, 90.4001],
  aftabnagar: ["Aftabnagar", "east", 23.748884, 90.449096],
  banasree: ["Banasree", "east", 23.762016, 90.438523],
  rampura: ["Rampura", "east", 23.759266, 90.42503],
  khilgaon: ["Khilgaon", "east", 23.745681, 90.426479],
  basabo: ["Basabo", "east", 23.735719, 90.431367],
  mugda: ["Mugda", "east", 23.725594, 90.433668],
  kamalapur: ["Kamalapur", "east", 23.729251, 90.426466],
  sayedabad: ["Sayedabad", "east", 23.718094, 90.425718],
  jatrabari: ["Jatrabari", "east", 23.709976, 90.434049],
  demra: ["Demra", "east", 23.709152, 90.467188],
  motijheel: ["Motijheel", "central", 23.733929, 90.418523],
  paltan: ["Paltan", "central", 23.737225, 90.408941],
  gulistan: ["Gulistan", "central", 23.725613, 90.412067],
  malibagh: ["Malibagh", "central", 23.744888, 90.414683],
  moghbazar: ["Moghbazar", "central", 23.749118, 90.402253],
  kawran_bazar: ["Karwan Bazar", "central", 23.750531, 90.392846],
  farmgate: ["Farmgate", "central", 23.757123, 90.390019],
  tejgaon: ["Tejgaon", "central", 23.764075, 90.392765],
  shahbagh: ["Shahbagh", "central", 23.738953, 90.395119],
  dhaka_univ: ["Dhaka University", "central", 23.733802, 90.392322],
  new_market: ["New Market", "central", 23.733117, 90.384416],
  science_lab: ["Science Lab", "central", 23.738445, 90.384311],
  panthapath: ["Panthapath", "central", 23.75212, 90.385216],
  dhanmondi27: ["Dhanmondi 27", "west", 23.755216, 90.376329],
  dhanmondi_satmasjid: ["Dhanmondi Satmasjid", "west", 23.745852, 90.371305],
  mohammadpur: ["Mohammadpur", "west", 23.765317, 90.359157],
  shyamoli: ["Shyamoli", "west", 23.773658, 90.365838],
  agargaon: ["Agargaon", "west", 23.777508, 90.380502],
  technical: ["Technical More", "west", 23.781065, 90.352242],
  gabtoli: ["Gabtoli", "west", 23.78061, 90.349405],
  mirpur1: ["Mirpur 1", "mirpur", 23.795509, 90.353591],
  shewrapara: ["Shewrapara", "mirpur", 23.792257, 90.374289],
  kazipara: ["Kazipara", "mirpur", 23.798507, 90.372108],
  mirpur10: ["Mirpur 10", "mirpur", 23.806966, 90.368517],
  mirpur11: ["Mirpur 11", "mirpur", 23.815799, 90.366017],
  mirpur12: ["Mirpur 12", "mirpur", 23.830343, 90.362815],
  mirpur14: ["Mirpur 14", "mirpur", 23.800005, 90.383013],
  mirpur_dohs: ["Mirpur DOHS", "mirpur", 23.823153, 90.382252],
  azimpur: ["Azimpur", "old-dhaka", 23.728536, 90.386019],
  lalbagh: ["Lalbagh", "old-dhaka", 23.719804, 90.389889],
  chawkbazar: ["Chawkbazar", "old-dhaka", 23.716498, 90.395823],
  babubazar: ["Babubazar", "old-dhaka", 23.712363, 90.400407],
  sadarghat: ["Sadarghat", "old-dhaka", 23.712742, 90.40528],
};

export const NODES: Readonly<Record<string, Node>> = Object.fromEntries(
  Object.entries(RAW_NODES).map(([id, [name, zone, lat, lng]]) => [id, { id, name, zone, lat, lng }]),
);

// ---------- edges ----------
/** [from, to, congestion multiplier] */
type RawEdge = readonly [from: string, to: string, congestion: number];

const RAW_EDGES: readonly RawEdge[] = [
  ["uttara_sec18", "abdullahpur", 0.9], ["abdullahpur", "uttara_hb", 1.0], ["uttara_hb", "rajlakshmi", 1.1],
  ["rajlakshmi", "airport", 1.0], ["airport", "kurmitola", 1.0], ["kurmitola", "banani", 1.2],
  ["banani", "mohakhali", 1.4],
  ["airport", "khilkhet", 1.1], ["khilkhet", "kuril", 1.2], ["kuril", "bashundhara", 1.1],
  ["bashundhara", "purbachal", 0.9], ["kuril", "notun_bazar", 1.3],
  ["notun_bazar", "baridhara", 1.2], ["baridhara", "gulshan2", 1.2], ["gulshan2", "banani", 1.2],
  ["gulshan2", "gulshan1", 1.4], ["gulshan1", "mohakhali", 1.3], ["gulshan1", "badda", 1.5],
  ["notun_bazar", "badda", 1.4],
  ["badda", "aftabnagar", 1.2], ["aftabnagar", "banasree", 1.2], ["banasree", "rampura", 1.3],
  ["badda", "rampura", 1.5], ["rampura", "khilgaon", 1.4], ["rampura", "malibagh", 1.5],
  ["khilgaon", "malibagh", 1.5], ["khilgaon", "basabo", 1.3], ["basabo", "mugda", 1.3],
  ["mugda", "kamalapur", 1.3], ["mugda", "jatrabari", 1.4], ["kamalapur", "sayedabad", 1.5],
  ["sayedabad", "jatrabari", 1.6], ["jatrabari", "demra", 1.2], ["kamalapur", "motijheel", 1.4],
  ["motijheel", "paltan", 1.3], ["motijheel", "gulistan", 1.4], ["paltan", "gulistan", 1.3],
  ["paltan", "malibagh", 1.5], ["paltan", "shahbagh", 1.4], ["malibagh", "moghbazar", 1.5],
  ["moghbazar", "mohakhali", 1.5], ["moghbazar", "kawran_bazar", 1.6],
  ["mohakhali", "tejgaon", 1.4], ["tejgaon", "farmgate", 1.4], ["farmgate", "kawran_bazar", 1.6],
  ["kawran_bazar", "shahbagh", 1.5], ["kawran_bazar", "panthapath", 1.4], ["farmgate", "agargaon", 1.3],
  ["shahbagh", "dhaka_univ", 1.4], ["dhaka_univ", "new_market", 1.4], ["shahbagh", "science_lab", 1.4],
  ["science_lab", "new_market", 1.4], ["panthapath", "science_lab", 1.5], ["panthapath", "dhanmondi27", 1.5],
  ["dhanmondi27", "dhanmondi_satmasjid", 1.3], ["dhanmondi_satmasjid", "science_lab", 1.4],
  ["dhanmondi_satmasjid", "mohammadpur", 1.3], ["dhanmondi27", "mohammadpur", 1.4],
  ["dhanmondi27", "shyamoli", 1.3], ["shyamoli", "mohammadpur", 1.3], ["shyamoli", "agargaon", 1.3],
  ["shyamoli", "technical", 1.3], ["technical", "gabtoli", 1.1], ["technical", "mirpur1", 1.2],
  ["agargaon", "shewrapara", 1.2], ["agargaon", "mirpur14", 1.2], ["shewrapara", "kazipara", 1.2],
  ["kazipara", "mirpur10", 1.3], ["mirpur14", "mirpur10", 1.2], ["mirpur14", "banani", 1.1],
  ["mirpur10", "mirpur1", 1.3], ["mirpur10", "mirpur11", 1.2], ["mirpur11", "mirpur12", 1.1],
  ["mirpur12", "mirpur_dohs", 1.0], ["mirpur_dohs", "kurmitola", 1.1],
  ["new_market", "azimpur", 1.4], ["azimpur", "lalbagh", 1.3], ["lalbagh", "chawkbazar", 1.4],
  ["chawkbazar", "babubazar", 1.3], ["chawkbazar", "sadarghat", 1.5], ["sadarghat", "babubazar", 1.4],
  ["sadarghat", "gulistan", 1.6],
];

const toRad = (d: number): number => (d * Math.PI) / 180;

function haversineKm(a: Node, b: Node): number {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export const edgeKey = (a: string, b: string): string => [a, b].sort().join("~");

export const EDGES: readonly Edge[] = RAW_EDGES.map(([from, to, congestion]) => {
  const a = NODES[from];
  const b = NODES[to];
  if (!a || !b) throw new Error(`Unknown node in edge ${from}-${to}`);
  const km = Math.max(0.6, Math.round(haversineKm(a, b) * ROAD_FACTOR * 10) / 10);
  const pricePaisa = Math.max(MIN_LEG_PAISA, Math.round((km * RATE_PER_KM_PAISA * congestion) / 100) * 100);
  const durationMin = Math.max(2, Math.round((km / (BASE_SPEED_KMH / congestion)) * 60));
  return { id: edgeKey(from, to), from, to, km, congestion, durationMin, pricePaisa };
});

export const EDGE_MAP: ReadonlyMap<string, Edge> = new Map(EDGES.map((e) => [e.id, e]));

export const getEdge = (a: string, b: string): Edge | null => EDGE_MAP.get(edgeKey(a, b)) ?? null;

/**
 * Resolve a stored 'a~b' leg id back to its edge. Throws when the id is
 * malformed or names a leg the graph no longer has — a stored leg that cannot
 * resolve is data corruption, not a condition to paper over with a null.
 */
export function edgeByLegId(legId: string): Edge {
  const [a, b] = legId.split("~");
  if (!a || !b) throw new Error(`Malformed leg id: ${legId}`);
  const edge = EDGE_MAP.get(edgeKey(a, b));
  if (!edge) throw new Error(`Unknown leg in the road graph: ${legId}`);
  return edge;
}

interface AdjacencyEntry {
  to: string;
  edge: Edge;
}

export const ADJACENCY: ReadonlyMap<string, readonly AdjacencyEntry[]> = (() => {
  const map = new Map<string, AdjacencyEntry[]>();
  for (const id of Object.keys(NODES)) map.set(id, []);
  for (const e of EDGES) {
    map.get(e.from)?.push({ to: e.to, edge: e });
    map.get(e.to)?.push({ to: e.from, edge: e });
  }
  return map;
})();

// ---------- routes ----------
/** [code, name, corridor, ordered stops] */
type RawRoute = readonly [code: string, name: string, corridor: string, stops: readonly string[]];

const RAW_ROUTES: readonly RawRoute[] = [
  ["R01", "Uttara to Mohakhali (Airport Road)", "Airport Road", ["uttara_hb", "rajlakshmi", "airport", "kurmitola", "banani", "mohakhali"]],
  ["R02", "Uttara North to Airport", "Uttara", ["uttara_sec18", "abdullahpur", "uttara_hb", "rajlakshmi", "airport"]],
  ["R03", "Airport to Purbachal", "Kuril-Purbachal Expressway", ["airport", "khilkhet", "kuril", "bashundhara", "purbachal"]],
  ["R04", "Kuril to Rampura (Progoti Sarani)", "Progoti Sarani", ["kuril", "notun_bazar", "badda", "rampura"]],
  ["R05", "Banani to Mohakhali via Gulshan", "Gulshan Ring", ["banani", "gulshan2", "gulshan1", "mohakhali"]],
  ["R06", "Notun Bazar to Banani via Baridhara", "Baridhara", ["notun_bazar", "baridhara", "gulshan2", "banani"]],
  ["R07", "Gulshan 1 to Banasree", "Badda-Aftabnagar", ["gulshan1", "badda", "aftabnagar", "banasree"]],
  ["R08", "Banasree to Motijheel", "Rampura-Malibagh", ["banasree", "rampura", "malibagh", "paltan", "motijheel"]],
  ["R09", "Badda to Mugda", "Rampura-Basabo", ["badda", "rampura", "khilgaon", "basabo", "mugda"]],
  ["R10", "Mugda to Sadarghat", "Kamalapur-Motijheel", ["mugda", "kamalapur", "motijheel", "gulistan", "sadarghat"]],
  ["R11", "Mugda to Demra", "Dhaka-Demra Road", ["mugda", "jatrabari", "demra"]],
  ["R12", "Kamalapur to Jatrabari", "Sayedabad", ["kamalapur", "sayedabad", "jatrabari"]],
  ["R13", "Mohakhali to Shahbagh", "Tejgaon-Farmgate", ["mohakhali", "tejgaon", "farmgate", "kawran_bazar", "shahbagh"]],
  ["R14", "Mohakhali to Gulistan", "Moghbazar-Malibagh", ["mohakhali", "moghbazar", "malibagh", "paltan", "gulistan"]],
  ["R15", "Moghbazar to Dhanmondi 27", "Karwan Bazar-Panthapath", ["moghbazar", "kawran_bazar", "panthapath", "dhanmondi27"]],
  ["R16", "Farmgate to Mohammadpur", "Agargaon-Shyamoli", ["farmgate", "agargaon", "shyamoli", "mohammadpur"]],
  ["R17", "Farmgate to Mirpur 12", "Mirpur Road", ["farmgate", "agargaon", "mirpur14", "mirpur10", "mirpur11", "mirpur12"]],
  ["R18", "Mirpur 10 to Gabtoli", "Mirpur-Technical", ["mirpur10", "mirpur1", "technical", "gabtoli"]],
  ["R19", "Agargaon to Mirpur 10", "Shewrapara-Kazipara", ["agargaon", "shewrapara", "kazipara", "mirpur10"]],
  ["R20", "Mirpur 12 to Banani via DOHS", "Mirpur DOHS-Airport Road", ["mirpur12", "mirpur_dohs", "kurmitola", "banani"]],
  ["R21", "Mirpur 14 to Banani", "Kachukhet-Banani", ["mirpur14", "banani"]],
  ["R22", "Technical to Panthapath", "Shyamoli-Dhanmondi", ["technical", "shyamoli", "dhanmondi27", "panthapath"]],
  ["R23", "Mohammadpur to New Market", "Satmasjid Road", ["mohammadpur", "dhanmondi_satmasjid", "science_lab", "new_market"]],
  ["R24", "Dhanmondi 27 to Satmasjid", "Dhanmondi Inner", ["dhanmondi27", "dhanmondi_satmasjid"]],
  ["R25", "Panthapath to Chawkbazar", "Elephant Road-Azimpur", ["panthapath", "science_lab", "new_market", "azimpur", "lalbagh", "chawkbazar"]],
  ["R26", "Shahbagh to New Market", "University Road", ["shahbagh", "dhaka_univ", "new_market"]],
  ["R27", "Shahbagh to Motijheel", "Purana Paltan", ["shahbagh", "paltan", "motijheel"]],
  ["R28", "Chawkbazar to Babubazar", "Old Dhaka South", ["chawkbazar", "sadarghat", "babubazar"]],
  ["R29", "Old Dhaka Loop", "Old Dhaka", ["azimpur", "lalbagh", "chawkbazar", "babubazar", "sadarghat", "gulistan"]],
  ["R30", "Rampura to Malibagh via Khilgaon", "Khilgaon-Malibagh", ["rampura", "khilgaon", "malibagh"]],
  ["R31", "Uttara to Motijheel (Express)", "North-South Trunk", ["uttara_hb", "rajlakshmi", "airport", "kurmitola", "banani", "mohakhali", "tejgaon", "farmgate", "kawran_bazar", "shahbagh", "paltan", "motijheel"]],
  ["R32", "Mirpur 12 to Motijheel", "Mirpur-Farmgate-Motijheel", ["mirpur12", "mirpur11", "mirpur10", "mirpur14", "agargaon", "farmgate", "kawran_bazar", "moghbazar", "malibagh", "paltan", "motijheel"]],
  ["R33", "Bashundhara to Mohakhali", "Kuril-Gulshan-Banani", ["bashundhara", "kuril", "notun_bazar", "baridhara", "gulshan2", "banani", "mohakhali"]],
  ["R34", "Gabtoli to Karwan Bazar", "Technical-Farmgate", ["gabtoli", "technical", "shyamoli", "agargaon", "farmgate", "kawran_bazar"]],
  ["R35", "Demra to Motijheel", "Jatrabari-Sayedabad", ["demra", "jatrabari", "sayedabad", "kamalapur", "motijheel"]],
  ["R36", "Aftabnagar to Kuril", "Badda-Notun Bazar", ["aftabnagar", "badda", "notun_bazar", "kuril"]],
  ["R37", "Dhanmondi 27 to Mohammadpur (direct)", "Mirpur Road South", ["dhanmondi27", "mohammadpur"]],
  ["R38", "Shahbagh to Panthapath via Science Lab", "Science Lab Road", ["shahbagh", "science_lab", "panthapath"]],
];

export const ROUTES: readonly Route[] = RAW_ROUTES.map(([code, name, corridor, stops]) => {
  const legs: Edge[] = [];
  for (let i = 0; i < stops.length - 1; i += 1) {
    const from = at(stops, i);
    const to = at(stops, i + 1);
    const edge = getEdge(from, to);
    if (!edge) throw new Error(`Route ${code}: no edge between ${from} and ${to}`);
    legs.push(edge);
  }
  return {
    id: code,
    code,
    name,
    corridor,
    stops: [...stops],
    legs,
    totalKm: Math.round(legs.reduce((s, l) => s + l.km, 0) * 10) / 10,
    totalMin: legs.reduce((s, l) => s + l.durationMin, 0),
    totalPricePaisa: legs.reduce((s, l) => s + l.pricePaisa, 0),
  };
});

export const ROUTE_MAP: ReadonlyMap<string, Route> = new Map(ROUTES.map((r) => [r.id, r]));

export const getRoute = (id: string): Route | null => ROUTE_MAP.get(id) ?? null;
