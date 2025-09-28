// tests/test-cli.mjs
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const tools = path.join(root, "tools");
const outDir = path.join(root, "schemas_cli");

// small helpers
function runNode(file, args = [], opts = {}) {
  const res = spawnSync(process.execPath, [file, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  if (res.status !== 0) {
    const msg = `Command failed: node ${file} ${args.join(" ")}\n${res.stdout}\n${res.stderr}`;
    throw new Error(msg);
  }
  return res.stdout.toString();
}
function read(p) {
  return fs.readFileSync(p, "utf8");
}
function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

// fresh output dir
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

console.log("=== CLI smoke tests ===");

// 1) create roles (default PK)
runNode(path.join(tools, "allez-orm.mjs"), ["create", "table", "roles", "--dir=" + outDir, "-f"]);
const rolesPath = path.join(outDir, "roles.schema.js");
assert.ok(exists(rolesPath), "roles.schema.js written");
console.log("✔ create roles (default PK)");

const rolesTxt = read(rolesPath);
assert.match(rolesTxt, /INTEGER PRIMARY KEY AUTOINCREMENT/, "roles has autoincrement PK");
console.log("✔ roles.schema.js written\n   → contains INTEGER PRIMARY KEY AUTOINCREMENT");

// 2) refuse overwrite without --force
fs.writeFileSync(rolesPath, "// sentinel", "utf8");
let refused = false;
try {
  runNode(path.join(tools, "allez-orm.mjs"), ["create", "table", "roles", "--dir=" + outDir]);
} catch {
  refused = true;
}
assert.ok(refused, "refused overwrite without --force");
console.log("✔ refused overwrite without --force");

// 3) overwrite with -f
runNode(path.join(tools, "allez-orm.mjs"), ["create", "table", "roles", "--dir=" + outDir, "-f"]);
assert.ok(exists(rolesPath), "roles re-written");
console.log("✔ overwrite roles with -f");

// 4) create users with email unique + stamps
runNode(path.join(tools, "allez-orm.mjs"), [
  "create", "table", "users",
  "email:text!+",
  "--stamps",
  "--dir=" + outDir, "-f"
]);
const usersPath = path.join(outDir, "users.schema.js");
assert.ok(exists(usersPath), "users.schema.js written");
const usersTxt = read(usersPath);

// order: UNIQUE then NOT NULL
assert.match(usersTxt, /email TEXT UNIQUE NOT NULL/, "users.email has UNIQUE then NOT NULL");
console.log("✔ create users with email unique + stamps");

// 5) create posts with FK user_id -> users(id) CASCADE + stamps (inline FK; no extraSQL)
runNode(path.join(tools, "allez-orm.mjs"), [
  "create", "table", "posts",
  "title:text!",
  "user_id:text->users",
  "--onDelete=cascade",
  "--stamps",
  "--dir=" + outDir, "-f"
]);
const postsPath = path.join(outDir, "posts.schema.js");
assert.ok(exists(postsPath), "posts.schema.js written");
const postsTxt = read(postsPath);

// FK must be inline with ON DELETE CASCADE
assert.match(
  postsTxt,
  /user_id TEXT REFERENCES users\(id\) ON DELETE CASCADE/,
  "posts.user_id has inline FK with ON DELETE CASCADE"
);

// ensure we DO NOT emit extraSQL at all anymore
assert.doesNotMatch(postsTxt, /\bextraSQL\b/, "no extraSQL emitted in generated module");
console.log("✔ create posts with FK user_id -> users(id) CASCADE + stamps");

// 6) stub generation for FK target tables: already created users above, but verify behavior
// Create memberships with org_id -> orgs to ensure stub for orgs appears
runNode(path.join(tools, "allez-orm.mjs"), [
  "create", "table", "memberships",
  "user_id:integer->users",
  "org_id:integer->orgs",
  "--dir=" + outDir, "-f"
]);
const orgsPath = path.join(outDir, "orgs.schema.js");
assert.ok(exists(orgsPath), "orgs stub schema written");
const orgsTxt = read(orgsPath);
assert.match(orgsTxt, /CREATE TABLE IF NOT EXISTS orgs \(\s*id INTEGER PRIMARY KEY AUTOINCREMENT\s*\);/s);
console.log("✔ create memberships and stub orgs");
console.log("✔ auto-created stub schema for 'orgs'");

// 7) overwrite via ALLEZ_FORCE=1 (env)
process.env.ALLEZ_FORCE = "1";
runNode(path.join(tools, "allez-orm.mjs"), ["create", "table", "roles", "--dir=" + outDir]);
console.log("✔ overwrite via ALLEZ_FORCE=1");

delete process.env.ALLEZ_FORCE;
