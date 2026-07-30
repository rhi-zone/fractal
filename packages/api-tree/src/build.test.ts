// packages/api-tree/src/build.test.ts — build orchestrator tests
//
// Covers: the build orchestrator wires extraction (extract.ts/tree.ts) ->
// @rhi-zone/fractal-type-ir's compileValidatorModule end-to-end, entryFile ->
// compiled module; and `wrapValidators`' wiring of that generated
// `{ check, errors, parse }` map directly onto a `Node` tree's handlers.

import { describe, expect, it } from "bun:test"
import {
  buildValidatorModuleSource,
  isValidatorWrapped,
  stubValidatorModuleSource,
  wrapValidators,
} from "./build.ts"
import type { GeneratedEntry } from "./build.ts"
import { api, op } from "./node.ts"
import type { Node } from "./node.ts"
import { isResultShape } from "./index.ts"
import { createExtractorProgram, defaultShouldShare } from "./extract.ts"

/** Strip TypeScript syntax (type annotations, `as` casts, `import type`) via
 * Bun's transpiler — `buildValidatorModuleSource` now emits typed guards, so
 * the raw source is no longer plain JS `new Function` can parse directly;
 * this mirrors what the consuming toolchain (Bun/tsc) does to the generated
 * file before running it. */
const tsTranspiler = new Bun.Transpiler({ loader: "ts" })

type Triple = {
  check: (value: unknown) => boolean
  errors: (value: unknown) => unknown[]
  parse: (value: unknown) => { kind: "ok"; value: unknown } | { kind: "err"; errors: unknown[] }
}

/** Evaluate a `compileValidatorModule(...)`-produced module source into its `validators` map. */
function evalModule(source: string): Record<string, Triple> {
  const commonJs = tsTranspiler.transformSync(source).replace("export const validators", "const validators") + "\nreturn validators;"
  return new Function(commonJs)()
}

describe("build orchestrator — entryFile -> compiled module, end-to-end", () => {
  const FIXTURE = `${import.meta.dir}/__fixtures__/tree.fixture.ts`
  const SHARING_FIXTURE = `${import.meta.dir}/__fixtures__/sharing-input.fixture.ts`

  it("builds a validator module from the tree fixture, keyed by route path", () => {
    const source = buildValidatorModuleSource(FIXTURE)
    expect(source).toContain('"users/create"')
    expect(source).toContain('"users/:userId/get"')

    const validators = evalModule(source)
    expect(
      validators["users/create"]!.check({
        name: "Alice",
        roles: ["admin"],
        address: { street: "Main" },
      }),
    ).toBe(true)
    expect(validators["users/create"]!.check({})).toBe(false)
    expect(validators["users/:userId/get"]!.check({ userId: "u1" })).toBe(true)
  })

  it("stubValidatorModuleSource emits an empty validators map", () => {
    expect(evalModule(stubValidatorModuleSource())).toEqual({})
  })

  it("without an outFile, a NAMED parameter type inlines its structure (no import, since there's no output location to resolve one against)", () => {
    const source = buildValidatorModuleSource(FIXTURE)
    // The module always imports `ValidationError` from type-ir regardless of
    // outFile — only a NAMED parameter type's import depends on having an
    // outFile to resolve a relative path against.
    expect(source.split("\n").filter((line) => line.startsWith("import type"))).toEqual([
      'import type { ValidationError } from "@rhi-zone/fractal-type-ir"',
    ])
    expect(source).toContain("value is { q?: string }")
  })

  it("given an outFile, a NAMED parameter type (BookQuery, __fixtures__/tree.fixture.ts) is imported by a path relative to outFile, not inlined", () => {
    const outFile = `${import.meta.dir}/generated/validators.ts`
    const source = buildValidatorModuleSource(FIXTURE, outFile)
    expect(source).toContain('import type { BookQuery } from "../__fixtures__/tree.fixture.ts"')
    expect(source).toContain("value is BookQuery")
    expect(source).not.toContain("value is { q?: string }")

    const validators = evalModule(source)
    expect(validators["namedType/search"]!.check({ q: "x" })).toBe(true)
    expect(validators["namedType/search"]!.check({})).toBe(true)
  })

  // Regression: a handler input typed directly as a TS builtin/global
  // utility type (`Record<K,V>`, `Partial<T>`, …) is NAMEABLE
  // (`type.aliasSymbol.name === "Record"`) exactly like a real project type
  // is, but its declaration lives in TypeScript's own bundled `lib.es5.d.ts`
  // — there is no module at that path to import from. Before the
  // `typeProvenanceOf` fix (extract.ts), an `outFile` triggered
  // `import type { Record } from ".../lib.es5.d.ts"` in the generated
  // module — invalid downstream (`TS2306: File '…' is not a module`) no
  // matter where `outFile` lives. Fixture leaf: `builtinNamedInput/merge`
  // (`__fixtures__/tree.fixture.ts`), input typed `Record<string, string>`.
  it("given an outFile, a builtin/global TS utility type (Record) inlines structurally — no import to a TS lib .d.ts file", () => {
    const outFile = `${import.meta.dir}/generated/validators.ts`
    const source = buildValidatorModuleSource(FIXTURE, outFile)
    // No import at all naming `Record` — TypeScript's global utility types
    // never need one. The annotation itself legitimately still SAYS
    // `Record<string, string>` (an inlined, ambient-global reference,
    // exactly like an ordinary `Array<T>`/`Map<K,V>` annotation would) —
    // only a spurious `import type { Record } from "…"` is the bug.
    expect(source).not.toContain("import type { Record }")
    expect(source).not.toMatch(/import type \{[^}]*\} from "[^"]*lib\.[a-z0-9.]*\.d\.ts"/i)
    expect(source).toContain("value is Record<string, string>")

    const validators = evalModule(source)
    expect(validators["builtinNamedInput/merge"]!.check({ a: "x" })).toBe(true)
    expect(validators["builtinNamedInput/merge"]!.check({ a: 1 })).toBe(false)
  })

  // Regression, end-to-end: a leaf whose RETURN type reaches into a TS/DOM
  // builtin's generically self-referential, symbol-keyed-member-bearing
  // structure (`Response`, fixture leaf `builtinReturnType/fetchIt`) must
  // produce a module that's syntactically valid TypeScript top to bottom —
  // the call-budget circuit breaker alone (type-ir's from-typescript.ts)
  // stops the RangeError, but the resulting TypeRef still needed a SECOND
  // fix (excluding symbol-keyed properties like `Uint8Array`'s
  // `[Symbol.iterator]`, whose TS-synthetic name — e.g. `"__@iterator@8"`
  // — isn't valid to emit as a bare object-type field name) before the
  // generated annotation text itself stopped being a syntax error. This
  // test is the one that actually would have caught that second bug —
  // from-typescript.test.ts's unit-level coverage checks the TypeRef
  // shape, not the compiled TEXT.
  it("a leaf reaching into a TS/DOM builtin's structure (Response, via its return type) compiles to syntactically valid TS", () => {
    const source = buildValidatorModuleSource(FIXTURE)
    expect(source).not.toContain("__@")
    // Bun's transpiler throws on invalid syntax — `evalModule` (used
    // throughout this file) already exercises this implicitly, but do it
    // explicitly here so a syntax error inside this one entry's annotation
    // text fails with a clear message pointing at this leaf, not a cryptic
    // parse error from whichever OTHER entry evalModule happens to hit
    // first.
    expect(() => tsTranspiler.transformSync(source)).not.toThrow()
  })

  it("without shouldShare, no defs are emitted — every route's input inlines its full structure (prior behavior)", () => {
    const source = buildValidatorModuleSource(SHARING_FIXTURE)
    expect(source).not.toContain("__def_Address_check")
  })

  it("with shouldShare, a type reused across routes' inputs compiles to ONE shared def, called from every ref site", () => {
    const source = buildValidatorModuleSource(SHARING_FIXTURE, undefined, defaultShouldShare)
    expect(source.match(/function __def_Address_check\(/g) ?? []).toHaveLength(1)

    const validators = evalModule(source)
    const validAddress = { street: "Main", city: "X", zip: "1", country: "Y", region: "Z", landmark: "L" }
    expect(validators["setBilling"]!.check({ userId: "u1", billing: validAddress })).toBe(true)
    expect(validators["setBilling"]!.check({ userId: "u1", billing: {} })).toBe(false)
    expect(validators["setShipping"]!.check({ userId: "u1", shipping: validAddress })).toBe(true)
  })

  // Regression: a caller doing BATCH extraction across many entry files (e.g.
  // busiless's codegen-fractal-validators.ts, 16 slices in one process) used
  // to have no way to avoid building 16 independent full `ts.Program`s in one
  // long-lived process — each Program's transitive-import parse+bind cost
  // (multi-GB for a real app) piling up faster than the GC reclaimed earlier
  // ones, which is exactly how that script reached 20+GB RSS and repeatedly
  // OOM-killed unrelated processes on the host. The 4th `program` parameter
  // lets a batch caller build ONE shared `ts.Program` (via
  // `createExtractorProgram`'s multi-root overload) and reuse it across every
  // `buildValidatorModuleSource` call — this test only proves the plumbing is
  // correct (same output, program's source-file table actually consulted, no
  // duplicate Program silently built underneath); the memory-shape regression
  // guard itself lives in type-ir's `from-typescript.memory.test.ts`, which
  // is where `createExtractorProgram` — the thing that actually holds the
  // multi-GB cost — is defined.
  it("passing a pre-built program (createExtractorProgram) produces byte-identical output to the default per-call program", () => {
    const withoutProgram = buildValidatorModuleSource(FIXTURE, undefined, undefined)
    const program = createExtractorProgram(FIXTURE)
    const withProgram = buildValidatorModuleSource(FIXTURE, undefined, undefined, program)
    expect(withProgram).toEqual(withoutProgram)
  })

  it("a program shared across TWO different entry files (multi-root) extracts each correctly", () => {
    const program = createExtractorProgram([FIXTURE, SHARING_FIXTURE])
    const fixtureSource = buildValidatorModuleSource(FIXTURE, undefined, undefined, program)
    const sharingSource = buildValidatorModuleSource(SHARING_FIXTURE, undefined, defaultShouldShare, program)

    expect(fixtureSource).toEqual(buildValidatorModuleSource(FIXTURE))
    expect(sharingSource).toEqual(buildValidatorModuleSource(SHARING_FIXTURE, undefined, defaultShouldShare))
  })
})

describe("wrapValidators — Node-level counterpart to route.ts's injectValidators", () => {
  /** A synthetic GeneratedEntry: rejects `id` fields that aren't a positive
   * integer string, coercing a valid one to a number — enough to prove
   * parse()'s coercion actually reaches the wrapped handler's input. */
  function idEntry(): GeneratedEntry {
    return {
      parse: (value: unknown) => {
        if (typeof value !== "object" || value === null) {
          return { kind: "err", errors: [{ kind: "type", path: [], expected: "object", actual: value }] }
        }
        const id = (value as Record<string, unknown>).id
        if (typeof id !== "string" || !/^\d+$/.test(id)) {
          return { kind: "err", errors: [{ kind: "type", path: ["id"], expected: "numeric string", actual: id }] }
        }
        return { kind: "ok", value: { ...(value as Record<string, unknown>), id: Number(id) } }
      },
    }
  }

  it("wraps a matching leaf: parse() runs first, handler receives the parsed value", async () => {
    const handler = (input: { id: number }) => ({ doubled: input.id * 2 })
    const tree = api({ get: op(handler) })
    const wrapped = wrapValidators(tree, { get: idEntry() })

    const result = await Promise.resolve(wrapped.children!.get!.handler!({ id: "21" }))
    expect(result).toEqual({ doubled: 42 })
  })

  it("returns an err Result (carrying the structured errors) instead of calling the handler on invalid input", async () => {
    const handler = (input: { id: number }) => ({ doubled: input.id * 2 })
    const tree = api({ get: op(handler) })
    const wrapped = wrapValidators(tree, { get: idEntry() })

    const result = await Promise.resolve(wrapped.children!.get!.handler!({ id: "not-a-number" }))
    expect(isResultShape(result)).toBe(true)
    if (!isResultShape(result) || result.kind !== "err") throw new Error("expected an err Result")
    expect(result.error).toEqual([
      { kind: "type", path: ["id"], expected: "numeric string", actual: "not-a-number" },
    ])
  })

  it("a leaf with no matching validator entry passes through with its original handler, untouched", () => {
    const handler = (input: { id: number }) => input
    const tree = api({ get: op(handler), other: op(handler) })
    const wrapped = wrapValidators(tree, { get: idEntry() }) // no entry for "other"

    expect(wrapped.children!.other!.handler).toBe(handler) // same reference — untouched
    expect(isValidatorWrapped(wrapped.children!.other!.handler!)).toBe(false)
    expect(wrapped.children!.get!.handler).not.toBe(handler) // wrapped — different reference
    expect(isValidatorWrapped(wrapped.children!.get!.handler!)).toBe(true)
  })

  it("keys nested children by '/'-joined path, matching extractRouteTypeRefs' convention", async () => {
    const handler = (input: { id: number }) => input
    const tree = api({ users: api({ get: op(handler) }) })
    const wrapped = wrapValidators(tree, { "users/get": idEntry() })

    expect(isValidatorWrapped(wrapped.children!.users!.children!.get!.handler!)).toBe(true)
    const result = await Promise.resolve(wrapped.children!.users!.children!.get!.handler!({ id: "7" }))
    expect(result).toEqual({ id: 7 })
  })

  it("keys a fallback (wildcard-capture) segment as ':name', matching the generated module's path convention", () => {
    const handler = (input: { id: number }) => input
    const tree = api(
      {},
      { fallback: { name: "userId", subtree: api({ get: op(handler) }) } },
    )
    const wrapped = wrapValidators(tree, { ":userId/get": idEntry() })

    expect(isValidatorWrapped((wrapped.fallback!.subtree.children!.get as Node).handler!)).toBe(true)
  })

  it("never mutates the input Node tree", () => {
    const handler = (input: { id: number }) => input
    const originalHandler = handler
    const tree = api({ get: op(handler) })
    const snapshotHandler = tree.children!.get!.handler

    wrapValidators(tree, { get: idEntry() })

    expect(tree.children!.get!.handler).toBe(snapshotHandler)
    expect(tree.children!.get!.handler).toBe(originalHandler)
  })

  it("returns a fresh tree — the root and every rebuilt branch are new objects", () => {
    const handler = (input: { id: number }) => input
    const tree = api({ get: op(handler) })
    const wrapped = wrapValidators(tree, { get: idEntry() })

    expect(wrapped).not.toBe(tree)
    expect(wrapped.children).not.toBe(tree.children)
  })

  it("an empty validators map wraps nothing", () => {
    const handler = (input: { id: number }) => input
    const tree = api({ get: op(handler) })
    const wrapped = wrapValidators(tree, {})

    expect(wrapped.children!.get!.handler).toBe(handler)
    expect(isValidatorWrapped(wrapped.children!.get!.handler!)).toBe(false)
  })
})
