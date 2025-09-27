#!/usr/bin/env node
/**
 * Allez ORM – schema generator CLI
 *
 * Generates a <table>.schema.js with:
 *  - CREATE TABLE with inline foreign keys:  col TYPE REFERENCES target(id) [ON DELETE ...]
 *  - Optional "stamps": created_at, updated_at, deleted_at
 *  - Optional unique / not-null markers
 *  - Optional ON DELETE behavior for *all* FKs via --onDelete=
 *  - Auto index per FK column in extraSQL
 *  - Auto-create stub schemas for FK target tables if missing
 *
 * Usage:
 *   node tools/allez-orm.mjs create table <name> [fields...] [--dir=schemas_cli] [--stamps] [-f|--force] [--onDelete=cascade|restrict|setnull|noaction]
 *
 * Field syntax (comma or symbol sugar):
 *   name              -> bare column "name TEXT"
 *   name!             -> NOT NULL
 *   name:text         -> explicit SQL type
 *   name:text!        -> TEXT NOT NULL
 *   email:text!+      -> TEXT UNIQUE NOT NULL
 *   user_id:text->users
 *   org_id:integer->orgs
 *   slug:text,unique  -> you can also use ",unique" or ",notnull"
 *
 * Defaults:
 *   - Adds "id INTEGER PRIMARY KEY AUTOINCREMENT" if you don't provide an "id" column yourself
 *   - Default type is TEXT when omitted
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);
const usage = () => {
  console.log(`
Usage:
  allez-orm create table <name> [options] [fields...]

Options:
  --dir=<outDir>         Output directory (default: schemas_cli)
  --stamps               Add created_at, updated_at, deleted_at columns
  --onDelete=<mode>      ON DELETE action for *all* FKs (cascade|restrict|setnull|noaction). Default: none
  -f, --force            Overwrite existing file
  --help                 Show this help

Field syntax:
  col[:type][!][+][->target] or "col:type,unique,notnull"
  Examples: email:text!+   user_id:text->users   org_id:integer->orgs
`);
};

if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
  usage();
  process.exit(0);
}

const die = (m, code = 1) => { console.error(m); process.exit(code); };

function parseOptions(args) {
  const out = {
    dir: "schemas_cli",
    stamps: false,
    onDelete: null,
    force: false,
    cmd: null,
    sub: null,
    table: null,
    fields: []
  };
  const positional = [];
  for (const a of args) {
    if (a.startsWith("--dir=")) {
      out.dir = a.slice(6);
    } else if (a === "--stamps") {
      out.stamps = true;
    } else if (a.startsWith("--onDelete=")) {
      const v = a.slice(11).toLowerCase();
      if (!["cascade","restrict","setnull","noaction"].includes(v)) {
        die(`Invalid --onDelete value: ${v}`);
      }
      out.onDelete = v;
    } else if (a === "-f" || a === "--force") {
      out.force = true;
    } else if (a.startsWith("-")) {
      die(`Unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }
  // pick up positional command pieces
  out.cmd = positional[0] || null;
  out.sub = positional[1] || null;
  out.table = positional[2] || null;
  out.fields = positional.slice(3);

  // ✅ env var should not interfere with positional parsing
  if (process.env.ALLEZ_FORCE === "1") {
    out.force = true;
  }
  return out;
}

const opts = parseOptions(argv);

// Commands
if (opts.cmd !== "create" || opts.sub !== "table" || !opts.table) {
  usage();
  die("Expected: create table <name> [fields...]");
}

// Ensure dir
fs.mkdirSync(opts.dir, { recursive: true });

const outFile = path.join(opts.dir, `${opts.table}.schema.js`);
if (fs.existsSync(outFile) && !opts.force) {
  die(`Refusing to overwrite existing file: ${outFile}\n(use -f or ALLEZ_FORCE=1)`);
}

// ---- Field parsing ---------------------------------------------------------

function parseFieldToken(tok) {
  // Accept "col[:type][!][+][->target]" OR "col:type,unique,notnull"
  const ret = { name: "", type: "TEXT", notnull: false, unique: false, fk: null };
  if (!tok) return null;

  // Split on "," for attribute list
  let main = tok;
  let flags = [];
  if (tok.includes(",")) {
    const [lhs, ...rhs] = tok.split(",");
    main = lhs;
    flags = rhs.map(s => s.trim().toLowerCase());
  }

  // name : type -> target
  let name = main;
  let type = null;
  let fkTarget = null;

  // ->target
  const fkIdx = main.indexOf("->");
  if (fkIdx >= 0) {
    fkTarget = main.slice(fkIdx + 2).trim();
    name = main.slice(0, fkIdx);
  }

  // :type
  const typeIdx = name.indexOf(":");
  if (typeIdx >= 0) {
    type = name.slice(typeIdx + 1).trim();   // may contain !/+
    name = name.slice(0, typeIdx).trim();
  } else {
    type = null;
  }

  // Collect flags from BOTH the name token and the type token
  const nameHasBang = /!/.test(name);
  const nameHasPlus = /\+/.test(name);
  const typeHasBang = type ? /!/.test(type) : false;
  const typeHasPlus = type ? /\+/.test(type) : false;

  if (nameHasBang || typeHasBang) ret.notnull = true;
  if (nameHasPlus || typeHasPlus) ret.unique = true;

  // Clean trailing !/+ off name and type segments
  name = name.replace(/[!+]+$/,"").trim();
  if (type) {
    type = type.replace(/[!+]+$/,"").trim();
    ret.type = type.toUpperCase();
  }

  if (fkTarget) ret.fk = { table: fkTarget, column: "id" };

  // also allow ",unique,notnull"
  for (const f of flags) {
    if (f === "unique") ret.unique = true;
    if (f === "notnull") ret.notnull = true;
  }

  ret.name = name;
  return ret;
}

const fields = opts.fields.map(parseFieldToken).filter(Boolean);

// Ensure an id column if not provided
const hasId = fields.some(f => f.name === "id");
if (!hasId) {
  fields.unshift({ name: "id", type: "INTEGER", notnull: true, unique: false, fk: null, pk: true });
}

// Stamps
if (opts.stamps) {
  fields.push(
    { name: "created_at", type: "TEXT", notnull: true },
    { name: "updated_at", type: "TEXT", notnull: true },
    { name: "deleted_at", type: "TEXT", notnull: false }
  );
}

// ---- SQL assembly ----------------------------------------------------------

function sqlForColumn(f) {
  if (f.pk) return `id INTEGER PRIMARY KEY AUTOINCREMENT`;
  let s = `${f.name} ${f.type}`;

  // Match test ordering: UNIQUE first, then NOT NULL
  if (f.unique) s += ` UNIQUE`;
  if (f.notnull) s += ` NOT NULL`;

  if (f.fk) {
    s += ` REFERENCES ${f.fk.table}(${f.fk.column})`;
    if (opts.onDelete) {
      const map = { cascade: "CASCADE", restrict: "RESTRICT", setnull: "SET NULL", noaction: "NO ACTION" };
      s += ` ON DELETE ${map[opts.onDelete]}`;
    }
  }
  return s;
}

const columnLines = fields.map(sqlForColumn);

// Build extraSQL (indexes for FK columns) — emit with BACKTICKS to satisfy tests
const extraSQL = [];
for (const f of fields) {
  if (f.fk) {
    extraSQL.push(
      `\`CREATE INDEX IF NOT EXISTS idx_${opts.table}_${f.name}_fk ON ${opts.table}(${f.name});\``
    );
  }
}

// Compose module text
const moduleText = `// ${opts.table}.schema.js (generated by tools/allez-orm.mjs)
const ${camel(opts.table)}Schema = {
  table: "${opts.table}",
  version: 1,
  createSQL: \`
CREATE TABLE IF NOT EXISTS ${opts.table} (
  ${columnLines.join(",\n  ")}
);\`,
  extraSQL: [
    ${extraSQL.join("\n    ")}
  ]
};
export default ${camel(opts.table)}Schema;
`;

fs.writeFileSync(outFile, moduleText, "utf8");
console.log(`Wrote ${outFile}`);

// ---- Auto-create stub schemas for FK targets (if missing) ------------------
const fkTargets = Array.from(new Set(fields.filter(f => f.fk).map(f => f.fk.table)))
  .filter(t => t && t !== opts.table);

for (const t of fkTargets) {
  const stubPath = path.join(opts.dir, `${t}.schema.js`);
  if (!fs.existsSync(stubPath)) {
    const stub = `// ${t}.schema.js (generated by tools/allez-orm.mjs - stub for FK target)
const ${camel(t)}Schema = {
  table: "${t}",
  version: 1,
  createSQL: \`
CREATE TABLE IF NOT EXISTS ${t} (
  id INTEGER PRIMARY KEY AUTOINCREMENT
);\`,
  extraSQL: [
    
  ]
};
export default ${camel(t)}Schema;
`;
    fs.writeFileSync(stubPath, stub, "utf8");
    console.log(`Wrote stub ${stubPath}`);
  }
}

process.exit(0);

// ---- helpers ---------------------------------------------------------------
function camel(s){return s.replace(/[-_](.)/g,(_,c)=>c.toUpperCase());}
