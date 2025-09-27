/**
 * Simple DDL auditor for Allez ORM schemas.
 * - Detects forbidden patterns for SQLite (e.g., ALTER TABLE ... ADD FOREIGN KEY ...)
 * - Suggests inline FK form
 */

export function auditCreateSQL(createSQL = "") {
  const problems = [];

  const badFk = /\bALTER\s+TABLE\b[^;]+ADD\s+FOREIGN\s+KEY/i;
  if (badFk.test(createSQL)) {
    problems.push({
      rule: "sqlite.inline_fk",
      message:
        "SQLite does not support `ALTER TABLE ... ADD FOREIGN KEY`. Put `REFERENCES target(id)` on the column inside CREATE TABLE.",
      fix: "Move the FK to the column definition:  col TYPE REFERENCES other(id) [ON DELETE ...]"
    });
  }

  return problems;
}

export function assertClean(createSQL = "") {
  const issues = auditCreateSQL(createSQL);
  if (issues.length) {
    const msg = issues.map(i => `• ${i.message}\n  → ${i.fix}`).join("\n");
    throw new Error(`DDL audit failed:\n${msg}`);
  }
  return true;
}
