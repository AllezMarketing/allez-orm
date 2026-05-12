// tests/test-spec-anchor.mjs
// Verifies spec-anchoring: headers, AGENTS.md emission, and the `verify` command.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const cli = path.join(root, "tools", "allez-orm.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "allez-anchor-"));
const outDir = path.join(tmp, "schemas_out");
const specPath = path.join(tmp, "spec.json");

const spec = {
  outDir,
  tables: [
    { name: "users", stamps: true, fields: [{ name: "email", type: "text", unique: true, notnull: true }] },
    { name: "posts", fields: [{ name: "title", type: "text", notnull: true }, { name: "user_id", type: "text", fk: { table: "users" } }] }
  ]
};
fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf8");

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts
  });
  return res;
}

console.log("=== Spec-anchor tests ===");

// 1) from-json writes headers + AGENTS.md
let res = run(["from-json", specPath, "--dir=" + outDir, "-f"]);
assert.strictEqual(res.status, 0, `from-json failed:\n${res.stderr}`);
const usersTxt = fs.readFileSync(path.join(outDir, "users.schema.js"), "utf8");
assert.match(usersTxt, /DO NOT EDIT/, "header contains do-not-edit notice");
assert.match(usersTxt, /SPEC_SHA256 [a-f0-9]{64}/, "header contains spec SHA");
assert.match(usersTxt, /TABLE_SHA256 [a-f0-9]{64}/, "header contains table SHA");
assert.match(usersTxt, /allez-orm from-json/, "header references regeneration command");
console.log("✔ from-json embeds spec anchors in generated files");

const agentsPath = path.join(outDir, "AGENTS.md");
assert.ok(fs.existsSync(agentsPath), "AGENTS.md was written");
const agentsTxt = fs.readFileSync(agentsPath, "utf8");
assert.match(agentsTxt, /generated artifacts/i, "AGENTS.md explains files are generated");
assert.match(agentsTxt, /allez-orm verify/, "AGENTS.md mentions verify command");
assert.match(agentsTxt, /- `users`/, "AGENTS.md lists tables");
console.log("✔ from-json writes AGENTS.md with spec ref + table list");

// 2) verify on clean output succeeds
res = run(["verify", specPath, "--dir=" + outDir]);
assert.strictEqual(res.status, 0, `verify on clean output should pass:\n${res.stderr}`);
assert.match(res.stdout, /match spec/, "verify reports match");
console.log("✔ verify succeeds on freshly-generated output");

// 3) verify detects drift when a generated file is edited by hand
const postsPath = path.join(outDir, "posts.schema.js");
const postsTxt = fs.readFileSync(postsPath, "utf8");
fs.writeFileSync(postsPath, postsTxt.replace("title TEXT NOT NULL", "title TEXT"), "utf8");
res = run(["verify", specPath, "--dir=" + outDir]);
assert.strictEqual(res.status, 1, "verify should fail on hand-edited file");
assert.match(res.stderr, /Drift detected/, "verify reports drift");
assert.match(res.stderr, /posts\.schema\.js/, "verify names the drifted file");
console.log("✔ verify detects hand-edits to generated files");

// 4) verify detects drift when the spec changes but files don't
fs.writeFileSync(postsPath, postsTxt, "utf8"); // restore
const spec2 = JSON.parse(JSON.stringify(spec));
spec2.tables[0].fields.push({ name: "display_name", type: "text" });
fs.writeFileSync(specPath, JSON.stringify(spec2, null, 2), "utf8");
res = run(["verify", specPath, "--dir=" + outDir]);
assert.strictEqual(res.status, 1, "verify should fail when spec adds a field but files are stale");
assert.match(res.stderr, /users\.schema\.js/, "verify flags the stale users file");
console.log("✔ verify detects stale files when spec changes");

// 5) verify detects missing generated files
fs.unlinkSync(path.join(outDir, "users.schema.js"));
res = run(["verify", specPath, "--dir=" + outDir]);
assert.strictEqual(res.status, 1, "verify should fail when a file is missing");
assert.match(res.stderr, /Missing.*users/, "verify reports missing file");
console.log("✔ verify detects missing generated files");

// cleanup
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n=== All spec-anchor tests passed ===");
