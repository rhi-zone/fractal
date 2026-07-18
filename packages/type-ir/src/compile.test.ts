// packages/type-ir/src/compile.test.ts — AOT validator codegen tests
//
// Covers:
//   1. compileValidator produces standalone JS evaluating to a `{ check,
//      errors, parse }` triple for a single TypeRef.
//   2. compileValidatorModule emits a full module whose `validators` map
//      exposes that triple per entry, and that check()/errors()/parse()
//      agree with each other across leaf/composite shapes, meta-driven
//      constraints, and coercion.
//
// The build orchestrator (entryFile -> compiled module, end-to-end) lives in
// @rhi-zone/fractal-api-tree's build.test.ts — it wires this package's
// compileValidatorModule to api-tree's own extractor/tree-walker.

import { describe, expect, it } from "bun:test"
import { compileValidator, compileValidatorModule, type ValidationError } from "./compile.ts"
import { t, types } from "./index.ts"
import { bytes, date, datetime, duration, int32, time, uri, uuid } from "./kinds/common.ts"

type Triple = {
  check: (value: unknown) => boolean
  errors: (value: unknown) => ValidationError[]
  parse: (value: unknown) => { kind: "ok"; value: unknown } | { kind: "err"; errors: ValidationError[] }
}

/** Strip TypeScript syntax (type annotations, `as` casts) via Bun's
 * transpiler — the generated source is no longer plain JS `new Function` can
 * parse directly; this mirrors what the consuming toolchain (Bun/tsc) does to
 * the generated file before running it. */
const tsTranspiler = new Bun.Transpiler({ loader: "ts" })
function stripTypes(source: string): string {
  return tsTranspiler.transformSync(source).trim().replace(/;$/, "")
}

/** Evaluate a `compileValidator(...)`-produced expression string into its `{ check, errors, parse }` triple. */
function evalValidator(source: string): Triple {
  return new Function(`return (${stripTypes(source)});`)()
}

/** Evaluate a `compileValidatorModule(...)`-produced module source into its `validators` map. */
function evalModule(source: string): Record<string, Triple> {
  const commonJs = stripTypes(source).replace("export const validators", "const validators") + "\nreturn validators;"
  return new Function(commonJs)()
}

describe("compileValidator — check/errors/parse triple", () => {
  it("check accepts a matching object and rejects a mismatched one", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.number, { optional: true }) }))
    const v = evalValidator(compileValidator(ref))

    expect(v.check({ name: "Alice" })).toBe(true)
    expect(v.check({ name: 42 })).toBe(false)
  })

  it("errors collects every violation, not just the first", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.number) }))
    const v = evalValidator(compileValidator(ref))
    const errs = v.errors({ name: 1, age: "x" })
    expect(errs).toHaveLength(2)
    expect(errs.map((e) => e.kind)).toEqual(["type", "type"])
  })

  it("errors reports a missing required field with its path", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const v = evalValidator(compileValidator(ref))
    const errs = v.errors({})
    expect(errs).toEqual([{ kind: "missing", path: ["id"] }])
  })

  it("parse returns ok with a fresh value, err with structured errors", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const v = evalValidator(compileValidator(ref))

    const ok = v.parse({ id: "x" })
    expect(ok).toEqual({ kind: "ok", value: { id: "x" } })

    const err = v.parse({}) as { kind: "err"; errors: ValidationError[] }
    expect(err.kind).toBe("err")
    expect(err.errors).toEqual([{ kind: "missing", path: ["id"] }])
  })

  it("parse never mutates or aliases the input object", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const v = evalValidator(compileValidator(ref))
    const input = { id: "x" }
    const result = v.parse(input) as { kind: "ok"; value: { id: string } }
    expect(result.value).not.toBe(input)
    expect(result.value).toEqual(input)
  })

  it("parse coerces a numeric string field", () => {
    const ref = t(types.object({ age: t(types.number) }))
    const v = evalValidator(compileValidator(ref))
    const result = v.parse({ age: "42" }) as { kind: "ok"; value: { age: number } }
    expect(result).toEqual({ kind: "ok", value: { age: 42 } })
  })

  it("parse coerces a boolean-like string field", () => {
    const ref = t(types.object({ active: t(types.boolean) }))
    const v = evalValidator(compileValidator(ref))
    expect(v.parse({ active: "true" })).toEqual({ kind: "ok", value: { active: true } })
    expect(v.parse({ active: "false" })).toEqual({ kind: "ok", value: { active: false } })
  })

  it("parse reports a coerce error for an unparseable numeric string", () => {
    const ref = t(types.object({ age: t(types.number) }))
    const v = evalValidator(compileValidator(ref))
    const result = v.parse({ age: "not-a-number" }) as { kind: "err"; errors: ValidationError[] }
    expect(result.kind).toBe("err")
    expect(result.errors[0]!.kind).toBe("coerce")
  })

  it("validates a nested object + array shape", () => {
    const ref = t(
      types.object({
        roles: t(types.array(t(types.string))),
        address: t(types.object({ street: t(types.string) })),
      }),
    )
    const v = evalValidator(compileValidator(ref))
    expect(v.check({ roles: ["a"], address: { street: "Main" } })).toBe(true)
    expect(v.check({ roles: [1], address: { street: "Main" } })).toBe(false)
    expect(v.check({ roles: ["a"], address: {} })).toBe(false)

    const errs = v.errors({ roles: [1], address: {} })
    expect(errs.some((e) => e.kind === "type" && e.path.join(".") === "roles.0")).toBe(true)
    expect(errs.some((e) => e.kind === "missing" && e.path.join(".") === "address.street")).toBe(true)
  })
})

describe("compileValidator — leaf kinds", () => {
  it("boolean/number/string", () => {
    expect(evalValidator(compileValidator(t(types.boolean))).check(true)).toBe(true)
    expect(evalValidator(compileValidator(t(types.boolean))).check("true")).toBe(false)
    expect(evalValidator(compileValidator(t(types.number))).check(1)).toBe(true)
    expect(evalValidator(compileValidator(t(types.string))).check("x")).toBe(true)
  })

  it("null/void/unknown/never", () => {
    expect(evalValidator(compileValidator(t(types.null))).check(null)).toBe(true)
    expect(evalValidator(compileValidator(t(types.null))).check(undefined)).toBe(false)
    expect(evalValidator(compileValidator(t(types.void))).check(undefined)).toBe(true)
    expect(evalValidator(compileValidator(t(types.unknown))).check("anything")).toBe(true)
    expect(evalValidator(compileValidator(t(types.never))).check("anything")).toBe(false)
  })

  it("literal", () => {
    const v = evalValidator(compileValidator(t(types.literal("active"))))
    expect(v.check("active")).toBe(true)
    expect(v.check("inactive")).toBe(false)
    expect(v.errors("inactive")).toEqual([{ kind: "literal", path: [], expected: "active", actual: "inactive" }])
  })

  it("enum", () => {
    const v = evalValidator(compileValidator(t(types.enum(["a", "b"]))))
    expect(v.check("a")).toBe(true)
    expect(v.check("c")).toBe(false)
    const errs = v.errors("c")
    expect(errs).toEqual([{ kind: "enum", path: [], expected: ["a", "b"], actual: "c" }])
  })

  it("nullable meta accepts null alongside the base type", () => {
    const v = evalValidator(compileValidator(t(types.string, { nullable: true })))
    expect(v.check(null)).toBe(true)
    expect(v.check("x")).toBe(true)
    expect(v.check(1)).toBe(false)
    expect(v.parse(null)).toEqual({ kind: "ok", value: null })
  })

  it("semantic string kinds (uuid/uri/date/time/datetime/duration/bytes)", () => {
    expect(evalValidator(compileValidator(uuid())).check("550e8400-e29b-41d4-a716-446655440000")).toBe(true)
    expect(evalValidator(compileValidator(uuid())).check("not-a-uuid")).toBe(false)
    expect(evalValidator(compileValidator(uri())).check("https://example.com")).toBe(true)
    expect(evalValidator(compileValidator(date())).check("2024-01-01")).toBe(true)
    expect(evalValidator(compileValidator(date())).check("01-01-2024")).toBe(false)
    expect(evalValidator(compileValidator(time())).check("12:30:00")).toBe(true)
    expect(evalValidator(compileValidator(datetime())).check("2024-01-01T12:30:00Z")).toBe(true)
    expect(evalValidator(compileValidator(duration())).check("P1DT2H")).toBe(true)
    expect(evalValidator(compileValidator(bytes())).check("aGVsbG8=")).toBe(true)
  })

  it("int32 enforces range on top of integer-ness", () => {
    const v = evalValidator(compileValidator(int32()))
    expect(v.check(42)).toBe(true)
    expect(v.check(3.5)).toBe(false)
    expect(v.check(2 ** 32)).toBe(false)
  })
})

describe("compileValidator — meta-driven constraints", () => {
  it("minLength/maxLength/pattern on strings", () => {
    const ref = t(types.string, { minLength: 2, maxLength: 4, pattern: "^[a-z]+$" })
    const v = evalValidator(compileValidator(ref))
    expect(v.check("ab")).toBe(true)
    expect(v.check("a")).toBe(false)
    expect(v.check("abcde")).toBe(false)
    expect(v.check("AB")).toBe(false)
    const errs = v.errors("A")
    expect(errs.map((e) => e.kind).sort()).toEqual(["min_length", "pattern"])
  })

  it("minimum/maximum/exclusiveMinimum/exclusiveMaximum/multipleOf on numbers", () => {
    const ref = t(types.number, { minimum: 0, maximum: 10, multipleOf: 2 })
    const v = evalValidator(compileValidator(ref))
    expect(v.check(4)).toBe(true)
    expect(v.check(-1)).toBe(false)
    expect(v.check(11)).toBe(false)
    expect(v.check(3)).toBe(false)
  })

  it("exclusive bounds mark the exclusive flag on the error", () => {
    const ref = t(types.number, { exclusiveMinimum: 0 })
    const v = evalValidator(compileValidator(ref))
    const errs = v.errors(0)
    expect(errs).toEqual([{ kind: "min", path: [], expected: 0, actual: 0, exclusive: true }])
  })

  it("array minLength/maxLength", () => {
    const ref = t(types.array(t(types.string)), { minLength: 1, maxLength: 2 })
    const v = evalValidator(compileValidator(ref))
    expect(v.check([])).toBe(false)
    expect(v.check(["a"])).toBe(true)
    expect(v.check(["a", "b", "c"])).toBe(false)
  })
})

describe("compileValidator — composite kinds", () => {
  it("tuple: check enforces arity and per-index shape; errors reports tuple_length", () => {
    const ref = t(types.tuple([t(types.string), t(types.number)]))
    const v = evalValidator(compileValidator(ref))
    expect(v.check(["a", 1])).toBe(true)
    expect(v.check(["a"])).toBe(false)
    expect(v.check(["a", 1, 2])).toBe(false)
    const errs = v.errors(["a"])
    expect(errs.some((e) => e.kind === "tuple_length")).toBe(true)
  })

  it("map (Record<string, V>)", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    const v = evalValidator(compileValidator(ref))
    expect(v.check({ a: 1, b: 2 })).toBe(true)
    expect(v.check({ a: "x" })).toBe(false)
    expect(v.parse({ a: "1" })).toEqual({ kind: "ok", value: { a: 1 } })
  })

  it("union: check is true if any variant matches; errors collects all variants' errors when none match", () => {
    const ref = t(types.union([t(types.string), t(types.number)]))
    const v = evalValidator(compileValidator(ref))
    expect(v.check("x")).toBe(true)
    expect(v.check(1)).toBe(true)
    expect(v.check(true)).toBe(false)
    const errs = v.errors(true)
    expect(errs).toHaveLength(1)
    expect(errs[0]!.kind).toBe("union")
    expect((errs[0] as { kind: "union"; errors: ValidationError[][] }).errors).toHaveLength(2)
  })

  it("union parse picks the first variant that validates without coercion errors", () => {
    const ref = t(types.union([t(types.number), t(types.string)]))
    const v = evalValidator(compileValidator(ref))
    expect(v.parse(5)).toEqual({ kind: "ok", value: 5 })
    expect(v.parse("hi")).toEqual({ kind: "ok", value: "hi" })
  })

  it("intersection: value must satisfy every member; object members merge into one fresh value", () => {
    const ref = t(types.intersection([t(types.object({ a: t(types.string) })), t(types.object({ b: t(types.number) }))]))
    const v = evalValidator(compileValidator(ref))
    expect(v.check({ a: "x", b: 1 })).toBe(true)
    expect(v.check({ a: "x" })).toBe(false)
    expect(v.parse({ a: "x", b: 1 })).toEqual({ kind: "ok", value: { a: "x", b: 1 } })
  })

  it("instance/ref/function shapes pass through (no runtime structural check available)", () => {
    expect(evalValidator(compileValidator(t(types.instance("Foo", "./foo.ts")))).check({})).toBe(true)
    expect(evalValidator(compileValidator(t(types.ref("Foo")))).check("anything")).toBe(true)
    expect(evalValidator(compileValidator(t(types.function([], t(types.void))))).check(() => {})).toBe(true)
    expect(evalValidator(compileValidator(t(types.function([], t(types.void))))).check("not a fn")).toBe(false)
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
    expect(validators["users/create"]!.check({ name: "Alice" })).toBe(true)
    expect(validators["users/create"]!.check({})).toBe(false)
    expect(validators["users/:userId/get"]!.check({ userId: "u1" })).toBe(true)
    expect(validators["users/:userId/get"]!.check({ userId: 1 })).toBe(false)
  })

  it("emits an empty validators map for no entries (the stub case)", () => {
    const source = compileValidatorModule([])
    expect(evalModule(source)).toEqual({})
  })

  it("each entry's guard narrows to the input's inline structural TypeScript rendering when no typeName is carried", () => {
    const source = compileValidatorModule([{ name: "users/create", ref: t(types.object({ name: t(types.string) })) }])
    expect(source).toContain("value is { name: string }")
    expect(source).not.toContain("import type")
  })

  it("imports a NAMED type (meta.typeName + meta.declarationFile) via resolveImport instead of inlining it", () => {
    const ref = t(types.object({ q: t(types.string, { optional: true }) }), {
      typeName: "BookQuery",
      declarationFile: "/repo/src/types.ts",
    })
    const source = compileValidatorModule([{ name: "catalog/search", ref }], {
      resolveImport: (declarationFile) => {
        expect(declarationFile).toBe("/repo/src/types.ts")
        return "../types.ts"
      },
    })
    expect(source).toContain('import type { BookQuery } from "../types.ts"')
    expect(source).toContain("value is BookQuery")
    expect(source).not.toContain("value is { q")

    // `import type` is type-only — Bun's transpiler elides it entirely, so
    // the module still evaluates standalone even though "../types.ts" (a
    // fixture path, not a real file) is never actually resolved at runtime.
    const validators = evalModule(source)
    expect(validators["catalog/search"]!.check({ q: "x" })).toBe(true)
  })

  it("groups multiple entries sharing the same resolved import specifier into one import line", () => {
    const bookQueryRef = t(types.object({ q: t(types.string) }), {
      typeName: "BookQuery",
      declarationFile: "/repo/src/types.ts",
    })
    const bookIdRef = t(types.object({ bookId: t(types.string) }), {
      typeName: "BookIdParam",
      declarationFile: "/repo/src/types.ts",
    })
    const source = compileValidatorModule(
      [
        { name: "catalog/search", ref: bookQueryRef },
        { name: "books/:bookId/read", ref: bookIdRef },
      ],
      { resolveImport: () => "../types.ts" },
    )
    const importLines = source.split("\n").filter((line) => line.startsWith("import type"))
    expect(importLines).toEqual(['import type { BookIdParam, BookQuery } from "../types.ts"'])
  })

  it("without resolveImport, a typeName-carrying TypeRef still inlines its structure rather than referencing an unimported name", () => {
    const ref = t(types.object({ q: t(types.string, { optional: true }) }), {
      typeName: "BookQuery",
      declarationFile: "/repo/src/types.ts",
    })
    const source = compileValidatorModule([{ name: "catalog/search", ref }])
    expect(source).not.toContain("import type")
    expect(source).not.toContain("value is BookQuery")
    expect(source).toContain("value is { q?: string }")
  })

  it("declares the ValidationError type and __inferTypeRef helper exactly once, shared across entries", () => {
    const source = compileValidatorModule([
      { name: "a", ref: t(types.object({ x: t(types.string) })) },
      { name: "b", ref: t(types.object({ y: t(types.number) })) },
    ])
    expect(source.split("function __inferTypeRef").length - 1).toBe(1)
    expect(source).toContain("export type ValidationError")
  })
})
