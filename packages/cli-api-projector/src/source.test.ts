// packages/cli-api-projector/src/source.test.ts — cli.source() tests
//
// Mirrors http-api-projector/src/verbs.test.ts's `http.source()` coverage —
// docs/design/wire-profiles-and-staged-validation.md's "Prerequisite: meta
// unification" §"UncoveredSourceParams generalizes": the SAME op()-time
// static coverage check http has now also has a literal-preserving
// authoring path for cli.
//
// The compile-time assertions here (`expectTypeOf`, `@ts-expect-error`)
// assert at `bun run typecheck` time; the runtime bodies exist only so
// `bun test` reports them. A `@ts-expect-error` that stops being an error
// fails typecheck with "Unused '@ts-expect-error' directive", so each
// negative case genuinely guards its invariant.

import { describe, expect, expectTypeOf, it } from "bun:test"
import { op } from "@rhi-zone/fractal-api-tree/node"
import type { FindStoreForParam } from "@rhi-zone/fractal-api-tree"
import { cli, source } from "./source.ts"

describe("cli.source() preserves literal key/store association", () => {
  it("a source() map's keys and stores survive as literal types on meta.cli.sourceMap", () => {
    const getBook = (input: { bookId: string; apiKey: string }) => input
    const n = op(getBook, cli.source({ apiKey: "env" }), source({ bookId: { store: "path", key: "id" } }))

    type Meta = typeof n.meta
    expectTypeOf<FindStoreForParam<Meta, "apiKey">>().toEqualTypeOf<"env">()
    expectTypeOf<FindStoreForParam<Meta, "bookId">>().toEqualTypeOf<"path">()

    expect(n.meta.cli?.sourceMap).toEqual({
      apiKey: { store: "env", key: "apiKey" },
      bookId: { store: "path", key: "id" },
    })
  })
})

describe("op() rejects a cli.source() param the handler doesn't declare", () => {
  it("a mistyped param name is a compile error at the op() call site", () => {
    const getBook = (input: { bookId: string }) => input

    op(getBook, cli.source({ bookId: "flag" }))

    // @ts-expect-error — "bookid" is not one of getBook's input keys.
    op(getBook, cli.source({ bookid: "flag" }))

    expect(true).toBe(true)
  })

  it("an unregistered store name is a compile error", () => {
    const getBook = (input: { bookId: string }) => input

    // @ts-expect-error — "database" is not a registered CliStoreName.
    op(getBook, cli.source({ bookId: "database" }))

    expect(true).toBe(true)
  })
})
