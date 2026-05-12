// tests/test-e2e-studio.mjs
// Playwright E2E test for AllezORM Studio (index.html + dev-server.mjs).
// Drives the UI to create a table via the CLI proxy, insert/update/delete rows,
// search, sort, add a column, and verifies the schema file is patched correctly.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const PORT = 5198; // unique port for tests
const BASE = `http://127.0.0.1:${PORT}`;
const schemasCli = path.join(root, "schemas_cli");
const backupDir = path.join(os.tmpdir(), `allez-bk-${Date.now()}`);

let serverProc = null;
let browser = null;
let exitCode = 0;
const pass = (m) => console.log(`✔ ${m}`);

function backupSchemas() {
  if (!fs.existsSync(schemasCli)) return;
  fs.cpSync(schemasCli, backupDir, { recursive: true });
  fs.rmSync(schemasCli, { recursive: true, force: true });
  fs.mkdirSync(schemasCli, { recursive: true });
}
function restoreSchemas() {
  fs.rmSync(schemasCli, { recursive: true, force: true });
  if (fs.existsSync(backupDir)) {
    fs.cpSync(backupDir, schemasCli, { recursive: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

async function waitForServer(maxMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await fetch(`${BASE}/api/schemas`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("dev-server did not come up");
}

async function startServer() {
  serverProc = spawn(process.execPath, [path.join(root, "dev-server.mjs")], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout.on("data", () => {});
  serverProc.stderr.on("data", (b) => process.stderr.write("[srv] " + b));
  await waitForServer();
}
function stopServer() {
  if (serverProc && !serverProc.killed) serverProc.kill("SIGKILL");
}

async function cleanup() {
  try { if (browser) await browser.close(); } catch {}
  stopServer();
  restoreSchemas();
}
process.on("SIGINT", () => { cleanup().finally(() => process.exit(130)); });

(async () => {
  console.log("=== E2E: AllezORM Studio ===");
  backupSchemas();

  try {
    await startServer();
    pass("dev-server is up");

    browser = await chromium.launch();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("dialog", async (d) => {
      consoleErrors.push(`[alert] ${d.message()}`);
      await d.dismiss();
    });

    await page.goto(BASE);
    // Wait until the ORM is bound on window (boot complete)
    await page.waitForFunction(() => !!window.orm, null, { timeout: 20000 });
    pass("Studio booted (window.orm ready, sql.js WASM loaded)");

    // ---------- Create a table via the UI dialog ----------
    await page.click("#btnNewTable");
    await page.fill("#newTableName", "widgets");
    await page.fill("#newTableSpecs", "name:text!+ price:real!");
    await page.click("#createTableGo");

    // The table should now appear in tableSel and the left list.
    await page.waitForFunction(() => {
      const sel = document.querySelector("#tableSel");
      return sel && Array.from(sel.options).some(o => o.value === "widgets");
    }, null, { timeout: 10000 });
    pass("Created table 'widgets' via Studio dialog (CLI proxy + ORM reload)");

    // The schema file should exist on disk under schemas_cli
    const widgetsSchemaPath = path.join(schemasCli, "widgets.schema.js");
    assert.ok(fs.existsSync(widgetsSchemaPath), "widgets.schema.js written by CLI proxy");
    const sTxt = fs.readFileSync(widgetsSchemaPath, "utf8");
    assert.match(sTxt, /name TEXT UNIQUE NOT NULL/);
    assert.match(sTxt, /price REAL NOT NULL/);
    pass("widgets.schema.js on disk has expected columns");

    // ---------- Insert rows via the in-page SQL box ----------
    await page.selectOption("#tableSel", "widgets");
    await page.fill("#sql", "INSERT INTO widgets (name, price, created_at, updated_at) VALUES ('alpha', 9.99, '2025-01-01', '2025-01-01'), ('beta', 4.50, '2025-01-02', '2025-01-02'), ('gamma', 12.00, '2025-01-03', '2025-01-03');");
    await page.click("#btnExec");
    // After exec, grid re-renders. Verify directly via ORM in the page:
    const count1 = await page.evaluate(async () => (await window.orm.query("SELECT COUNT(*) AS n FROM widgets"))[0].n);
    assert.strictEqual(count1, 3, "should have 3 rows after insert");
    pass("Inserted 3 rows via the SQL box");

    // ---------- Search filters rows ----------
    await page.fill("#q", "alp");
    // debounced 180ms
    await page.waitForFunction(() => /1 shown/.test(document.querySelector("#meta").textContent), null, { timeout: 3000 });
    pass("Search box filters grid down to matching rows");
    await page.fill("#q", "");
    await page.waitForFunction(() => /3 shown/.test(document.querySelector("#meta").textContent), null, { timeout: 3000 });

    // ---------- Sort by a column ----------
    // Click 'price' header twice -> ASC then DESC; verify the first row in the rendered grid is correct.
    await page.click('th[data-col="price"]'); // ASC
    let firstRow = await page.evaluate(() => document.querySelector("#grid tbody tr td:nth-child(3)").textContent);
    assert.strictEqual(firstRow.trim(), "4.5", "ASC sort: cheapest first");
    await page.click('th[data-col="price"]'); // DESC
    firstRow = await page.evaluate(() => document.querySelector("#grid tbody tr td:nth-child(3)").textContent);
    assert.strictEqual(firstRow.trim(), "12", "DESC sort: most expensive first");
    pass("Column header sort toggles ASC/DESC and re-renders");

    // ---------- Update via the ORM helper (table().update) ----------
    await page.evaluate(async () => {
      const beta = (await window.orm.query("SELECT id FROM widgets WHERE name='beta'"))[0];
      await window.orm.table("widgets").update(beta.id, { price: 5.55 });
    });
    const updated = await page.evaluate(async () => (await window.orm.query("SELECT price FROM widgets WHERE name='beta'"))[0].price);
    assert.strictEqual(updated, 5.55, "ORM update() should change the row");
    pass("ORM table().update() mutates the row");

    // ---------- Delete via ORM remove() ----------
    await page.evaluate(async () => {
      const g = (await window.orm.query("SELECT id FROM widgets WHERE name='gamma'"))[0];
      await window.orm.table("widgets").remove(g.id);
    });
    const count2 = await page.evaluate(async () => (await window.orm.query("SELECT COUNT(*) AS n FROM widgets"))[0].n);
    assert.strictEqual(count2, 2, "should have 2 rows after remove");
    pass("ORM table().remove() deletes the row");

    // ---------- Add a column via the dialog ----------
    // SQLite ALTER TABLE forbids NOT NULL without DEFAULT, so use a nullable col here.
    await page.click("#btnAddColumn");
    await page.fill("#colTable", "widgets");
    await page.fill("#colSpec", "sku:text");
    await page.click("#addColumnGo");

    // Confirm column exists in DB
    await page.waitForFunction(async () => {
      const cols = await window.orm.query("PRAGMA table_info(widgets)");
      return cols.some(c => c.name === "sku");
    }, null, { timeout: 5000 });
    pass("Added 'sku' column to widgets via Add column dialog (ALTER TABLE in browser)");

    // Wait for the dialog handler to finish (it writes the file after the ALTER).
    try {
      await page.waitForFunction(() => !document.querySelector("#dlgColumn").open, null, { timeout: 5000 });
    } catch (e) {
      const debug = await page.evaluate(() => ({
        dlgOpen: document.querySelector("#dlgColumn").open,
        tableSelOptions: Array.from(document.querySelector("#tableSel").options).map(o => o.value),
      }));
      console.error("Dialog hang debug:", debug);
      console.error("Recent console errors:", consoleErrors);
      throw e;
    }
    // Confirm schema file on disk got patched (poll briefly for the disk write).
    let sTxt2 = "";
    for (let i = 0; i < 25; i++) {
      sTxt2 = fs.readFileSync(widgetsSchemaPath, "utf8");
      if (/\bsku TEXT\b/.test(sTxt2)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.match(sTxt2, /\bsku TEXT\b/, "schema file was patched with new column");
    pass("Schema file on disk was patched with the new column");

    // ---------- IndexedDB persistence across reload ----------
    await page.evaluate(async () => { await window.orm.saveNow(); });
    await page.reload();
    await page.waitForFunction(() => !!window.orm, null, { timeout: 20000 });
    const count3 = await page.evaluate(async () => (await window.orm.query("SELECT COUNT(*) AS n FROM widgets"))[0].n);
    assert.strictEqual(count3, 2, "rows survive page reload via IndexedDB");
    pass("IndexedDB persistence: rows survive a full page reload");

    // ---------- FK integrity: create posts -> widgets and trip FK violation ----------
    await page.click("#btnNewTable");
    await page.fill("#newTableName", "tickets");
    await page.fill("#newTableSpecs", "title:text! widget_id:integer->widgets");
    await page.click("#createTableGo");
    await page.waitForFunction(() => {
      const sel = document.querySelector("#tableSel");
      return sel && Array.from(sel.options).some(o => o.value === "tickets");
    }, null, { timeout: 10000 });

    const fkPragma = await page.evaluate(async () => (await window.orm.query("PRAGMA foreign_keys"))[0].foreign_keys);
    assert.strictEqual(fkPragma, 1, "FK enforcement should be ON after init");
    const fkViolated = await page.evaluate(async () => {
      try {
        await window.orm.table("tickets").insert({ title: "bad", widget_id: 9999, created_at: "x", updated_at: "x" });
        return false;
      } catch { return true; }
    });
    assert.ok(fkViolated, "inserting orphaned FK should throw");
    pass("FK integrity: orphaned reference is rejected by SQLite");

    // ---------- No uncaught page errors ----------
    if (consoleErrors.length) {
      console.error("Page errors:\n" + consoleErrors.join("\n"));
      throw new Error(`${consoleErrors.length} page error(s) during run`);
    }
    pass("Zero uncaught page errors during the run");

    console.log("\n=== All E2E Studio tests passed ===");
  } catch (e) {
    exitCode = 1;
    console.error("E2E failed:", e.stack || e.message);
  } finally {
    await cleanup();
    process.exit(exitCode);
  }
})();
