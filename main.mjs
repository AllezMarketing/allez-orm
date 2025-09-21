// main.mjs
import { AllezORM } from "./allez-orm.mjs";

/* ─────────────────────────── helpers ─────────────────────────── */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const on = (el, ev, cb, opts) => el.addEventListener(ev, cb, opts);
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* DOM refs */
const qSel      = $("#q");
const meta      = $("#meta");
const grid      = $("#grid");
const tableSel  = $("#tableSel");
const tableList = $("#tableList");
const dlgTable  = $("#dlgTable");
const dlgColumn = $("#dlgColumn");

/* ─────────────────── column-spec parsing helpers ─────────────────── */
const TYPE_ALIASES = {
  int: "INTEGER", integer: "INTEGER", bool: "INTEGER",
  text: "TEXT", string: "TEXT", datetime: "TEXT", timestamp: "TEXT",
  real: "REAL", float: "REAL",
  number: "NUMERIC", numeric: "NUMERIC",
  blob: "BLOB"
};

function parseNameTypeFlags(base) {
  let name, rhs = "", explicitType = false;
  if (base.includes(":")) { [name, rhs = ""] = base.split(":"); explicitType = true; }
  else { name = base; rhs = ""; }
  name = name.trim();

  let typeToken = "", flagsStr = "";
  if (rhs) {
    const m = rhs.match(/^(.*?)([!+^#~?]+)?$/);
    typeToken = (m?.[1] || "").trim();
    flagsStr  = m?.[2] || "";
  } else {
    const m = name.match(/^(.*?)([!+^#~?]+)?$/);
    name     = (m?.[1] || "").trim();
    flagsStr = m?.[2] || "";
  }

  let type = typeToken ? (TYPE_ALIASES[typeToken.toLowerCase()] ?? typeToken.toUpperCase()) : "";
  const flags = new Set(
    flagsStr.split("")
      .map(c => c === "!" ? "notnull"
               : c === "+" ? "unique"
               : c === "^" ? "index"
               : c === "#" ? "pk"
               : c === "~" ? "ai"
               : "")
      .filter(Boolean)
  );
  return { name, type, flags, explicitType };
}

function buildColumnSQLFromSpec(spec) {
  // FK forms: left->table(col?) or type:fk(table.col)
  if ((spec.includes(">") || spec.includes("->")) && !spec.includes(":fk")) {
    const [left, rhsRaw] = spec.includes("->") ? spec.split("->") : spec.split(">");
    const { name, type, flags, explicitType } = parseNameTypeFlags(left);
    const m = rhsRaw.match(/^([a-zA-Z0-9_]+)(?:\(([a-zA-Z0-9_]+)\))?$/);
    if (!m) throw new Error("Bad FK spec");
    const refTable = m[1], refCol = m[2] || "id";
    const t = explicitType ? (type || "TEXT") : "INTEGER";
    return `${name} ${(TYPE_ALIASES[t.toLowerCase()] ?? t.toUpperCase())} REFERENCES ${refTable}(${refCol})`
         + (flags.has("notnull") ? " NOT NULL" : "")
         + (flags.has("unique")  ? " UNIQUE"   : "");
  }

  // general case: name[:type][!+…] [,default=...]
  const parts = spec.split(",");
  const base  = parts.shift();
  let { name, type, flags } = parseNameTypeFlags(base);
  if (!type) type = "TEXT";

  let sql = `${name} ${type}`;
  if (flags.has("pk"))      sql += " PRIMARY KEY";
  if (flags.has("ai"))      sql += " AUTOINCREMENT";
  if (flags.has("unique"))  sql += " UNIQUE";
  if (flags.has("notnull")) sql += " NOT NULL";

  const defKV = parts.find(x => x.startsWith("default="));
  if (defKV) sql += " DEFAULT " + defKV.split("=",2)[1];

  return sql;
}

/* ─────────────────────────── app state ─────────────────────────── */
let orm;
let currentTable = null;
let sortCol = null;
let sortDir = "DESC"; // default newest-first when 'updated_at' exists

/* ─────────────────────── data access helpers ─────────────────────── */
async function fetchSchemas() {
  const r = await fetch("/api/schemas");
  const j = await r.json();
  return j.schemas || [];
}

async function initORM() {
  const schemas = await fetchSchemas();
  orm = await AllezORM.init({ dbName: "demo.db", schemas });
  await orm.exec?.("PRAGMA foreign_keys = ON;"); // ensure FKs
  window.orm = orm; // console convenience
}

async function tableNames() {
  const rows = await orm.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='allez_meta' ORDER BY name"
  );
  return rows.map(r => r.name);
}

async function columnsFor(table) {
  const cols = await orm.query(`PRAGMA table_info(${table})`);
  return cols.map(c => ({ name: c.name, type: String(c.type || "").toUpperCase() }));
}

/* ─────────────────────────── UI rendering ─────────────────────────── */
/** Render a table using known column names; still shows header if rows === 0 */
function renderTableRows(rows, knownCols /* array of strings */) {
  let colNames = knownCols && knownCols.length
    ? knownCols
    : (rows.length ? Object.keys(rows[0]) : []);

  if (!colNames.length) { // truly nothing known
    grid.innerHTML = `<div class="muted" style="padding:10px">No rows.</div>`;
    return;
  }

  const thead = `<tr>${
    colNames.map(c => {
      const active = (c === sortCol) ? (sortDir === "ASC" ? "↑" : "↓") : "";
      return `<th data-col="${c}" class="cHead">${c}<span class="sort">${active}</span></th>`;
    }).join("")
  }</tr>`;

  const body = rows.length
    ? rows.map(r =>
        `<tr>${colNames.map(c => {
          const v = r[c];
          const s =
            (v === null || v === undefined) ? "<span class='muted'>∅</span>" :
            typeof v === "object"           ? `<code>${JSON.stringify(v)}</code>` :
            String(v).length > 180          ? `<details><summary>${String(v).slice(0,180)}…</summary><pre>${String(v)}</pre></details>` :
                                               String(v);
          return `<td>${s}</td>`;
        }).join("")}</tr>`
      ).join("")
    : `<tr><td colspan="${colNames.length}"><div class="muted">No rows.</div></td></tr>`;

  grid.innerHTML = `<table><thead>${thead}</thead><tbody>${body}</tbody></table>`;

  // header click to sort
  $$(".cHead", grid).forEach(th => {
    on(th, "click", () => {
      const col = th.dataset.col;
      if (sortCol === col) sortDir = (sortDir === "ASC" ? "DESC" : "ASC");
      else { sortCol = col; sortDir = "ASC"; }
      searchAndRender();
    });
  });
}

async function searchAndRender() {
  const table = currentTable || tableSel.value;
  if (!table) return;

  const q        = qSel.value.trim();
  const colsMeta = await columnsFor(table);
  const colNames = colsMeta.map(c => c.name);

  const textCols = colsMeta
    .filter(c => c.type.includes("CHAR") || c.type.includes("TEXT") || c.type === "")
    .map(c => c.name);

  const orderCol = (sortCol && colNames.includes(sortCol))
      ? sortCol
      : (colNames.includes("updated_at") ? "updated_at" : "id");
  const order = `${orderCol} ${sortDir}`;

  let rows;
  if (q && textCols.length) {
    const where  = textCols.map(c => `${table}.${c} LIKE ?`).join(" OR ");
    const params = textCols.map(() => `%${q}%`);
    rows = await orm.query(`SELECT * FROM ${table} WHERE (${where}) ORDER BY ${order} LIMIT 300`, params);
  } else {
    rows = await orm.query(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 300`);
  }

  meta.textContent = `${rows.length} shown • ${table}`;
  renderTableRows(rows, colNames);
}

/* ─────────────────────────── UI wiring ─────────────────────────── */
async function refreshTablesUI() {
  const names = await tableNames();

  // <select>
  tableSel.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join("");
  if (!currentTable) currentTable = names[0];
  if (currentTable && !names.includes(currentTable)) currentTable = names[0];
  tableSel.value = currentTable;

  // left list
  tableList.innerHTML = names.map(n => `<li class="kitem"><span class="name">${n}</span></li>`).join("");
  $$(".kitem", tableList).forEach((li, i) => {
    on(li, "click", () => {
      currentTable = names[i];
      tableSel.value = currentTable;
      sortCol = null; sortDir = "DESC";
      searchAndRender();
    });
  });
}

on(tableSel, "change", () => {
  currentTable = tableSel.value;
  sortCol = null; sortDir = "DESC";
  searchAndRender();
});

on(qSel, "input", debounce(searchAndRender, 180));

/* Run-SQL box */
on($("#btnExec"), "click", async () => {
  const sql = $("#sql").value.trim();
  if (!sql) return;

  const isQuery = /^\s*(select|with|pragma)\b/i.test(sql);
  try {
    if (isQuery) {
      const rows = await orm.query(sql);
      meta.textContent = `OK • ${rows.length} row(s)`;
      renderTableRows(rows); // no known columns for arbitrary SQL
    } else {
      await orm.exec(sql);
      meta.textContent = "OK";
      const rows = await orm.query("SELECT changes() AS changes");
      renderTableRows(rows);
      await refreshTablesUI();
    }
  } catch (e) {
    meta.textContent = "Error";
    grid.innerHTML = `<pre style="color:#b00020">${String(e)}</pre>`;
  }
});

/* dialogs */
on($("#btnNewTable"), "click", () => dlgTable.showModal());
on($("#btnAddColumn"), "click", () => {
  $("#colTable").value = currentTable || ""; // helpful default
  dlgColumn.showModal();
});

/* Create table via CLI, then reload schemas & DB */
on($("#createTableGo"), "click", async (ev) => {
  ev.preventDefault();
  const name  = $("#newTableName").value.trim();
  const specs = $("#newTableSpecs").value.trim();
  if (!name) return dlgTable.close();

  const args = ["create", "table", name, ...(specs ? specs.split(/\s+/) : []), "--stamps"];
  const r = await fetch("/api/cli", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args })
  });
  const j = await r.json();
  if (j.code !== 0) alert("CLI error:\n" + (j.err || j.out));

  await initORM();
  await refreshTablesUI();
  await searchAndRender();
  dlgTable.close();
});

/* Add column: ALTER TABLE in browser + patch schema file */
on($("#addColumnGo"), "click", async (ev) => {
  ev.preventDefault();
  const table = $("#colTable").value.trim();
  const spec  = $("#colSpec").value.trim();
  if (!table || !spec) return dlgColumn.close();

  try {
    const colSQL = buildColumnSQLFromSpec(spec);
    await orm.exec(`ALTER TABLE ${table} ADD COLUMN ${colSQL}`);

    // optional index via '^' flag
    let extraIndexSQL = null;
    if (/\^/.test(spec)) {
      const left = spec.includes(">") || spec.includes("->") ? spec.split(/->|>/)[0] : spec.split(",")[0];
      const { name } = parseNameTypeFlags(left);
      extraIndexSQL = `CREATE INDEX IF NOT EXISTS idx_${table}_${name} ON ${table}(${name});`;
      await orm.exec(extraIndexSQL);
    }

    await fetch("/api/schema/add-column", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ table, columnSQL: colSQL, extraIndexSQL })
    });

    await refreshTablesUI();
    await searchAndRender();
    dlgColumn.close();
  } catch (e) {
    alert("Add column failed:\n" + String(e));
  }
});

/* ───────────────────────────── boot ───────────────────────────── */
await initORM();
await refreshTablesUI();
await searchAndRender();
console.log("AllezORM Studio ready. Try:", `await window.orm.table("users").searchLike("adam",["email"])`);
