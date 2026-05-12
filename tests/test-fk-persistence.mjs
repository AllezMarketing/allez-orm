// tests/test-fk-persistence.mjs
// Regression test: PRAGMA foreign_keys must stay ON across saveNow()/db.export()
// (sql.js resets connection-scoped PRAGMAs during export).
import assert from "node:assert";
import initSqlJs from "sql.js";
import { AllezORM } from "../allez-orm.mjs";

console.log("=== FK persistence tests ===");

const SQL = await initSqlJs();
const db = new SQL.Database();
const orm = new AllezORM(SQL, db, { dbName: "test.db", autoSaveMs: 999999 });

await orm.exec("PRAGMA foreign_keys = ON;");
await orm.exec(`
  CREATE TABLE parents (id INTEGER PRIMARY KEY);
  CREATE TABLE children (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES parents(id)
  );
`);

// Sanity: FK is ON before any save
let pragma = (await orm.query("PRAGMA foreign_keys"))[0].foreign_keys;
assert.strictEqual(pragma, 1, "FK should be on after exec");
console.log("✔ FK pragma is ON after CREATE TABLE");

// saveNow() (which calls db.export()) used to reset FK to 0
await orm.saveNow();
pragma = (await orm.query("PRAGMA foreign_keys"))[0].foreign_keys;
assert.strictEqual(pragma, 1, "FK should remain ON after saveNow()");
console.log("✔ FK pragma survives saveNow() / db.export()");

// And the constraint should actually enforce
await orm.exec("INSERT INTO parents (id) VALUES (1);");
await orm.saveNow();
let threw = false;
try {
  await orm.exec("INSERT INTO children (parent_id) VALUES (9999);");
} catch { threw = true; }
assert.ok(threw, "FK violation should throw after saveNow()");
console.log("✔ FK constraint actually enforces after saveNow()");

// And it survives multiple saves in a row
await orm.saveNow();
await orm.saveNow();
threw = false;
try {
  await orm.exec("INSERT INTO children (parent_id) VALUES (12345);");
} catch { threw = true; }
assert.ok(threw, "FK violation should still throw after repeated saves");
console.log("✔ FK constraint survives repeated saveNow() calls");

console.log("\n=== All FK persistence tests passed ===");
