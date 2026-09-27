/**
 * data-copy-as.spec.ts
 *
 * TDD spec — written before the implementation.
 * Runs with: vitest (or node --experimental-strip-types for standalone verify)
 *
 * Coverage matrix
 * ─────────────────────────────────────────────────────────────────
 * sqlLiteral    : null, undefined, number, bigint, boolean, string,
 *                 injection payload, nested object
 * quoteIdent    : normal, embedded double-quote, empty → throws
 * rowToInsert   : column order, mixed types, single-column
 * rowToUpdateByPk : single PK, composite PK, missing PK → throws,
 *                   PK-only row (no non-PK cols)
 * rowToJson     : pretty-print, nested object
 * rowsToMarkdown : happy path, pipe escape, newline escape, NULL cell,
 *                  empty rows array
 * ─────────────────────────────────────────────────────────────────
 */

import { describe, it, expect } from "vitest";
import {
  sqlLiteral,
  quoteIdent,
  rowToInsert,
  rowToUpdateByPk,
  rowToJson,
  rowsToMarkdown,
  type Row,
} from "./data-copy-as.js";

// ──────────────────────────────────────────────────────────────────
// sqlLiteral
// ──────────────────────────────────────────────────────────────────
describe("sqlLiteral", () => {
  it("returns NULL for null", () => {
    expect(sqlLiteral(null)).toBe("NULL");
  });

  it("returns NULL for undefined", () => {
    expect(sqlLiteral(undefined)).toBe("NULL");
  });

  it("returns bare number for integer", () => {
    expect(sqlLiteral(42)).toBe("42");
  });

  it("returns bare number for float", () => {
    expect(sqlLiteral(3.14)).toBe("3.14");
  });

  it("returns bare number for negative", () => {
    expect(sqlLiteral(-7)).toBe("-7");
  });

  it("returns bare number for bigint", () => {
    expect(sqlLiteral(9007199254740993n)).toBe("9007199254740993");
  });

  it("returns 1 for true", () => {
    expect(sqlLiteral(true)).toBe("1");
  });

  it("returns 0 for false", () => {
    expect(sqlLiteral(false)).toBe("0");
  });

  it("wraps plain string in single quotes", () => {
    expect(sqlLiteral("hello")).toBe("'hello'");
  });

  it("doubles single-quotes inside a string (SQL injection safety)", () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it("escapes a classic injection payload", () => {
    // The value  x'); DROP TABLE users; --
    // must appear inside valid SQL quotes on the clipboard
    const payload = "x'); DROP TABLE users; --";
    const lit = sqlLiteral(payload);
    // Must start and end with a single-quote (it is a string literal)
    expect(lit.startsWith("'")).toBe(true);
    expect(lit.endsWith("'")).toBe(true);
    // Internal single-quotes must be doubled
    expect(lit).toBe("'x''); DROP TABLE users; --'");
    // Result must NOT contain an unescaped '); sequence outside the outer quotes
    const inner = lit.slice(1, -1);
    expect(inner).not.toMatch(/(?<!')'(?!')/); // no lone apostrophe in the body
  });

  it("serialises a plain object to a JSON-quoted string", () => {
    expect(sqlLiteral({ a: 1 })).toBe("'{\"a\":1}'");
  });

  it("serialises a nested object, escaping its single-quotes", () => {
    // JSON.stringify never produces single-quotes, so no doubling needed here —
    // but the string must still be wrapped in single-quotes.
    const result = sqlLiteral({ key: "value", nested: [1, 2] });
    expect(result).toBe("'{\"key\":\"value\",\"nested\":[1,2]}'");
  });

  it("handles empty string", () => {
    expect(sqlLiteral("")).toBe("''");
  });

  it("handles string with only single-quotes", () => {
    // "'''" has 3 apostrophes; each doubles to '' → "''''''"; outer quotes add 2 more → "''''''''"
    // inner content: 3 × '' = 6 chars; wrapped: '......' = 8 chars total
    expect(sqlLiteral("'''")).toBe("''''''''");
  });
});

// ──────────────────────────────────────────────────────────────────
// quoteIdent
// ──────────────────────────────────────────────────────────────────
describe("quoteIdent", () => {
  it("wraps a simple identifier in double-quotes", () => {
    expect(quoteIdent("users")).toBe('"users"');
  });

  it("doubles embedded double-quotes", () => {
    expect(quoteIdent('say "hi"')).toBe('"say ""hi"""');
  });

  it("handles a name with spaces", () => {
    expect(quoteIdent("my table")).toBe('"my table"');
  });

  it("throws RangeError on empty string", () => {
    expect(() => quoteIdent("")).toThrow(RangeError);
  });
});

// ──────────────────────────────────────────────────────────────────
// rowToInsert
// ──────────────────────────────────────────────────────────────────
describe("rowToInsert", () => {
  it("produces a correct INSERT for mixed types", () => {
    const row: Row = { id: 1, name: "Alice", active: true, score: null };
    expect(rowToInsert("users", row)).toBe(
      `INSERT INTO "users" ("id","name","active","score") VALUES (1,'Alice',1,NULL);`
    );
  });

  it("preserves column order from the row object", () => {
    const row: Row = { z: 3, a: 1, m: 2 };
    const sql = rowToInsert("t", row);
    const colSection = sql.match(/\(([^)]+)\)/)?.[1] ?? "";
    expect(colSection).toBe('"z","a","m"');
  });

  it("handles a single-column row", () => {
    expect(rowToInsert("log", { msg: "hi" })).toBe(
      `INSERT INTO "log" ("msg") VALUES ('hi');`
    );
  });

  it("quotes the table name", () => {
    expect(rowToInsert("my table", { id: 1 })).toMatch(/^INSERT INTO "my table"/);
  });

  it("escapes injection in a string value", () => {
    const row: Row = { id: 1, name: "x'); DROP TABLE t;--" };
    const sql = rowToInsert("t", row);
    // The dangerous string must be safely quoted
    expect(sql).toContain("'x''); DROP TABLE t;--'");
  });
});

// ──────────────────────────────────────────────────────────────────
// rowToUpdateByPk
// ──────────────────────────────────────────────────────────────────
describe("rowToUpdateByPk", () => {
  it("produces a correct UPDATE for a single PK", () => {
    const row: Row = { id: 1, name: "Bob", email: "bob@example.com" };
    expect(rowToUpdateByPk("users", row, ["id"])).toBe(
      `UPDATE "users" SET "name"='Bob',"email"='bob@example.com' WHERE "id"=1;`
    );
  });

  it("handles a composite PK", () => {
    const row: Row = { org_id: 10, user_id: 20, role: "admin" };
    expect(rowToUpdateByPk("memberships", row, ["org_id", "user_id"])).toBe(
      `UPDATE "memberships" SET "role"='admin' WHERE "org_id"=10 AND "user_id"=20;`
    );
  });

  it("throws RangeError when a PK column is missing from the row", () => {
    const row: Row = { name: "Charlie" };
    expect(() => rowToUpdateByPk("users", row, ["id"])).toThrow(RangeError);
  });

  it("throws RangeError for each missing PK column individually", () => {
    const row: Row = { org_id: 1, name: "test" };
    expect(() =>
      rowToUpdateByPk("m", row, ["org_id", "user_id"])
    ).toThrow(/user_id/);
  });

  it("handles PK-only row (no non-PK columns) without error", () => {
    // Produces a no-op SET with the PK value itself
    const row: Row = { id: 5 };
    const sql = rowToUpdateByPk("t", row, ["id"]);
    expect(sql).toMatch(/^UPDATE "t" SET "id"=5 WHERE "id"=5;$/);
  });

  it("correctly sets NULL in a non-PK column", () => {
    const row: Row = { id: 1, deleted_at: null };
    expect(rowToUpdateByPk("t", row, ["id"])).toBe(
      `UPDATE "t" SET "deleted_at"=NULL WHERE "id"=1;`
    );
  });

  it("handles boolean in non-PK column", () => {
    const row: Row = { id: 1, active: false };
    expect(rowToUpdateByPk("t", row, ["id"])).toBe(
      `UPDATE "t" SET "active"=0 WHERE "id"=1;`
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// rowToJson
// ──────────────────────────────────────────────────────────────────
describe("rowToJson", () => {
  it("pretty-prints with 2-space indent", () => {
    const result = rowToJson({ id: 1, name: "Alice" });
    expect(result).toBe('{\n  "id": 1,\n  "name": "Alice"\n}');
  });

  it("handles nested object", () => {
    const result = rowToJson({ meta: { tags: ["a", "b"] } });
    expect(result).toBe('{\n  "meta": {\n    "tags": [\n      "a",\n      "b"\n    ]\n  }\n}');
  });

  it("handles null values", () => {
    const result = rowToJson({ id: 1, deleted_at: null });
    expect(result).toContain('"deleted_at": null');
  });
});

// ──────────────────────────────────────────────────────────────────
// rowsToMarkdown
// ──────────────────────────────────────────────────────────────────
describe("rowsToMarkdown", () => {
  it("produces a 3-part markdown table (header + separator + rows)", () => {
    const result = rowsToMarkdown(["id", "name"], [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    const lines = result.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("| id | name |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toBe("| 1 | Alice |");
    expect(lines[3]).toBe("| 2 | Bob |");
  });

  it("escapes pipe characters in cell values", () => {
    const result = rowsToMarkdown(["cmd"], [{ cmd: "a|b|c" }]);
    expect(result).toContain("a\\|b\\|c");
  });

  it("replaces newlines in cell values with a space", () => {
    const result = rowsToMarkdown(["note"], [{ note: "line1\nline2" }]);
    expect(result).toContain("line1 line2");
  });

  it("replaces \\r\\n with a single space", () => {
    const result = rowsToMarkdown(["note"], [{ note: "a\r\nb" }]);
    expect(result).toContain("a b");
  });

  it("shows NULL / undefined cells as empty", () => {
    const result = rowsToMarkdown(["id", "deleted_at"], [
      { id: 1, deleted_at: null },
    ]);
    expect(result).toContain("| 1 |  |");
  });

  it("handles empty rows array (header + separator only)", () => {
    const result = rowsToMarkdown(["id"], []);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("| id |");
    expect(lines[1]).toBe("| --- |");
  });

  it("escapes pipe in column header", () => {
    const result = rowsToMarkdown(["a|b"], [{ "a|b": 1 }]);
    const lines = result.split("\n");
    expect(lines[0]).toContain("a\\|b");
  });

  it("handles objects in cells by JSON-serialising them", () => {
    const result = rowsToMarkdown(["data"], [{ data: { x: 1 } }]);
    expect(result).toContain('{"x":1}');
  });

  it("ignores columns not listed in cols", () => {
    const result = rowsToMarkdown(["id"], [{ id: 1, secret: "hidden" }]);
    expect(result).not.toContain("secret");
    expect(result).not.toContain("hidden");
  });
});
