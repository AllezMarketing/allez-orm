// allez-orm.mjs
// AllezORM — minimal browser ORM on top of sql.js (WASM)
// - Pure client-side
// - IndexedDB persistence (debounced auto-save)
// - Plug-in schemas with optional versioned upgrades
// - Simple table helpers (insert/upsert/update/deleteSoft/remove/findById/searchLike)

/**
 * @typedef {Object} Schema
 * @property {string} table               // table name
 * @property {string} createSQL           // CREATE TABLE IF NOT EXISTS ...
 * @property {string[]=} extraSQL         // indexes / triggers / FTS setup
 * @property {number=} version            // defaults to 1
 * @property {(db:any,from:number,to:number)=>void|Promise<void>=} onUpgrade
 */

/**
 * @typedef {Object} InitOptions
 * @property {string=} dbName
 * @property {number=} autoSaveMs
 * @property {(file:string)=>string=} wasmLocateFile
 * @property {Schema[]=} schemas
 * @property {Record<string,{default:Schema}>=} schemaModules
 */

const DEFAULT_DB_NAME = "allez.db";
const DEFAULT_AUTOSAVE_MS = 1500;

/** Resolve/init sql.js WASM in a way that never triggers node core deps. */
async function loadSqlJs(opts = {}) {
  // 1) If user included <script src="https://sql.js.org/dist/sql-wasm.js">, use it.
  if (typeof window !== "undefined" && window.initSqlJs) {
    return await window.initSqlJs({
      locateFile: opts.wasmLocateFile ?? (f => `https://sql.js.org/dist/${f}`)
    });
  }

  // 2) Try a CDN ESM import that bundlers won't touch (no fs/path/crypto resolution).
  //    Dynamic URL import requires CORS; the official CDN allows it.
  try {
    // @ts-ignore
    const mod = await import(/* webpackIgnore: true */ "https://sql.js.org/dist/sql-wasm.js");
    const initSqlJs = mod.default || mod;
    return await initSqlJs({
      locateFile: opts.wasmLocateFile ?? (f => `https://sql.js.org/dist/${f}`)
    });
  } catch (_) {
    // continue to step 3
  }

  // 3) Last resort: local dist entry. This ONLY works if the consumer configured
  //    resolve.alias OR fallbacks to disable node core modules in their bundler.
  const mod = await import("sql.js/dist/sql-wasm.js"); // never import "sql.js"
  const initSqlJs = mod.default || mod;
  return await initSqlJs({
    locateFile: opts.wasmLocateFile ?? (f => `https://sql.js.org/dist/${f}`)
  });
}

export class AllezORM {
  /** @param {any} SQL @param {any} db @param {InitOptions} opts */
  constructor(SQL, db, opts) {
    this.SQL = SQL;
    this.db = db;
    this.dbName = opts.dbName ?? DEFAULT_DB_NAME;
    this.autoSaveMs = opts.autoSaveMs ?? DEFAULT_AUTOSAVE_MS;
    this.saveTimer = null;
  }

  // run arbitrary SQL (DDL/DML). Returns true on success.
  async exec(sql, params = []) {
    if (params && params.length) {
      const stmt = this.db.prepare(sql);
      try {
        stmt.bind(params);
        while (stmt.step()) { /* drain */ }
      } finally {
        stmt.free();
      }
    } else {
      this.db.exec(sql);
    }
    if (typeof this.saveNow === "function") await this.saveNow();
    return true;
  }

  run(sql, params) { return this.exec(sql, params); }

  /** @param {InitOptions=} opts */
  static async init(opts = {}) {
    // Always use the WASM/browser build loader above.
    const SQL = await loadSqlJs(opts);

    // Restore DB from IndexedDB, or create fresh
    const saved = await idbGet(opts.dbName ?? DEFAULT_DB_NAME);
    const db = saved ? new SQL.Database(saved) : new SQL.Database();

    const orm = new AllezORM(SQL, db, opts);
    await orm.execute("PRAGMA foreign_keys = ON;");
    await orm.#ensureMeta();

    const schemas = collectSchemas(opts);
    await orm.registerSchemas(schemas);
    db.exec("PRAGMA foreign_keys = ON;");

    return orm;
  }

  // ---------------- core SQL helpers ----------------

  async execute(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      while (stmt.step()) { /* drain */ }
    } finally {
      stmt.free();
    }
    this.#scheduleSave();
  }

  async query(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const out = [];
    try {
      stmt.bind(params);
      while (stmt.step()) out.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return out;
  }

  async get(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows[0];
  }

  // ---------------- table helper ----------------

  table(table) {
    const self = this;
    return {
      async insert(obj) {
        const cols = Object.keys(obj);
        const qs = cols.map(() => "?").join(",");
        await self.execute(
          `INSERT INTO ${table} (${cols.join(",")}) VALUES (${qs})`,
          cols.map(c => obj[c])
        );
      },
      async upsert(obj) {
        const cols = Object.keys(obj);
        const qs = cols.map(() => "?").join(",");
        const updates = cols.map(c => `${c}=excluded.${c}`).join(",");
        await self.execute(
          `INSERT INTO ${table} (${cols.join(",")}) VALUES (${qs})
           ON CONFLICT(id) DO UPDATE SET ${updates}`,
          cols.map(c => obj[c])
        );
      },
      async update(id, patch) {
        const cols = Object.keys(patch);
        if (!cols.length) return;
        const assigns = cols.map(c => `${c}=?`).join(",");
        await self.execute(
          `UPDATE ${table} SET ${assigns} WHERE id=?`,
          [...cols.map(c => patch[c]), id]
        );
      },
      async deleteSoft(id, ts = new Date().toISOString()) {
        await self.execute(`UPDATE ${table} SET deleted_at=? WHERE id=?`, [ts, id]);
      },
      async remove(id) {
        await self.execute(`DELETE FROM ${table} WHERE id=?`, [id]);
      },
      async findById(id) {
        return await self.get(`SELECT * FROM ${table} WHERE id=?`, [id]);
      },
      async searchLike(q, columns, limit = 50) {
        if (!columns?.length) return [];
        const where = columns.map(c => `${table}.${c} LIKE ?`).join(" OR ");
        const params = columns.map(() => `%${q}%`);
        return await self.query(
          `SELECT * FROM ${table} WHERE (${where}) LIMIT ?`,
          [...params, limit]
        );
      }
    };
  }

  // ---------------- schema registration ----------------

  /** @param {Schema[]} schemas */
  async registerSchemas(schemas) {
    const meta = await this.#currentVersions();
    for (const s of schemas) {
      const exists = await this.get(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
        [s.table]
      );
      if (!exists) {
        await this.execute(s.createSQL);
        if (Array.isArray(s.extraSQL)) {
          for (const x of s.extraSQL) await this.execute(x);
        }
        await this.execute(
          `INSERT OR REPLACE INTO allez_meta(table_name,version) VALUES(?,?)`,
          [s.table, s.version ?? 1]
        );
      } else {
        const cur = meta.get(s.table) ?? 1;
        const next = s.version ?? cur;
        if (s.onUpgrade && next > cur) {
          await s.onUpgrade(this.db, cur, next);
          await this.execute(
            `UPDATE allez_meta SET version=? WHERE table_name=?`,
            [next, s.table]
          );
        }
      }
    }
    this.#scheduleSave();
  }

  async saveNow() {
    const data = this.db.export(); // Uint8Array
    await idbSet(this.dbName, data);
  }

  // ---------------- internals ----------------

  async #ensureMeta() {
    await this.execute(`
      CREATE TABLE IF NOT EXISTS allez_meta (
        table_name TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      );
    `);
  }

  async #currentVersions() {
    const rows = await this.query(
      `SELECT table_name, version FROM allez_meta`
    );
    return new Map(rows.map(r => [r.table_name, r.version]));
  }

  #scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.saveNow(); }, this.autoSaveMs);
  }
}

// ---------------- helpers: schema collection + IndexedDB ----------------

/** @param {InitOptions} opts */
function collectSchemas(opts) {
  const fromModules = opts.schemaModules
    ? Object.values(opts.schemaModules).map(m => m.default)
    : [];
  const fromArray = opts.schemas ?? [];
  return [...fromModules, ...fromArray];
}

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("allez-orm-store", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("dbs");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

async function idbGet(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("dbs", "readonly");
    const store = tx.objectStore("dbs");
    const get = store.get(key);
    get.onsuccess = () => resolve(get.result || null);
    get.onerror = () => reject(get.error);
  });
}

async function idbSet(key, value) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("dbs", "readwrite");
    tx.objectStore("dbs").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
