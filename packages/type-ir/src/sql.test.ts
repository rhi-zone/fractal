import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { bytes, date, datetime, duration, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { columnDef, toCreateTable, toSqlDdl } from "./sql.ts"

describe("leaf types (postgres)", () => {
  test("boolean", () => {
    expect(toSqlDdl(t(types.boolean))).toEqual({ type: "BOOLEAN", nullable: false })
  })

  test("number", () => {
    expect(toSqlDdl(t(types.number))).toEqual({ type: "DOUBLE PRECISION", nullable: false })
  })

  test("integer", () => {
    expect(toSqlDdl(t(types.integer))).toEqual({ type: "INTEGER", nullable: false })
  })

  test("int32", () => {
    expect(toSqlDdl(int32())).toEqual({ type: "INTEGER", nullable: false })
  })

  test("int64", () => {
    expect(toSqlDdl(int64())).toEqual({ type: "BIGINT", nullable: false })
  })

  test("float32", () => {
    expect(toSqlDdl(float32())).toEqual({ type: "REAL", nullable: false })
  })

  test("float64", () => {
    expect(toSqlDdl(float64())).toEqual({ type: "DOUBLE PRECISION", nullable: false })
  })

  test("string", () => {
    expect(toSqlDdl(t(types.string))).toEqual({ type: "TEXT", nullable: false })
  })

  test("uuid", () => {
    expect(toSqlDdl(uuid())).toEqual({ type: "UUID", nullable: false })
  })

  test("uri", () => {
    expect(toSqlDdl(uri())).toEqual({ type: "TEXT", nullable: false })
  })

  test("datetime", () => {
    expect(toSqlDdl(datetime())).toEqual({ type: "TIMESTAMPTZ", nullable: false })
  })

  test("date", () => {
    expect(toSqlDdl(date())).toEqual({ type: "DATE", nullable: false })
  })

  test("time", () => {
    expect(toSqlDdl(time())).toEqual({ type: "TIME", nullable: false })
  })

  test("duration", () => {
    expect(toSqlDdl(duration())).toEqual({ type: "INTERVAL", nullable: false })
  })

  test("bytes", () => {
    expect(toSqlDdl(bytes())).toEqual({ type: "BYTEA", nullable: false })
  })

  test("null", () => {
    expect(toSqlDdl(t(types.null))).toEqual({ type: "TEXT", nullable: false })
  })

  test("void", () => {
    expect(toSqlDdl(t(types.void))).toEqual({ type: "TEXT", nullable: false })
  })

  test("unknown", () => {
    expect(toSqlDdl(t(types.unknown))).toEqual({ type: "JSONB", nullable: false })
  })

  test("never", () => {
    expect(toSqlDdl(t(types.never))).toEqual({ type: "TEXT", nullable: false })
  })

  test("enum", () => {
    expect(toSqlDdl(t(types.enum(["a", "b"])))).toEqual({ type: "TEXT", nullable: false })
  })

  test("ref", () => {
    expect(toSqlDdl(t(types.ref("User")))).toEqual({ type: "TEXT", nullable: false })
  })
})

describe("literal types", () => {
  test("string literal", () => {
    expect(toSqlDdl(t(types.literal("active")))).toEqual({ type: "TEXT", nullable: false })
  })

  test("number literal", () => {
    expect(toSqlDdl(t(types.literal(1)))).toEqual({ type: "NUMERIC", nullable: false })
  })

  test("boolean literal", () => {
    expect(toSqlDdl(t(types.literal(true)))).toEqual({ type: "BOOLEAN", nullable: false })
  })

  test("null literal", () => {
    expect(toSqlDdl(t(types.literal(null)))).toEqual({ type: "TEXT", nullable: false })
  })
})

describe("complex types (postgres)", () => {
  test("object", () => {
    expect(toSqlDdl(t(types.object({ name: t(types.string) })))).toEqual({ type: "JSONB", nullable: false })
  })

  test("array", () => {
    expect(toSqlDdl(t(types.array(t(types.string))))).toEqual({ type: "JSONB", nullable: false })
  })

  test("tuple", () => {
    expect(toSqlDdl(t(types.tuple([t(types.string), t(types.integer)])))).toEqual({
      type: "JSONB",
      nullable: false,
    })
  })

  test("map", () => {
    expect(toSqlDdl(t(types.map(t(types.string), t(types.number))))).toEqual({ type: "JSONB", nullable: false })
  })

  test("union", () => {
    expect(toSqlDdl(t(types.union([t(types.string), t(types.integer)])))).toEqual({
      type: "JSONB",
      nullable: false,
    })
  })
})

describe("metadata", () => {
  test("nullable", () => {
    expect(toSqlDdl(t(types.string, { nullable: true }))).toEqual({ type: "TEXT", nullable: true })
  })

  test("string default", () => {
    expect(toSqlDdl(t(types.string, { default: "hi" }))).toEqual({
      type: "TEXT",
      nullable: false,
      default: "'hi'",
    })
  })

  test("string default escapes quotes", () => {
    expect(toSqlDdl(t(types.string, { default: "o'clock" }))).toEqual({
      type: "TEXT",
      nullable: false,
      default: "'o''clock'",
    })
  })

  test("number default", () => {
    expect(toSqlDdl(t(types.integer, { default: 0 }))).toEqual({
      type: "INTEGER",
      nullable: false,
      default: "0",
    })
  })

  test("boolean default", () => {
    expect(toSqlDdl(t(types.boolean, { default: false }))).toEqual({
      type: "BOOLEAN",
      nullable: false,
      default: "false",
    })
  })

  test("null default", () => {
    expect(toSqlDdl(t(types.string, { default: null }))).toEqual({
      type: "TEXT",
      nullable: false,
      default: "NULL",
    })
  })
})

describe("sqlite dialect overrides", () => {
  test("uuid", () => {
    expect(toSqlDdl(uuid(), { dialect: "sqlite" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("datetime", () => {
    expect(toSqlDdl(datetime(), { dialect: "sqlite" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("date", () => {
    expect(toSqlDdl(date(), { dialect: "sqlite" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("time", () => {
    expect(toSqlDdl(time(), { dialect: "sqlite" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("duration", () => {
    expect(toSqlDdl(duration(), { dialect: "sqlite" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("bytes", () => {
    expect(toSqlDdl(bytes(), { dialect: "sqlite" })).toEqual({ type: "BLOB", nullable: false })
  })

  test("int64", () => {
    expect(toSqlDdl(int64(), { dialect: "sqlite" })).toEqual({ type: "INTEGER", nullable: false })
  })

  test("float32", () => {
    expect(toSqlDdl(float32(), { dialect: "sqlite" })).toEqual({ type: "REAL", nullable: false })
  })

  test("float64", () => {
    expect(toSqlDdl(float64(), { dialect: "sqlite" })).toEqual({ type: "REAL", nullable: false })
  })

  test("object", () => {
    expect(toSqlDdl(t(types.object({ a: t(types.string) })), { dialect: "sqlite" })).toEqual({
      type: "TEXT",
      nullable: false,
    })
  })

  test("array", () => {
    expect(toSqlDdl(t(types.array(t(types.string))), { dialect: "sqlite" })).toEqual({
      type: "TEXT",
      nullable: false,
    })
  })

  test("unknown", () => {
    expect(toSqlDdl(t(types.unknown), { dialect: "sqlite" })).toEqual({ type: "TEXT", nullable: false })
  })
})

describe("mysql dialect", () => {
  test("boolean", () => {
    expect(toSqlDdl(t(types.boolean), { dialect: "mysql" })).toEqual({ type: "TINYINT(1)", nullable: false })
  })

  test("number", () => {
    expect(toSqlDdl(t(types.number), { dialect: "mysql" })).toEqual({ type: "DOUBLE", nullable: false })
  })

  test("integer", () => {
    expect(toSqlDdl(t(types.integer), { dialect: "mysql" })).toEqual({ type: "INT", nullable: false })
  })

  test("int32", () => {
    expect(toSqlDdl(int32(), { dialect: "mysql" })).toEqual({ type: "INT", nullable: false })
  })

  test("int64", () => {
    expect(toSqlDdl(int64(), { dialect: "mysql" })).toEqual({ type: "BIGINT", nullable: false })
  })

  test("float32", () => {
    expect(toSqlDdl(float32(), { dialect: "mysql" })).toEqual({ type: "FLOAT", nullable: false })
  })

  test("float64", () => {
    expect(toSqlDdl(float64(), { dialect: "mysql" })).toEqual({ type: "DOUBLE", nullable: false })
  })

  test("string", () => {
    expect(toSqlDdl(t(types.string), { dialect: "mysql" })).toEqual({ type: "VARCHAR(255)", nullable: false })
  })

  test("uuid", () => {
    expect(toSqlDdl(uuid(), { dialect: "mysql" })).toEqual({ type: "CHAR(36)", nullable: false })
  })

  test("uri", () => {
    expect(toSqlDdl(uri(), { dialect: "mysql" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("datetime", () => {
    expect(toSqlDdl(datetime(), { dialect: "mysql" })).toEqual({ type: "DATETIME", nullable: false })
  })

  test("date", () => {
    expect(toSqlDdl(date(), { dialect: "mysql" })).toEqual({ type: "DATE", nullable: false })
  })

  test("time", () => {
    expect(toSqlDdl(time(), { dialect: "mysql" })).toEqual({ type: "TIME", nullable: false })
  })

  test("duration", () => {
    expect(toSqlDdl(duration(), { dialect: "mysql" })).toEqual({ type: "VARCHAR(255)", nullable: false })
  })

  test("bytes", () => {
    expect(toSqlDdl(bytes(), { dialect: "mysql" })).toEqual({ type: "BLOB", nullable: false })
  })

  test("null", () => {
    expect(toSqlDdl(t(types.null), { dialect: "mysql" })).toEqual({ type: "TINYINT(1)", nullable: false })
  })

  test("unknown", () => {
    expect(toSqlDdl(t(types.unknown), { dialect: "mysql" })).toEqual({ type: "JSON", nullable: false })
  })

  test("object", () => {
    expect(toSqlDdl(t(types.object({ a: t(types.string) })), { dialect: "mysql" })).toEqual({
      type: "JSON",
      nullable: false,
    })
  })

  test("array", () => {
    expect(toSqlDdl(t(types.array(t(types.string))), { dialect: "mysql" })).toEqual({
      type: "JSON",
      nullable: false,
    })
  })

  test("map", () => {
    expect(toSqlDdl(t(types.map(t(types.string), t(types.number))), { dialect: "mysql" })).toEqual({
      type: "JSON",
      nullable: false,
    })
  })

  test("union", () => {
    expect(toSqlDdl(t(types.union([t(types.string), t(types.integer)])), { dialect: "mysql" })).toEqual({
      type: "JSON",
      nullable: false,
    })
  })

  test("enum", () => {
    expect(toSqlDdl(t(types.enum(["a", "b"])), { dialect: "mysql" })).toEqual({
      type: "ENUM('a', 'b')",
      nullable: false,
    })
  })

  test("boolean literal", () => {
    expect(toSqlDdl(t(types.literal(true)), { dialect: "mysql" })).toEqual({ type: "TINYINT(1)", nullable: false })
  })

  test("number literal", () => {
    expect(toSqlDdl(t(types.literal(1)), { dialect: "mysql" })).toEqual({ type: "NUMERIC", nullable: false })
  })

  test("string literal", () => {
    expect(toSqlDdl(t(types.literal("active")), { dialect: "mysql" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("ref", () => {
    expect(toSqlDdl(t(types.ref("User")), { dialect: "mysql" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("toCreateTable builds full table DDL", () => {
    const ref = t(
      types.object({
        id: uuid(),
        name: t(types.string),
        nickname: t(types.string, { nullable: true }),
        age: int32({ default: 0 }),
      }),
    )
    expect(toCreateTable("users", ref, { dialect: "mysql" })).toBe(
      "CREATE TABLE users (\n" +
        "  id CHAR(36) NOT NULL,\n" +
        "  name VARCHAR(255) NOT NULL,\n" +
        "  nickname VARCHAR(255),\n" +
        "  age INT NOT NULL DEFAULT 0\n" +
        ");",
    )
  })
})

describe("columnDef", () => {
  test("not null column", () => {
    expect(columnDef("name", { type: "TEXT", nullable: false })).toBe("name TEXT NOT NULL")
  })

  test("nullable column", () => {
    expect(columnDef("nickname", { type: "TEXT", nullable: true })).toBe("nickname TEXT")
  })

  test("with default", () => {
    expect(columnDef("count", { type: "INTEGER", nullable: false, default: "0" })).toBe(
      "count INTEGER NOT NULL DEFAULT 0",
    )
  })
})

describe("toCreateTable", () => {
  test("builds full table DDL", () => {
    const ref = t(
      types.object({
        id: uuid(),
        name: t(types.string),
        nickname: t(types.string, { nullable: true }),
        age: int32({ default: 0 }),
      }),
    )
    expect(toCreateTable("users", ref)).toBe(
      "CREATE TABLE users (\n" +
        "  id UUID NOT NULL,\n" +
        "  name TEXT NOT NULL,\n" +
        "  nickname TEXT,\n" +
        "  age INTEGER NOT NULL DEFAULT 0\n" +
        ");",
    )
  })

  test("throws for non-object type", () => {
    expect(() => toCreateTable("users", t(types.string))).toThrow()
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toSqlDdl(ref)).toEqual({ type: "INTEGER", nullable: false })
  })
})

describe("unrecognized metadata (open metadata bag)", () => {
  test("meta.brand is silently ignored — projects to the base type's column", () => {
    expect(toSqlDdl(t(types.string, { brand: "LocationId" }))).toEqual({
      type: "TEXT",
      nullable: false,
    })
  })
})

describe("CHECK constraints from metadata", () => {
  test("numeric minimum/maximum", () => {
    expect(toSqlDdl(int32({ minimum: 0, maximum: 100 }))).toEqual({
      type: "INTEGER",
      nullable: false,
      checks: ["CHECK ({name} >= 0)", "CHECK ({name} <= 100)"],
    })
  })

  test("exclusiveMinimum/exclusiveMaximum", () => {
    expect(toSqlDdl(t(types.number, { exclusiveMinimum: 0, exclusiveMaximum: 1 }))).toEqual({
      type: "DOUBLE PRECISION",
      nullable: false,
      checks: ["CHECK ({name} > 0)", "CHECK ({name} < 1)"],
    })
  })

  test("string minLength/maxLength", () => {
    expect(toSqlDdl(t(types.string, { minLength: 1, maxLength: 50 }))).toEqual({
      type: "TEXT",
      nullable: false,
      checks: ["CHECK (LENGTH({name}) >= 1)", "CHECK (LENGTH({name}) <= 50)"],
    })
  })

  test("multipleOf", () => {
    expect(toSqlDdl(t(types.integer, { multipleOf: 5 }))).toEqual({
      type: "INTEGER",
      nullable: false,
      checks: ["CHECK ({name} % 5 = 0)"],
    })
  })

  test("pattern (postgres uses ~)", () => {
    expect(toSqlDdl(t(types.string, { pattern: "^[a-z]+$" }))).toEqual({
      type: "TEXT",
      nullable: false,
      checks: ["CHECK ({name} ~ '^[a-z]+$')"],
    })
  })

  test("pattern (mysql uses REGEXP)", () => {
    expect(toSqlDdl(t(types.string, { pattern: "^[a-z]+$" }), { dialect: "mysql" })).toEqual({
      type: "VARCHAR(255)",
      nullable: false,
      checks: ["CHECK ({name} REGEXP '^[a-z]+$')"],
    })
  })

  test("pattern is skipped for sqlite (no native regex)", () => {
    expect(toSqlDdl(t(types.string, { pattern: "^[a-z]+$" }), { dialect: "sqlite" })).toEqual({
      type: "TEXT",
      nullable: false,
    })
  })

  test("non-numeric/non-string kinds ignore numeric/string constraints", () => {
    expect(toSqlDdl(t(types.boolean, { minimum: 0, minLength: 1 }))).toEqual({
      type: "BOOLEAN",
      nullable: false,
    })
  })

  test("combined constraints", () => {
    expect(toSqlDdl(int32({ minimum: 0, maximum: 100, multipleOf: 5 }))).toEqual({
      type: "INTEGER",
      nullable: false,
      checks: ["CHECK ({name} >= 0)", "CHECK ({name} <= 100)", "CHECK ({name} % 5 = 0)"],
    })
  })
})

describe("description metadata → comment", () => {
  test("postgres uses a block comment", () => {
    expect(toSqlDdl(t(types.string, { description: "the user's handle" }))).toEqual({
      type: "TEXT",
      nullable: false,
      comment: "/* the user's handle */",
    })
  })

  test("mysql uses native inline COMMENT", () => {
    expect(toSqlDdl(t(types.string, { description: "the user's handle" }), { dialect: "mysql" })).toEqual({
      type: "VARCHAR(255)",
      nullable: false,
      comment: "COMMENT 'the user''s handle'",
    })
  })

  test("sqlite uses a block comment", () => {
    expect(toSqlDdl(t(types.string, { description: "note" }), { dialect: "sqlite" })).toEqual({
      type: "TEXT",
      nullable: false,
      comment: "/* note */",
    })
  })
})

describe("columnDef renders checks and comments", () => {
  test("substitutes {name} into check clauses", () => {
    expect(columnDef("age", toSqlDdl(int32({ minimum: 0, maximum: 130 })))).toBe(
      "age INTEGER NOT NULL CHECK (age >= 0) CHECK (age <= 130)",
    )
  })

  test("appends comment after checks", () => {
    expect(
      columnDef(
        "age",
        toSqlDdl(int32({ minimum: 0, description: "age in years" })),
      ),
    ).toBe("age INTEGER NOT NULL CHECK (age >= 0) /* age in years */")
  })

  test("mysql: comment renders as native COMMENT clause", () => {
    expect(
      columnDef("name", toSqlDdl(t(types.string, { description: "display name" }), { dialect: "mysql" })),
    ).toBe("name VARCHAR(255) NOT NULL COMMENT 'display name'")
  })

  test("toCreateTable: comma is preserved, not swallowed by the comment", () => {
    const ref = t(
      types.object({
        id: uuid(),
        age: int32({ minimum: 0, description: "age in years" }),
      }),
    )
    expect(toCreateTable("users", ref)).toBe(
      "CREATE TABLE users (\n" +
        "  id UUID NOT NULL,\n" +
        "  age INTEGER NOT NULL CHECK (age >= 0) /* age in years */\n" +
        ");",
    )
  })
})

describe("function", () => {
  test("degrades to the opaque-data column type per dialect (not persistable)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toSqlDdl(ref)).toEqual({ type: "JSONB", nullable: false })
    expect(toSqlDdl(ref, { dialect: "sqlite" })).toEqual({ type: "TEXT", nullable: false })
    expect(toSqlDdl(ref, { dialect: "mysql" })).toEqual({ type: "JSON", nullable: false })
  })
})

describe("stream", () => {
  test("degrades the same as array, not persistable as an ongoing sequence", () => {
    const ref = t(types.stream(t(types.string)))
    expect(toSqlDdl(ref)).toEqual({ type: "JSONB", nullable: false })
    expect(toSqlDdl(ref, { dialect: "sqlite" })).toEqual({ type: "TEXT", nullable: false })
    expect(toSqlDdl(ref, { dialect: "mysql" })).toEqual({ type: "JSON", nullable: false })
  })
})
