/**
 * Diffs the live Postgres schema against the ERD schema in scripts/erd_schema.mjs.
 *
 * The diagram is hand-curated (types abbreviated, FK targets inlined), so this
 * compares structure rather than spelling: which tables and columns exist,
 * which columns are foreign keys, and whether each is nullable — the latter is
 * what decides whether a connector is drawn solid or dashed.
 *
 *   node scripts/diff_schema.mjs
 *
 * Exits non-zero when the database has moved on, so it can guard a commit.
 */
import "dotenv/config";
import pg from "pg";
import { TABLES } from "./erd_schema.mjs";

// The diagram documents schema_migrations for completeness; it is migration
// bookkeeping rather than part of the modelled schema, so it is not compared.
const IGNORED_TABLES = new Set(["schema_migrations"]);

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
});
await client.connect();

const { tables, fks, uniques, deleteRules } = await readSchema();

// ------------------------------------------------------- what the diagram has

const expTables = new Map(
  TABLES.filter((t) => !IGNORED_TABLES.has(t.name)).map((t) => [t.name, t]),
);

const expCols = new Map(); // "table.column" -> column spec
for (const t of expTables.values()) {
  for (const c of t.cols) expCols.set(`${t.name}.${c.n}`, c);
}

// Derived from the columns, which name the column outright. RELS cannot be used
// here: two columns of one table can point at the same parent (user_id and
// counterparty_id both reference users), and RELS only records table->table.
const expFks = new Map(); // "table.column->target" -> optional?
for (const t of expTables.values()) {
  for (const c of t.cols) {
    // Key markers read "PK", "UQ", "FK->users", "FK?->users", "FK UQ->users".
    const m = (c.k ?? "").match(/FK\s*\??\s*(?:UQ\s*)?->\s*(\w+)/);
    if (m) expFks.set(`${t.name}.${c.n}->${m[1]}`, (c.k ?? "").includes("FK?"));
  }
}

// ------------------------------------------------------------- what the db has

const problems = [];

for (const name of Object.keys(tables)) {
  if (!expTables.has(name)) problems.push(`table not in diagram: ${name}`);
}
for (const name of expTables.keys()) {
  if (!tables[name]) problems.push(`table in diagram but not in db: ${name}`);
}

for (const [table, cols] of Object.entries(tables)) {
  const spec = expTables.get(table);
  if (!spec) continue;
  const seen = new Set();
  for (const r of cols) {
    const key = `${table}.${r.column_name}`;
    seen.add(r.column_name);
    const c = expCols.get(key);
    if (!c) {
      problems.push(
        `column not in diagram: ${key} ${r.data_type}${r.is_nullable === "YES" ? " NULL" : ""}`);
      continue;
    }
    if (!(c.k ?? "").includes("FK")) continue;
    const drawnOptional = (c.k ?? "").includes("FK?");
    const dbOptional = r.is_nullable === "YES";
    if (drawnOptional !== dbOptional) {
      problems.push(
        `nullability changed: ${key} is ${dbOptional ? "NULL" : "NOT NULL"} in db, ` +
        `drawn as ${drawnOptional ? "FK? (dashed)" : "FK (solid)"}`);
    }
  }
  for (const c of spec.cols) {
    if (!seen.has(c.n)) problems.push(`column in diagram but not in db: ${table}.${c.n}`);
  }
}

const dbFks = new Set(fks);
for (const f of dbFks) if (!expFks.has(f)) problems.push(`foreign key not in diagram: ${f}`);
for (const f of expFks.keys()) {
  if (!dbFks.has(f)) problems.push(`foreign key in diagram but not in db: ${f}`);
}

// The diagram also prints each column's type and flags unique columns, so both
// are checked as well.
for (const [table, cols] of Object.entries(tables)) {
  const spec = expTables.get(table);
  if (!spec) continue;
  for (const r of cols) {
    const c = expCols.get(`${table}.${r.column_name}`);
    if (!c) continue;
    const actual = abbrev(r);
    if (c.t !== actual) {
      problems.push(`type changed: ${table}.${r.column_name} drawn "${c.t}", db says "${actual}"`);
    }
  }
}

for (const [table, col] of uniques) {
  const c = expCols.get(`${table}.${col}`);
  if (!c) continue;
  if (!(c.k ?? "").includes("UQ") && !(c.k ?? "").includes("PK")) {
    problems.push(
      `unique constraint not marked: ${table}.${col} is UNIQUE in db, not flagged in diagram`);
  }
}

// ON DELETE rules are summarised in the legend rather than drawn per column, so
// they are reported for review and flagged only when a rule appears that the
// legend's CASCADE / SET NULL wording would misdescribe.
const UNDOCUMENTED_RULES = new Set(["RESTRICT", "SET DEFAULT"]);
for (const { col, rule } of deleteRules) {
  if (UNDOCUMENTED_RULES.has(rule)) {
    problems.push(`ON DELETE ${rule} on ${col} — legend does not document this rule`);
  }
}

await client.end();

// --------------------------------------------------------------------- report

console.log(`db: ${new URL(process.env.DATABASE_URL).host}`);
console.log(`database: ${Object.keys(tables).length} tables, ${dbFks.size} foreign keys`);
console.log(
  `diagram:  ${expTables.size} tables, ${expFks.size} foreign keys ` +
  `(+ schema_migrations, not compared)`);

const byRule = new Map();
for (const { col, rule } of deleteRules) {
  if (!byRule.has(rule)) byRule.set(rule, []);
  byRule.get(rule).push(col);
}
for (const [rule, cols] of [...byRule].sort()) {
  console.log(`\nON DELETE ${rule}:`);
  for (const c of cols) console.log(`  ${c}`);
}

if (problems.length === 0) {
  console.log("\nIn sync — the diagram matches the live database.");
} else {
  console.log(`\n${problems.length} difference(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
}

async function readSchema() {
  const t = await client.query(`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name <> 'schema_migrations'
    order by table_name`);

  const tables = {};
  for (const { table_name } of t.rows) {
    const cols = await client.query(`
      select column_name, data_type, is_nullable, udt_name,
             numeric_precision, numeric_scale
      from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`, [table_name]);
    tables[table_name] = cols.rows;
  }

  const fk = await client.query(`
    select tc.table_name src, kcu.column_name col, ccu.table_name tgt
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
    join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
    order by 1, 2`);

  // Single-column UNIQUE constraints, excluding primary keys. Composite
  // uniques (fare_legs' (request_id, leg_no)) are not drawn per column, so
  // they are deliberately not compared.
  const uq = await client.query(`
    select tc.table_name, kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
    join (
      select constraint_name from information_schema.key_column_usage
      where table_schema = 'public' group by constraint_name having count(*) = 1
    ) single on single.constraint_name = tc.constraint_name
    where tc.constraint_type = 'UNIQUE' and tc.table_schema = 'public'
    order by 1, 2`);
  const uniques = uq.rows.map((r) => [r.table_name, r.column_name]);

  const del = await client.query(`
    select tc.table_name || '.' || kcu.column_name as col, rc.delete_rule rule
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
    join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
      and rc.delete_rule <> 'NO ACTION'
    order by 1`);

  return {
    tables,
    fks: fk.rows.map((r) => `${r.src}.${r.col}->${r.tgt}`),
    uniques,
    deleteRules: del.rows,
  };
}

/** Postgres type -> the abbreviation the diagram prints. */
function abbrev(r) {
  if (r.data_type === "ARRAY") return `${String(r.udt_name).replace(/^_/, "")}[]`.toUpperCase();
  if (r.data_type === "numeric") {
    return r.numeric_precision == null
      ? "NUMERIC"
      : `NUMERIC(${r.numeric_precision},${r.numeric_scale})`;
  }
  return {
    text: "TEXT",
    integer: "INT",
    bigint: "BIGINT",
    smallint: "SMALLINT",
    boolean: "BOOLEAN",
    "double precision": "DOUBLE PRECISION",
    "timestamp with time zone": "TIMESTAMPTZ",
    jsonb: "JSONB",
  }[r.data_type] ?? r.data_type.toUpperCase();
}