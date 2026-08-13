// mcp.source().
//
// Two things to hold: the literal key-and-store association survives into
// `meta.mcp.sourceMap` as types, and `op()` rejects a map naming a parameter
// the handler does not have or a store MCP does not know. The same ground
// http-api-projector/src/verbs.test.ts covers for `http.source()`; the shared
// mechanism is described in docs/design/wire-profiles-and-staged-validation.md,
// under "UncoveredSourceParams generalizes".

import { describe, expect, expectTypeOf, it } from "bun:test";
import { op } from "@rhi-zone/fractal-api-tree/node";
import type { FindStoreForParam } from "@rhi-zone/fractal-api-tree";
import { mcp, source } from "./source.ts";

describe("mcp.source() preserves literal key/store association", () => {
  it("a source() map's keys and stores survive as literal types on meta.mcp.sourceMap", () => {
    const getBook = (input: { bookId: string; note: string }) => input;
    const n = op(
      getBook,
      mcp.source({ bookId: "uri-variable" }),
      source({ note: { store: "argument", key: "comment" } }),
    );

    type Meta = typeof n.meta;
    expectTypeOf<FindStoreForParam<Meta, "bookId">>().toEqualTypeOf<"uri-variable">();
    expectTypeOf<FindStoreForParam<Meta, "note">>().toEqualTypeOf<"argument">();

    expect(n.meta.mcp?.sourceMap).toEqual({
      bookId: { store: "uri-variable", key: "bookId" },
      note: { store: "argument", key: "comment" },
    });
  });
});

describe("op() rejects an mcp.source() param the handler doesn't declare", () => {
  it("a mistyped param name is a compile error at the op() call site", () => {
    const getBook = (input: { bookId: string }) => input;

    op(getBook, mcp.source({ bookId: "argument" }));

    // @ts-expect-error — "bookid" is not one of getBook's input keys.
    op(getBook, mcp.source({ bookid: "argument" }));

    expect(true).toBe(true);
  });

  it("an unregistered store name is a compile error", () => {
    const getBook = (input: { bookId: string }) => input;

    // @ts-expect-error — "database" is not a registered McpStoreName.
    op(getBook, mcp.source({ bookId: "database" }));

    expect(true).toBe(true);
  });
});
