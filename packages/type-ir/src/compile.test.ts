// packages/type-ir/src/compile.test.ts — AOT validator codegen tests
//
// Covers:
//   1. buildSchema produces correct TSchema shapes (leaf / object / array /
//      union / literal / enum / nullable / intersection)
//   2. compileValidator produces standalone JS that, once evaluated, is a
//      Validator: `(bag) => Result<unknown, unknown>`
//   3. compileValidatorModule emits a full module whose `validators` map
//      actually validates/rejects per-entry
//
// The build orchestrator (entryFile -> compiled module, end-to-end) lives in
// @rhi-zone/fractal-api-tree's build.test.ts — it wires this package's
// compileValidatorModule to api-tree's own extractor/tree-walker.

import { describe, expect, it } from "bun:test"
import { t, types, type TypeShape } from "./index.ts"
import { uuid } from "./kinds/common.ts"
import { buildSchema, compileValidator, compileValidatorModule } from "./compile.ts"

/** TypeBox TSchema objects carry a non-JSON `Symbol(TypeBox.Kind)` tag — strip
 * it via a JSON round-trip before comparing plain schema shapes with toEqual. */
function toPlain(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema))
}

/** Evaluate a `compileValidator(...)`-produced expression string into a callable Validator. */
function evalValidator(source: string): (bag: Record<string, unknown>) => { kind: "ok" | "err"; value?: unknown; error?: unknown } {
  return new Function(`return (${source});`)()
}

/** Evaluate a `compileValidatorModule(...)`-produced module source into its `validators` map. */
function evalModule(source: string): Record<string, (bag: Record<string, unknown>) => { kind: "ok" | "err"; value?: unknown; error?: unknown }> {
  const commonJs = source.replace("export const validators", "const validators") + "\nreturn validators;"
  return new Function(commonJs)()
}

describe("buildSchema — leaf kinds", () => {
  it("boolean", () => {
    expect(toPlain(buildSchema(t(types.boolean)))).toEqual({ type: "boolean" })
  })

  it("number", () => {
    expect(toPlain(buildSchema(t(types.number)))).toEqual({ type: "number" })
  })

  it("string", () => {
    expect(toPlain(buildSchema(t(types.string)))).toEqual({ type: "string" })
  })

  it("uuid carries the format option", () => {
    expect(buildSchema(uuid())).toMatchObject({ type: "string", format: "uuid" })
  })

  it("null", () => {
    expect(toPlain(buildSchema(t(types.null)))).toEqual({ type: "null" })
  })

  it("unknown", () => {
    expect(toPlain(buildSchema(t(types.unknown)))).toEqual({})
  })
})

describe("buildSchema — composite kinds", () => {
  it("object with optional field", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        age: t(types.number, { optional: true }),
      }),
    )
    const schema = buildSchema(ref) as unknown as {
      type: string
      required?: string[]
      properties: Record<string, unknown>
    }
    expect(schema.type).toBe("object")
    expect(schema.required).toEqual(["name"])
    expect(schema.properties.age).toMatchObject({ type: "number" })
  })

  it("array", () => {
    const ref = t(types.array(t(types.string)))
    expect(buildSchema(ref)).toMatchObject({ type: "array", items: { type: "string" } })
  })

  it("tuple", () => {
    const ref = t(types.tuple([t(types.string), t(types.number)]))
    const schema = toPlain(buildSchema(ref)) as { type: string; items: unknown[] }
    expect(schema.type).toBe("array")
    expect(schema.items).toEqual([{ type: "string" }, { type: "number" }])
  })

  it("map (Record<string, V>)", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    const schema = toPlain(buildSchema(ref)) as { type: string; patternProperties: Record<string, unknown> }
    expect(schema.type).toBe("object")
    expect(Object.values(schema.patternProperties)[0]).toEqual({ type: "number" })
  })

  it("union", () => {
    const ref = t(types.union([t(types.string), t(types.number)]))
    const schema = toPlain(buildSchema(ref)) as { anyOf: unknown[] }
    expect(schema.anyOf).toEqual([{ type: "string" }, { type: "number" }])
  })

  it("literal (string)", () => {
    expect(toPlain(buildSchema(t(types.literal("active"))))).toEqual({ const: "active", type: "string" })
  })

  it("literal (null) lowers to Type.Null", () => {
    expect(toPlain(buildSchema(t(types.literal(null))))).toEqual({ type: "null" })
  })

  it("enum", () => {
    const ref = t(types.enum(["a", "b"]))
    const schema = toPlain(buildSchema(ref)) as { anyOf: unknown[] }
    expect(schema.anyOf).toEqual([
      { const: "a", type: "string" },
      { const: "b", type: "string" },
    ])
  })

  it("intersection", () => {
    const ref = t(
      types.intersection([
        t(types.object({ a: t(types.string) })),
        t(types.object({ b: t(types.number) })),
      ]),
    )
    const schema = buildSchema(ref) as unknown as { allOf: unknown[] }
    expect(schema.allOf).toHaveLength(2)
  })

  it("nullable meta wraps the schema in a union with Type.Null", () => {
    const ref = t(types.string, { nullable: true })
    const schema = toPlain(buildSchema(ref)) as { anyOf: unknown[] }
    expect(schema.anyOf).toEqual([{ type: "string" }, { type: "null" }])
  })

  it("unhandled/unresolvable kind falls back to Type.Unknown", () => {
    const ref = t({ kind: "totally-unknown-kind" } as unknown as TypeShape)
    expect(toPlain(buildSchema(ref))).toEqual({})
  })
})

describe("compileValidator — standalone validator source", () => {
  it("accepts a matching object and rejects a mismatched one", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        age: t(types.number, { optional: true }),
      }),
    )
    const validator = evalValidator(compileValidator(ref))

    const ok = validator({ name: "Alice" })
    expect(ok.kind).toBe("ok")
    expect(ok.value).toEqual({ name: "Alice" })

    const err = validator({ name: 42 })
    expect(err.kind).toBe("err")
    expect(err.error).toBeDefined()
  })

  it("rejects a missing required field", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const validator = evalValidator(compileValidator(ref))
    expect(validator({}).kind).toBe("err")
    expect(validator({ id: "x" }).kind).toBe("ok")
  })

  it("validates a nested object + array shape", () => {
    const ref = t(
      types.object({
        roles: t(types.array(t(types.string))),
        address: t(types.object({ street: t(types.string) })),
      }),
    )
    const validator = evalValidator(compileValidator(ref))
    expect(validator({ roles: ["a"], address: { street: "Main" } }).kind).toBe("ok")
    expect(validator({ roles: [1], address: { street: "Main" } }).kind).toBe("err")
    expect(validator({ roles: ["a"], address: {} }).kind).toBe("err")
  })

  it("carries a custom error message", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const validator = evalValidator(compileValidator(ref, "custom message"))
    const result = validator({}) as { kind: "err"; error: { message: string } }
    expect(result.error.message).toBe("custom message")
  })
})

describe("compileValidatorModule — full module emission", () => {
  it("emits a module whose validators map validates/rejects per entry", () => {
    const source = compileValidatorModule([
      { name: "users/create", ref: t(types.object({ name: t(types.string) })) },
      { name: "users/:userId/get", ref: t(types.object({ userId: t(types.string) })) },
    ])
    expect(source).toContain("export const validators")
    expect(source).toContain('"users/create"')
    expect(source).toContain('"users/:userId/get"')

    const validators = evalModule(source)
    expect(Object.keys(validators)).toEqual(["users/create", "users/:userId/get"])
    expect(validators["users/create"]!({ name: "Alice" }).kind).toBe("ok")
    expect(validators["users/create"]!({}).kind).toBe("err")
    expect(validators["users/:userId/get"]!({ userId: "u1" }).kind).toBe("ok")
    expect(validators["users/:userId/get"]!({ userId: 1 }).kind).toBe("err")
  })

  it("emits an empty validators map for no entries (the stub case)", () => {
    const source = compileValidatorModule([])
    expect(evalModule(source)).toEqual({})
  })
})
