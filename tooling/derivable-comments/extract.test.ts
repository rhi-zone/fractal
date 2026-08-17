// tooling/derivable-comments/extract.test.ts
//
// Covers the association logic specifically: a leading comment must attach
// its enclosing function-like declaration's real param names/types/return
// type, across the shapes this codebase actually uses (`function` decl,
// `const x = (...) => ...`), and must NOT attach facts to a comment above a
// non-function declaration (checks 1/2 must simply not run there).

import { describe, expect, it } from "bun:test";
import { extractComments } from "./extract.ts";

describe("extractComments — declaration association", () => {
  it("attaches params/return type for a function declaration", () => {
    const src = `/** doc */\nexport function f(a: string, b?: number): boolean { return true; }`;
    const [c] = extractComments(src, "f.ts");
    expect(c!.facts?.params.map((p) => p.name)).toEqual(["a", "b"]);
    expect(c!.facts?.params.map((p) => p.typeText)).toEqual(["string", "number"]);
    expect(c!.facts?.returnTypeText).toBe("boolean");
  });

  it("attaches facts for a const arrow function (comment on the VariableStatement)", () => {
    const src = `/** doc */\nexport const f = (a: string): number => 1;`;
    const [c] = extractComments(src, "f.ts");
    expect(c!.facts?.params.map((p) => p.name)).toEqual(["a"]);
    expect(c!.facts?.returnTypeText).toBe("number");
  });

  it("resolves local interface field names for param.field checks", () => {
    const src = `
      export interface Opts { transforms?: string; }
      /** doc */
      export function f(opts: Opts) {}
    `;
    const comments = extractComments(src, "f.ts");
    const c = comments[comments.length - 1]!;
    expect(c.facts?.localFields.get("opts")?.has("transforms")).toBe(true);
  });

  it("does not attach facts to a comment above a plain const or interface", () => {
    const src = `/** doc */\nexport const x = 5;`;
    const [c] = extractComments(src, "f.ts");
    expect(c!.facts).toBeUndefined();
  });

  it("still extracts a mid-body comment with no facts", () => {
    const src = `export function f() {\n  // just a local note\n  return 1;\n}`;
    const comments = extractComments(src, "f.ts");
    expect(comments.length).toBe(1);
    expect(comments[0]!.facts).toBeUndefined();
  });
});
