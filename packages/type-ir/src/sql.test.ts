import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
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
    expect(toSqlDdl(t(types.int32))).toEqual({ type: "INTEGER", nullable: false })
  })

  test("int64", () => {
    expect(toSqlDdl(t(types.int64))).toEqual({ type: "BIGINT", nullable: false })
  })

  test("float32", () => {
    expect(toSqlDdl(t(types.float32))).toEqual({ type: "REAL", nullable: false })
  })

  test("float64", () => {
    expect(toSqlDdl(t(types.float64))).toEqual({ type: "DOUBLE PRECISION", nullable: false })
  })

  test("string", () => {
    expect(toSqlDdl(t(types.string))).toEqual({ type: "TEXT", nullable: false })
  })

  test("uuid", () => {
    expect(toSqlDdl(t(types.uuid))).toEqual({ type: "UUID", nullable: false })
  })

  test("uri", () => {
    expect(toSqlDdl(t(types.uri))).toEqual({ type: "TEXT", nullable: false })
  })

  test("datetime", () => {
    expect(toSqlDdl(t(types.datetime))).toEqual({ type: "TIMESTAMPTZ", nullable: false })
  })

  test("date", () => {
    expect(toSqlDdl(t(types.date))).toEqual({ type: "DATE", nullable: false })
  })

  test("time", () => {
    expect(toSqlDdl(t(types.time))).toEqual({ type: "TIME", nullable: false })
  })

  test("duration", () => {
    expect(toSqlDdl(t(types.duration))).toEqual({ type: "INTERVAL", nullable: false })
  })

  test("bytes", () => {
    expect(toSqlDdl(t(types.bytes))).toEqual({ type: "BYTEA", nullable: false })
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
    expect(toSqlDdl(t(types.uuid), { dialect: "sqlite" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("datetime", () => {
    expect(toSqlDdl(t(types.datetime), { dialect: "sqlite" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("date", () => {
    expect(toSqlDdl(t(types.date), { dialect: "sqlite" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("time", () => {
    expect(toSqlDdl(t(types.time), { dialect: "sqlite" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("duration", () => {
    expect(toSqlDdl(t(types.duration), { dialect: "sqlite" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("bytes", () => {
    expect(toSqlDdl(t(types.bytes), { dialect: "sqlite" })).toEqual({ type: "BLOB", nullable: false })
  })

  test("int64", () => {
    expect(toSqlDdl(t(types.int64), { dialect: "sqlite" })).toEqual({ type: "INTEGER", nullable: false })
  })

  test("float32", () => {
    expect(toSqlDdl(t(types.float32), { dialect: "sqlite" })).toEqual({ type: "REAL", nullable: false })
  })

  test("float64", () => {
    expect(toSqlDdl(t(types.float64), { dialect: "sqlite" })).toEqual({ type: "REAL", nullable: false })
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
    expect(toSqlDdl(t(types.int32), { dialect: "mysql" })).toEqual({ type: "INT", nullable: false })
  })

  test("int64", () => {
    expect(toSqlDdl(t(types.int64), { dialect: "mysql" })).toEqual({ type: "BIGINT", nullable: false })
  })

  test("float32", () => {
    expect(toSqlDdl(t(types.float32), { dialect: "mysql" })).toEqual({ type: "FLOAT", nullable: false })
  })

  test("float64", () => {
    expect(toSqlDdl(t(types.float64), { dialect: "mysql" })).toEqual({ type: "DOUBLE", nullable: false })
  })

  test("string", () => {
    expect(toSqlDdl(t(types.string), { dialect: "mysql" })).toEqual({ type: "VARCHAR(255)", nullable: false })
  })

  test("uuid", () => {
    expect(toSqlDdl(t(types.uuid), { dialect: "mysql" })).toEqual({ type: "CHAR(36)", nullable: false })
  })

  test("uri", () => {
    expect(toSqlDdl(t(types.uri), { dialect: "mysql" })).toEqual({ type: "TEXT", nullable: false })
  })

  test("datetime", () => {
    expect(toSqlDdl(t(types.datetime), { dialect: "mysql" })).toEqual({ type: "DATETIME", nullable: false })
  })

  test("date", () => {
    expect(toSqlDdl(t(types.date), { dialect: "mysql" })).toEqual({ type: "DATE", nullable: false })
  })

  test("time", () => {
    expect(toSqlDdl(t(types.time), { dialect: "mysql" })).toEqual({ type: "TIME", nullable: false })
  })

  test("duration", () => {
    expect(toSqlDdl(t(types.duration), { dialect: "mysql" })).toEqual({ type: "VARCHAR(255)", nullable: false })
  })

  test("bytes", () => {
    expect(toSqlDdl(t(types.bytes), { dialect: "mysql" })).toEqual({ type: "BLOB", nullable: false })
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
        id: t(types.uuid),
        name: t(types.string),
        nickname: t(types.string, { nullable: true }),
        age: t(types.int32, { default: 0 }),
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
        id: t(types.uuid),
        name: t(types.string),
        nickname: t(types.string, { nullable: true }),
        age: t(types.int32, { default: 0 }),
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
