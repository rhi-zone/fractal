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

import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"
import { compileValidator, compileValidatorModule, type ValidationError } from "./compile.ts"
import { t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, int32, time, uri, uuid } from "./kinds/common.ts"
import { int64 } from "./kinds/int-widths.ts"

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

  it("semantic string kinds (uuid/uri/email/time/duration/bytes)", () => {
    expect(evalValidator(compileValidator(uuid())).check("550e8400-e29b-41d4-a716-446655440000")).toBe(true)
    expect(evalValidator(compileValidator(uuid())).check("not-a-uuid")).toBe(false)
    expect(evalValidator(compileValidator(uri())).check("https://example.com")).toBe(true)
    expect(evalValidator(compileValidator(email())).check("user@example.com")).toBe(true)
    expect(evalValidator(compileValidator(email())).check("not-an-email")).toBe(false)
    expect(evalValidator(compileValidator(time())).check("12:30:00")).toBe(true)
    expect(evalValidator(compileValidator(duration())).check("P1DT2H")).toBe(true)
    expect(evalValidator(compileValidator(bytes())).check("aGVsbG8=")).toBe(true)
  })

  // datetime/date are type-ir's `Date` domain type, not a string subtype —
  // see kinds/date-time.ts. check()/errors() require an actual (valid)
  // `Date` instance; parse() additionally coerces an ISO string via
  // `new Date(v)`.
  it("datetime/date (Date domain type)", () => {
    expect(evalValidator(compileValidator(datetime())).check(new Date("2024-01-01T12:30:00Z"))).toBe(true)
    expect(evalValidator(compileValidator(datetime())).check(new Date("not-a-date"))).toBe(false)
    expect(evalValidator(compileValidator(datetime())).check("2024-01-01T12:30:00Z")).toBe(false)
    expect(evalValidator(compileValidator(date())).check(new Date("2024-01-01"))).toBe(true)
    expect(evalValidator(compileValidator(date())).check("2024-01-01")).toBe(false)
  })

  it("datetime/date parse() coerces an ISO string to a Date", () => {
    const v = evalValidator(compileValidator(datetime()))
    const ok = v.parse("2024-01-01T12:30:00Z") as { kind: "ok"; value: Date }
    expect(ok.kind).toBe("ok")
    expect(ok.value instanceof Date).toBe(true)
    expect(ok.value.toISOString()).toBe("2024-01-01T12:30:00.000Z")

    const err = v.parse("not-a-date") as { kind: "err"; errors: ValidationError[] }
    expect(err.kind).toBe("err")
    expect(err.errors[0]!.kind).toBe("coerce")
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

  it("stream: check accepts an async iterable without consuming/validating its elements", () => {
    const ref = t(types.stream(t(types.number)))
    const v = evalValidator(compileValidator(ref))
    async function* gen() {
      yield "not a number" // elements are never validated — see the stream doc comment
    }
    expect(v.check(gen())).toBe(true)
    expect(v.check([1, 2, 3])).toBe(false) // a plain array has no Symbol.asyncIterator
    expect(v.check({})).toBe(false)
    expect(v.check(null)).toBe(false)
  })

  it("stream: errors/parse report a type error for a non-async-iterable, and alias the input otherwise", () => {
    const ref = t(types.stream(t(types.number)))
    const v = evalValidator(compileValidator(ref))
    expect(v.errors({})).toHaveLength(1)
    expect(v.errors({})[0]!.kind).toBe("type")
    async function* gen() {
      yield 1
    }
    const g = gen()
    expect(v.errors(g)).toHaveLength(0)
    const parsed = v.parse(g)
    expect(parsed).toEqual({ kind: "ok", value: g })
  })

  it("page (cursor style): check enforces items/hasMore/cursor shape", () => {
    const ref = t(types.page(t(types.string), "cursor"))
    const v = evalValidator(compileValidator(ref))
    expect(v.check({ items: ["a", "b"], hasMore: false })).toBe(true)
    expect(v.check({ items: ["a", "b"], cursor: "abc", hasMore: true })).toBe(true)
    expect(v.check({ items: ["a", 1], hasMore: false })).toBe(false) // wrong element type
    expect(v.check({ items: ["a"], hasMore: "no" })).toBe(false) // hasMore must be boolean
    expect(v.check({ items: ["a"] })).toBe(false) // missing hasMore
  })

  it("page (offset style): check enforces items/offset/total/hasMore shape", () => {
    const ref = t(types.page(t(types.string), "offset"))
    const v = evalValidator(compileValidator(ref))
    expect(v.check({ items: ["a"], offset: 0, total: 10, hasMore: true })).toBe(true)
    expect(v.check({ items: ["a"], hasMore: true })).toBe(false) // missing offset/total
  })

  it("page: errors/parse validate per-field and coerce items' elements", () => {
    const ref = t(types.page(t(types.number), "offset"))
    const v = evalValidator(compileValidator(ref))
    expect(v.errors({ items: [1, 2], offset: 0, total: 2, hasMore: false })).toHaveLength(0)
    const errs = v.errors({ items: [1], hasMore: false })
    expect(errs.length).toBeGreaterThan(0)
    expect(v.parse({ items: ["1", "2"], offset: "0", total: "2", hasMore: true })).toEqual({
      kind: "ok",
      value: { items: [1, 2], offset: 0, total: 2, hasMore: true },
    })
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
    // The module always imports `ValidationError` from type-ir (see the
    // "declares the __inferTypeRef helper..." test below) even with no
    // typeName-carrying entries — that's the only `import type` line here.
    expect(source.split("\n").filter((line) => line.startsWith("import type"))).toEqual([
      'import type { ValidationError } from "@rhi-zone/fractal-type-ir"',
    ])
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
    expect(importLines).toEqual([
      'import type { ValidationError } from "@rhi-zone/fractal-type-ir"',
      'import type { BookIdParam, BookQuery } from "../types.ts"',
    ])
  })

  it("without resolveImport, a typeName-carrying TypeRef still inlines its structure rather than referencing an unimported name", () => {
    const ref = t(types.object({ q: t(types.string, { optional: true }) }), {
      typeName: "BookQuery",
      declarationFile: "/repo/src/types.ts",
    })
    const source = compileValidatorModule([{ name: "catalog/search", ref }])
    expect(source).not.toContain("value is BookQuery")
    expect(source).toContain("value is { q?: string }")
    // The only import present is the always-emitted `ValidationError` one —
    // no import was introduced for the (unresolved) typeName.
    expect(source.split("\n").filter((line) => line.startsWith("import type"))).toEqual([
      'import type { ValidationError } from "@rhi-zone/fractal-type-ir"',
    ])
  })

  it("declares the __inferTypeRef helper exactly once, shared across entries, and imports ValidationError from type-ir instead of redeclaring it", () => {
    const source = compileValidatorModule([
      { name: "a", ref: t(types.object({ x: t(types.string) })) },
      { name: "b", ref: t(types.object({ y: t(types.number) })) },
    ])
    expect(source.split("function __inferTypeRef").length - 1).toBe(1)
    expect(source).toContain('import type { ValidationError } from "@rhi-zone/fractal-type-ir"')
    expect(source).not.toContain("export type ValidationError")
  })
})

describe("compileValidator — map key validation (bug: key type was never checked)", () => {
  it("check rejects a map whose keys don't match the key type (uuid)", () => {
    const ref = t(types.map(uuid(), t(types.number)))
    const v = evalValidator(compileValidator(ref))
    expect(v.check({ "550e8400-e29b-41d4-a716-446655440000": 1 })).toBe(true)
    expect(v.check({ "not-a-uuid": 1 })).toBe(false)
  })

  it("check rejects a map whose keys don't match the key type (enum)", () => {
    const ref = t(types.map(t(types.enum(["a", "b"])), t(types.number)))
    const v = evalValidator(compileValidator(ref))
    expect(v.check({ a: 1, b: 2 })).toBe(true)
    expect(v.check({ c: 1 })).toBe(false)
  })

  it("check rejects a map whose keys violate a pattern constraint", () => {
    const ref = t(types.map(t(types.string, { pattern: "^[a-z]+$" }), t(types.number)))
    const v = evalValidator(compileValidator(ref))
    expect(v.check({ abc: 1 })).toBe(true)
    expect(v.check({ ABC: 1 })).toBe(false)
  })

  it("errors reports a bad key's violation at the entry's path", () => {
    const ref = t(types.map(uuid(), t(types.number)))
    const v = evalValidator(compileValidator(ref))
    const errs = v.errors({ "not-a-uuid": 1 })
    expect(errs.length).toBeGreaterThan(0)
    expect(errs.some((e) => e.path.join(".") === "not-a-uuid")).toBe(true)
  })

  it("parse reports a bad key's violation and still validates the value", () => {
    const ref = t(types.map(t(types.enum(["a", "b"])), t(types.number)))
    const v = evalValidator(compileValidator(ref))
    const result = v.parse({ c: "not-a-number" }) as { kind: "err"; errors: ValidationError[] }
    expect(result.kind).toBe("err")
    expect(result.errors.some((e) => e.kind === "enum")).toBe(true)
    expect(result.errors.some((e) => e.kind === "coerce")).toBe(true)
  })
})

describe("compileValidator — standalone output typechecks (bug: ValidationError type was never declared)", () => {
  it("compileValidator's output declares a local ValidationError type usable without a cast", () => {
    const ref = t(types.object({ name: t(types.string) }))
    const source = compileValidator(ref)
    expect(source).toContain("type ValidationError")
  })

  it("compileValidator's standalone output typechecks under tsc with no unresolved names", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.number, { optional: true }) }))
    const expr = compileValidator(ref)
    const source = `const v = (${expr});\nexport {};\n`
    const dir = mkdtempSync(join(tmpdir(), "compile-validator-tsc-"))
    const file = join(dir, "standalone.ts")
    writeFileSync(file, source)
    // `--ignoreConfig`: TypeScript 6 errors (TS5112) when a tsconfig.json is
    // present in the process cwd and files are also passed on the command
    // line — even though that ambient tsconfig has nothing to do with the
    // standalone file under test here. The test runner's cwd is this
    // package (which has its own tsconfig.json), so without this flag the
    // invocation fails regardless of whether the generated source is valid.
    const result = spawnSync(
      "bunx",
      ["tsc", "--noEmit", "--strict", "--target", "es2022", "--module", "es2022", "--skipLibCheck", "--ignoreConfig", file],
      { encoding: "utf-8" },
    )
    expect({ status: result.status, output: result.stdout + result.stderr }).toEqual({ status: 0, output: expect.stringContaining("") })
  })
})

describe("compileValidator — errors()/parse() agree on error kind for wrong-type values (bug: parse over-reported coerce)", () => {
  it("a boolean where a number is expected is a type error in both errors() and parse()", () => {
    const ref = t(types.object({ age: t(types.number) }))
    const v = evalValidator(compileValidator(ref))
    const errKinds = v.errors({ age: true }).map((e) => e.kind)
    const parseResult = v.parse({ age: true }) as { kind: "err"; errors: ValidationError[] }
    expect(errKinds).toEqual(["type"])
    expect(parseResult.kind).toBe("err")
    expect(parseResult.errors.map((e) => e.kind)).toEqual(["type"])
  })

  it("an array where a number is expected is a type error in both errors() and parse()", () => {
    const ref = t(types.object({ age: t(types.number) }))
    const v = evalValidator(compileValidator(ref))
    expect(v.errors({ age: [1] }).map((e) => e.kind)).toEqual(["type"])
    const parseResult = v.parse({ age: [1] }) as { kind: "err"; errors: ValidationError[] }
    expect(parseResult.errors.map((e) => e.kind)).toEqual(["type"])
  })

  it("a number where a boolean is expected is a type error in both errors() and parse()", () => {
    const ref = t(types.object({ active: t(types.boolean) }))
    const v = evalValidator(compileValidator(ref))
    expect(v.errors({ active: 1 }).map((e) => e.kind)).toEqual(["type"])
    const parseResult = v.parse({ active: 1 }) as { kind: "err"; errors: ValidationError[] }
    expect(parseResult.errors.map((e) => e.kind)).toEqual(["type"])
  })

  it("an unparseable numeric string is still a coerce error (not over-corrected to type)", () => {
    const ref = t(types.object({ age: t(types.number) }))
    const v = evalValidator(compileValidator(ref))
    const parseResult = v.parse({ age: "nope" }) as { kind: "err"; errors: ValidationError[] }
    expect(parseResult.errors.map((e) => e.kind)).toEqual(["coerce"])
  })

  it("a non-true/false string is still a coerce error for boolean (not over-corrected to type)", () => {
    const ref = t(types.object({ active: t(types.boolean) }))
    const v = evalValidator(compileValidator(ref))
    const parseResult = v.parse({ active: "nope" }) as { kind: "err"; errors: ValidationError[] }
    expect(parseResult.errors.map((e) => e.kind)).toEqual(["coerce"])
  })
})

describe("compileValidator — int64 range check (bug: int64 had no bounds check, identical to integer)", () => {
  it("check accepts values within Number.MIN_SAFE_INTEGER/MAX_SAFE_INTEGER and rejects values outside", () => {
    const v = evalValidator(compileValidator(int64()))
    expect(v.check(42)).toBe(true)
    expect(v.check(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(v.check(Number.MAX_SAFE_INTEGER + 2)).toBe(false)
    expect(v.check(Number.MIN_SAFE_INTEGER - 2)).toBe(false)
  })

  it("errors reports a type error for an out-of-range int64", () => {
    const v = evalValidator(compileValidator(int64()))
    const errs = v.errors(Number.MAX_SAFE_INTEGER + 2)
    expect(errs).toHaveLength(1)
    expect(errs[0]!.kind).toBe("type")
  })
})

describe("compileValidator — duplicate const hoisting (quality: enum/known-field consts were emitted 3x)", () => {
  it("an enum field's member array is hoisted once, not once per check/errors/parse", () => {
    const ref = t(types.object({ status: t(types.enum(["a", "b", "c"])) }))
    const source = compileValidator(ref)
    // Count `const __membersN = [...]` DECLARATIONS specifically (not
    // substring occurrences of the array literal text, which also shows up
    // nested inside the unrelated `__ref` TypeRef literal used for `type`
    // errors) — errors()/parse() both reference `.enum` handling, so a
    // pre-fix build would declare this const twice (once per handler
    // invocation) even though check() only invokes it once more.
    const memberConstDecls = source.match(/const __members\d+ = /g) ?? []
    expect(memberConstDecls).toHaveLength(1)
  })

  it("an object's known-field Set is hoisted once, not once per check/errors/parse", () => {
    const ref = t(types.object({ name: t(types.string) }), { additionalProperties: false })
    const source = compileValidator(ref)
    const occurrences = source.split("new Set(").length - 1
    expect(occurrences).toBe(1)
  })
})
