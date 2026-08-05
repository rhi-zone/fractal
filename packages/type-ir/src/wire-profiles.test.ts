// packages/type-ir/src/wire-profiles.test.ts — staged wire-profile validator
// codegen (Wire --validateEncoding--> ValidWire --decode--> T
// --defaults-fill--> T --validateConstraints--> valid T).
//
// See docs/design/wire-profiles-and-staged-validation.md for the design this
// exercises, and compile.ts's "Wire profiles + staged validation" section for
// the implementation. Mirrors compile.test.ts's eval-the-generated-source
// convention.

import { describe, expect, it } from "bun:test"
import {
  argvProfile,
  compileConstraintsFn,
  compileWireModule,
  identityProfile,
  jsonProfile,
  queryProfile,
  wireTypeText,
  wireValidatorKey,
  type ValidationError,
  type WireProfile,
} from "./compile.ts"
import { t, type TypeRef, types } from "./index.ts"
import { datetime } from "./kinds/common.ts"

type WireTriple = {
  parse: (wire: unknown) => { kind: "ok"; value: unknown } | { kind: "err"; errors: ValidationError[] }
}

const tsTranspiler = new Bun.Transpiler({ loader: "ts" })
function stripTypes(source: string): string {
  return tsTranspiler.transformSync(source).trim().replace(/;$/, "")
}

function evalWireModule(source: string): Record<string, WireTriple> {
  const commonJs = stripTypes(source).replace("export const wireValidators", "const wireValidators") + "\nreturn wireValidators;"
  return new Function(commonJs)()
}

/** Compile+evaluate ONE (entry, profile) pair via the full `compileWireModule`
 * assembly (not a hand-rolled harness) — realistic end-to-end, and exercises
 * `assembleWireModule`'s module-scope wiring (the shared `__inferTypeRef`
 * helper, the `ValidationError` type, the by-name `constraintsFn` call) the
 * same way a real generated module would. */
function evalWireEntry(name: string, ref: TypeRef, profile: WireProfile): WireTriple {
  const mod = evalWireModule(compileWireModule([{ name, ref }], [profile]))
  return mod[wireValidatorKey(name, profile.name)]!
}

describe("wire profiles — per-profile emission", () => {
  it("argv: coerces a numeric string field, rejects a non-numeric one", () => {
    const ref = t(types.object({ page: t(types.number) }))
    const v = evalWireEntry("Page", ref, argvProfile)
    expect(v.parse({ page: "42" })).toEqual({ kind: "ok", value: { page: 42 } })
    const err = v.parse({ page: "abc" }) as { kind: "err"; errors: ValidationError[] }
    expect(err.kind).toBe("err")
    expect(err.errors[0]!.kind).toBe("encoding")
  })

  it("query: same numeric-string coercion as argv", () => {
    const ref = t(types.object({ page: t(types.number) }))
    const v = evalWireEntry("Page", ref, queryProfile)
    expect(v.parse({ page: "7" })).toEqual({ kind: "ok", value: { page: 7 } })
  })

  it("json: numbers/booleans/strings arrive already typed, no coercion", () => {
    const ref = t(types.object({ count: t(types.number), active: t(types.boolean) }))
    const v = evalWireEntry("Counter", ref, jsonProfile)
    expect(v.parse({ count: 3, active: true })).toEqual({ kind: "ok", value: { count: 3, active: true } })
    // A numeric STRING is a wire-shape violation under json (typed wire, no
    // coercion) — unlike argv/query, where the same input coerces.
    const err = v.parse({ count: "3", active: true }) as { kind: "err"; errors: ValidationError[] }
    expect(err.kind).toBe("err")
    expect(err.errors[0]!.kind).toBe("type")
  })

  it("json: date/datetime still coerce from an ISO string (JSON has no date literal)", () => {
    const ref = t(types.object({ createdAt: datetime() }))
    const v = evalWireEntry("Event", ref, jsonProfile)
    const ok = v.parse({ createdAt: "2024-01-01T00:00:00.000Z" }) as { kind: "ok"; value: { createdAt: Date } }
    expect(ok.kind).toBe("ok")
    expect(ok.value.createdAt).toBeInstanceOf(Date)
  })

  it("identity: no coercion at all — a numeric string is an encoding error, not a decode", () => {
    const ref = t(types.object({ count: t(types.number) }))
    const v = evalWireEntry("Counter", ref, identityProfile)
    expect(v.parse({ count: 3 })).toEqual({ kind: "ok", value: { count: 3 } })
    const err = v.parse({ count: "3" }) as { kind: "err"; errors: ValidationError[] }
    expect(err.kind).toBe("err")
    expect(err.errors[0]!.kind).toBe("type")
  })

  it("identity IS strict validation: full constraint check still runs (min/max on T)", () => {
    const ref = t(types.object({ age: t(types.number, { minimum: 0, maximum: 130 }) }))
    const v = evalWireEntry("Person", ref, identityProfile)
    const err = v.parse({ age: 200 }) as { kind: "err"; errors: ValidationError[] }
    expect(err.kind).toBe("err")
    expect(err.errors[0]!.kind).toBe("max")
  })
})

describe("wire profiles — strict boolean encoding", () => {
  it("query: only \"true\"/\"false\" strings, no native boolean, no loose spellings", () => {
    const ref = t(types.object({ active: t(types.boolean) }))
    const v = evalWireEntry("Flag", ref, queryProfile)
    expect(v.parse({ active: "true" })).toEqual({ kind: "ok", value: { active: true } })
    expect(v.parse({ active: "false" })).toEqual({ kind: "ok", value: { active: false } })
    expect((v.parse({ active: "1" }) as { kind: "err" }).kind).toBe("err")
    expect((v.parse({ active: "yes" }) as { kind: "err" }).kind).toBe("err")
    expect((v.parse({ active: true }) as { kind: "err" }).kind).toBe("err")
  })

  it("argv: native true/false sentinel OR strict \"true\"/\"false\" strings, no loose spellings", () => {
    const ref = t(types.object({ verbose: t(types.boolean) }))
    const v = evalWireEntry("Flags", ref, argvProfile)
    expect(v.parse({ verbose: true })).toEqual({ kind: "ok", value: { verbose: true } })
    expect(v.parse({ verbose: "true" })).toEqual({ kind: "ok", value: { verbose: true } })
    expect(v.parse({ verbose: "false" })).toEqual({ kind: "ok", value: { verbose: false } })
    expect((v.parse({ verbose: "1" }) as { kind: "err" }).kind).toBe("err")
    expect((v.parse({ verbose: "yes" }) as { kind: "err" }).kind).toBe("err")
  })
})

describe("wire profiles — ValidWire typing", () => {
  it("argv: a number field's ValidWire type is string", () => {
    expect(wireTypeText(t(types.number), argvProfile)).toBe("string")
  })

  it("argv: a boolean field's ValidWire type is the boolean|string-literal union", () => {
    expect(wireTypeText(t(types.boolean), argvProfile)).toBe(`boolean | "true" | "false"`)
  })

  it("query: a boolean field's ValidWire type is the strict string-literal union", () => {
    expect(wireTypeText(t(types.boolean), queryProfile)).toBe(`"true" | "false"`)
  })

  it("identity: a number field's ValidWire type is number (no coercion, wire IS T)", () => {
    expect(wireTypeText(t(types.number), identityProfile)).toBe("number")
  })

  it("object: every field renders optional in ValidWire, regardless of meta.optional", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.number) }))
    expect(wireTypeText(ref, argvProfile)).toBe(`{ "id"?: string; "age"?: string }`)
  })

  it("array of a coerced leaf renders element-wise", () => {
    const ref = t(types.array(t(types.number)))
    expect(wireTypeText(ref, argvProfile)).toBe("(string)[]")
  })
})

describe("wire profiles — defaults-fill", () => {
  it("fills a missing field's meta.default before constraint-checking, for every profile", () => {
    const ref = t(types.object({ limit: t(types.number, { default: 10, minimum: 1 }) }))
    for (const profile of [argvProfile, queryProfile, jsonProfile, identityProfile]) {
      const v = evalWireEntry("Query", ref, profile)
      expect(v.parse({})).toEqual({ kind: "ok", value: { limit: 10 } })
    }
  })

  it("a required field with no default still reports missing, post-fill (unchanged validateConstraints)", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const v = evalWireEntry("Item", ref, argvProfile)
    const err = v.parse({}) as { kind: "err"; errors: ValidationError[] }
    expect(err.errors).toEqual([{ kind: "missing", path: ["id"] }])
  })

  it("a caller-supplied value is unaffected by a field's default", () => {
    const ref = t(types.object({ limit: t(types.number, { default: 10 }) }))
    const v = evalWireEntry("Query", ref, argvProfile)
    expect(v.parse({ limit: "5" })).toEqual({ kind: "ok", value: { limit: 5 } })
  })
})

describe("wire profiles — shared constraint validator reused across profiles", () => {
  it("compileConstraintsFn's output is identical text regardless of which profile will call it", () => {
    const ref = t(types.object({ age: t(types.number, { minimum: 0 }) }))
    const a = compileConstraintsFn("Person", ref)
    const b = compileConstraintsFn("Person", ref)
    expect(a.lines.join("\n")).toBe(b.lines.join("\n"))
  })

  it("compileWireModule emits the constraints fn ONCE per entry even when requested for multiple profiles", () => {
    const ref = t(types.object({ age: t(types.number, { minimum: 0 }) }))
    const source = compileWireModule([{ name: "Person", ref }], [argvProfile, jsonProfile, identityProfile])
    const occurrences = source.split("function __constraints_Person(").length - 1
    expect(occurrences).toBe(1)
  })

  it("the same min-constraint violation is caught identically whether reached via argv or json", () => {
    const ref = t(types.object({ age: t(types.number, { minimum: 0 }) }))
    const source = compileWireModule([{ name: "Person", ref }], [argvProfile, jsonProfile])
    const mod = evalWireModule(source)
    const argvErr = mod[wireValidatorKey("Person", "argv")]!.parse({ age: "-5" }) as { kind: "err"; errors: ValidationError[] }
    const jsonErr = mod[wireValidatorKey("Person", "json")]!.parse({ age: -5 }) as { kind: "err"; errors: ValidationError[] }
    expect(argvErr.errors).toEqual(jsonErr.errors)
    expect(argvErr.errors[0]!.kind).toBe("min")
  })
})

describe("wire profiles — error phrasing per stage", () => {
  it("encoding-stage error is phrased against the WIRE (expected: a shape description string)", () => {
    const ref = t(types.object({ page: t(types.number) }))
    const v = evalWireEntry("Page", ref, argvProfile)
    const err = v.parse({ page: "abc" }) as { kind: "err"; errors: ValidationError[] }
    expect(err.errors[0]).toEqual({ kind: "encoding", path: ["page"], expected: "numeric string (number)", actual: "abc" })
  })

  it("constraint-stage error is phrased against T (expected: a number, not a wire description)", () => {
    const ref = t(types.object({ age: t(types.number, { minimum: 18 }) }))
    const v = evalWireEntry("Person", ref, argvProfile)
    const err = v.parse({ age: "10" }) as { kind: "err"; errors: ValidationError[] }
    expect(err.errors[0]).toEqual({ kind: "min", path: ["age"], expected: 18, actual: 10, exclusive: false })
  })

  it("a wholly wrong wire shape (object expected, got an array) is an encoding error, not a type error", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const v = evalWireEntry("Item", ref, argvProfile)
    const err = v.parse([1, 2, 3]) as { kind: "err"; errors: ValidationError[] }
    expect(err.errors).toEqual([{ kind: "encoding", path: [], expected: "object", actual: [1, 2, 3] }])
  })
})

describe("wire profiles — object/array structural decode", () => {
  it("argv: array of numeric strings decodes element-wise", () => {
    const ref = t(types.object({ ids: t(types.array(t(types.number))) }))
    const v = evalWireEntry("Batch", ref, argvProfile)
    expect(v.parse({ ids: ["1", "2", "3"] })).toEqual({ kind: "ok", value: { ids: [1, 2, 3] } })
  })

  it("a field absent from the wire is left absent post-decode (no missing error at the encoding stage)", () => {
    const ref = t(types.object({ id: t(types.string), nickname: t(types.string, { optional: true }) }))
    const v = evalWireEntry("Item", ref, argvProfile)
    const err = v.parse({ id: "x" }) as { kind: "ok"; value: { id: string; nickname?: string } }
    expect(err).toEqual({ kind: "ok", value: { id: "x" } })
  })
})
