#!/usr/bin/env node
// tools/allez-orm.mjs  —  AllezORM schema generator with foreign-key support (SQLite)
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const CWD = process.cwd();

// ---- robust force detection (works across shells) ----
const FORCE_FROM_ENV = String(process.env.ALLEZ_FORCE || "").trim() === "1";
const FORCE_FROM_ARGV = process.argv.includes("--force") || process.argv.includes("-f");
const FORCE_EFFECTIVE = FORCE_FROM_ENV || FORCE_FROM_ARGV;

function die(msg, code = 1) { console.error(msg); process.exit(code); }
function help() {
  console.log(`
AllezORM schema generator

Usage:
  allez-orm create table <name> [fieldSpec ...]
    [--dir=./schemas] [--ts] [--version=1]
    [--stamps] [--soft-delete] [--force|-f]
    [--onDelete=cascade|restrict|setnull|setdefault]
    [--onUpdate=cascade|restrict|setnull|setdefault]
    [--ensure-refs] [--no-fk-index]

Env overrides:
  ALLEZ_FORCE=1        # forces overwrite even if your shell drops --force

FieldSpec grammar (compact):
  name                       -> TEXT
  name! / name+ / name^ ...  -> short flags directly after name (default type TEXT)
  name:type                  -> type = INTEGER|TEXT|REAL|BLOB|NUMERIC (aliases allowed)
  name:type!+^#~             -> ! NOT NULL, + UNIQUE, ^ INDEX, # PRIMARY KEY, ~ AUTOINCREMENT
  name:type,notnull,unique,index,pk,ai,default=<expr>
  ^col                       -> standalone index on col
  fk shorthand:
    col>table                -> INTEGER REFERENCES table(id)
    col>table(col)           -> INTEGER REFERENCES table(col)
    col:fk(table.col)        -> same, leaves type as INTEGER unless you pass another
  PowerShell-safe FK alias:
    col->table[(col)]        -> same as '>'
  Per-field FK options via commas: ,onDelete=cascade ,onUpdate=restrict ,defer ,deferrable
`);
}

const TYPE_ALIASES = {
  int: "INTEGER", integer: "INTEGER", bool: "INTEGER",
  text: "TEXT", string: "TEXT", datetime: "TEXT", timestamp: "TEXT",
  real: "REAL", float: "REAL",
  number: "NUMERIC", numeric: "NUMERIC", blob: "BLOB"
};

const VALID_ACTIONS = new Set(["cascade", "restrict", "setnull", "setdefault"]);

function kebabToPascal(name) {
  return name.split(/[_\- ]+/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("");
}
function sanitizeTable(name) {
  const ok = name.trim().toLowerCase().replace(/[^\w]/g, "_");
  if (!ok) die("Invalid table name.");
  return ok;
}

function parseArgs(argv) {
  const out = {
    nonFlags: [], dir: "schemas", asTS: false, version: 1, stamps: false, softDelete: false, force: false,
    ensureRefs: true, onDelete: null, onUpdate: null, noFkIndex: false
  };
  for (const a of argv) {
    if (a === "--") continue;                           // ignore npm passthrough token
    if (a === "--ts") out.asTS = true;
    else if (a.startsWith("--dir=")) out.dir = a.split("=")[1];
    else if (a.startsWith("--version=")) out.version = Number(a.split("=")[1] || "1") || 1;
    else if (a === "--stamps") out.stamps = true;
    else if (a === "--soft-delete") out.softDelete = true;
    else if (a === "--force" || a === "-f") out.force = true;
    else if (a === "--ensure-refs") out.ensureRefs = true;
    else if (a === "--no-fk-index") out.noFkIndex = true;
    else if (a.startsWith("--onDelete=")) out.onDelete = a.split("=")[1].toLowerCase();
    else if (a.startsWith("--onUpdate=")) out.onUpdate = a.split("=")[1].toLowerCase();
    else out.nonFlags.push(a);
  }
  if (FORCE_EFFECTIVE) out.force = true;

  if (out.onDelete && !VALID_ACTIONS.has(out.onDelete)) die("Invalid --onDelete action");
  if (out.onUpdate && !VALID_ACTIONS.has(out.onUpdate)) die("Invalid --onUpdate action");
  return out;
}

// ---- helper: parse "name[:type][shortFlags]" into parts ----
function parseNameTypeFlags(base) {
  let name, rhs = "", explicitType = false;

  if (base.includes(":")) {
    [name, rhs = ""] = base.split(":");
    explicitType = true;
  } else {
    name = base;
    rhs = ""; // default TEXT; short flags may be on name itself
  }

  name = String(name || "").trim();
  if (!name) die(`Bad field spec '${base}'`);

  // If no ":", short flags might be appended to name (e.g., "name!+")
  // If ":", short flags might be appended to type token (e.g., "text!+")
  let typeToken = rhs;
  let shortFlagsStr = "";
  if (rhs) {
    const m = rhs.match(/^(.*?)([!+^#~?]+)?$/);
    typeToken = (m?.[1] || "").trim();
    shortFlagsStr = m?.[2] || "";
  } else {
    const m = name.match(/^(.*?)([!+^#~?]+)?$/);
    name = (m?.[1] || "").trim();
    shortFlagsStr = m?.[2] || "";
  }

  const flags = new Set(shortFlagsStr.split("").map(c =>
    c === "!" ? "notnull" :
    c === "+" ? "unique"  :
    c === "^" ? "index"   :
    c === "#" ? "pk"      :
    c === "~" ? "ai"      :
    ""
  ).filter(Boolean));

  // Normalize the type token if present
  let type = typeToken ? (TYPE_ALIASES[typeToken.toLowerCase()] ?? typeToken.toUpperCase()) : "";

  return { name, type, flags, explicitType };
}

// -------- Field parsing (with FK forms) ------------------------------------
function parseFieldSpec(specRaw) {
  // Handle "^col" index-only
  if (specRaw.startsWith("^")
      && !specRaw.includes(":")
      && !specRaw.includes(",")
      && !specRaw.includes(">")
      && !specRaw.includes("->")) {
    return { kind: "indexOnly", name: specRaw.slice(1) };
  }

  // FK shorthand "left>table(col)" or PowerShell-safe "left->table(col)"
  if ((specRaw.includes(">") || specRaw.includes("->")) && !specRaw.includes(":fk")) {
    const [left, rhs] = specRaw.includes("->") ? specRaw.split("->") : specRaw.split(">");
    const { name, type, flags, explicitType } = parseNameTypeFlags(left);
    const m = rhs.match(/^([a-zA-Z0-9_]+)(?:\(([a-zA-Z0-9_]+)\))?$/);
    if (!m) die(`Bad FK ref '${specRaw}'`);
    const table = sanitizeTable(m[1]);
    const refCol = m[2] || "id";

    // default FK storage type is INTEGER unless caller annotated a type
    const resolvedType = explicitType ? (type || "TEXT") : "INTEGER";
    const finalType = TYPE_ALIASES[(resolvedType || "").toLowerCase()] ?? (resolvedType || "TEXT");

    return {
      kind: "field",
      name,
      type: finalType,
      flags,
      fk: { table, col: refCol, opts: [] },
      wantsIndex: flags.has("index")
    };
  }

  // General field (may include ":fk(table.col)" in type OR short flags on name/type)
  const parts = specRaw.split(",");
  const base = parts.shift();
  const ntf = parseNameTypeFlags(base);
  let { name, type, flags } = ntf;

  let fk = null;
  const typeLower = (type || "").toLowerCase();
  if (typeLower.startsWith("fk(") && typeLower.endsWith(")")) {
    const inside = type.slice(3, -1);
    const [t, c = "id"] = inside.split(".");
    fk = { table: sanitizeTable(t), col: c, opts: [] };
    type = "INTEGER"; // storage type for fk()
  }

  // default type if still empty
  if (!type) type = "TEXT";

  // long flags
  for (const f of parts) {
    const [k, v] = f.split("=");
    const key = (k || "").toLowerCase().trim();
    if (!key) continue;
    if (["notnull", "nn", "!"].includes(key)) flags.add("notnull");
    else if (["unique", "u", "+"].includes(key)) flags.add("unique");
    else if (["index", "idx", "^"].includes(key)) flags.add("index");
    else if (["pk", "primary", "#"].includes(key)) flags.add("pk");
    else if (["ai", "autoincrement", "~"].includes(key)) flags.add("ai");
    else if (["default", "def", "="].includes(key)) flags.add(`default=${v}`);
    else if (["ondelete", "on_delete"].includes(key)) fk?.opts.push(`ON DELETE ${v.toUpperCase()}`);
    else if (["onupdate", "on_update"].includes(key)) fk?.opts.push(`ON UPDATE ${v.toUpperCase()}`);
    else if (["defer", "deferrable"].includes(key)) fk?.opts.push(`DEFERRABLE INITIALLY DEFERRED`);
    else die(`Unknown flag '${key}' in '${specRaw}'`);
  }

  return { kind: "field", name, type, flags, fk, wantsIndex: flags.has("index") };
}

function buildColumnSQL(f, globalFK) {
  const parts = [`${f.name} ${f.type}`];

  if (f.flags?.has("pk")) parts.push("PRIMARY KEY");
  if (f.flags?.has("ai")) {
    if (!(f.flags.has("pk") && f.type === "INTEGER")) die(`AUTOINCREMENT requires INTEGER PRIMARY KEY on '${f.name}'`);
    parts.push("AUTOINCREMENT");
  }
  if (f.flags?.has("unique")) parts.push("UNIQUE");
  if (f.flags?.has("notnull")) parts.push("NOT NULL");

  // FK inline constraint
  const fk = f.fk;
  if (fk) {
    const segs = [`REFERENCES ${fk.table}(${fk.col})`];
    const scoped = [];
    const gDel = globalFK?.onDelete ? `ON DELETE ${globalFK.onDelete.toUpperCase()}` : null;
    const gUpd = globalFK?.onUpdate ? `ON UPDATE ${globalFK.onUpdate.toUpperCase()}` : null;
    if (fk.opts?.length) scoped.push(...fk.opts);
    else { if (gDel) scoped.push(gDel); if (gUpd) scoped.push(gUpd); }
    parts.push(segs.join(" "));
    if (scoped.length) parts.push(scoped.join(" "));
  }

  const def = [...(f.flags || [])].find(x => String(x).startsWith("default="));
  if (def) parts.push("DEFAULT " + String(def).split("=")[1]);

  return parts.join(" ");
}

// ---------------- main ----------------
async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const raw = cfg.nonFlags;
  const a = raw.length && raw[0] === "--" ? raw.slice(1) : raw;  // belt & suspenders for stray '--'

  if (!a.length || ["-h", "--help", "help"].includes(a[0])) return help();
  if (!(a[0] === "create" && a[1] === "table")) return help();

  const table = sanitizeTable(a[2] || "");
  if (!table) die("Missing table name.");
  const pascal = kebabToPascal(table) + "Schema";

  const specs = (a.slice(3) || []).map(parseFieldSpec);

  // Default PK if none supplied
  const hasUserPK = specs.some(f => f.kind === "field" && f.flags?.has("pk"));
  const cols = [];
  if (!hasUserPK) cols.push({ name: "id", type: "INTEGER", flags: new Set(["pk", "ai"]) });

  const fkRefs = [];  // { table, col }
  for (const f of specs) {
    if (f.kind === "indexOnly") continue;
    cols.push(f);
    if (f.fk) fkRefs.push({ table: f.fk.table, col: f.fk.col });
  }

  if (cfg.stamps) {
    cols.push({ name: "created_at", type: "TEXT", flags: new Set(["notnull"]) });
    cols.push({ name: "updated_at", type: "TEXT", flags: new Set(["notnull"]) });
  }
  if (cfg.softDelete || cfg.stamps) cols.push({ name: "deleted_at", type: "TEXT", flags: new Set() });

  // Compose DDL
  const ddl =
`CREATE TABLE IF NOT EXISTS ${table} (
  ${cols.map(c => buildColumnSQL(c, { onDelete: cfg.onDelete, onUpdate: cfg.onUpdate })).join(",\n  ")}
);`;

  // Extra indexes: any explicit ^ plus FK columns (unless --no-fk-index)
  const extraIdx = new Set();
  for (const f of specs) {
    if (f.kind === "indexOnly") {
      extraIdx.add(`CREATE INDEX IF NOT EXISTS idx_${table}_${f.name} ON ${table}(${f.name});`);
    } else {
      if (f.wantsIndex) extraIdx.add(`CREATE INDEX IF NOT EXISTS idx_${table}_${f.name} ON ${table}(${f.name});`);
      if (f.fk && !cfg.noFkIndex) extraIdx.add(`CREATE INDEX IF NOT EXISTS idx_${table}_${f.name}_fk ON ${table}(${f.name});`);
    }
  }

  const fileJS =
`// ./schemas/${table}.schema.js
const ${pascal} = {
  table: "${table}",
  version: ${cfg.version},

  createSQL: \`
    ${ddl.split("\n").join("\n    ")}
  \`,

  extraSQL: [
${[...extraIdx].map(s => `    \`${s}\``).join("\n")}
  ]
};

export default ${pascal};
`;

  const fileTS =
`// ./schemas/${table}.schema.ts
import type { Schema } from "../allez-orm";
const ${pascal}: Schema = {
  table: "${table}",
  version: ${cfg.version},

  createSQL: \`
    ${ddl.split("\n").join("\n    ")}
  \`,

  extraSQL: [
${[...extraIdx].map(s => `    \`${s}\``).join("\n")}
  ]
};

export default ${pascal};
`;

  // Ensure out dir
  const dir = path.resolve(CWD, cfg.dir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Write this schema
  const outFile = path.join(dir, `${table}.schema.${cfg.asTS ? "ts" : "js"}`);
  if (fs.existsSync(outFile) && !cfg.force) die(`Refusing to overwrite: ${path.relative(CWD, outFile)} (use --force)`);
  fs.writeFileSync(outFile, cfg.asTS ? fileTS : fileJS, "utf8");
  console.log(`✔ Created ${path.relative(CWD, outFile)}`);

  // Ensure referenced schemas exist (minimal ones)
  if (cfg.ensureRefs && fkRefs.length) {
    for (const r of fkRefs) {
      const refPathJS = path.join(dir, `${r.table}.schema.js`);
      const refPathTS = path.join(dir, `${r.table}.schema.ts`);
      if (fs.existsSync(refPathJS) || fs.existsSync(refPathTS)) continue;
      const pas = kebabToPascal(r.table) + "Schema";
      const stub =
`// ./schemas/${r.table}.schema.js  (auto-created stub for FK target)
const ${pas} = {
  table: "${r.table}",
  version: 1,
  createSQL: \`
    CREATE TABLE IF NOT EXISTS ${r.table} (
      id INTEGER PRIMARY KEY AUTOINCREMENT
    );
  \`,
  extraSQL: []
};
export default ${pas};
`;
      fs.writeFileSync(refPathJS, stub, "utf8");
      console.log(`✔ Created FK target stub ${path.relative(CWD, refPathJS)}`);
    }
  }
}

await main();
