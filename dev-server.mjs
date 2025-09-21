// dev-server.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const PORT = 5173;

function send(res, code, body, headers = {}) {
  const b = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    ...headers,
  });
  res.end(b);
}
function notFound(res) { send(res, 404, "Not found"); }

async function listSchemas() {
  const dir = path.join(ROOT, "schemas");
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => /\.schema\.(js|ts)$/.test(f));
  const out = [];
  for (const f of files) {
    const p = path.join(dir, f);
    const u = pathToFileURL(p).href;
    // Dynamic-import each schema module and take default export
    const mod = await import(u + `?t=${Date.now()}`); // cache-bust in dev
    const s = mod.default;
    out.push({ table: s.table, version: s.version, createSQL: s.createSQL, extraSQL: s.extraSQL || [] });
  }
  return out;
}

function guessType(p) {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".svg")) return "image/svg+xml";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".json")) return "application/json";
  return "text/plain; charset=utf-8";
}

// Patch schema: insert column line inside CREATE TABLE block
function patchSchemaAddColumn({ table, columnSQL, extraIndexSQL }) {
  const file = path.join(ROOT, "schemas", `${table}.schema.js`);
  if (!fs.existsSync(file)) throw new Error(`Schema not found: ${file}`);
  let src = fs.readFileSync(file, "utf8");

  // Add column inside createSQL before closing ");
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\(([\\s\\S]*?)\\);`);
  const m = src.match(re);
  if (!m) throw new Error(`CREATE TABLE block not found for ${table} in schema`);
  const before = m[0];
  const body = m[1].trimEnd();
  const needsComma = !body.trim().endsWith(",");
  const bodyNew = body + (needsComma ? ",\n" : "\n") + "      " + columnSQL;
  const replaced = before.replace(m[1], bodyNew);
  src = src.replace(before, replaced);

  if (extraIndexSQL && extraIndexSQL.trim()) {
    // Insert into extraSQL array before closing ]
    src = src.replace(/extraSQL:\s*\[/, match => `${match}\n    \`${extraIndexSQL}\`,`);
  }

  fs.writeFileSync(file, src, "utf8");
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new url.URL(req.url, `http://localhost:${PORT}`);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type"
      });
      return res.end();
    }

    // API routes
    if (u.pathname === "/api/schemas" && req.method === "GET") {
      const schemas = await listSchemas();
      return send(res, 200, { schemas });
    }

    if (u.pathname === "/api/cli" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => body += c);
      req.on("end", () => {
        const { args = [] } = JSON.parse(body || "{}");
        const child = spawn(process.execPath, [path.join(ROOT, "tools", "allez-orm.mjs"), ...args], {
          cwd: ROOT,
          env: { ...process.env, ALLEZ_FORCE: "1" }, // make overwrites easy in dev
          stdio: ["ignore", "pipe", "pipe"]
        });
        let out = "", err = "";
        child.stdout.on("data", d => out += d);
        child.stderr.on("data", d => err += d);
        child.on("close", code => send(res, 200, { code, out, err }));
      });
      return;
    }

    if (u.pathname === "/api/schema/add-column" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => body += c);
      req.on("end", () => {
        try {
          const { table, columnSQL, extraIndexSQL } = JSON.parse(body || "{}");
          if (!table || !columnSQL) return send(res, 400, { error: "table and columnSQL required" });
          patchSchemaAddColumn({ table, columnSQL, extraIndexSQL });
          return send(res, 200, { ok: true });
        } catch (e) {
          return send(res, 500, { error: String(e?.message || e) });
        }
      });
      return;
    }

    // Static files
    let filePath = path.join(ROOT, decodeURIComponent(u.pathname));
    if (u.pathname === "/") filePath = path.join(ROOT, "index.html");
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!fs.existsSync(filePath)) return notFound(res);
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      "content-type": guessType(filePath),
      "cache-control": "no-cache, no-store"
    });
    res.end(data);
  } catch (e) {
    send(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n   Serving on http://localhost:${PORT}\n`);
});
