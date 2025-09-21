// tools/ddl-audit.mjs — audit ONLY SQL template strings in schemas for bad tokens
import fs from "node:fs";
import path from "node:path";

const TARGET_DIRS = process.argv.slice(2).length ? process.argv.slice(2) : ["schemas"];

// patterns that should never appear inside SQL we execute
const BAD = [
  {
    name: "dangling-short-flag",
    rx: / [A-Za-z_][A-Za-z0-9_]*! /g, // e.g., "name! " instead of "name TEXT NOT NULL"
    hint: 'Use "NOT NULL" — generator should emit it now.',
  },
  {
    name: "type-suffix-in-sql",
    rx: /:[A-Za-z]+/g,               // e.g., "user_id:text" leaking into SQL
    hint: "Identifiers must not contain :type suffixes — generator should strip them.",
  },
];

function getSqlBlocks(source) {
  // Grab all backticked segments; our schemas put SQL in template literals.
  const blocks = [];
  const re = /`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(source))) {
    blocks.push({ text: m[1], start: m.index + 1 }); // +1 to point inside the backtick
  }
  return blocks;
}

function indexToLineCol(text, idx) {
  // line/col are 1-based
  let line = 1, col = 1;
  for (let i = 0; i < idx; i++) {
    if (text[i] === "\n") { line++; col = 1; }
    else { col++; }
  }
  return { line, col };
}

let totalIssues = 0;

for (const dir of TARGET_DIRS) {
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".js") || f.endsWith(".ts"));
  for (const f of files) {
    const full = path.join(dir, f);
    const src = fs.readFileSync(full, "utf8");
    const blocks = getSqlBlocks(src);
    if (!blocks.length) continue;

    let fileIssues = 0;
    for (const { text, start } of blocks) {
      for (const rule of BAD) {
        rule.rx.lastIndex = 0; // reset global regex
        let m;
        while ((m = rule.rx.exec(text))) {
          const hitIdx = start + m.index; // index in whole file (unused except for future)
          const { line, col } = indexToLineCol(text, m.index);
          const ctxStart = Math.max(0, m.index - 40);
          const ctxEnd = Math.min(text.length, m.index + m[0].length + 40);
          const snippet = text.slice(ctxStart, ctxEnd).replace(/\n/g, "↵");
          if (fileIssues === 0) {
            console.log(`\n✖ ${full}`);
          }
          console.log(
            `  • ${rule.name} at SQL ${line}:${col}  ${rule.hint}\n` +
            `    …${snippet}…`
          );
          fileIssues++;
          totalIssues++;
        }
      }
    }
  }
}

if (totalIssues === 0) {
  console.log("✓ SQL audit: no offending tokens found.");
} else {
  console.error(`\nFound ${totalIssues} offending token(s).`);
  process.exit(1);
}
