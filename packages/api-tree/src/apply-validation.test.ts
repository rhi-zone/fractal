// packages/api-tree/src/apply-validation.test.ts — applyValidation runtime tests
//
// Covers the structural walker (both recognized leaf shapes: a direct
// `handler`, and an `HttpRoute`-style `methods` record whose entries carry
// handlers), the keyed pass-through/duplicate-key contract, and the loud
// build-mode coverage check.

import { describe, expect, it } from "bun:test"
import {
  assertValidationCoverage,
  createApplyValidation,
  isApplyValidationWrapped,
  UncoveredLeafError,
} from "./apply-validation.ts"
import type { GeneratedEntry, ValidatorMap, WireValidatorMap } from "./apply-validation.ts"
import { api, op } from "./node.ts"
import { isResultShape } from "./index.ts"

/** A generated-entry stand-in: accepts an object carrying `ok: true`, and
 * narrows it by adding `parsed: true` (so a test can tell the handler saw the
 * PARSED value, not the raw one). */
const entry = (): GeneratedEntry => ({
  parse: (value: unknown) =>
    typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true
      ? { kind: "ok", value: { ...(value as object), parsed: true } }
      : { kind: "err", errors: [{ kind: "type", got: value }] },
})

/** An `HttpRoute`-shaped fixture — handlers one level deeper, under
 * `methods.<VERB>`, with per-method `meta`. Built as a plain object literal:
 * api-tree can't import http-api-projector (the dependency runs the other
 * way), and the walker matches structurally, so the literal is the whole
 * contract. */
function routeTree(seen: string[]) {
  return {
    meta: {},
    children: {
      books: {
        meta: {},
        methods: {
          GET: { handler: (input: unknown) => { seen.push("books.GET"); return input }, meta: {} },
          POST: { handler: (input: unknown) => { seen.push("books.POST"); return input }, meta: {} },
        },
        fallback: {
          name: "bookId",
          subtree: {
            meta: {},
            methods: {
              GET: { handler: (input: unknown) => { seen.push("byId.GET"); return input }, meta: {} },
            },
          },
        },
      },
    },
  }
}

describe("createApplyValidation — keyed application", () => {
  it("returns the tree untouched when the key isn't in the map (the stub/pass-through case)", () => {
    const applyValidation = createApplyValidation({})
    const tree = api({ list: op((input: { ok: boolean }) => input) })
    expect(applyValidation("books", tree)).toBe(tree)
  })

  it("throws when one key is used twice on the same returned function", () => {
    const applyValidation = createApplyValidation({ books: { list: entry() } })
    const tree = api({ list: op((input: { ok: boolean }) => input) })
    applyValidation("books", tree)
    expect(() => applyValidation("books", tree)).toThrow(/key "books" has already been used/)
  })

  it("independent keys applied to independent trees don't interfere", () => {
    const validators: ValidatorMap = { a: { list: entry() }, b: {} }
    const applyValidation = createApplyValidation(validators)
    const treeA = api({ list: op((input: { ok: boolean }) => input) })
    const treeB = api({ list: op((input: { ok: boolean }) => input) })
    const outA = applyValidation("a", treeA)
    const outB = applyValidation("b", treeB)
    expect(isApplyValidationWrapped(outA.children.list.handler)).toBe(true)
    expect(isApplyValidationWrapped(outB.children.list.handler)).toBe(false)
  })
})

/** A "query"-shaped entry: `page` coerces from a numeric string, matching
 * `queryProfile`'s posture. */
const queryLikeEntry = (): GeneratedEntry => ({
  parse: (value: unknown) => {
    const page = (value as { page?: unknown } | undefined)?.page
    if (typeof page === "string" && page.trim() !== "" && !Number.isNaN(Number(page))) {
      return { kind: "ok", value: { page: Number(page) } }
    }
    return { kind: "err", errors: [{ kind: "encoding", got: value }] }
  },
})

/** An "identity"-shaped entry: `page` must already be a number — a numeric
 * STRING is rejected, matching `identityProfile`'s strict, non-coercing
 * posture. */
const identityLikeEntry = (): GeneratedEntry => ({
  parse: (value: unknown) => {
    const page = (value as { page?: unknown } | undefined)?.page
    if (typeof page === "number") return { kind: "ok", value: { page } }
    return { kind: "err", errors: [{ kind: "type", got: value }] }
  },
})

describe("createApplyValidation — protocol-aware wrap selection (WireValidatorMap, 3-arg applyValidation)", () => {
  it("the SAME key/tree gets its OWN profile's parse per protocol — \"3\" decodes differently", async () => {
    const wireValidators: WireValidatorMap = {
      http: { list: { http: queryLikeEntry() } },
      identity: { list: { identity: identityLikeEntry() } },
    }
    const applyValidation = createApplyValidation({}, wireValidators)

    const httpOut = applyValidation("http", api({ list: op((input: { page: number }) => input) }), "http")
    const httpResult = (await httpOut.children.list.handler({ page: "3" } as never)) as unknown
    expect(httpResult).toEqual({ page: 3 })

    const identityOut = applyValidation(
      "identity",
      api({ list: op((input: { page: number }) => input) }),
      "identity",
    )
    const identityResult = (await identityOut.children.list.handler({ page: "3" } as never)) as unknown
    expect(isResultShape(identityResult)).toBe(true)
    expect((identityResult as { kind: string }).kind).toBe("err")
  })

  it("a 2-arg call is unaffected by an unrelated 3-arg protocol map (old behavior fully preserved)", () => {
    const validators: ValidatorMap = { books: { list: entry() } }
    const wireValidators: WireValidatorMap = { books: { list: { http: queryLikeEntry() } } }
    const applyValidation = createApplyValidation(validators, wireValidators)
    const out = applyValidation("books", api({ list: op((input: { ok: boolean }) => input) }))
    expect(isApplyValidationWrapped(out.children.list.handler)).toBe(true)
  })

  it("an omitted `wireValidators` argument defaults to {} — existing single-argument callers are unaffected", () => {
    const applyValidation = createApplyValidation({ books: { list: entry() } })
    const tree = api({ list: op((input: { ok: boolean }) => input) })
    expect(isApplyValidationWrapped(applyValidation("books", tree).children.list.handler)).toBe(true)
  })
})

describe("structural walker — direct `handler` (Node) shape", () => {
  const validators: ValidatorMap = {
    books: { list: entry(), ":bookId/get": entry() },
  }

  const tree = () =>
    api({
      list: op((input: { ok: boolean }) => input),
      unwired: op((input: { ok: boolean }) => input),
    }, {
      fallback: {
        name: "bookId",
        subtree: api({ get: op((input: { ok: boolean }) => input) }),
      },
    })

  it("wraps only the leaves whose path matches an entry", () => {
    const out = createApplyValidation(validators)("books", tree())
    expect(isApplyValidationWrapped(out.children.list.handler)).toBe(true)
    expect(isApplyValidationWrapped(out.children.unwired.handler)).toBe(false)
    expect(isApplyValidationWrapped(out.fallback.subtree.children.get.handler)).toBe(true)
  })

  it("passes the PARSED value to the handler on success", async () => {
    const out = createApplyValidation(validators)("books", tree())
    const parsed = (await out.children.list.handler({ ok: true } as never)) as unknown
    expect(parsed).toEqual({ ok: true, parsed: true })
  })

  it("short-circuits with a Result error and never calls the handler on failure", async () => {
    let called = false
    const source = api({ list: op((input: { ok: boolean }) => { called = true; return input }) })
    const out = createApplyValidation({ books: { list: entry() } })("books", source)
    const result = (await out.children.list.handler({ ok: false } as never)) as unknown
    expect(called).toBe(false)
    expect(isResultShape(result)).toBe(true)
    expect((result as { kind: string }).kind).toBe("err")
  })

  it("never mutates the input tree", () => {
    const source = api({ list: op((input: { ok: boolean }) => input) })
    const original = source.children.list.handler
    createApplyValidation({ books: { list: entry() } })("books", source)
    expect(source.children.list.handler).toBe(original)
  })
})

describe("structural walker — `methods`-nested (HttpRoute) shape", () => {
  it("wraps every method entry's handler at a matching path", async () => {
    const seen: string[] = []
    const out = createApplyValidation({ http: { books: entry() } })("http", routeTree(seen)) as ReturnType<
      typeof routeTree
    >
    expect(isApplyValidationWrapped(out.children.books.methods.GET.handler)).toBe(true)
    expect(isApplyValidationWrapped(out.children.books.methods.POST.handler)).toBe(true)
    await expect(out.children.books.methods.GET.handler({ ok: true })).resolves.toEqual({ ok: true, parsed: true })
    expect(seen).toEqual(["books.GET"])
  })

  it("keys a fallback position as `:name`, same as the Node shape", () => {
    const seen: string[] = []
    const out = createApplyValidation({ http: { "books/:bookId": entry() } })("http", routeTree(seen)) as ReturnType<
      typeof routeTree
    >
    expect(isApplyValidationWrapped(out.children.books.fallback.subtree.methods.GET.handler)).toBe(true)
    expect(isApplyValidationWrapped(out.children.books.methods.GET.handler)).toBe(false)
  })

  it("preserves fields it doesn't recognize (a method entry's `meta`, a projector's own additions)", () => {
    const route = {
      meta: { note: "root" },
      children: {
        books: {
          meta: {},
          methods: { GET: { handler: (input: unknown) => input, meta: { verb: "GET" }, sources: { paramNames: ["q"] } } },
        },
      },
    }
    const out = createApplyValidation({ http: { books: entry() } })("http", route)
    expect(out.meta).toEqual({ note: "root" })
    expect(out.children.books.methods.GET.meta).toEqual({ verb: "GET" })
    expect(out.children.books.methods.GET.sources).toEqual({ paramNames: ["q"] })
  })
})

describe("assertValidationCoverage — loud, build-mode only", () => {
  it("throws listing EVERY uncovered leaf path", () => {
    const tree = api({
      list: op((input: { ok: boolean }) => input),
      create: op((input: { ok: boolean }) => input),
    })
    let thrown: unknown
    try {
      assertValidationCoverage("books", tree, { books: {} })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(UncoveredLeafError)
    expect((thrown as UncoveredLeafError).paths).toEqual(["list", "create"])
    expect((thrown as UncoveredLeafError).message).toContain("tags: { unvalidated: true }")
  })

  it("passes when a leaf is tagged meta.tags.unvalidated", () => {
    const tree = api({
      list: op((input: { ok: boolean }) => input, { tags: { unvalidated: true } }),
    })
    expect(() => assertValidationCoverage("books", tree, { books: {} })).not.toThrow()
  })

  it("passes when every leaf has a validator entry", () => {
    const tree = api({ list: op((input: { ok: boolean }) => input) })
    expect(() => assertValidationCoverage("books", tree, { books: { list: entry() } })).not.toThrow()
  })

  it("treats an unknown key as `nothing generated` — every leaf uncovered", () => {
    const tree = api({ list: op((input: { ok: boolean }) => input) })
    expect(() => assertValidationCoverage("missing", tree, {})).toThrow(UncoveredLeafError)
  })

  it("checks the `methods` shape too, per-method-entry meta included", () => {
    const seen: string[] = []
    expect(() => assertValidationCoverage("http", routeTree(seen), { http: {} })).toThrow(UncoveredLeafError)
    const tagged = {
      meta: {},
      children: {
        books: {
          meta: {},
          methods: { GET: { handler: (input: unknown) => input, meta: { tags: { unvalidated: true } } } },
        },
      },
    }
    expect(() => assertValidationCoverage("http", tagged, { http: {} })).not.toThrow()
  })

  it("is NOT run by applyValidation itself — the stub stays permissive", () => {
    const applyValidation = createApplyValidation({})
    const tree = api({ list: op((input: { ok: boolean }) => input) })
    expect(() => applyValidation("books", tree)).not.toThrow()
  })
})
