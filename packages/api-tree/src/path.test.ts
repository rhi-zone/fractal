// See path.ts's module doc for what `escapeJoin`/`unescapeJoin` fix and why.
// This file's job is to PROVE the collision-freedom claim, not just assert
// it: the round-trip property (`unescapeJoin(escapeJoin(s, d), d) === s` for
// every segment array `s` and delimiter `d`) implies injectivity directly —
// if two different segment arrays `a !== b` ever produced the same joined
// string, unescaping that one string could not recover both `a` and `b`,
// contradicting round-trip correctness holding for both. So a round-trip
// property test that passes across a wide randomized/adversarial sample IS
// the collision-freedom proof for every case it covers.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { escapeJoin, unescapeJoin } from "./path.ts";

const DELIMITERS = ["_", ".", "/", " ", ":"] as const;

describe("escapeJoin / unescapeJoin", () => {
  // ==========================================================================
  // Property: round-trip, for arbitrary segments (any string, including ones
  // built from the delimiter and the escape character themselves) and
  // arbitrary delimiters from the real set every projector actually uses.
  // ==========================================================================
  test("round-trips for arbitrary segments and delimiters (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 8 }),
        fc.constantFrom(...DELIMITERS),
        (segments, delimiter) => {
          const joined = escapeJoin(segments, delimiter);
          expect(unescapeJoin(joined, delimiter)).toEqual(segments);
        },
      ),
    );
  });

  // ==========================================================================
  // Property: round-trip over an ADVERSARIAL alphabet — segments built only
  // from the delimiter, the backslash escape character, and one plain
  // character, at higher density than fc.string()'s default distribution
  // would produce. This is where a broken escaping scheme actually breaks.
  // ==========================================================================
  test("round-trips for segments built from the delimiter/backslash alphabet (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DELIMITERS),
        fc.array(
          fc.string({ unit: fc.constantFrom("_", ".", "/", " ", ":", "\\", "a"), minLength: 0, maxLength: 6 }),
          { minLength: 1, maxLength: 6 },
        ),
        (delimiter, segments) => {
          const joined = escapeJoin(segments, delimiter);
          expect(unescapeJoin(joined, delimiter)).toEqual(segments);
        },
      ),
    );
  });

  // ==========================================================================
  // Direct collision-freedom check: for any two segment arrays sampled from
  // the adversarial alphabet, escapeJoin(a) === escapeJoin(b) implies a and b
  // are the SAME array — checked directly (not just inferred from round-trip)
  // as the property the whole primitive exists to guarantee.
  // ==========================================================================
  test("two different segment arrays never join to the same string (property)", () => {
    const seg = fc.array(
      fc.string({ unit: fc.constantFrom("_", ".", "\\", "a", "b"), minLength: 0, maxLength: 4 }),
      { minLength: 1, maxLength: 5 },
    );
    fc.assert(
      fc.property(fc.constantFrom(...DELIMITERS), seg, seg, (delimiter, a, b) => {
        const same = escapeJoin(a, delimiter) === escapeJoin(b, delimiter);
        expect(same).toBe(JSON.stringify(a) === JSON.stringify(b));
      }),
    );
  });

  // ==========================================================================
  // The exact motivating case from the investigation: an authored segment
  // literally containing the delimiter used to collide with a genuinely
  // different, deeper tree position. escapeJoin keeps them apart.
  // ==========================================================================
  test("a segment containing the delimiter no longer collides with a deeper tree position", () => {
    // Old unescaped join: ["books_get"].join("_") === ["books", "get"].join("_") === "books_get".
    const a = escapeJoin(["books_get"], "_");
    const b = escapeJoin(["books", "get"], "_");
    expect(a).not.toBe(b);
    expect(unescapeJoin(a, "_")).toEqual(["books_get"]);
    expect(unescapeJoin(b, "_")).toEqual(["books", "get"]);
  });

  test("a segment containing a literal backslash still round-trips", () => {
    const joined = escapeJoin(["a\\b", "c"], "_");
    expect(unescapeJoin(joined, "_")).toEqual(["a\\b", "c"]);
    // And still distinguishable from the "natural" collision a naive
    // backslash-blind scheme would produce.
    expect(escapeJoin(["a\\b", "c"], "_")).not.toBe(escapeJoin(["a\\_b", "c"], "_"));
  });

  test("an empty-string segment round-trips and stays distinguishable from an adjacent real segment", () => {
    expect(unescapeJoin(escapeJoin(["", "a"], "_"), "_")).toEqual(["", "a"]);
    expect(unescapeJoin(escapeJoin(["a", ""], "_"), "_")).toEqual(["a", ""]);
    expect(escapeJoin(["", "a"], "_")).not.toBe(escapeJoin(["a"], "_"));
  });

  test("byte-identical output for the common (delimiter-free) case — the no-op fast path", () => {
    // Regression anchor: when no segment contains the delimiter or a
    // backslash, escapeJoin must produce EXACTLY the old naive join's output
    // — every existing fixture across every consumer package depends on this.
    expect(escapeJoin(["books", "get"], "_")).toBe("books_get");
    expect(escapeJoin(["users", "list"], "_")).toBe("users_list");
    expect(escapeJoin(["a"], "_")).toBe("a");
    expect(escapeJoin(["users", "bookId", "get"], "_")).toBe("users_bookId_get");
    expect(escapeJoin(["users", "list"], ".")).toBe("users.list");
    expect(escapeJoin(["users", "list"], "/")).toBe("users/list");
    expect(escapeJoin(["users", "list"], " ")).toBe("users list");
  });

  // ==========================================================================
  // Input contracts.
  // ==========================================================================
  test("throws on an empty delimiter", () => {
    expect(() => escapeJoin(["a"], "")).toThrow();
    expect(() => unescapeJoin("a", "")).toThrow();
  });

  test("throws on a multi-character delimiter", () => {
    // Multi-character delimiters have a self-overlap ambiguity this scheme
    // doesn't attempt to solve (see path.ts's assertValidDelimiter doc) — no
    // real consumer needs one, so it's a checked contract, not a silent gap.
    expect(() => escapeJoin(["a"], "::")).toThrow();
    expect(() => unescapeJoin("a::b", "::")).toThrow();
  });

  test("throws on a delimiter that is the escape character itself", () => {
    expect(() => escapeJoin(["a"], "\\")).toThrow();
  });

  test("throws on an empty segments array", () => {
    expect(() => escapeJoin([], "_")).toThrow();
  });
});
