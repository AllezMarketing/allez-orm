// tests/test-security.mjs
// Node-based unit tests for SQL identifier safety in allez-orm
import assert from "node:assert";
import initSqlJs from "sql.js";
import { AllezORM, safeIdent } from "../allez-orm.mjs";

// Patch: AllezORM.init() uses browser-only sql.js loading.
// We bypass it and construct directly for Node testing.
async function createTestOrm() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const orm = new AllezORM(SQL, db, { dbName: "test.db", autoSaveMs: 999999 });
  await orm.execute("PRAGMA foreign_keys = ON;");
  await orm.execute(`
    CREATE TABLE IF NOT EXISTS allez_meta (
      table_name TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    );
  `);
  await orm.execute(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      description TEXT,
      deletedAt TEXT,
      deleted_at TEXT
    );
  `);
  return orm;
}

console.log("=== Security tests ===");

// --- safeIdent tests ---

// Valid identifiers should pass
assert.strictEqual(safeIdent("users"), '"users"');
assert.strictEqual(safeIdent("my_table"), '"my_table"');
assert.strictEqual(safeIdent("Column1"), '"Column1"');
assert.strictEqual(safeIdent("_private"), '"_private"');
assert.strictEqual(safeIdent("a"), '"a"');
console.log("✔ safeIdent accepts valid identifiers");

// SQL injection attempts should throw
const malicious = [
  "users; DROP TABLE users--",
  "users; DROP TABLE users",
  "1; DROP TABLE users",
  "users\"; DROP TABLE users--",
  "users' OR '1'='1",
  "Robert'); DROP TABLE Students;--",
  "",
  "123abc",  // starts with digit
  "user-name",  // hyphen
  "table.column",  // dot
  "name with spaces",
  "col\nname",  // newline
  "col\x00name",  // null byte
];

for (const bad of malicious) {
  let threw = false;
  try { safeIdent(bad); } catch { threw = true; }
  assert.ok(threw, `safeIdent should reject: ${JSON.stringify(bad)}`);
}
console.log(`✔ safeIdent rejects ${malicious.length} malicious identifiers`);

// Non-string inputs should throw
for (const bad of [null, undefined, 42, {}, [], true]) {
  let threw = false;
  try { safeIdent(bad); } catch { threw = true; }
  assert.ok(threw, `safeIdent should reject non-string: ${JSON.stringify(bad)}`);
}
console.log("✔ safeIdent rejects non-string inputs");

// --- table() method integration tests ---

const orm = await createTestOrm();

// table() with valid name should work
const items = orm.table("items");
await items.insert({ id: 1, name: "Widget", description: "A widget" });
const found = await items.findById(1);
assert.ok(found, "insert + findById works");
assert.strictEqual(found.name, "Widget");
console.log("✔ table().insert + findById works with safe identifiers");

// upsert
await items.upsert({ id: 1, name: "Updated Widget", description: "Updated" });
const upserted = await items.findById(1);
assert.strictEqual(upserted.name, "Updated Widget");
console.log("✔ table().upsert works");

// update
await items.update(1, { name: "Final Widget" });
const updated = await items.findById(1);
assert.strictEqual(updated.name, "Final Widget");
console.log("✔ table().update works");

// searchLike
await items.insert({ id: 2, name: "Gadget", description: "A gadget" });
const search = await items.searchLike("adg", ["name", "description"]);
assert.ok(search.length >= 1, "searchLike finds matching row");
console.log("✔ table().searchLike works");

// deleteSoft
await items.deleteSoft(1);
const softDeleted = await items.findById(1);
assert.ok(softDeleted.deletedAt || softDeleted.deleted_at, "deleteSoft sets timestamp");
console.log("✔ table().deleteSoft works");

// remove
await items.remove(2);
const removed = await items.findById(2);
assert.ok(!removed, "remove deletes row");
console.log("✔ table().remove works");

// --- SQL injection via table name should throw ---
let threw = false;
try {
  orm.table("items; DROP TABLE items--");
} catch (e) {
  threw = true;
  assert.match(e.message, /Unsafe SQL identifier/);
}
assert.ok(threw, "table() rejects malicious table name");
console.log("✔ table() rejects SQL injection in table name");

// --- SQL injection via column name in insert should throw ---
threw = false;
try {
  const bad = orm.table("items");
  await bad.insert({ "id": 3, "name; DROP TABLE items--": "gotcha" });
} catch (e) {
  threw = true;
  assert.match(e.message, /Unsafe SQL identifier/);
}
assert.ok(threw, "insert rejects malicious column name");
console.log("✔ insert rejects SQL injection in column name");

// --- SQL injection via column name in update should throw ---
threw = false;
try {
  const bad = orm.table("items");
  await bad.update(1, { "name=1; DROP TABLE items--": "gotcha" });
} catch (e) {
  threw = true;
  assert.match(e.message, /Unsafe SQL identifier/);
}
assert.ok(threw, "update rejects malicious column name");
console.log("✔ update rejects SQL injection in column name");

// --- SQL injection via column name in searchLike should throw ---
threw = false;
try {
  const t = orm.table("items");
  await t.searchLike("test", ["name; DROP TABLE items--"]);
} catch (e) {
  threw = true;
  assert.match(e.message, /Unsafe SQL identifier/);
}
assert.ok(threw, "searchLike rejects malicious column name");
console.log("✔ searchLike rejects SQL injection in column name");

// --- Verify the table still exists (injection didn't succeed) ---
const verify = await orm.query("SELECT name FROM sqlite_master WHERE type='table' AND name='items'");
assert.ok(verify.length === 1, "items table still exists (no injection succeeded)");
console.log("✔ Confirmed: table survived all injection attempts");

console.log("\n=== All security tests passed ===");
