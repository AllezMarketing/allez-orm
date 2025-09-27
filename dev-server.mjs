#!/usr/bin/env node
/**
 * Minimal dev server for AllezORM Studio.
 * - Serves static files from repo root
 * - API /api/schemas       -> returns all *.schema.js from ./schemas and ./schemas_cli
 * - API /api/cli           -> runs tools/allez-orm.mjs with args
 * - API /api/schema/add-column -> patches a schema file's createSQL and extraSQL
 *
 * No external deps.
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const PORT = process.env.PORT ? Number(process.env.PORT) : 5174;

const SCHEMA_DIRS = [
  path.join(ROOT, "schemas"),
  path.join(ROOT, "schemas_cli"),
];

const INDEX = path.join(ROOT, "index.html");

// ---------- tiny helpers ----------
const mime = (p) => {
  const ext = path.extname(p).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".mjs":  "text/javascript; charset=utf-8",
    ".js":   "text/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png":  "image/png",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
  })[ext] || "application/octet-stream";
};

const safeRead = async (p) => {
  try { return await fsp.readFile(p); } catch { return null; }
};

const exists = (p) => fs.existsSync(p);

const listSchemas = async () => {
  const out = [];
  for (const dir of SCHEMA_DIRS) {
    if (!exists(dir)) continue;
    const files = (await fsp.readdir(dir)).filter(f => f.endsWith(".schema.js"));
    for (const f of files) out.push(path.join(dir, f));
  }
  return out;
};

const importFresh = async (file) => {
  // Bust Node ESM cache by adding a version query
  const url = new URL(pathToFileURL(file).href);
  url.searchParams.set("v", Date.now().toString());
  const mod = await import(url.href);
  return mod?.default ?? mod;
};

// ---------- API handlers ----------
async function handleSchemas(_req, res) {
  try {
    const files = await listSchemas();
    const schemas = [];
    for (const f of files) {
      try {
        const mod = await importFresh(f);
        if (mod && typeof mod === "object") schemas.push(mod);
      } catch (e) {
        console.error("[schemas] import failed:", f, e);
      }
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ schemas, count: schemas.length }));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: String(e) }));
  }
}

async function handleCLI(req, res) {
  try {
    const body = await getJsonBody(req);
    const args = Array.isArray(body?.args) ? body.args : [];
    const cli = path.join(ROOT, "tools", "allez-orm.mjs");

    const child = spawn(process.execPath, [cli, ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "", err = "";
    child.stdout.on("data", (b) => out += b.toString());
    child.stderr.on("data", (b) => err += b.toString());

    child.on("close", (code) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ code, out, err }));
    });
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ code: -1, err: String(e) }));
  }
}

/**
 * Very light schema patcher used by Studio's "Add column / FK".
 * We look for:
 *   createSQL: `
 *   CREATE TABLE IF NOT EXISTS <table> (
 *     ...columns...
 *   );`,
 * and inject the new column before the closing `);`.
 * If extraIndexSQL provided, we append inside `extraSQL: [ ... ]`.
 */
async function handleAddColumn(req, res) {
  try {
    const { table, columnSQL, extraIndexSQL } = await getJsonBody(req);
    if (!table || !columnSQL) throw new Error("table and columnSQL required");

    const file = await resolveSchemaFile(table);
    if (!file) throw new Error(`schema file for '${table}' not found in ./schemas or ./schemas_cli`);

    let text = (await fsp.readFile(file, "utf8"));

    // ---- patch createSQL block ----
    const createStart = text.indexOf("createSQL:");
    const startTick = text.indexOf("`", createStart);
    const endTick = text.indexOf("`", startTick + 1);
    if (createStart < 0 || startTick < 0 || endTick < 0) {
      throw new Error("Unable to locate createSQL template literal in schema file.");
    }

    const createBlock = text.slice(startTick + 1, endTick);
    // Find closing ); and inject before it (with comma if needed)
    const closeIdx = createBlock.lastIndexOf(");");
    if (closeIdx < 0) throw new Error("Malformed createSQL block (missing ');').");

    // Add a comma if previous non-whitespace char before close is not a comma or opening paren
    const beforeClose = createBlock.slice(0, closeIdx).replace(/\s+$/,"");
    const needsComma = !/[,(]\s*$/.test(beforeClose);
    const injected = beforeClose + (needsComma ? ",\n  " : "\n  ") + columnSQL + "\n" + createBlock.slice(closeIdx);

    text = text.slice(0, startTick + 1) + injected + text.slice(endTick);

    // ---- optionally patch extraSQL array ----
    if (extraIndexSQL) {
      const m = text.match(/extraSQL\s*:\s*\[([\s\S]*?)\]/);
      if (m) {
        const arrayBody = m[1].trim();
        const hasTrailingComma = arrayBody.length && !arrayBody.trim().endsWith(",");
        const insert = (arrayBody ? (arrayBody + (hasTrailingComma ? "," : "")) + `\n    \`${extraIndexSQL}\`` : `\n    \`${extraIndexSQL}\``);
        text = text.replace(/extraSQL\s*:\s*\[[\s\S]*?\]/, `extraSQL: [${insert}\n  ]`);
      }
    }

    await fsp.writeFile(file, text, "utf8");
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, file }));
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}

async function resolveSchemaFile(table) {
  for (const dir of SCHEMA_DIRS) {
    const p = path.join(dir, `${table}.schema.js`);
    if (exists(p)) return p;
  }
  return null;
}

async function getJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

// ---------- static file server ----------
async function serveStatic(req, res) {
  let urlPath = decodeURI(new URL(req.url, `http://${req.headers.host}`).pathname);

  // API routes
  if (req.method === "GET"  && urlPath === "/api/schemas")        return handleSchemas(req, res);
  if (req.method === "POST" && urlPath === "/api/cli")            return handleCLI(req, res);
  if (req.method === "POST" && urlPath === "/api/schema/add-column") return handleAddColumn(req, res);

  // trim leading slash
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(ROOT, urlPath);

  let data = await safeRead(filePath);
  if (!data) {
    // single page app: fall back to index.html
    if (path.extname(filePath)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    data = await safeRead(INDEX);
  }

  res.writeHead(200, {
    "content-type": mime(filePath),
    // Dev: do not cache to let Studio pick up new schemas immediately
    "cache-control": "no-store",
  });
  res.end(data);
}

// ---------- boot ----------
const server = http.createServer(serveStatic);

server.listen(PORT, () => {
  console.log(`AllezORM dev server running at http://localhost:${PORT}`);
  console.log(`Serving from ${ROOT}`);
  const [schemasDir, schemasCliDir] = SCHEMA_DIRS;
  console.log(`Schemas dir: ${schemasDir} ${exists(schemasDir) ? "" : "(missing)"}`);
  console.log(`Schemas CLI dir: ${schemasCliDir} ${exists(schemasCliDir) ? "" : "(missing)"}`);
});
