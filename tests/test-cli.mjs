// tests/test-cli.mjs
// Runs cross-platform CLI smoke tests (no external deps).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

const NODE = process.execPath;
const CLI = path.join(process.cwd(), "tools", "allez-orm.mjs");
const OUTDIR = path.join(process.cwd(), "schemas_cli");

// clean output dir each run
fs.rmSync(OUTDIR, { recursive: true, force: true });
fs.mkdirSync(OUTDIR, { recursive: true });

function run(args, env = {}) {
  const res = spawnSync(NODE, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
  const out = (res.stdout || "") + (res.stderr || "");
  return { code: res.status ?? 0, out };
}

function must(codeOk, message, extra = "") {
  if (!codeOk) {
    console.error("\n❌", message);
    if (extra) console.error(extra);
    process.exit(1);
  } else {
    console.log("✔", message);
  }
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

console.log("=== CLI smoke tests ===");

// 1) Create roles with default id
{
  const { code, out } = run(["create", "table", "roles", "--dir=" + OUTDIR]);
  must(code === 0, "create roles (default PK)");
  const f = path.join(OUTDIR, "roles.schema.js");
  must(fs.existsSync(f), "roles.schema.js written");
  const s = read(f);
  assert.match(s, /id INTEGER PRIMARY KEY AUTOINCREMENT/);
  console.log("   → contains INTEGER PRIMARY KEY AUTOINCREMENT");
}

// 2) Refuse overwrite without --force/-f
{
  const { code, out } = run(["create", "table", "roles", "name!", "--dir=" + OUTDIR]);
  must(code !== 0, "refused overwrite without --force");
  assert.match(out, /Refusing to overwrite/);
}

// 3) Overwrite with -f (force)
{
  const { code } = run(["create", "table", "roles", "name!", "--dir=" + OUTDIR, "-f"]);
  must(code === 0, "overwrite roles with -f");
  const s = read(path.join(OUTDIR, "roles.schema.js"));
  assert.match(s, /name TEXT NOT NULL/);
}

// 4) Create users with stamps and unique email
{
  const { code } = run(["create", "table", "users", "email:text!+", "--stamps", "--dir=" + OUTDIR, "-f"]);
  must(code === 0, "create users with email unique + stamps");
  const s = read(path.join(OUTDIR, "users.schema.js"));
  assert.match(s, /email TEXT UNIQUE NOT NULL/);
  assert.match(s, /created_at TEXT NOT NULL/);
  assert.match(s, /updated_at TEXT NOT NULL/);
  assert.match(s, /deleted_at TEXT/);
}

// 5) Create posts with PS-safe FK '->', ON DELETE CASCADE, and stamps
{
  const { code } = run(["create", "table", "posts", "title!", "user_id:text->users", "--onDelete=cascade", "--stamps", "--dir=" + OUTDIR, "-f"]);
  must(code === 0, "create posts with FK user_id -> users(id) CASCADE + stamps");
  const s = read(path.join(OUTDIR, "posts.schema.js"));
  assert.match(s, /user_id TEXT REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(s, /`CREATE INDEX IF NOT EXISTS idx_posts_user_id_fk ON posts\(user_id\);`/);
}

// 6) Auto-create stub for missing FK target
{
  const { code } = run(["create", "table", "memberships", "org_id:integer->orgs", "--dir=" + OUTDIR, "-f"]);
  must(code === 0, "create memberships and stub orgs");
  const stub = path.join(OUTDIR, "orgs.schema.js");
  must(fs.existsSync(stub), "auto-created stub schema for 'orgs'");
  const s = read(stub);
  assert.match(s, /CREATE TABLE IF NOT EXISTS orgs/);
}

// 7) Env override ALLEZ_FORCE=1 also forces overwrite
{
  const { code } = run(["create", "table", "roles", "slug:text,unique", "--dir=" + OUTDIR], { ALLEZ_FORCE: "1" });
  must(code === 0, "overwrite via ALLEZ_FORCE=1");
  const s = read(path.join(OUTDIR, "roles.schema.js"));
  assert.match(s, /slug TEXT UNIQUE/);
}

console.log("\n🎉 All CLI tests passed.\n");
