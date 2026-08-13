// packages/graphql-api-projector/src/source.test.ts — graphql.source() tests
//
// Mirrors http-api-projector/src/verbs.test.ts's `http.source()` coverage —
// docs/design/wire-profiles-and-staged-validation.md's "Prerequisite: meta
// unification" §"UncoveredSourceParams generalizes": the SAME op()-time
// static coverage check http has now also has a literal-preserving
// authoring path for graphql.

import { describe, expect, expectTypeOf, it } from "bun:test";
import { op } from "@rhi-zone/fractal-api-tree/node";
import type { FindStoreForParam } from "@rhi-zone/fractal-api-tree";
import { graphql, source } from "./source.ts";

describe("graphql.source() preserves literal key/store association", () => {
  it("a source() map's keys and stores survive as literal types on meta.graphql.sourceMap", () => {
    const getBook = (input: { bookId: string; note: string }) => input;
    const n = op(
      getBook,
      graphql.source({ bookId: "argument" }),
      source({ note: { store: "caller", key: "who" } }),
    );

    type Meta = typeof n.meta;
    expectTypeOf<FindStoreForParam<Meta, "bookId">>().toEqualTypeOf<"argument">();
    expectTypeOf<FindStoreForParam<Meta, "note">>().toEqualTypeOf<"caller">();

    expect(n.meta.graphql?.sourceMap).toEqual({
      bookId: { store: "argument", key: "bookId" },
      note: { store: "caller", key: "who" },
    });
  });
});

describe("op() rejects a graphql.source() param the handler doesn't declare", () => {
  it("a mistyped param name is a compile error at the op() call site", () => {
    const getBook = (input: { bookId: string }) => input;

    op(getBook, graphql.source({ bookId: "argument" }));

    // @ts-expect-error — "bookid" is not one of getBook's input keys.
    op(getBook, graphql.source({ bookid: "argument" }));

    expect(true).toBe(true);
  });

  it("an unregistered store name is a compile error", () => {
    const getBook = (input: { bookId: string }) => input;

    // @ts-expect-error — "database" is not a registered GraphQLStoreName.
    op(getBook, graphql.source({ bookId: "database" }));

    expect(true).toBe(true);
  });
});
