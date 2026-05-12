#!/usr/bin/env node
/**
 * Allez ORM – schema generator CLI
 *
 * Generates a <table>.schema.js with:
 *  - CREATE TABLE with inline foreign keys:  col TYPE REFERENCES target(id) [ON DELETE ...]
 *  - Optional "stamps": created_at, updated_at, deleted_at
 *  - Optional unique / not-null markers
 *  - Optional ON DELETE behavior for *all* FKs via --onDelete=
 *  - (No extraSQL output by default)
 *  - Auto-create stub schemas for FK target tables if missing
 *
 * Spec anchoring (so agents stay tied to the original spec):
 *  - Each generated file carries a SPEC header with the source spec path
 *    and SHA-256s for the whole spec and the per-table fragment.
 *  - `from-json` also writes an AGENTS.md in the output directory.
 *  - `allez-orm verify <spec.json>` re-generates in memory and reports drift.
 *
 * Usage:
 *   allez-orm create table <name> [fields...] [--dir=schemas_cli] [--stamps] [-f|--force] [--onDelete=cascade|restrict|setnull|noaction]
 *   allez-orm from-json <config.json> [--dir=schemas_cli] [-f|--force]
 *   allez-orm verify <config.json> [--dir=schemas_cli]
 *   allez-orm --print-json-schema
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";

const argv = process.argv.slice(2);

const usage = () => {
  console.log(`
Usage:
  allez-orm create table <name> [options] [fields...]
  allez-orm from-json <config.json> [--dir=<outDir>] [-f|--force]
  allez-orm verify    <config.json> [--dir=<outDir>]
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
    dir: null,
    dirExplicit: false,
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
      out.dirExplicit = true;
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

  if (process.env.ALLEZ_FORCE === "1") out.force = true;

  out.cmd = positional[0] || null;
  out.sub = positional[1] || null;

  if (out.cmd === "create" && out.sub === "table") {
    out.table = positional[2] || null;
    out.fields = positional.slice(3);
  } else if (out.cmd === "from-json" || out.cmd === "verify") {
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
          // Accept either rich field objects or simple string tokens.
          fields: {
            type: "array",
            items: {
              anyOf: [
                {
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
                },
                { type: "string" } // token form: "email:text!+->users"
              ]
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
} else if (opts.cmd === "verify") {
  if (!opts.jsonFile) die("verify requires a <config.json> path");
  runVerify(opts).catch(e => die(e.stack || String(e)));
} else if (opts.cmd === "create" && opts.sub === "table" && opts.table) {
  const outDir = opts.dir || "schemas_cli";
  fs.mkdirSync(outDir, { recursive: true });
  const text = buildModuleText({
    name: opts.table,
    stamps: opts.stamps,
    onDelete: opts.onDelete,
    fieldTokens: opts.fields,
    specMeta: null, // CLI form has no spec to anchor to
  });
  writeModule({
    outDir,
    name: opts.table,
    text,
    force: opts.force,
    fieldTokens: opts.fields,
  });
  process.exit(0);
} else {
  usage();
  die("Expected: create table <name> …  or  from-json <config.json>  or  verify <config.json>");
}

// ---------------- core generator (shared) ----------------

function resolveFields(name, stamps, fieldTokens) {
  const fields = fieldTokens.map(parseFieldToken).filter(Boolean);
  if (!fields.some(f => f.name === "id")) {
    fields.unshift({ name: "id", type: "INTEGER", notnull: true, unique: false, fk: null, pk: true });
  }
  if (stamps) {
    fields.push(
      { name: "created_at", type: "TEXT", notnull: true },
      { name: "updated_at", type: "TEXT", notnull: true },
      { name: "deleted_at", type: "TEXT", notnull: false }
    );
  }
  return fields;
}

function buildModuleText({ name, stamps, onDelete, fieldTokens, specMeta }) {
  const fields = resolveFields(name, stamps, fieldTokens);
  const onDel = onDelete ? ({ cascade:"CASCADE", restrict:"RESTRICT", setnull:"SET NULL", noaction:"NO ACTION" })[onDelete] : null;
  const columnLines = fields.map(f => sqlForColumn(f, onDel));

  const header = specMeta
    ? `// ${name}.schema.js (generated by allez-orm)
// DO NOT EDIT — regenerate by editing the spec, then running:
//   allez-orm from-json ${specMeta.specPath}
// SPEC ${specMeta.specPath}
// SPEC_SHA256 ${specMeta.specSha}
// TABLE_SHA256 ${specMeta.tableSha}
`
    : `// ${name}.schema.js (generated by tools/allez-orm.mjs)\n`;

  return `${header}const ${camel(name)}Schema = {
  table: "${name}",
  version: 1,
  createSQL: \`
CREATE TABLE IF NOT EXISTS ${name} (
  ${columnLines.join(",\n  ")}
);\`
};
export default ${camel(name)}Schema;
`;
}

function buildStubText(targetTable) {
  return `// ${targetTable}.schema.js (generated by tools/allez-orm.mjs - stub for FK target)
const ${camel(targetTable)}Schema = {
  table: "${targetTable}",
  version: 1,
  createSQL: \`
CREATE TABLE IF NOT EXISTS ${targetTable} (
  id INTEGER PRIMARY KEY AUTOINCREMENT
);\`
};
export default ${camel(targetTable)}Schema;
`;
}

function writeModule({ outDir, name, text, force, fieldTokens }) {
  const outFile = path.join(outDir, `${name}.schema.js`);
  if (!force && fs.existsSync(outFile)) {
    die(`Refusing to overwrite existing file: ${outFile}\n(use -f or ALLEZ_FORCE=1)`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, text, "utf8");
  console.log(`Wrote ${outFile}`);

  // Stub FK targets (only if not self & missing)
  const fields = (fieldTokens || []).map(parseFieldToken).filter(Boolean);
  const fkTargets = new Set();
  for (const f of fields) if (f.fk && f.fk.table && f.fk.table !== name) fkTargets.add(f.fk.table);
  for (const t of fkTargets) {
    const stubPath = path.join(outDir, `${t}.schema.js`);
    if (!fs.existsSync(stubPath)) {
      fs.writeFileSync(stubPath, buildStubText(t), "utf8");
      console.log(`Wrote stub ${stubPath}`);
    }
  }
}

function sqlForColumn(f, onDelUpper) {
  if (f.pk) return `id INTEGER PRIMARY KEY AUTOINCREMENT`;
  let s = `${f.name} ${f.type}`;
  // Keep order: UNIQUE then NOT NULL (matches tests/expectations)
  if (f.unique) s += ` UNIQUE`;
  if (f.notnull) s += ` NOT NULL`;
  if (f.fk) {
    s += ` REFERENCES ${f.fk.table}(${f.fk.column || "id"})`;
    if (onDelUpper) s += ` ON DELETE ${onDelUpper}`;
  }
  return s;
}

function parseFieldToken(tok) {
  // Accept:
  //   - token string "col[:type][!][+][->target]" or "col:type,unique,notnull"
  //   - object {name,type,unique,notnull,fk:{table,column}}
  if (tok == null) return null;

  // Fast path: token is already string
  if (typeof tok === "string") {
    return parseTokenString(tok);
  }

  // Object form -> tokenize once, then reuse the same parser
  if (typeof tok === "object") {
    const name = String(tok.name ?? tok.Name ?? "").trim();
    if (!name) return null;
    const type = String(tok.type ?? tok.Type ?? "TEXT").trim().toLowerCase();
    const unique = !!(tok.unique ?? tok.Unique);
    const notnull = !!(tok.notnull ?? tok.notNull ?? tok.NotNull);
    const fkRaw = tok.fk ?? tok.FK;
    const fkTable = fkRaw ? (fkRaw.table ?? fkRaw.Table) : null;
    const fkCol = fkRaw ? (fkRaw.column ?? fkRaw.Column ?? "id") : "id";

    let token = `${name}:${type}`;
    if (notnull) token += "!";
    if (unique)  token += "+";
    if (fkTable) token += `->${fkTable}`;

    const parsed = parseTokenString(token);
    if (fkTable) parsed.fk.column = fkCol; // preserve non-id if provided
    return parsed;
  }

  return null;
}

function parseTokenString(tok) {
  // Split on "," for attribute list
  const ret = { name: "", type: "TEXT", notnull: false, unique: false, fk: null };
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

  const fkIdx = main.indexOf("->");
  if (fkIdx >= 0) {
    fkTarget = main.slice(fkIdx + 2).trim();
    name = main.slice(0, fkIdx);
  }

  const typeIdx = name.indexOf(":");
  if (typeIdx >= 0) {
    type = name.slice(typeIdx + 1).trim();   // may contain !/+
    name = name.slice(0, typeIdx).trim();
  } else {
    type = null;
  }

  // flags may appear on either side
  const nameHasBang = /!/.test(name);
  const nameHasPlus = /\+/.test(name);
  const typeHasBang = type ? /!/.test(type) : false;
  const typeHasPlus = type ? /\+/.test(type) : false;

  if (nameHasBang || typeHasBang) ret.notnull = true;
  if (nameHasPlus || typeHasPlus) ret.unique = true;

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

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Canonical JSON of a table fragment — stable across key order and irrelevant whitespace.
function canonicalTable(t) {
  const name = pick(t, "name", "Name");
  const stamps = !!pick(t, "stamps", "Stamps");
  const rawFields = pick(t, "fields", "Fields", "columns", "Columns") || [];
  const fields = rawFields.map(f => {
    if (typeof f === "string") return { token: f };
    return {
      name: pick(f, "name", "Name"),
      type: String(pick(f, "type", "Type") ?? "TEXT").toLowerCase(),
      unique: !!pick(f, "unique", "Unique"),
      notnull: !!pick(f, "notnull", "notNull", "NotNull"),
      fk: (() => {
        const fk = pick(f, "fk", "FK");
        if (!fk) return null;
        return { table: pick(fk, "table", "Table"), column: pick(fk, "column", "Column") ?? "id" };
      })(),
    };
  });
  return JSON.stringify({ name, stamps, fields });
}

// ---------------- from-json implementation (resilient & fast) ----------------

function pick(obj, ...keys) {
  for (const k of keys) { if (obj && obj[k] !== undefined) return obj[k]; }
  return undefined;
}

function loadSpec(jsonFile) {
  const file = path.resolve(jsonFile);
  if (!fs.existsSync(file)) die(`Config not found: ${file}`);
  const raw = fs.readFileSync(file, "utf8");
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { die(`Invalid JSON: ${e.message}`); }
  const tables = pick(cfg, "tables", "Tables");
  if (!Array.isArray(tables)) die(`Config must have an array at "tables" (or "Tables").`);
  return { file, raw, cfg, tables, specSha: sha256(raw) };
}

function fieldsToTokens(fieldsList, tName) {
  return fieldsList.map(f => {
    if (typeof f === "string") return f;
    const name = pick(f, "name", "Name");
    if (!name) die(`Table "${tName}" has a field without "name".`);
    const type = String(pick(f, "type", "Type") ?? "TEXT").toLowerCase();
    const unique = !!pick(f, "unique", "Unique");
    const notnull = !!pick(f, "notnull", "notNull", "NotNull");
    const fk = pick(f, "fk", "FK");
    const fkTable = fk ? pick(fk, "table", "Table") : null;
    let tok = `${name}:${type}`;
    if (notnull) tok += "!";
    if (unique)  tok += "+";
    if (fkTable) tok += `->${fkTable}`;
    return tok;
  });
}

function planTables(spec, outDir) {
  const defaultOnDelete = pick(spec.cfg, "defaultOnDelete", "DefaultOnDelete") ?? null;
  const specPathRel = path.relative(path.resolve(outDir), spec.file).split(path.sep).join("/");

  return spec.tables.map((t, i) => {
    const name = pick(t, "name", "Name");
    if (!name || typeof name !== "string") die(`Table at index ${i} is missing "name".`);
    const stamps = !!pick(t, "stamps", "Stamps");
    const fieldsList = pick(t, "fields", "Fields", "columns", "Columns");
    if (!Array.isArray(fieldsList)) die(`Table "${name}" must have "fields" array.`);
    const tableSha = sha256(canonicalTable(t));
    const fieldTokens = fieldsToTokens(fieldsList, name);
    return {
      name,
      stamps,
      onDelete: defaultOnDelete || null,
      fieldTokens,
      specMeta: { specPath: specPathRel, specSha: spec.specSha, tableSha },
    };
  });
}

async function runFromJson(cliOpts) {
  const spec = loadSpec(cliOpts.jsonFile);
  const outDir = (cliOpts.dirExplicit && cliOpts.dir)
    || pick(spec.cfg, "outDir", "OutDir")
    || cliOpts.dir
    || "schemas_cli";
  fs.mkdirSync(outDir, { recursive: true });

  const plans = planTables(spec, outDir);
  const tableNames = new Set(plans.map(p => p.name));

  for (const plan of plans) {
    const text = buildModuleText(plan);
    writeModule({
      outDir,
      name: plan.name,
      text,
      force: cliOpts.force,
      fieldTokens: plan.fieldTokens,
    });
  }

  writeAgentsMd(outDir, spec.file, plans);
  process.exit(0);
}

function writeAgentsMd(outDir, specFile, plans) {
  const specRel = path.relative(path.resolve(outDir), specFile).split(path.sep).join("/");
  const tableList = plans.map(p => `- \`${p.name}\``).join("\n");
  const body = `# AGENTS.md — schemas in this directory

These \`*.schema.js\` files are **generated artifacts**. The source of truth is:

    ${specRel}

## Rules for agents working in this directory

1. **Do not edit the generated \`*.schema.js\` files directly.** Each file's
   header carries SPEC and TABLE SHA-256 anchors that pin it to the spec
   fragment it came from. Hand-edits silently desync from the spec.
2. **To change a table:** edit the spec above, then re-run:
   \`\`\`
   allez-orm from-json ${specRel} --dir=. -f
   \`\`\`
3. **Before opening a PR:** run drift check:
   \`\`\`
   allez-orm verify ${specRel} --dir=.
   \`\`\`
   It will exit non-zero if any file has drifted from the spec.

## Tables generated from this spec

${tableList}

(This file is regenerated by \`allez-orm from-json\`. Edits to it will be overwritten.)
`;
  const p = path.join(outDir, "AGENTS.md");
  fs.writeFileSync(p, body, "utf8");
  console.log(`Wrote ${p}`);
}

// ---------------- verify ----------------

async function runVerify(cliOpts) {
  const spec = loadSpec(cliOpts.jsonFile);
  const outDir = (cliOpts.dirExplicit && cliOpts.dir)
    || pick(spec.cfg, "outDir", "OutDir")
    || cliOpts.dir
    || "schemas_cli";
  if (!fs.existsSync(outDir)) die(`Output directory not found: ${outDir}`);

  const plans = planTables(spec, outDir);
  const drift = [];
  const missing = [];

  for (const plan of plans) {
    const file = path.join(outDir, `${plan.name}.schema.js`);
    if (!fs.existsSync(file)) {
      missing.push(plan.name);
      continue;
    }
    const expected = buildModuleText(plan);
    const actual = fs.readFileSync(file, "utf8");
    if (actual !== expected) {
      drift.push({ name: plan.name, file });
    }
  }

  if (missing.length === 0 && drift.length === 0) {
    console.log(`✔ verify: ${plans.length} table(s) match spec ${path.relative(process.cwd(), spec.file)}`);
    process.exit(0);
  }

  if (missing.length) {
    console.error(`✗ Missing generated files for: ${missing.join(", ")}`);
  }
  if (drift.length) {
    console.error(`✗ Drift detected in ${drift.length} file(s):`);
    for (const d of drift) console.error(`  - ${d.file}`);
    console.error(`\nTo resync, run:  allez-orm from-json ${path.relative(process.cwd(), spec.file)} --dir=${outDir} -f`);
  }
  process.exit(1);
}
