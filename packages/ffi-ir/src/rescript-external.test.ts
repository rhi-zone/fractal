import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { t, types } from "@rhi-zone/fractal-type-ir";
import { toReScriptFfi } from "./rescript-external.ts";
import { boundary, f, ownership, resourceRef, withOwnership, type FfiRef } from "./index.ts";

describe("toReScriptFfi — function", () => {
  test("a simple free function with no module context binds via @val", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: t(types.integer) },
          { name: "b", type: t(types.integer) },
        ],
        t(types.integer),
      ),
    );
    const src = toReScriptFfi(addFn, "add");

    expect(src).toContain("@val");
    expect(src).toContain('external add: (int, int) => int = "add"');
    expect(src).not.toContain("@module");
  });

  test("a free function reached through a module binds via @module, naming the module's raw JS name", () => {
    const openParams = [{ name: "path", type: t(types.string) }];
    const openFn: FfiRef = f(boundary.function(openParams, t(types.boolean)));
    const fsModule: FfiRef = f(boundary.module("node:fs", { open: openFn }, {}));

    const src = toReScriptFfi(fsModule, "node:fs");

    expect(src).toContain('@module("node:fs")');
    // "open" is a ReScript reserved word — the binding identifier is
    // sanitized to "open_" while the JS-side name (string literal) stays
    // exactly "open".
    expect(src).toContain('external open_: (string) => bool = "open"');
  });

  test("a function requires a name", () => {
    const fn = f(boundary.function([], t(types.void)));
    expect(() => toReScriptFfi(fn)).toThrow(/requires a name/);
  });
});

describe("toReScriptFfi — method", () => {
  test("a method on a resource binds via @send, with the receiver as the first positional parameter", () => {
    const readMethod: FfiRef = f(
      boundary.method(
        [{ name: "length", type: t(types.integer) }],
        t(types.array(t(types.integer))),
        "FileHandle",
      ),
    );
    const src = toReScriptFfi(readMethod, "read");

    expect(src).toContain("@send");
    expect(src).toContain('external read: (fileHandle, int) => array<int> = "read"');
  });

  test("a no-arg method still gets the receiver as its sole parameter", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"));
    const src = toReScriptFfi(closeMethod, "close");
    expect(src).toContain('external close: (fileHandle) => unit = "close"');
  });
});

describe("toReScriptFfi — resource", () => {
  test("emits an opaque type plus @send externals per method, JS-side names preserved, ReScript-side names prefixed to avoid cross-resource collisions", () => {
    const readMethod: FfiRef = f(
      boundary.method([], t(types.array(t(types.integer))), "FileHandle"),
    );
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"));
    const fileHandle: FfiRef = f(
      boundary.resource("FileHandle", { read: readMethod, close: closeMethod }),
    );

    const src = toReScriptFfi(fileHandle, "FileHandle");

    expect(src).toContain("type fileHandle");
    expect(src).toContain('external fileHandleRead: (fileHandle) => array<int> = "read"');
    expect(src).toContain('external fileHandleClose: (fileHandle) => unit = "close"');
    // no invented constructor — ffi-ir's `resource` kind has no constructor
    // field, only a methods map (same gap wasm-bindgen.ts's buildResource
    // lives with).
    expect(src).not.toContain("@new");
  });

  test("ownership discipline never gates or throws for this target — copy/opaque-handle/refcount/resource all lower identically", () => {
    const readMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.string), ownership.copy()), "Handle"),
    );
    const forCopy: FfiRef = f(boundary.resource("Handle", { read: readMethod }), {
      ownership: ownership.copy(),
    });
    const forRefcount: FfiRef = f(boundary.resource("Handle", { read: readMethod }), {
      ownership: ownership.refcount(),
    });

    expect(() => toReScriptFfi(forCopy, "Handle")).not.toThrow();
    expect(() => toReScriptFfi(forRefcount, "Handle")).not.toThrow();
    expect(toReScriptFfi(forCopy, "Handle")).toBe(toReScriptFfi(forRefcount, "Handle"));
  });

  test("a resourceRef used as a parameter/return type resolves to the same identifier the resource's own type declares", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"));
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }));
    const resourceDecl = toReScriptFfi(fileHandle, "FileHandle");

    const openParams = [{ name: "path", type: t(types.string) }];
    const openReturn = withOwnership(resourceRef("FileHandle", "own"), ownership.resource("own"));
    const openFn: FfiRef = f(boundary.function(openParams, openReturn));
    const fnDecl = toReScriptFfi(openFn, "open_");

    expect(resourceDecl).toContain("type fileHandle");
    expect(fnDecl).toContain("=> fileHandle");
  });
});

describe("toReScriptFfi — module", () => {
  test("groups resources and functions into a ReScript module block", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"));
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }));
    const openParams = [{ name: "path", type: t(types.string) }];
    const openReturn = withOwnership(resourceRef("FileHandle", "own"), ownership.resource("own"));
    const openFn: FfiRef = f(boundary.function(openParams, openReturn));
    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }));

    const src = toReScriptFfi(fsModule, "fs");

    expect(src).toContain("module Fs = {");
    expect(src).toContain("type fileHandle");
    expect(src).toContain('@module("fs")');
    // "open" is a ReScript reserved word — sanitized to "open_" on the
    // ReScript side; the JS-side literal stays "open".
    expect(src).toContain('external open_: (string) => fileHandle = "open"');
    expect(src).toContain('external fileHandleClose: (fileHandle) => unit = "close"');
  });
});

// ============================================================================
// Real-toolchain check — `rescript build` against a real ReScript compiler.
//
// Unlike the other two sibling investigations this task covers
// (typescript-bun.ts: toolchain already present; ocaml-melange.ts: needed a
// new flake.nix devShell input), the real `rescript`/`bsc` compiler binary is
// not a nixpkgs derivation at all (only `rescript-language-server` and a
// tree-sitter grammar are packaged there) — it ships as a prebuilt binary via
// the npm package `rescript` instead. Investigated as network-dependent and
// initially expected to stay string-only per this task's own briefing, but a
// real attempt turned out simple and fast: `rescript@^12.3.0` is now a
// `devDependency` here (packages/ffi-ir/package.json), giving a real local
// `node_modules/.bin/rescript` binary the same way `typescript`/`bun-types`
// give packages/type-ir its own local `tsc` — `bun install` resolves and
// downloads it in under a second, no fragile scaffolding: v12's build system
// needs only a minimal `rescript.json` (`sources`, `package-specs`,
// `suffix`), no legacy `bsconfig.json`. Kept in the same
// network-at-test-time bucket packages/type-ir/src/compile-check.test.ts's
// own rust-serde describe block already documents as an accepted precedent
// for `cargo build` resolving serde/serde_json from crates.io.
// ============================================================================

type ReScriptRunResult = { ok: boolean; output: string };

const rescriptBin = join(import.meta.dir, "..", "node_modules", ".bin", "rescript");

function checkReScript(src: string): ReScriptRunResult {
  const dir = mkdtempSync(join(import.meta.dir, ".cc-res-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "rescript.json"),
      JSON.stringify({
        name: "compile-check",
        sources: { dir: "src", subdirs: true },
        "package-specs": [{ module: "esmodule", "in-source": true }],
        suffix: ".res.mjs",
      }),
    );
    writeFileSync(join(dir, "src", "Fixture.res"), src);
    const proc = Bun.spawnSync({
      cmd: [rescriptBin, "build"],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ok: proc.exitCode === 0,
      output: proc.stdout.toString() + proc.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertReScriptCompiles(result: ReScriptRunResult): void {
  expect(result.ok, result.output).toBe(true);
}

describe("toReScriptFfi (rescript build, real compiler)", () => {
  test("a plain free function with int params/return, bound via @val, compiles", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: t(types.integer) },
          { name: "b", type: t(types.integer) },
        ],
        t(types.integer),
      ),
    );
    assertReScriptCompiles(checkReScript(toReScriptFfi(addFn, "add")));
  });

  test("a function named after a ReScript keyword gets a trailing-underscore escape that is real, valid ReScript syntax", () => {
    const fn: FfiRef = f(boundary.function([], t(types.void)));
    const src = toReScriptFfi(fn, "type");
    expect(src).toContain("external type_:");
    assertReScriptCompiles(checkReScript(src));
  });

  test("a hand-written, deliberately-broken ReScript file is genuinely rejected by the compiler (proves this check isn't vacuous)", () => {
    const result = checkReScript('let bad: int = "not an int"\n');
    expect(result.ok).toBe(false);
    expect(result.output.length).toBeGreaterThan(0);
  });

  // ==========================================================================
  // Real bug this real-compiler check surfaced, that the string-comparison
  // tests above structurally could not see: `buildResource` (this file) used
  // to declare a resource's opaque type as `type ${toPascalCase(name)}` —
  // i.e. always capitalized (e.g. `type Greeter`, `type FileHandle`).
  // ReScript type identifiers must start with a lowercase letter; a
  // capitalized one is a hard parse error, not a type error — confirmed
  // directly against the real compiler:
  //
  //   type Greeter
  //
  //   Syntax error!
  //   1 │ type Greeter
  //   Did you mean `greeter` instead of `Greeter`?
  //
  // Fixed: `buildResource` now emits `type ${decapitalize(toPascalCase(name))}`
  // (a lowercase-leading camelCase identifier), and type-ir's
  // `rescript-native.ts` `ref` handler (used to render every reference to
  // that type, e.g. a method receiver or a function's return type) was fixed
  // the same way so declaration and every reference agree. This test — no
  // longer `test.todo` — is the module-level, end-to-end case: a resource's
  // `type` decl, its methods' receivers, and a free function returning the
  // resource type all compile together as real ReScript.
  // ==========================================================================
  test("a resource's opaque type declaration compiles, lowercase-leading per ReScript's type-identifier rule", () => {
    const greetMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.string), ownership.copy()), "Greeter"),
    );
    const greeter: FfiRef = f(boundary.resource("Greeter", { greet: greetMethod }));
    assertReScriptCompiles(checkReScript(toReScriptFfi(greeter, "Greeter")));
  });

  test("a module wrapping a resource and a function returning that resource type compiles end to end", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"));
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }));
    const openParams = [{ name: "path", type: t(types.string) }];
    const openReturn = withOwnership(resourceRef("FileHandle", "own"), ownership.resource("own"));
    const openFn: FfiRef = f(boundary.function(openParams, openReturn));
    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }));

    const src = toReScriptFfi(fsModule, "fs");
    assertReScriptCompiles(checkReScript(src));
  });
});
