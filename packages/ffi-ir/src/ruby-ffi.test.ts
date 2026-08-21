import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t, types } from "@rhi-zone/fractal-type-ir";
import { toRubyFfi, toRubyFfiType } from "./ruby-ffi.ts";
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts";

/** The opaque-handle convention shared with c-abi.test.ts: a plain `ref`
 * TypeRef carrying `opaque-handle` ownership metadata. */
function handleRef(resourceName: string, freeFn?: string): ReturnType<typeof withOwnership> {
  return withOwnership(
    { shape: { kind: "ref", target: resourceName }, meta: {} },
    ownership.opaqueHandle(freeFn),
  );
}

describe("toRubyFfiType", () => {
  test("copy discipline (or no ownership meta at all) maps to the base ffi-gem primitive symbols", () => {
    expect(toRubyFfiType(t(types.integer))).toBe(":int64");
    expect(toRubyFfiType(t(types.number))).toBe(":double");
    expect(toRubyFfiType(t(types.string))).toBe(":string");
    expect(toRubyFfiType(withOwnership(t(types.boolean), ownership.copy()))).toBe(":bool");
    expect(toRubyFfiType(t(types.void))).toBe(":void");
  });

  test("opaque-handle, refcount, and resource disciplines all collapse to the identical bare :pointer symbol", () => {
    expect(toRubyFfiType(handleRef("FileHandle"))).toBe(":pointer");
    expect(toRubyFfiType(withOwnership(t(types.integer), ownership.refcount()))).toBe(":pointer");
    expect(
      toRubyFfiType(
        withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("own")),
      ),
    ).toBe(":pointer");
    expect(
      toRubyFfiType(
        withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("borrow")),
      ),
    ).toBe(":pointer");
  });

  test("a structural shape with no minimal ffi-gem mapping throws explicitly", () => {
    expect(() => toRubyFfiType(t(types.object({ x: t(types.integer) })))).toThrow(
      /no minimal ffi-gem type-symbol mapping/,
    );
  });
});

describe("toRubyFfi — function", () => {
  test("a simple free function with copy-discipline params/return", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const src = toRubyFfi(addFn, "add");
    expect(src).toBe('attach_function "add", [:int64, :int64], :int64');
  });

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    expect(() => toRubyFfi(fn)).toThrow(/"function" requires a name/);
  });
});

describe("toRubyFfi — resource with an opaque-handle method", () => {
  test("a resource's method takes the receiver as a synthesized leading :pointer, plus an auto-generated free binding", () => {
    const readMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.integer), ownership.copy()), "FileHandle"),
    );
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }));

    const src = toRubyFfi(fileHandle);

    expect(src).toContain('attach_function "file_handle_read", [:pointer], :int64');
    expect(src).toContain('attach_function "file_handle_free", [:pointer], :void');
  });

  test("resource emission ignores an explicit name argument in favor of the shape's own name", () => {
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", {}));
    const src = toRubyFfi(fileHandle, "SomeOtherName");
    expect(src).toContain('attach_function "file_handle_free"');
    expect(src).not.toContain("SomeOtherName");
  });
});

describe("toRubyFfi — module", () => {
  test("wraps functions and resources in a Ruby module extending FFI::Library, requiring meta.libPath", () => {
    const closeMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.void), ownership.copy()), "FileHandle"),
    );
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }));
    const openFn: FfiRef = f(
      boundary.function(
        [{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }],
        handleRef("FileHandle"),
      ),
    );
    const fsModule: FfiRef = f(
      boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }),
      { libPath: "./libfs.so" },
    );

    const src = toRubyFfi(fsModule, "fs");

    expect(src).toContain("module Fs");
    expect(src).toContain("extend FFI::Library");
    expect(src).toContain('ffi_lib "./libfs.so"');
    expect(src).toContain('attach_function "open", [:string], :pointer');
    expect(src).toContain('attach_function "file_handle_close", [:pointer], :void');
    expect(src).toContain('attach_function "file_handle_free", [:pointer], :void');
    expect(src.trim().endsWith("end")).toBe(true);
  });

  test("a module without meta.libPath throws explicitly rather than guessing a library path", () => {
    const fsModule: FfiRef = f(boundary.module("fs", {}, {}));
    expect(() => toRubyFfi(fsModule, "fs")).toThrow(/missing required meta\.libPath/);
  });

  test("a module requires a name", () => {
    const fsModule: FfiRef = f(boundary.module("fs", {}, {}), { libPath: "./libfs.so" });
    expect(() => toRubyFfi(fsModule)).toThrow(/"module" requires a name/);
  });
});

// ============================================================================
// Real-toolchain compile-check coverage — `ruby -c` actually parsing the
// generated Ruby source for real (not just this file's string-comparison
// tests above).
//
// This file's own header comment documents that the `ffi` gem is a pure
// consumer-side runtime library: `extend FFI::Library`/`ffi_lib`/
// `attach_function` only resolve and bind at `require`+load time. flake.nix's
// devshell provides plain `ruby` with no gems installed (unlike, say,
// python3.withPackages's real pydantic/attrs for packages/type-ir's own
// compile-check suite), so a full `ruby root.rb` execution of this
// projector's output would fail on every fixture with a `LoadError: cannot
// load such file -- ffi` that has nothing to do with ruby-ffi.ts's own
// correctness. `ruby -c` (parse-only — it never executes `require`s) mirrors
// packages/type-ir/src/compile-check.test.ts's own
// ruby-sorbet/ruby-dry-types precedent: "parse-only is still a real check
// when full execution isn't feasible" — enough to catch identifier/escaping
// defects a string-comparison test can't, without needing the gem installed.
// ============================================================================

type RunResult = { ok: boolean; output: string };

function run(cmd: string[], cwd: string): RunResult {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: proc.exitCode === 0, output: proc.stdout.toString() + proc.stderr.toString() };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ffi-ir-ruby-compile-check-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertParses(result: RunResult): void {
  expect(result.ok, result.output).toBe(true);
}

function checkRuby(src: string): RunResult {
  return withTempDir((dir) => {
    const file = join(dir, "root.rb");
    writeFileSync(file, src);
    return run(["ruby", "-c", file], dir);
  });
}

describe("toRubyFfi — real `ruby -c` parse of generated modules", () => {
  test("a plain function inside a module: real Ruby syntax", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const mathModule: FfiRef = f(boundary.module("math", { add: addFn }, {}), {
      libPath: "./libmath.so",
    });
    assertParses(checkRuby(toRubyFfi(mathModule, "math")));
  });

  // ruby-ffi.ts's own file header documents that it has no keyword-escaping
  // logic anywhere (unlike python-ctypes.ts's PY_KEYWORDS/escapePyIdent) —
  // and this is correct, not a gap: every user-derived name this projector
  // emits lands in a Ruby *string literal* position (`attach_function`'s
  // first argument, `ffi_lib`'s argument, both via `quote()`), never as a
  // bare Ruby identifier, so a Ruby reserved word (`class`, `def`, `end`,
  // `module`) as a function/param name can never collide with Ruby's own
  // keyword grammar the way it can in Python's `getattr(lib, ...)`
  // attribute-position case. Confirmed for real below rather than merely
  // asserted.
  test("a function AND a method named after Ruby reserved words (class/def/end) parse as real Ruby — reserved words only collide as bare identifiers, and this projector never emits one there", () => {
    const endMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.integer), ownership.copy()), "Resource"),
    );
    const resource: FfiRef = f(boundary.resource("Resource", { end: endMethod }));
    const defFn: FfiRef = f(
      boundary.function(
        [{ name: "class", type: withOwnership(t(types.integer), ownership.copy()) }],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const mod: FfiRef = f(boundary.module("kw", { def: defFn }, { Resource: resource }), {
      libPath: "./libkw.so",
    });
    const src = toRubyFfi(mod, "kw");
    expect(src).toContain('attach_function "def"');
    expect(src).toContain('attach_function "resource_end"');
    assertParses(checkRuby(src));
  });

  // Ownership-discipline coverage native to this target (see the file
  // header's "Ownership-discipline mapping" section): a resource's method
  // takes the receiver as a synthesized leading `:pointer` — the one real
  // branch this target's type mapping has (unlike gleam.ts's every-discipline-
  // identical case) — parses as real Ruby.
  test("a resource's opaque-handle method (synthesized leading :pointer receiver) plus its paired free binding: real Ruby syntax", () => {
    const readMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.integer), ownership.copy()), "FileHandle"),
    );
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }));
    const openFn: FfiRef = f(
      boundary.function(
        [{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }],
        withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.opaqueHandle()),
      ),
    );
    const fsModule: FfiRef = f(
      boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }),
      { libPath: "./libfs.so" },
    );
    assertParses(checkRuby(toRubyFfi(fsModule, "fs")));
  });

  // CRITICAL: proves the check above is a real check, not a vacuous one.
  // `buildModule` runs the module's own `name` through `pascalCase` to get
  // the Ruby constant it declares (`module <Name>`), but `pascalCase` never
  // validates that its result is actually a legal Ruby constant — Ruby
  // constants must start with an uppercase ASCII letter, and `pascalCase`
  // only uppercases each word's first character, it never rejects a
  // leading-digit name. A module literally named "123" round-trips through
  // `pascalCase("123")` unchanged (there is no non-alphanumeric character
  // for its word-splitting regex to act on, and `"1".toUpperCase()` is a
  // no-op), producing `module 123`, a genuine Ruby syntax error — reproduced
  // directly:
  //   ruby: root.rb:1: syntax error found (SyntaxError)
  //   > 1 | module 123
  //   |        ^~~ unexpected constant path after `module`; class/module
  //   name must be CONSTANT
  // This is a real gap in `toRubyFfi` (no identifier validation on the
  // module name, unlike python-ctypes.ts's keyword-escaping precedent for
  // its own user-derived identifiers) — not fixed here, recorded via this
  // assertion rather than a `test.todo` since asserting the rejection IS the
  // point of this specific test (proving `ruby -c` genuinely fires on bad
  // output), but worth the same "surprising, don't silently fix" flag this
  // suite's other findings get.
  test("CRITICAL: a deliberately-broken input (a module named with a leading digit) is genuinely rejected by real ruby -c", () => {
    const brokenModule: FfiRef = f(boundary.module("123", {}, {}), { libPath: "./lib123.so" });
    const src = toRubyFfi(brokenModule, "123");
    expect(src).toContain("module 123");
    const result = checkRuby(src);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("syntax error");
  });
});
