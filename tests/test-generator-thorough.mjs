// tests/test-generator-thorough.mjs
// Exhaustive edge-case suite for the schema generator CLI.
// Hits CLI form, from-json form, verify, AGENTS.md, and validates
// that the output is parseable + actually creates working SQLite tables.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import initSqlJs from "sql.js";
import { auditCreateSQL } from "../tools/ddl-audit.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const cli = path.join(root, "tools", "allez-orm.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "allez-gen-"));
// Make .js files in this tree behave as ESM so we can import generated schemas.
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
let testCount = 0;
const pass = (label) => { testCount++; console.log(`✔ ${label}`); };

function run(args, opts = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts
  });
}

async function importSchema(filePath) {
  const url = new URL(pathToFileURL(filePath).href);
  url.searchParams.set("v", Math.random().toString());
  return (await import(url.href)).default;
}

async function ddlCompiles(createSQL) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(createSQL);
  db.close();
}

console.log("=== Generator thorough tests ===");

// ---------- 1. CLI: no explicit type defaults to TEXT ----------
{
  const dir = path.join(tmp, "t1");
  const r = run(["create", "table", "notes", "body", "--dir=" + dir, "-f"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const txt = fs.readFileSync(path.join(dir, "notes.schema.js"), "utf8");
  assert.match(txt, /body TEXT/, "body defaults to TEXT");
  pass("CLI: column with no type defaults to TEXT");
}

// ---------- 2. CLI: all four onDelete modes emit correct SQL ----------
{
  const dir = path.join(tmp, "t2");
  const cases = [
    ["cascade",  "ON DELETE CASCADE"],
    ["restrict", "ON DELETE RESTRICT"],
    ["setnull",  "ON DELETE SET NULL"],
    ["noaction", "ON DELETE NO ACTION"],
  ];
  for (const [mode, expected] of cases) {
    const r = run(["create", "table", "comments_" + mode,
                   "post_id:integer->posts",
                   "--onDelete=" + mode, "--dir=" + dir, "-f"]);
    assert.strictEqual(r.status, 0, r.stderr);
    const txt = fs.readFileSync(path.join(dir, `comments_${mode}.schema.js`), "utf8");
    assert.ok(txt.includes(expected), `onDelete=${mode} should emit ${expected}`);
  }
  pass("CLI: all four onDelete modes emit correct ON DELETE clauses");
}

// ---------- 3. CLI: rejects invalid onDelete ----------
{
  const r = run(["create", "table", "x", "--onDelete=bogus", "--dir=" + path.join(tmp, "t3")]);
  assert.notStrictEqual(r.status, 0, "should fail on invalid onDelete");
  assert.match(r.stderr, /Invalid --onDelete/);
  pass("CLI: invalid --onDelete value is rejected");
}

// ---------- 4. CLI: refuses overwrite without --force ----------
{
  const dir = path.join(tmp, "t4");
  let r = run(["create", "table", "roles", "--dir=" + dir, "-f"]);
  assert.strictEqual(r.status, 0);
  r = run(["create", "table", "roles", "--dir=" + dir]); // no -f
  assert.notStrictEqual(r.status, 0, "should refuse overwrite");
  assert.match(r.stderr, /Refusing to overwrite/);
  pass("CLI: refuses overwrite without --force");
}

// ---------- 5. CLI: ALLEZ_FORCE=1 acts as --force ----------
{
  const dir = path.join(tmp, "t5");
  let r = run(["create", "table", "roles", "--dir=" + dir, "-f"]);
  assert.strictEqual(r.status, 0);
  r = run(["create", "table", "roles", "--dir=" + dir], { env: { ...process.env, ALLEZ_FORCE: "1" } });
  assert.strictEqual(r.status, 0, "ALLEZ_FORCE=1 should let overwrite proceed");
  pass("CLI: ALLEZ_FORCE=1 env var overrides --force requirement");
}

// ---------- 6. CLI: multi-FK table with two different targets stubs both ----------
{
  const dir = path.join(tmp, "t6");
  const r = run(["create", "table", "memberships",
                 "user_id:integer->users",
                 "org_id:integer->orgs",
                 "role_id:integer->roles",
                 "--dir=" + dir, "-f"]);
  assert.strictEqual(r.status, 0, r.stderr);
  for (const t of ["users", "orgs", "roles"]) {
    assert.ok(fs.existsSync(path.join(dir, `${t}.schema.js`)), `${t} stub`);
  }
  const txt = fs.readFileSync(path.join(dir, "memberships.schema.js"), "utf8");
  assert.match(txt, /user_id INTEGER REFERENCES users\(id\)/);
  assert.match(txt, /org_id INTEGER REFERENCES orgs\(id\)/);
  assert.match(txt, /role_id INTEGER REFERENCES roles\(id\)/);
  pass("CLI: multi-FK table stubs every distinct target");
}

// ---------- 7. CLI: self-referencing FK does NOT stub itself ----------
{
  const dir = path.join(tmp, "t7");
  const r = run(["create", "table", "nodes",
                 "parent_id:integer->nodes",
                 "--dir=" + dir, "-f"]);
  assert.strictEqual(r.status, 0);
  const files = fs.readdirSync(dir);
  assert.deepStrictEqual(files.filter(f => f.endsWith(".schema.js")).sort(), ["nodes.schema.js"]);
  pass("CLI: self-referencing FK does not generate a redundant stub");
}

// ---------- 8. --print-json-schema emits valid JSON-Schema document ----------
{
  const r = run(["--print-json-schema"]);
  assert.strictEqual(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.type, "object");
  assert.ok(j.properties.tables, "schema has tables prop");
  pass("CLI: --print-json-schema emits valid JSON Schema");
}

// ---------- 9. from-json: outDir/defaultOnDelete read from spec ----------
{
  const specDir = path.join(tmp, "t9");
  fs.mkdirSync(specDir, { recursive: true });
  const outDir = path.join(specDir, "out");
  const spec = {
    outDir,
    defaultOnDelete: "setnull",
    tables: [
      { name: "comments", fields: [{ name: "post_id", type: "integer", fk: { table: "posts" } }] }
    ]
  };
  const specPath = path.join(specDir, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec));
  // Note: don't pass --dir, force CLI to read outDir from spec
  const r = run(["from-json", specPath]);
  assert.strictEqual(r.status, 0, r.stderr);
  const txt = fs.readFileSync(path.join(outDir, "comments.schema.js"), "utf8");
  assert.match(txt, /ON DELETE SET NULL/);
  pass("from-json: outDir + defaultOnDelete are read from the spec file");
}

// ---------- 10. from-json: token-string field form works ----------
{
  const specDir = path.join(tmp, "t10");
  fs.mkdirSync(specDir, { recursive: true });
  const spec = {
    outDir: path.join(specDir, "out"),
    tables: [
      { name: "items", fields: ["sku:text!+", "qty:integer!"] }
    ]
  };
  const specPath = path.join(specDir, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const r = run(["from-json", specPath]);
  assert.strictEqual(r.status, 0, r.stderr);
  const txt = fs.readFileSync(path.join(specDir, "out", "items.schema.js"), "utf8");
  assert.match(txt, /sku TEXT UNIQUE NOT NULL/);
  assert.match(txt, /qty INTEGER NOT NULL/);
  pass("from-json: string-token field form parses unique/notnull flags");
}

// ---------- 11. from-json: invalid spec is rejected with helpful error ----------
{
  const specDir = path.join(tmp, "t11");
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, "spec.json");
  fs.writeFileSync(specPath, "{ not valid json");
  let r = run(["from-json", specPath]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /Invalid JSON/);

  fs.writeFileSync(specPath, JSON.stringify({ tables: "nope" }));
  r = run(["from-json", specPath]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /array/);

  fs.writeFileSync(specPath, JSON.stringify({ tables: [{ fields: [] }] }));
  r = run(["from-json", specPath]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /missing "name"/);
  pass("from-json: invalid specs are rejected with informative errors");
}

// ---------- 12. Generated module imports cleanly and exports a Schema ----------
{
  const dir = path.join(tmp, "t12");
  const r = run(["create", "table", "widgets",
                 "name:text!+", "price:real!", "--stamps",
                 "--dir=" + dir, "-f"]);
  assert.strictEqual(r.status, 0);
  const mod = await importSchema(path.join(dir, "widgets.schema.js"));
  assert.strictEqual(mod.table, "widgets");
  assert.strictEqual(mod.version, 1);
  assert.match(mod.createSQL, /CREATE TABLE IF NOT EXISTS widgets/);
  pass("Generated schema module imports as { table, version, createSQL }");
}

// ---------- 13. Generated CREATE TABLE is valid SQL in real sql.js ----------
{
  const r = run(["from-json", path.join(tmp, "t9", "spec.json"), "-f"]);
  assert.strictEqual(r.status, 0, r.stderr);
  // Build a tiny world: posts (referenced) + comments
  const posts = await importSchema(path.join(tmp, "t9", "out", "posts.schema.js"));
  const comments = await importSchema(path.join(tmp, "t9", "out", "comments.schema.js"));
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(posts.createSQL);
  db.exec(comments.createSQL);
  db.exec("INSERT INTO posts (id) VALUES (1);");
  db.exec("INSERT INTO comments (post_id) VALUES (1);");
  // SET NULL on FK target delete
  db.exec("DELETE FROM posts WHERE id=1;");
  const stmt = db.prepare("SELECT post_id FROM comments LIMIT 1");
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  assert.strictEqual(row.post_id, null, "SET NULL FK should null the column");
  pass("Generated DDL runs in sql.js and ON DELETE SET NULL behaves correctly");
}

// ---------- 14. DDL audit passes for every emitted file ----------
{
  const dir = path.join(tmp, "t14");
  const r = run(["create", "table", "audit_test",
                 "user_id:integer->users", "--onDelete=cascade",
                 "--dir=" + dir, "-f"]);
  assert.strictEqual(r.status, 0);
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".schema.js"))) {
    const mod = await importSchema(path.join(dir, f));
    const problems = auditCreateSQL(mod.createSQL);
    assert.strictEqual(problems.length, 0, `audit problems in ${f}: ${JSON.stringify(problems)}`);
  }
  pass("DDL audit: all generated files use inline FKs (no ALTER TABLE ADD FK)");
}

// ---------- 15. Verify: relative spec path works ----------
{
  const dir = path.join(tmp, "t15");
  fs.mkdirSync(dir, { recursive: true });
  const spec = {
    outDir: path.join(dir, "out"),
    tables: [{ name: "tags", fields: [{ name: "label", type: "text", notnull: true }] }]
  };
  const specPath = path.join(dir, "tags.spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec));
  let r = run(["from-json", "tags.spec.json"], { cwd: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(["verify", "tags.spec.json"], { cwd: dir });
  assert.strictEqual(r.status, 0, "verify with relative path should pass");
  pass("verify: works with relative spec path (cwd-relative)");
}

// ---------- 16. AGENTS.md contains every table from spec ----------
{
  const dir = path.join(tmp, "t16");
  fs.mkdirSync(dir, { recursive: true });
  const spec = {
    outDir: path.join(dir, "out"),
    tables: [
      { name: "a", fields: ["x:text"] },
      { name: "b", fields: ["y:text"] },
      { name: "c", fields: ["z:text"] }
    ]
  };
  const specPath = path.join(dir, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const r = run(["from-json", specPath]);
  assert.strictEqual(r.status, 0, r.stderr);
  const agents = fs.readFileSync(path.join(dir, "out", "AGENTS.md"), "utf8");
  for (const t of ["a", "b", "c"]) {
    assert.ok(agents.includes(`\`${t}\``), `AGENTS.md should list table ${t}`);
  }
  pass("AGENTS.md lists every table from the spec");
}

// ---------- 17. Verify: SPEC SHA in file matches spec content ----------
{
  // Reuse t16 spec
  const out = path.join(tmp, "t16", "out");
  const a = fs.readFileSync(path.join(out, "a.schema.js"), "utf8");
  const b = fs.readFileSync(path.join(out, "b.schema.js"), "utf8");
  const aSpec = a.match(/SPEC_SHA256 ([a-f0-9]{64})/)[1];
  const bSpec = b.match(/SPEC_SHA256 ([a-f0-9]{64})/)[1];
  assert.strictEqual(aSpec, bSpec, "all files generated from same spec share SPEC SHA");
  const aTable = a.match(/TABLE_SHA256 ([a-f0-9]{64})/)[1];
  const bTable = b.match(/TABLE_SHA256 ([a-f0-9]{64})/)[1];
  assert.notStrictEqual(aTable, bTable, "different tables have different TABLE SHAs");
  pass("Spec anchors: SPEC_SHA shared, TABLE_SHA unique per table");
}

// ---------- 18. CLI form (no spec) emits no SPEC header ----------
{
  const dir = path.join(tmp, "t18");
  const r = run(["create", "table", "loose", "name:text", "--dir=" + dir, "-f"]);
  assert.strictEqual(r.status, 0);
  const txt = fs.readFileSync(path.join(dir, "loose.schema.js"), "utf8");
  assert.doesNotMatch(txt, /SPEC_SHA256/, "CLI form does not pin to a spec");
  pass("CLI form (ad-hoc, no spec): file has no SPEC_SHA header");
}

// ---------- 19. Verify: outDir from spec is honored ----------
{
  const dir = path.join(tmp, "t19");
  fs.mkdirSync(dir, { recursive: true });
  const outDir = path.join(dir, "nested", "out");
  fs.mkdirSync(outDir, { recursive: true });
  const spec = { outDir, tables: [{ name: "z", fields: ["x:text"] }] };
  const specPath = path.join(dir, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec));
  let r = run(["from-json", specPath]);
  assert.strictEqual(r.status, 0, r.stderr);
  // verify without --dir should pick up outDir from spec
  r = run(["verify", specPath]);
  assert.strictEqual(r.status, 0, `verify should honor outDir from spec:\n${r.stderr}`);
  pass("verify: uses outDir from spec when --dir is omitted");
}

// ---------- 20. Stamps always produce all three timestamp columns ----------
{
  const dir = path.join(tmp, "t20");
  const r = run(["create", "table", "audit_events", "--stamps", "--dir=" + dir, "-f"]);
  assert.strictEqual(r.status, 0);
  const txt = fs.readFileSync(path.join(dir, "audit_events.schema.js"), "utf8");
  assert.match(txt, /created_at TEXT NOT NULL/);
  assert.match(txt, /updated_at TEXT NOT NULL/);
  assert.match(txt, /deleted_at TEXT/);
  // deleted_at must be nullable (no NOT NULL)
  assert.doesNotMatch(txt, /deleted_at TEXT NOT NULL/);
  pass("--stamps emits created_at/updated_at NOT NULL and deleted_at nullable");
}

// ---------- 21. Idempotency: re-running from-json with -f produces identical output ----------
{
  const dir = path.join(tmp, "t21");
  fs.mkdirSync(dir, { recursive: true });
  const spec = {
    outDir: path.join(dir, "out"),
    tables: [{ name: "tags", fields: [{ name: "label", type: "text", notnull: true }] }]
  };
  const specPath = path.join(dir, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec));
  let r = run(["from-json", specPath]);
  assert.strictEqual(r.status, 0);
  const first = fs.readFileSync(path.join(dir, "out", "tags.schema.js"), "utf8");
  r = run(["from-json", specPath, "-f"]);
  assert.strictEqual(r.status, 0);
  const second = fs.readFileSync(path.join(dir, "out", "tags.schema.js"), "utf8");
  assert.strictEqual(first, second, "re-running with same spec must produce byte-identical output");
  pass("Idempotency: regeneration produces byte-identical files");
}

// cleanup
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== ${testCount} thorough generator tests passed ===`);
