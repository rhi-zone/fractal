import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { mssqlColumnDef, toMssqlCreateTable, toMssqlType } from "./sql-mssql.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toMssqlType(t(types.boolean))).toBe("BIT")
  })

  test("number", () => {
    expect(toMssqlType(t(types.number))).toBe("FLOAT")
  })

  test("integer", () => {
    expect(toMssqlType(t(types.integer))).toBe("INT")
  })

  test("int32", () => {
    expect(toMssqlType(t(types.int32))).toBe("INT")
  })

  test("int64", () => {
    expect(toMssqlType(t(types.int64))).toBe("BIGINT")
  })

  test("float32", () => {
    expect(toMssqlType(t(types.float32))).toBe("REAL")
  })

  test("float64", () => {
    expect(toMssqlType(t(types.float64))).toBe("FLOAT")
  })

  test("string", () => {
    expect(toMssqlType(t(types.string))).toBe("NVARCHAR(255)")
  })

  test("uuid", () => {
    expect(toMssqlType(t(types.uuid))).toBe("UNIQUEIDENTIFIER")
  })

  test("uri", () => {
    expect(toMssqlType(t(types.uri))).toBe("NVARCHAR(MAX)")
  })

  test("datetime", () => {
    expect(toMssqlType(t(types.datetime))).toBe("DATETIME2")
  })

  test("date", () => {
    expect(toMssqlType(t(types.date))).toBe("DATE")
  })

  test("time", () => {
    expect(toMssqlType(t(types.time))).toBe("TIME")
  })

  test("duration", () => {
    expect(toMssqlType(t(types.duration))).toBe("NVARCHAR(255)")
  })

  test("bytes", () => {
    expect(toMssqlType(t(types.bytes))).toBe("VARBINARY(MAX)")
  })

  test("null", () => {
    expect(toMssqlType(t(types.null))).toBe("BIT")
  })

  test("void", () => {
    expect(toMssqlType(t(types.void))).toBe("NVARCHAR(255)")
  })

  test("unknown", () => {
    expect(toMssqlType(t(types.unknown))).toBe("NVARCHAR(MAX)")
  })

  test("never", () => {
    expect(toMssqlType(t(types.never))).toBe("NVARCHAR(255)")
  })

  test("enum", () => {
    expect(toMssqlType(t(types.enum(["a", "b"])))).toBe("NVARCHAR(255)")
  })

  test("ref", () => {
    expect(toMssqlType(t(types.ref("User")))).toBe("NVARCHAR(255)")
  })
})

describe("literal types", () => {
  test("string literal", () => {
    expect(toMssqlType(t(types.literal("active")))).toBe("NVARCHAR(255)")
  })

  test("number literal", () => {
    expect(toMssqlType(t(types.literal(1)))).toBe("NUMERIC")
  })

  test("boolean literal", () => {
    expect(toMssqlType(t(types.literal(true)))).toBe("BIT")
  })

  test("null literal", () => {
    expect(toMssqlType(t(types.literal(null)))).toBe("NVARCHAR(255)")
  })
})

describe("complex types", () => {
  test("object", () => {
    expect(toMssqlType(t(types.object({ name: t(types.string) })))).toBe("NVARCHAR(MAX)")
  })

  test("array", () => {
    expect(toMssqlType(t(types.array(t(types.string))))).toBe("NVARCHAR(MAX)")
  })

  test("tuple", () => {
    expect(toMssqlType(t(types.tuple([t(types.string), t(types.integer)])))).toBe("NVARCHAR(MAX)")
  })

  test("map", () => {
    expect(toMssqlType(t(types.map(t(types.string), t(types.number))))).toBe("NVARCHAR(MAX)")
  })

  test("union", () => {
    expect(toMssqlType(t(types.union([t(types.string), t(types.integer)])))).toBe("NVARCHAR(MAX)")
  })
})

describe("mssqlColumnDef", () => {
  test("not null column", () => {
    expect(mssqlColumnDef("name", t(types.string))).toBe("name NVARCHAR(255) NOT NULL")
  })

  test("nullable column", () => {
    expect(mssqlColumnDef("nickname", t(types.string, { nullable: true }))).toBe("nickname NVARCHAR(255) NULL")
  })

  test("with default", () => {
    expect(mssqlColumnDef("count", t(types.integer, { default: 0 }))).toBe("count INT NOT NULL DEFAULT 0")
  })

  test("string default escapes quotes", () => {
    expect(mssqlColumnDef("label", t(types.string, { default: "o'clock" }))).toBe(
      "label NVARCHAR(255) NOT NULL DEFAULT 'o''clock'",
    )
  })

  test("null default", () => {
    expect(mssqlColumnDef("label", t(types.string, { default: null }))).toBe(
      "label NVARCHAR(255) NOT NULL DEFAULT NULL",
    )
  })

  test("identity column", () => {
    expect(mssqlColumnDef("id", t(types.int32, { identity: true }))).toBe("id INT IDENTITY(1,1) NOT NULL")
  })

  test("uuid column", () => {
    expect(mssqlColumnDef("id", t(types.uuid))).toBe("id UNIQUEIDENTIFIER NOT NULL")
  })

  test("enum column gets CHECK constraint", () => {
    expect(mssqlColumnDef("status", t(types.enum(["active", "inactive"])))).toBe(
      "status NVARCHAR(255) NOT NULL CHECK (status IN ('active', 'inactive'))",
    )
  })

  test("nullable enum column gets CHECK constraint after NULL", () => {
    expect(mssqlColumnDef("status", t(types.enum(["a", "b"]), { nullable: true }))).toBe(
      "status NVARCHAR(255) NULL CHECK (status IN ('a', 'b'))",
    )
  })
})

describe("toMssqlCreateTable", () => {
  test("builds full table DDL", () => {
    expect(
      toMssqlCreateTable("users", {
        id: t(types.int32, { identity: true }),
        externalId: t(types.uuid),
        name: t(types.string),
        nickname: t(types.string, { nullable: true }),
        age: t(types.int32, { default: 0 }),
        status: t(types.enum(["active", "inactive"])),
      }),
    ).toBe(
      "CREATE TABLE users (\n" +
        "  id INT IDENTITY(1,1) NOT NULL,\n" +
        "  externalId UNIQUEIDENTIFIER NOT NULL,\n" +
        "  name NVARCHAR(255) NOT NULL,\n" +
        "  nickname NVARCHAR(255) NULL,\n" +
        "  age INT NOT NULL DEFAULT 0,\n" +
        "  status NVARCHAR(255) NOT NULL CHECK (status IN ('active', 'inactive'))\n" +
        ");",
    )
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toMssqlType(ref)).toBe("INT")
  })
})
