// packages/api-tree/src/wire-of-check.test.ts
//
// Decision 3 of docs/design/wire-profiles-and-staged-validation.md's
// implementation-trace addendum (function-form `encodingMap`): a decoder's
// declared param/return types should type-check against
// `(w: WireOf<FieldType, ResolvedStore>) => FieldType` at `op()` itself —
// `MismatchedEncodingMapDecoders`/`EncodingMapWireOf` (input.ts), folded into
// `CheckedContributions` (node.ts) the same way `UncoveredSourceParams`
// already is.
//
// The compile-time assertions here (`@ts-expect-error`) assert at
// `bun run typecheck` time, not at `bun test` runtime — the runtime bodies
// exist only so `bun test` reports them. A `@ts-expect-error` line that
// stops being an error fails typecheck with "Unused '@ts-expect-error'
// directive", so each negative case genuinely guards its invariant rather
// than silently passing (see cli-api-projector/src/source.test.ts's own
// header comment for the same convention, applied to `UncoveredSourceParams`).
//
// Every field below carries an EXPLICIT `sourceMap` entry (`{ store: "query" }`)
// so its resolved store is UNAMBIGUOUS (no path-slug/method-default union in
// play — see input.ts's `ResolvedStoresForField` doc comment for when that
// union would otherwise apply) — these tests are about the decoder-typing
// check itself, not the exactness gap decision 3 separately investigates.

import { describe, expect, it } from "bun:test";
import { op } from "./node.ts";

describe("encodingMap function-form: decoder typing at op()", () => {
  it("a decoder matching WireOf<FieldType, ResolvedStore> => FieldType type-checks", () => {
    const getPrice = (input: { cents: number }) => input;

    // cents resolves to the explicit "query" store -> WireOf<number,"query">
    // is `string` (numericStringLeaf's own wire shape) -> the decoder's
    // param must be `string`, and its return must be `number` (cents' own
    // domain type).
    op(getPrice, {
      http: {
        method: "GET",
        sourceMap: { cents: { store: "query" } },
        encodingMap: { cents: (w: string): number => Number(w) },
      },
    });

    expect(true).toBe(true);
  });

  it("a decoder with the wrong PARAMETER type is a compile error", () => {
    const getPrice = (input: { cents: number }) => input;

    // @ts-expect-error — cents resolves to the "query" store; its
    // WireOf<number,"query"> is `string`, not `number` — a decoder
    // declaring `(w: number)` doesn't match the real wire shape.
    op(getPrice, {
      http: {
        method: "GET",
        sourceMap: { cents: { store: "query" } },
        encodingMap: { cents: (w: number): number => w },
      },
    });

    expect(true).toBe(true);
  });

  it("a decoder with the wrong RETURN type is a compile error", () => {
    const getPrice = (input: { cents: number }) => input;

    // @ts-expect-error — a decoder must return the FIELD's own domain type
    // (`number`, cents' declared type on getPrice's input), not `string`.
    op(getPrice, {
      http: {
        method: "GET",
        sourceMap: { cents: { store: "query" } },
        encodingMap: { cents: (w: string): string => w },
      },
    });

    expect(true).toBe(true);
  });

  it("a decoder for a JSON-body-sourced field accepts an already-typed value, not a string", () => {
    const getPrice = (input: { cents: number }) => input;

    // cents resolves to the explicit "body" store under HTTP ->
    // WireOf<number,"json"> is `number` itself (typed JSON, no coercion) —
    // a decoder expecting a STRING here would be wrong.
    op(getPrice, {
      http: {
        method: "POST",
        sourceMap: { cents: { store: "body" } },
        encodingMap: { cents: (w: number): number => w * 2 },
      },
    });

    expect(true).toBe(true);
  });

  it('cli: a decoder matching WireOf<FieldType,"argv"> type-checks', () => {
    const getPrice = (input: { cents: number }) => input;

    op(getPrice, {
      cli: {
        sourceMap: { cents: { store: "flag" } },
        encodingMap: { cents: (w: string): number => Number(w) },
      },
    });

    expect(true).toBe(true);
  });

  it("the real exactness gap: no sourceMap + a non-GET method requires the decoder to accept EITHER wire shape", () => {
    const getPrice = (input: { cents: number }) => input;

    // No explicit sourceMap for `cents`, method POST (default store
    // "body" -> jsonProfile) — op() cannot see whether this leaf's final
    // tree position also gives `cents` a path-slug match (queryProfile).
    // The computed type is the UNION `string | number`
    // (WireOf<number,"query"> | WireOf<number,"json">), not a single type —
    // this is exactly the gap this phase's decision 3 investigated and
    // reported as real (see input.ts's `ResolvedStoresForField` doc
    // comment). A decoder that only handles ONE of the two shapes would be
    // a compile error here; one that handles both is accepted.
    op(getPrice, {
      http: {
        method: "POST",
        encodingMap: {
          cents: (w: string | number): number => (typeof w === "string" ? Number(w) : w),
        },
      },
    });

    // @ts-expect-error — a decoder that only accepts `string` (assuming
    // this leaf will only ever be path/query-sourced) is unsound: op()
    // cannot rule out the "body" (json) default, whose wire shape is a
    // real `number`, not a string.
    op(getPrice, {
      http: { method: "POST", encodingMap: { cents: (w: string): number => Number(w) } } as const,
    });

    expect(true).toBe(true);
  });

  it("a string-form (base-profile-name) encodingMap entry is untouched by this check", () => {
    const getPrice = (input: { cents: number }) => input;

    // The STRING form (phase B) names a base profile, not a decoder
    // function — nothing for `MismatchedEncodingMapDecoders` to check here;
    // this must keep compiling unchanged.
    op(getPrice, { http: { method: "GET", encodingMap: { cents: "identity" } } });

    expect(true).toBe(true);
  });
});
