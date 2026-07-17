// packages/api-tree/src/index.test.ts — the function-core base + derived combinators.

import { describe, expect, it } from "bun:test";
import {
  bind,
  collect,
  compose,
  composeK,
  err,
  map,
  match,
  ok,
  pipe,
  type Result,
} from "./index.ts";

describe("function category", () => {
  it("compose and pipe agree", () => {
    const inc = (n: number) => n + 1;
    const dbl = (n: number) => n * 2;
    expect(compose(inc)(dbl)(3)).toBe(8); // dbl(inc(3)) = 8
    expect(pipe(3, inc, dbl)).toBe(8);
  });
});

describe("Result", () => {
  it("map / bind short-circuit on error", () => {
    const half = (n: number): Result<number, string> =>
      n % 2 === 0 ? ok(n / 2) : err("odd");
    expect(map(ok(4), (n) => n + 1)).toEqual({ kind: "ok", value: 5 });
    expect(bind(ok(8), half)).toEqual({ kind: "ok", value: 4 });
    expect(bind(ok(7), half)).toEqual({ kind: "err", error: "odd" });
    expect(match(err<string>("x"), { ok: () => 1, err: () => 2 })).toBe(2);
  });

  it("composeK threads a fallible chain", () => {
    const parse = (s: string): Result<number, string> =>
      Number.isNaN(Number(s)) ? err("nan") : ok(Number(s));
    const recip = (n: number): Result<number, string> =>
      n === 0 ? err("div0") : ok(1 / n);
    const f = composeK(parse)(recip);
    expect(f("4")).toEqual({ kind: "ok", value: 0.25 });
    expect(f("0")).toEqual({ kind: "err", error: "div0" });
    expect(f("x")).toEqual({ kind: "err", error: "nan" });
  });
});

describe("collect (applicative)", () => {
  it("gathers field outputs and short-circuits on first failure", () => {
    // `collect`'s common input `I` is passed explicitly — it is not inferred
    // from the producer record (the producers' param type lives in a constraint
    // position, which TS does not use as an inference site).
    const run = collect<
      { x: string },
      string,
      {
        a: (i: { x: string }) => Result<number, string>;
        b: (i: { x: string }) => Result<string, string>;
      }
    >({
      a: (i) => ok(i.x.length),
      b: (i) => (i.x === "" ? err("empty") : ok(i.x[0]!)),
    });
    expect(run({ x: "hi" })).toEqual({ kind: "ok", value: { a: 2, b: "h" } });
    expect(run({ x: "" })).toEqual({ kind: "err", error: "empty" });
  });
});

