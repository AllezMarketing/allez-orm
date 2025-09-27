#!/usr/bin/env node
/**
 * Allez ORM – schema generator CLI
 *
 * Generates a <table>.schema.js with:
 *  - CREATE TABLE with inline foreign keys:  col TYPE REFERENCES target(id) [ON DELETE ...]
 *  - Optional "stamps": created_at, updated_at, deleted_at
 *  - Optional unique / not-null markers
 *  - Optional ON DELETE behavior for *all* FKs via --onDelete=
 *  - Auto index per FK column in extraSQL (emitted as backticked strings)
 *  - Auto-create stub schemas for FK target tables if missing
 *
 * New:
 *  - from-json <file>: bulk-generate schemas from a JSON config
 *  - --print-json-schema: output the JSON Schema used for validation
 *
 * Usage:
 *   allez-orm create table <name> [fields...] [--dir=schemas_cli] [--stamps] [-f|--force] [--onDelete=cascade|restrict|setnull|noaction]
 *   allez-orm from-json <config.json> [--dir=schemas_cli] [-f|--force]
 *   allez-orm --print-json-schema
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);

const usage = () => {
  console.log(`
Usage:
  allez-orm create table <name> [options] [fields...]
  allez-orm from-json <config.json> [--dir=<outDir>] [-f|--force]
  allez-orm --print-json-schema

Options:
  --dir=<outDir>         Output directory (default: schemas_cli)
  --stamps               Add created_at, updated_at, deleted_at columns
  --onDelete=<mode>      ON DELETE for *all* FKs (cascade|restrict|setnull|noaction). Default: none
  -f, --force            Overwrite existing files
  --help                 Show help

Field syntax:
  col[:type][!][+][->target] or "col:type,unique,notnull"
  Examples: email:text!+   user_id:text->users   org_id:integer->orgs
`);
};

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
    fields: [],
    jsonFile: null,
    printJsonSchema: false,
  };
  const positional = [];
  for (const a of args) {
    if (a === "--help" || a === "-h") {
      usage(); process.exit(0);
    } else if (a.startsWith("--dir=")) {
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
    } else if (a === "--print-json-schema") {
      out.printJsonSchema = true;
    } else if (a.startsWith("-")) {
      die(`Unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }

  // env var ALLEZ_FORCE=1 is honored (does not break positional parsing)
  if (process.env.ALLEZ_FORCE === "1") out.force = true;

  out.cmd = positional[0] || null;
  out.sub = positional[1] || null;

  if (out.cmd === "create" && out.sub === "table") {
    out.table = positional[2] || null;
    out.fields = positional.slice(3);
  } else if (out.cmd === "from-json") {
    out.jsonFile = positional[1] || null;
  }

  return out;
}

const opts = parseOptions(argv);

// ---------------- JSON Schema (string) ----------------

const CONFIG_JSON_SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://allez-orm.dev/allez.config.schema.json",
  type: "object",
  additionalProperties: false,
  properties: {
    outDir: { type: "string" },
    defaultOnDelete: { enum: ["cascade","restrict","setnull","noaction",null] },
    tables: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1 },
          stamps: { type: "boolean" },
          fields: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name"],
              properties: {
                name: { type: "string" },
                type: { type: "string" },
                unique: { type: "boolean" },
                notnull: { type: "boolean" },
                fk: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    table: { type: "string" },
                    column: { type: "string", default: "id" }
                  }
                }
              }
            }
          }
        },
        required: ["name","fields"]
      }
    }
  },
  required: ["tables"]
}, null, 2);

// ---------------- command switchboard ----------------

if (opts.printJsonSchema) {
  console.log(CONFIG_JSON_SCHEMA);
  process.exit(0);
}

if (!opts.cmd) {
  usage();
  process.exit(0);
}

if (opts.cmd === "from-json") {
  if (!opts.jsonFile) die("from-json requires a <config.json> path");
  runFromJson(opts).catch(e => die(e.stack || String(e)));
  // will exit inside
} else if (opts.cmd === "create" && opts.sub === "table" && opts.table) {
  fs.mkdirSync(opts.dir, { recursive: true });
  generateOne({
    outDir: opts.dir,
    name: opts.table,
    stamps: opts.stamps,
    onDelete: opts.onDelete,
    force: opts.force,
    fieldTokens: opts.fields
  }).then(() => process.exit(0))
    .catch(e => die(e.stack || String(e)));
} else {
  usage();
  die("Expected: create table <name> …  or  from-json <config.json>");
}

// ---------------- core generator (shared) ----------------

async function generateOne({ outDir, name, stamps, onDelete, force, fieldTokens }) {
  const outFile = path.join(outDir, `${name}.schema.js`);
  if (fs.existsSync(outFile) && !force) {
    die(`Refusing to overwrite existing file: ${outFile}\n(use -f or ALLEZ_FORCE=1)`);
  }

  // Parse tokens into field descriptors
  const fields = fieldTokens.map(parseFieldToken).filter(Boolean);

  // Ensure id PK
  const hasId = fields.some(f => f.name === "id");
  if (!hasId) {
    fields.unshift({ name: "id", type: "INTEGER", notnull: true, unique: false, fk: null, pk: true });
  }

  // stamps
  if (stamps) {
    fields.push(
      { name: "created_at", type: "TEXT", notnull: true },
      { name: "updated_at", type: "TEXT", notnull: true },
      { name: "deleted_at", type: "TEXT", notnull: false }
    );
  }

  // SQL
  const columnLines = fields.map(f => sqlForColumn(f, onDelete));

  // FK indexes
  const extraSQL = [];
  for (const f of fields) {
    if (f.fk) {
      extraSQL.push(
        `\`CREATE INDEX IF NOT EXISTS idx_${name}_${f.name}_fk ON ${name}(${f.name});\``
      );
    }
  }

  // module text
  const moduleText = `// ${name}.schema.js (generated by tools/allez-orm.mjs)
const ${camel(name)}Schema = {
  table: "${name}",
  version: 1,
  createSQL: \`
CREATE TABLE IF NOT EXISTS ${name} (
  ${columnLines.join(",\n  ")}
);\`,
  extraSQL: [
    ${extraSQL.join("\n    ")}
  ]
};
export default ${camel(name)}Schema;
`;

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, moduleText, "utf8");
  console.log(`Wrote ${outFile}`);

  // stub FK targets
  const fkTargets = Array.from(new Set(fields.filter(f => f.fk).map(f => f.fk.table)))
    .filter(t => t && t !== name);

  for (const t of fkTargets) {
    const stubPath = path.join(outDir, `${t}.schema.js`);
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
}

function sqlForColumn(f, onDelete) {
  if (f.pk) return `id INTEGER PRIMARY KEY AUTOINCREMENT`;
  let s = `${f.name} ${f.type}`;
  // ordering (UNIQUE then NOT NULL) matches tests
  if (f.unique) s += ` UNIQUE`;
  if (f.notnull) s += ` NOT NULL`;
  if (f.fk) {
    s += ` REFERENCES ${f.fk.table}(${f.fk.column || "id"})`;
    if (onDelete) {
      const map = { cascade: "CASCADE", restrict: "RESTRICT", setnull: "SET NULL", noaction: "NO ACTION" };
      s += ` ON DELETE ${map[onDelete]}`;
    }
  }
  return s;
}

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

  // flags from both name and type segments
  const nameHasBang = /!/.test(name);
  const nameHasPlus = /\+/.test(name);
  const typeHasBang = type ? /!/.test(type) : false;
  const typeHasPlus = type ? /\+/.test(type) : false;

  if (nameHasBang || typeHasBang) ret.notnull = true;
  if (nameHasPlus || typeHasPlus) ret.unique = true;

  // Clean trailing !/+ off name and type
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

function camel(s){return s.replace(/[-_](.)/g,(_,c)=>c.toUpperCase());}

// ---------------- from-json implementation (resilient) ----------------

function pick(obj, ...keys) {
  for (const k of keys) { if (obj && obj[k] !== undefined) return obj[k]; }
  return undefined;
}

async function runFromJson(cliOpts) {
  const file = path.resolve(cliOpts.jsonFile);
  if (!fs.existsSync(file)) die(`Config not found: ${file}`);

  const raw = fs.readFileSync(file, "utf8");
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { die(`Invalid JSON: ${e.message}`); }

  // allow OutDir/DefaultOnDelete/Tables
  const outDir = cliOpts.dir || pick(cfg, "outDir", "OutDir") || "schemas_cli";
  const defaultOnDelete = pick(cfg, "defaultOnDelete", "DefaultOnDelete") ?? null;

  const tables = pick(cfg, "tables", "Tables");
  if (!Array.isArray(tables)) {
    die(`Config must have an array at "tables" (or "Tables").`);
  }

  fs.mkdirSync(outDir, { recursive: true });

  for (let ti = 0; ti < tables.length; ti++) {
    const tRaw = tables[ti] || {};
    const tName = pick(tRaw, "name", "Name");
    if (!tName || typeof tName !== "string") {
      die(`Table at index ${ti} is missing "name".`);
    }
    const tStamps = !!pick(tRaw, "stamps", "Stamps");

    // accept fields/Fields OR columns/Columns
    let fieldsList = pick(tRaw, "fields", "Fields", "columns", "Columns");
    if (!Array.isArray(fieldsList)) {
      die(`Table "${tName}" must have "fields" (or "Fields"/"columns"/"Columns") array.`);
    }

    const tokens = [];
    for (let fi = 0; fi < fieldsList.length; fi++) {
      const f = fieldsList[fi] || {};
      const name = pick(f, "name", "Name");
      if (!name || typeof name !== "string") {
        die(`Table "${tName}" field #${fi} is missing "name".`);
      }
      const typeRaw = pick(f, "type", "Type");
      const type = (typeRaw ? String(typeRaw) : "TEXT").toLowerCase();

      const unique = !!pick(f, "unique", "Unique");
      // support notnull, notNull, NotNull
      const notnull = !!pick(f, "notnull", "notNull", "NotNull");

      // FK variations: fk/FK with table/Table, column/Column
      const fkRaw = pick(f, "fk", "FK");
      const fkTable = fkRaw ? pick(fkRaw, "table", "Table") : undefined;
      const fkCol = fkRaw ? (pick(fkRaw, "column", "Column") || "id") : undefined;

      let token = name + `:${type}`;
      if (notnull) token += `!`;
      if (unique) token += `+`;
      if (fkTable) token += `->` + fkTable;

      tokens.push(token);
    }

    await generateOne({
      outDir,
      name: tName,
      stamps: tStamps,
      onDelete: defaultOnDelete || null,
      force: cliOpts.force,
      fieldTokens: tokens
    });
  }

  process.exit(0);
}
