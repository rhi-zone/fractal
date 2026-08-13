// packages/json-rpc-api-projector/src/source.test.ts — jsonrpc.source() tests
//
// Mirrors http-api-projector/src/verbs.test.ts's `http.source()` coverage —
// docs/design/wire-profiles-and-staged-validation.md's "Prerequisite: meta
// unification" §"UncoveredSourceParams generalizes": the SAME op()-time
// static coverage check http has now also has a literal-preserving
// authoring path for jsonrpc.

import { describe, expect, expectTypeOf, it } from "bun:test";
import { op } from "@rhi-zone/fractal-api-tree/node";
import type { FindStoreForParam } from "@rhi-zone/fractal-api-tree";
import { jsonrpc, source } from "./source.ts";

describe("jsonrpc.source() preserves literal key/store association", () => {
  it("a source() map's keys and stores survive as literal types on meta.jsonrpc.sourceMap", () => {
    const getBook = (input: { bookId: string; note: string }) => input;
    const n = op(
      getBook,
      jsonrpc.source({ bookId: "params" }),
      source({ note: { store: "caller", key: "who" } }),
    );

    type Meta = typeof n.meta;
    expectTypeOf<FindStoreForParam<Meta, "bookId">>().toEqualTypeOf<"params">();
    expectTypeOf<FindStoreForParam<Meta, "note">>().toEqualTypeOf<"caller">();

    expect(n.meta.jsonrpc?.sourceMap).toEqual({
      bookId: { store: "params", key: "bookId" },
      note: { store: "caller", key: "who" },
    });
  });
});

describe("op() rejects a jsonrpc.source() param the handler doesn't declare", () => {
  it("a mistyped param name is a compile error at the op() call site", () => {
    const getBook = (input: { bookId: string }) => input;

    op(getBook, jsonrpc.source({ bookId: "params" }));

    // @ts-expect-error — "bookid" is not one of getBook's input keys.
    op(getBook, jsonrpc.source({ bookid: "params" }));

    expect(true).toBe(true);
  });

  it("an unregistered store name is a compile error", () => {
    const getBook = (input: { bookId: string }) => input;

    // @ts-expect-error — "database" is not a registered JsonRpcStoreName.
    op(getBook, jsonrpc.source({ bookId: "database" }));

    expect(true).toBe(true);
  });
});
