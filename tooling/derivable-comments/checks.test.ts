// tooling/derivable-comments/checks.test.ts
//
// Each check gets a positive case (matches something in the codebase's own
// dx.ts, the source of the five tells) and at least one negative case that
// looks superficially similar but is legitimate — a param/type mention
// attached to real explanation, a currently-valid path, a small number that
// isn't paired with a countable noun. The negative cases are the ones that
// matter most here: this tool is only worth running if it stays quiet on
// good comments.

import { describe, expect, it } from "bun:test";
import { extractComments } from "./extract.ts";
import { runChecks } from "./checks.ts";

const alwaysExists = () => true;
const neverExists = () => false;

function findingsFor(src: string) {
  return extractComments(src, "f.ts").flatMap((c) => runChecks(c, alwaysExists));
}

describe("param-restatement", () => {
  it("flags a comment that only names a param.field pair", () => {
    const src = `
      export type Opts = { transforms?: string };
      /**
       * One-call thing.
       *
       * Swap individual transforms via \`opts.transforms\`:
       */
      export function f(tree: string, opts?: Opts) {}
    `;
    const findings = findingsFor(src).filter((f) => f.check === "param-restatement");
    expect(findings.length).toBe(1);
  });

  it("does not flag a param.field mention attached to real explanation", () => {
    const src = `
      export type Opts = { transforms?: string };
      /**
       * \`opts.transforms\` must preserve method-setting rewriters or
       * \`applyMethods\`'s output silently loses the HTTP verb.
       */
      export function f(tree: string, opts?: Opts) {}
    `;
    const findings = findingsFor(src).filter((f) => f.check === "param-restatement");
    expect(findings.length).toBe(0);
  });

  it("does not flag a bare param mention when another backtick span on the same line names real content", () => {
    // Regression: an earlier version stripped EVERY backtick span on the
    // line before counting residual words, which swallowed a second,
    // unrelated backtick reference (naming the helper function `ref` is
    // delegated to) as if it were connector fluff — a real false positive
    // found on packages/type-ir/src/rust-wasm-bindgen.ts's own doc comment.
    const src = `
      /** Without \`name\`, returns just the inline type expression for
       * \`ref\` (\`toWasmBindgenType\`). */
      export function f(ref: string, name?: string) {}
    `;
    const findings = findingsFor(src).filter((f) => f.check === "param-restatement");
    expect(findings.length).toBe(0);
  });

  it("does not flag a bare param mention that's just the wrapped tail of a longer sentence", () => {
    // Regression: found on packages/ffi-ir/src/csharp-pinvoke.ts — a
    // formatter wraps "... requires `name`, the method's own key, and
    // `libraryName`)." across two physical lines, and an earlier version
    // judged the second line (just "`libraryName`).") in isolation, reading
    // the wrap as "this line names nothing but the param".
    const src = `
      /**
       * A method entry point (requires \`name\`, the method's own key, and
       * \`libraryName\`).
       */
      export function f(name: string, libraryName: string) {}
    `;
    const findings = findingsFor(src).filter((f) => f.check === "param-restatement");
    expect(findings.length).toBe(0);
  });

  it("does not flag a field name that isn't resolvable on the param's own type", () => {
    // `opts` here is typed `SomeImportedType`, not declared in this file —
    // the field can't be verified, so this must not be flagged (precision
    // over recall: an unresolved field never contributes a match).
    const src = `
      import type { SomeImportedType } from "elsewhere";
      /** Configure via \`opts.whatever\`. */
      export function f(opts: SomeImportedType) {}
    `;
    const findings = findingsFor(src).filter((f) => f.check === "param-restatement");
    expect(findings.length).toBe(0);
  });
});

describe("signature-restatement", () => {
  it("flags a backtick arrow-type that matches the real param/return types", () => {
    const src = `
      export type Node = {};
      export type HttpRoute = {};
      /**
       * One-call \`Node => HttpRoute\` projection with the standard rewriter
       * pipeline pre-composed.
       */
      export function httpProjection(tree: Node): HttpRoute {
        return {} as HttpRoute;
      }
    `;
    const findings = findingsFor(src).filter((f) => f.check === "signature-restatement");
    expect(findings.length).toBe(1);
  });

  it("does not flag an arrow-type expression that doesn't match the real signature", () => {
    const src = `
      export type A = {};
      export type B = {};
      /** Conceptually similar to \`A => C\` in the abstract sense. */
      export function f(a: A): B {
        return {} as B;
      }
    `;
    const findings = findingsFor(src).filter((f) => f.check === "signature-restatement");
    expect(findings.length).toBe(0);
  });

  it("does not flag inside a fenced code example", () => {
    const src = `
      export type Node = {};
      export type HttpRoute = {};
      /**
       * Example:
       * \`\`\`ts
       * const routes: Node => HttpRoute = httpProjection
       * \`\`\`
       */
      export function httpProjection(tree: Node): HttpRoute {
        return {} as HttpRoute;
      }
    `;
    const findings = findingsFor(src).filter((f) => f.check === "signature-restatement");
    expect(findings.length).toBe(0);
  });
});

describe("rotting-count", () => {
  it("flags a hardcoded count paired with a countable noun", () => {
    const src = `/** It's ~7 lines over api() + op(). */\nexport function f() {}`;
    const findings = findingsFor(src).filter((f) => f.check === "rotting-count");
    expect(findings.length).toBe(1);
  });

  it("flags a spelled-out count too", () => {
    const src = `/** Built from three pieces, none of them new machinery. */\nexport function f() {}`;
    const findings = findingsFor(src).filter((f) => f.check === "rotting-count");
    expect(findings.length).toBe(1);
  });

  it("upgrades to 'already wrong' when the param count is checkable and doesn't match", () => {
    const src = `/** Takes two parameters. */\nexport function f(a: string) {}`;
    const findings = findingsFor(src).filter((f) => f.check === "rotting-count");
    expect(findings.length).toBe(1);
    expect(findings[0]!.reason).toContain("already wrong");
  });

  it("does not flag a bare number with no countable noun", () => {
    const src = `/** Retries up to 7 before giving up. */\nexport function f() {}`;
    const findings = findingsFor(src).filter((f) => f.check === "rotting-count");
    expect(findings.length).toBe(0);
  });
});

describe("path-reference", () => {
  it("flags a valid repo path as a silently-rotting cross-reference", () => {
    const src = `/** See docs/design/routing-and-transforms.md § DX. */\nexport function f() {}`;
    const findings = extractComments(src, "f.ts").flatMap((c) => runChecks(c, alwaysExists));
    const found = findings.filter((f) => f.check === "path-reference");
    expect(found.length).toBe(1);
    expect(found[0]!.reason).toContain("rots silently");
  });

  it("upgrades to 'already broken' when the path doesn't exist", () => {
    const src = `/** See docs/design/nonexistent.md. */\nexport function f() {}`;
    const findings = extractComments(src, "f.ts").flatMap((c) => runChecks(c, neverExists));
    const found = findings.filter((f) => f.check === "path-reference");
    expect(found.length).toBe(1);
    expect(found[0]!.reason).toContain("already broken");
  });

  it("does not flag a repo-looking path segment embedded in an external URL", () => {
    // Regression: found on packages/type-ir/src/cpp-glaze.ts — a comment
    // links https://github.com/.../blob/main/docs/enums.md, an external
    // repo's doc, not this repo's docs/enums.md; the suffix coincidentally
    // matches one of this repo's own top-level directory names.
    const src = `/** See glaze's table (https://github.com/x/y/blob/main/docs/enums.md). */\nexport function f() {}`;
    const findings = extractComments(src, "f.ts").flatMap((c) => runChecks(c, neverExists));
    const found = findings.filter((f) => f.check === "path-reference");
    expect(found.length).toBe(0);
  });

  it("does not flag a file's reference to its own path", () => {
    const src = `// pkg/f.ts — header\n/** See pkg/f.ts for details. */\nexport function f() {}`;
    const findings = extractComments(src, "f.ts").flatMap((c) =>
      runChecks(c, alwaysExists, "pkg/f.ts"),
    );
    const found = findings.filter((f) => f.check === "path-reference");
    expect(found.length).toBe(0);
  });
});

describe("decoration", () => {
  it("flags a banner line of repeated symbols", () => {
    const src = `// ============================================================\nexport function f() {}`;
    const findings = findingsFor(src).filter((f) => f.check === "decoration");
    expect(findings.length).toBe(1);
  });

  it("does not flag a normal comment line", () => {
    const src = `// Handles the common case; see the fallback branch below for the rest.\nexport function f() {}`;
    const findings = findingsFor(src).filter((f) => f.check === "decoration");
    expect(findings.length).toBe(0);
  });
});
