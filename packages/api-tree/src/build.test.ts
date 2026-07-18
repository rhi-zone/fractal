// packages/api-tree/src/build.test.ts — build orchestrator tests
//
// Covers: the build orchestrator wires extraction (extract.ts/tree.ts) ->
// @rhi-zone/fractal-type-ir's compileValidatorModule end-to-end, entryFile ->
// compiled module, and `toValidatorRecord`'s adaptation of the generated
// `{ check, errors, parse }` triples into the single-function `Validator`
// shape `createApplyValidation` expects.

import { describe, expect, it } from "bun:test"
import {
  buildValidatorModuleSource,
  HandlerValidationError,
  isValidatorWrapped,
  stubValidatorModuleSource,
  toValidatorRecord,
  wrapValidators,
} from "./build.ts"
import type { GeneratedEntry } from "./build.ts"
import { api, op } from "./node.ts"
import type { Node } from "./node.ts"

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

  it("throws HandlerValidationError (carrying the structured errors) instead of calling the handler on invalid input", async () => {
    const handler = (input: { id: number }) => ({ doubled: input.id * 2 })
    const tree = api({ get: op(handler) })
    const wrapped = wrapValidators(tree, { get: idEntry() })

    await expect(Promise.resolve(wrapped.children!.get!.handler!({ id: "not-a-number" }))).rejects.toThrow(
      HandlerValidationError,
    )
    try {
      await wrapped.children!.get!.handler!({ id: "not-a-number" })
      throw new Error("expected rejection")
    } catch (err) {
      expect(err).toBeInstanceOf(HandlerValidationError)
      expect((err as HandlerValidationError).errors).toEqual([
        { kind: "type", path: ["id"], expected: "numeric string", actual: "not-a-number" },
      ])
    }
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

  it("keys a fallback (wildcard-capture) segment as ':name', matching route.ts's pathKey convention", () => {
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

describe("toValidatorRecord — adapts { check, errors, parse } into a single-function Validator", () => {
  it("wraps parse's ok branch through unchanged", () => {
    const source = buildValidatorModuleSource(`${import.meta.dir}/__fixtures__/tree.fixture.ts`)
    const validators = evalModule(source)
    const adapted = toValidatorRecord(validators)
    const result = adapted["users/:userId/get"]!({ userId: "u1" })
    expect(result).toEqual({ kind: "ok", value: { userId: "u1" } })
  })

  it("wraps parse's err branch, renaming errors (plural) to error (singular) to match Result<T,E>", () => {
    const source = buildValidatorModuleSource(`${import.meta.dir}/__fixtures__/tree.fixture.ts`)
    const validators = evalModule(source)
    const adapted = toValidatorRecord(validators)
    const result = adapted["users/create"]!({}) as { kind: "err"; error: unknown[] }
    expect(result.kind).toBe("err")
    expect(Array.isArray(result.error)).toBe(true)
    expect(result.error.length).toBeGreaterThan(0)
  })
})
