import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { toTypeDeclaration, toTypeDeclarations, toTypeScript } from "./typescript.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toTypeScript(t(types.boolean))).toBe("boolean")
  })

  test("number", () => {
    expect(toTypeScript(t(types.number))).toBe("number")
  })

  test("string", () => {
    expect(toTypeScript(t(types.string))).toBe("string")
  })
})

describe("numeric subtypes", () => {
  for (const kind of ["integer", "int32", "int64", "float32", "float64"] as const) {
    test(kind, () => {
      expect(toTypeScript(t(types[kind]))).toBe("number")
    })
  }
})

describe("string subtypes", () => {
  for (const kind of ["uuid", "uri", "datetime", "date", "time", "duration"] as const) {
    test(kind, () => {
      expect(toTypeScript(t(types[kind]))).toBe("string")
    })
  }
})

test("bytes", () => {
  expect(toTypeScript(t(types.bytes))).toBe("Uint8Array")
})

describe("boundary types", () => {
  test("null", () => {
    expect(toTypeScript(t(types.null))).toBe("null")
  })

  test("void", () => {
    expect(toTypeScript(t(types.void))).toBe("void")
  })

  test("unknown", () => {
    expect(toTypeScript(t(types.unknown))).toBe("unknown")
  })

  test("never", () => {
    expect(toTypeScript(t(types.never))).toBe("never")
  })
})

test("object with required and optional fields", () => {
  const ref = t(
    types.object({
      name: t(types.string),
      age: t(types.number, { optional: true }),
    }),
  )
  expect(toTypeScript(ref)).toBe("{ name: string; age?: number }")
})

test("array", () => {
  expect(toTypeScript(t(types.array(t(types.string))))).toBe("string[]")
})

test("array of union uses Array<>", () => {
  const ref = t(types.array(t(types.union([t(types.string), t(types.number)]))))
  expect(toTypeScript(ref)).toBe("Array<string | number>")
})

test("tuple", () => {
  const ref = t(types.tuple([t(types.string), t(types.number)]))
  expect(toTypeScript(ref)).toBe("[string, number]")
})

test("map with string key", () => {
  const ref = t(types.map(t(types.string), t(types.number)))
  expect(toTypeScript(ref)).toBe("Record<string, number>")
})

test("map with non-string key", () => {
  const ref = t(types.map(t(types.number), t(types.string)))
  expect(toTypeScript(ref)).toBe("Map<number, string>")
})

test("union", () => {
  const ref = t(types.union([t(types.string), t(types.number)]))
  expect(toTypeScript(ref)).toBe("string | number")
})

test("literal string", () => {
  expect(toTypeScript(t(types.literal("active")))).toBe('"active"')
})

test("intersection", () => {
  const ref = t(
    types.intersection([
      t(types.object({ id: t(types.string) })),
      t(types.object({ createdAt: t(types.string) })),
    ]),
  )
  expect(toTypeScript(ref)).toBe("{ id: string } & { createdAt: string }")
})

test("three-way intersection joins all members with &", () => {
  const ref = t(
    types.intersection([t(types.object({ id: t(types.string) })), t(types.string), t(types.number)]),
  )
  expect(toTypeScript(ref)).toBe("{ id: string } & string & number")
})

test("array of intersection uses Array<>", () => {
  const ref = t(types.array(t(types.intersection([t(types.string), t(types.number)]))))
  expect(toTypeScript(ref)).toBe("Array<string & number>")
})

test("literal number", () => {
  expect(toTypeScript(t(types.literal(42)))).toBe("42")
})

test("literal boolean", () => {
  expect(toTypeScript(t(types.literal(true)))).toBe("true")
})

test("literal null", () => {
  expect(toTypeScript(t(types.literal(null)))).toBe("null")
})

test("enum", () => {
  expect(toTypeScript(t(types.enum(["a", "b", "c"])))).toBe('"a" | "b" | "c"')
})

test("ref", () => {
  expect(toTypeScript(t(types.ref("User")))).toBe("User")
})

test("nullable appends | null", () => {
  expect(toTypeScript(t(types.string, { nullable: true }))).toBe("string | null")
})

test("toTypeDeclaration for object", () => {
  const ref = t(types.object({ id: t(types.string) }))
  expect(toTypeDeclaration("User", ref)).toBe("type User = { id: string };")
})

test("toTypeDeclaration for non-object", () => {
  expect(toTypeDeclaration("Name", t(types.string))).toBe("type Name = string;")
})

test("toTypeDeclarations", () => {
  const registry = {
    User: t(types.object({ id: t(types.string) })),
    Status: t(types.enum(["active", "inactive"])),
  }
  expect(toTypeDeclarations(registry)).toBe(
    "type User = { id: string };\ntype Status = \"active\" | \"inactive\";",
  )
})

test("branded string emits an intersection with a __brand tag", () => {
  expect(toTypeScript(t(types.string, { brand: "LocationId" }))).toBe(
    'string & { readonly __brand: "LocationId" }',
  )
})

test("unknown kind fallback", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} }
  expect(toTypeScript(ref)).toBe("unknown")
})
