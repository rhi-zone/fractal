import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import {
  mssqlColumnDef,
  singleTableInheritanceMssqlLayout,
  tablePerVariantMssqlLayout,
  toMssqlCreateTable,
  toMssqlCreateTableFromRef,
  toMssqlType,
} from "./sql-mssql.ts"

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
    expect(toMssqlType(int32())).toBe("INT")
  })

  test("int64", () => {
    expect(toMssqlType(int64())).toBe("BIGINT")
  })

  test("float32", () => {
    expect(toMssqlType(float32())).toBe("REAL")
  })

  test("float64", () => {
    expect(toMssqlType(float64())).toBe("FLOAT")
  })

  test("string", () => {
    expect(toMssqlType(t(types.string))).toBe("NVARCHAR(255)")
  })

  test("uuid", () => {
    expect(toMssqlType(uuid())).toBe("UNIQUEIDENTIFIER")
  })

  test("uri", () => {
    expect(toMssqlType(uri())).toBe("NVARCHAR(MAX)")
  })

  test("email", () => {
    expect(toMssqlType(email())).toBe("NVARCHAR(255)")
  })

  test("datetime", () => {
    expect(toMssqlType(datetime())).toBe("DATETIME2")
  })

  test("date", () => {
    expect(toMssqlType(date())).toBe("DATE")
  })

  test("time", () => {
    expect(toMssqlType(time())).toBe("TIME")
  })

  test("duration", () => {
    expect(toMssqlType(duration())).toBe("NVARCHAR(255)")
  })

  test("bytes", () => {
    expect(toMssqlType(bytes())).toBe("VARBINARY(MAX)")
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
    expect(mssqlColumnDef("id", int32({ identity: true }))).toBe("id INT IDENTITY(1,1) NOT NULL")
  })

  test("uuid column", () => {
    expect(mssqlColumnDef("id", uuid())).toBe("id UNIQUEIDENTIFIER NOT NULL")
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
        id: int32({ identity: true }),
        externalId: uuid(),
        name: t(types.string),
        nickname: t(types.string, { nullable: true }),
        age: int32({ default: 0 }),
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

describe("CHECK constraints from metadata", () => {
  test("numeric minimum/maximum", () => {
    expect(mssqlColumnDef("age", int32({ minimum: 0, maximum: 130 }))).toBe(
      "age INT NOT NULL CHECK (age >= 0) CHECK (age <= 130)",
    )
  })

  test("exclusiveMinimum/exclusiveMaximum", () => {
    expect(mssqlColumnDef("ratio", t(types.number, { exclusiveMinimum: 0, exclusiveMaximum: 1 }))).toBe(
      "ratio FLOAT NOT NULL CHECK (ratio > 0) CHECK (ratio < 1)",
    )
  })

  test("string minLength/maxLength uses LEN, not LENGTH", () => {
    expect(mssqlColumnDef("name", t(types.string, { minLength: 1, maxLength: 50 }))).toBe(
      "name NVARCHAR(255) NOT NULL CHECK (LEN(name) >= 1) CHECK (LEN(name) <= 50)",
    )
  })

  test("multipleOf", () => {
    expect(mssqlColumnDef("qty", t(types.integer, { multipleOf: 5 }))).toBe(
      "qty INT NOT NULL CHECK (qty % 5 = 0)",
    )
  })

  test("pattern is skipped (no lossless regex equivalent in T-SQL)", () => {
    expect(mssqlColumnDef("code", t(types.string, { pattern: "^[a-z]+$" }))).toBe("code NVARCHAR(255) NOT NULL")
  })

  test("non-numeric/non-string kinds ignore numeric/string constraints", () => {
    expect(mssqlColumnDef("active", t(types.boolean, { minimum: 0, minLength: 1 }))).toBe("active BIT NOT NULL")
  })

  test("combined constraints, enum CHECK, and identity all compose", () => {
    expect(
      mssqlColumnDef("id", int32({ identity: true, minimum: 1 })),
    ).toBe("id INT IDENTITY(1,1) NOT NULL CHECK (id >= 1)")
  })
})

describe("description metadata → comment", () => {
  test("renders as a block comment (MSSQL has no inline COMMENT syntax)", () => {
    expect(mssqlColumnDef("name", t(types.string, { description: "display name" }))).toBe(
      "name NVARCHAR(255) NOT NULL /* display name */",
    )
  })

  test("comment comes after CHECK constraints", () => {
    expect(mssqlColumnDef("age", int32({ minimum: 0, description: "age in years" }))).toBe(
      "age INT NOT NULL CHECK (age >= 0) /* age in years */",
    )
  })
})

describe("toMssqlCreateTable: comma is preserved, not swallowed by the comment", () => {
  test("full table DDL with checks and comments", () => {
    expect(
      toMssqlCreateTable("users", {
        id: int32({ identity: true }),
        age: int32({ minimum: 0, description: "age in years" }),
      }),
    ).toBe(
      "CREATE TABLE users (\n" +
        "  id INT IDENTITY(1,1) NOT NULL,\n" +
        "  age INT NOT NULL CHECK (age >= 0) /* age in years */\n" +
        ");",
    )
  })
})

describe("function", () => {
  test("degrades to NVARCHAR(MAX) (not persistable column data)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toMssqlType(ref)).toBe("NVARCHAR(MAX)")
  })
})

describe("stream", () => {
  test("degrades to NVARCHAR(MAX), same as array (not persistable as an ongoing sequence)", () => {
    expect(toMssqlType(t(types.stream(t(types.string))))).toBe("NVARCHAR(MAX)")
  })
})

describe("union roots (toMssqlCreateTableFromRef)", () => {
  const successResponse = t(
    types.object({
      type: t(types.literal("success")),
      data: t(types.object({ result: t(types.string) })),
    }),
  )
  const errorResponse = t(
    types.object({
      type: t(types.literal("error")),
      code: t(types.integer),
      message: t(types.string),
    }),
  )
  const discriminatedUnion = t(types.union([successResponse, errorResponse]), { discriminator: "type" })

  test("object root behaves exactly like toMssqlCreateTable", () => {
    const ref = t(
      types.object({
        id: int32({ identity: true }),
        name: t(types.string),
      }),
    )
    expect(toMssqlCreateTableFromRef("users", ref)).toBe(
      toMssqlCreateTable("users", { id: int32({ identity: true }), name: t(types.string) }),
    )
  })

  describe("default layout (single-table-inheritance)", () => {
    test("discriminated union: discriminator column NOT NULL + nullable variant columns, shared fields not duplicated", () => {
      expect(toMssqlCreateTableFromRef("ApiResponse", discriminatedUnion)).toBe(
        "CREATE TABLE ApiResponse (\n" +
          "  type NVARCHAR(255) NOT NULL,\n" +
          "  data NVARCHAR(MAX) NULL,\n" +
          "  code INT NULL,\n" +
          "  message NVARCHAR(255) NULL\n" +
          ");",
      )
    })

    test("plain (undiscriminated) union: falls back to a bare 'kind' discriminator column", () => {
      const plainUnion = t(types.union([t(types.string), t(types.integer)]))
      expect(toMssqlCreateTableFromRef("Plain", plainUnion)).toBe(
        "CREATE TABLE Plain (\n  kind NVARCHAR(255) NOT NULL\n);",
      )
    })

    test("discriminatorColumn overrides the fallback name when the union carries no meta.discriminator", () => {
      const plainUnion = t(types.union([t(types.string), t(types.integer)]))
      expect(
        toMssqlCreateTableFromRef("Plain", plainUnion, {
          unionLayout: singleTableInheritanceMssqlLayout({ discriminatorColumn: "variant_kind" }),
        }),
      ).toBe("CREATE TABLE Plain (\n  variant_kind NVARCHAR(255) NOT NULL\n);")
    })
  })

  describe("tablePerVariantMssqlLayout", () => {
    test("one CREATE TABLE per variant, each with proper NOT NULL constraints", () => {
      expect(
        toMssqlCreateTableFromRef("ApiResponse", discriminatedUnion, { unionLayout: tablePerVariantMssqlLayout() }),
      ).toBe(
        "CREATE TABLE ApiResponse_success (\n" +
          "  type NVARCHAR(255) NOT NULL,\n" +
          "  data NVARCHAR(MAX) NOT NULL\n" +
          ");\n\n" +
          "CREATE TABLE ApiResponse_error (\n" +
          "  type NVARCHAR(255) NOT NULL,\n" +
          "  code INT NOT NULL,\n" +
          "  message NVARCHAR(255) NOT NULL\n" +
          ");",
      )
    })

    test("plain union falls back to positional variant names and a single 'value' column", () => {
      const plainUnion = t(types.union([t(types.string), t(types.integer)]))
      expect(
        toMssqlCreateTableFromRef("Plain", plainUnion, { unionLayout: tablePerVariantMssqlLayout() }),
      ).toBe(
        "CREATE TABLE Plain_variant1 (\n  value NVARCHAR(255) NOT NULL\n);\n\n" +
          "CREATE TABLE Plain_variant2 (\n  value INT NOT NULL\n);",
      )
    })

    test("tableName callback overrides the default {union}_{variant} naming", () => {
      const plainUnion = t(types.union([t(types.string)]))
      expect(
        toMssqlCreateTableFromRef("Plain", plainUnion, {
          unionLayout: tablePerVariantMssqlLayout({ tableName: (root, variant) => `${root}__${variant}` }),
        }),
      ).toBe("CREATE TABLE Plain__variant1 (\n  value NVARCHAR(255) NOT NULL\n);")
    })
  })

  describe("custom layout function", () => {
    test("a caller's own MssqlUnionLayout is honored — no closed set of built-in strategies", () => {
      const countingLayout = (input: { name: string; variants: { name: string }[] }) =>
        `-- ${input.name} has ${input.variants.length} variants: ${input.variants.map((v) => v.name).join(", ")}`
      expect(toMssqlCreateTableFromRef("ApiResponse", discriminatedUnion, { unionLayout: countingLayout })).toBe(
        "-- ApiResponse has 2 variants: success, error",
      )
    })
  })

  test("throws for a non-object, non-union root", () => {
    expect(() => toMssqlCreateTableFromRef("x", t(types.string))).toThrow()
  })
})
