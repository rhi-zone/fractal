import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t, types } from "@rhi-zone/fractal-type-ir";
import { toRustCAbi, toRustCAbiType } from "./rust-c-abi.ts";
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts";

/** The C-target convention for referencing an opaque resource by pointer:
 * a plain `ref` TypeRef carrying `opaque-handle` ownership (not the
 * `resource`-discipline `resourceRef` helper, which is the WIT-oriented own/
 * borrow convention this target explicitly does not implement). */
function handleRef(resourceName: string, freeFn?: string): ReturnType<typeof withOwnership> {
  return withOwnership(
    { shape: { kind: "ref", target: resourceName }, meta: {} },
    ownership.opaqueHandle(freeFn),
  );
}

describe("toRustCAbiType", () => {
  test("copy discipline (or no ownership meta at all) maps straight through rust-serde's toRustType", () => {
    expect(toRustCAbiType(t(types.integer))).toBe("i64");
    expect(toRustCAbiType(withOwnership(t(types.boolean), ownership.copy()))).toBe("bool");
  });

  test("opaque-handle discipline becomes a raw *mut pointer to the underlying Rust type", () => {
    expect(toRustCAbiType(handleRef("FileHandle"))).toBe("*mut FileHandle");
  });

  test("refcount discipline throws — no native C mechanism, out of scope by design", () => {
    expect(() => toRustCAbiType(withOwnership(t(types.integer), ownership.refcount()))).toThrow(
      /unsupported ownership discipline "refcount" for C target/,
    );
  });

  test("resource discipline (own/borrow) throws — WIT-only, out of scope for C", () => {
    expect(() =>
      toRustCAbiType(
        withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("own")),
      ),
    ).toThrow(/unsupported ownership discipline "resource" for C target/);
    expect(() =>
      toRustCAbiType(
        withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("borrow")),
      ),
    ).toThrow(/unsupported ownership discipline "resource" for C target/);
  });
});

describe("toRustCAbi — function", () => {
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
    const src = toRustCAbi(addFn, "add");

    expect(src).toContain("#[no_mangle]");
    expect(src).toContain('pub extern "C" fn add(a: i64, b: i64) -> i64 {');
    expect(src).toContain("todo!(");
  });

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    expect(() => toRustCAbi(fn)).toThrow(/"function" requires a name/);
  });

  test("a function taking a resource parameter uses the opaque-handle pointer convention", () => {
    const closeFn: FfiRef = f(
      boundary.function(
        [{ name: "handle", type: handleRef("FileHandle", "file_handle_free") }],
        withOwnership(t(types.void), ownership.copy()),
      ),
    );
    const src = toRustCAbi(closeFn, "close");

    expect(src).toContain('pub extern "C" fn close(handle: *mut FileHandle) {');
    // void return omits the arrow entirely
    expect(src).not.toContain("->");
  });
});

// Reserved-word collision coverage — string-comparison only here; the same
// keyword-escaping cases are re-verified against a real `rustc`/`cargo`
// build in the "real cargo build (compile-check)" describe block at the
// bottom of this file.
describe("toRustCAbi — reserved-word (Rust keyword) identifiers get the r#-raw-identifier escape", () => {
  test("a param named after a Rust keyword", () => {
    const fn: FfiRef = f(
      boundary.function(
        [{ name: "match", type: withOwnership(t(types.integer), ownership.copy()) }],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const src = toRustCAbi(fn, "identify");
    expect(src).toContain("r#match: i64");
  });

  test("a standalone/module-level function itself named after a Rust keyword", () => {
    const fn: FfiRef = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    const src = toRustCAbi(fn, "type");
    expect(src).toContain('pub extern "C" fn r#type()');
  });

  test("a method/resource-generated function name never collides (always <receiver>_<method>-concatenated), so it's never escaped", () => {
    const matchMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.void), ownership.copy()), "Type"),
    );
    const resource: FfiRef = f(boundary.resource("Type", { match: matchMethod }));
    const src = toRustCAbi(resource);
    expect(src).toContain('pub extern "C" fn type_match(');
  });
});

describe("toRustCAbi — resource", () => {
  test("a resource with a constructor, methods, and an auto-generated destructor", () => {
    const readMethod: FfiRef = f(
      boundary.method(
        [],
        withOwnership(t(types.array(t(types.integer))), ownership.copy()),
        "FileHandle",
      ),
    );
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }));

    const openFn: FfiRef = f(
      boundary.function(
        [{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }],
        handleRef("FileHandle", "file_handle_free"),
      ),
    );

    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }));
    const src = toRustCAbi(fsModule);

    // opaque struct
    expect(src).toContain("#[repr(C)]");
    expect(src).toContain("pub struct FileHandle {");
    expect(src).toContain("_private: [u8; 0],");

    // constructor (a plain module function returning an opaque-handle pointer)
    expect(src).toContain('pub extern "C" fn open(path: String) -> *mut FileHandle {');

    // method, receiver-prefixed with a synthesized handle parameter
    expect(src).toContain(
      'pub extern "C" fn file_handle_read(handle: *mut FileHandle) -> Vec<i64> {',
    );

    // auto-generated destructor
    expect(src).toContain('pub extern "C" fn file_handle_free(handle: *mut FileHandle) {');
    expect(src).toContain("drop(Box::from_raw(handle));");
  });

  test("resource emission ignores an explicit name argument in favor of the shape's own name", () => {
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", {}));
    const src = toRustCAbi(fileHandle, "SomeOtherName");
    expect(src).toContain("pub struct FileHandle {");
    expect(src).not.toContain("SomeOtherName");
  });
});

describe("toRustCAbi — module", () => {
  test("concatenates all contained functions and resources with no module wrapper (C has no module system)", () => {
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
    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }));

    const src = toRustCAbi(fsModule);
    expect(src).toContain('pub extern "C" fn open(');
    expect(src).toContain("pub struct FileHandle {");
    expect(src).toContain('pub extern "C" fn file_handle_close(');
    expect(src).toContain('pub extern "C" fn file_handle_free(');
    // no "mod fs" or namespace wrapper of any kind
    expect(src).not.toContain("mod fs");
  });
});

// ============================================================================
// Real-toolchain compile-check — actually runs the generated Rust source
// through `cargo build` (rustc/cargo from flake.nix's devShell), not just
// string-comparison against the output text. This is the bug class the
// string-comparison tests above cannot see by construction: f0d23bf fixed a
// standalone function named after a Rust keyword not being escaped, and a
// string-comparison test only ever checks for the presence of a substring —
// it has no way to notice the *rest* of the file is invalid Rust.
//
// One shared temp Cargo project reused across fixtures (mirrors type-ir's
// compile-check.test.ts "rust-serde (cargo build)" block): only src/lib.rs
// is rewritten per test, since even a dependency-free `cargo build` pays a
// few seconds of fixed cost from an empty target dir on the first build.
// No crates.io dependency is needed here — rust-c-abi.ts's output is plain
// `#[no_mangle] extern "C"` functions/`#[repr(C)]` structs over std only, so
// this doesn't need network access the way the wasm-bindgen target's suite
// does.
// ============================================================================

describe("toRustCAbi — real cargo build (compile-check)", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "ffi-ir-compile-check-rust-c-abi-"));
  mkdirSync(join(projectDir, "src"));
  writeFileSync(
    join(projectDir, "Cargo.toml"),
    '[package]\nname = "compile-check"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  function build(src: string): { exitCode: number; stderr: string } {
    writeFileSync(
      join(projectDir, "src", "lib.rs"),
      `#![allow(dead_code, non_snake_case, unused_variables)]\n\n${src}\n`,
    );
    const proc = Bun.spawnSync({
      cmd: ["cargo", "build"],
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: proc.exitCode ?? -1, stderr: proc.stderr.toString() };
  }

  test(
    "a plain function with copy-discipline params/return compiles",
    () => {
      const addFn: FfiRef = f(
        boundary.function(
          [
            { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
            { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
          ],
          withOwnership(t(types.integer), ownership.copy()),
        ),
      );
      const result = build(toRustCAbi(addFn, "add"));
      expect(result.exitCode, result.stderr).toBe(0);
    },
    30_000,
  );

  test(
    "a function and a param both named after Rust keywords compile once escaped",
    () => {
      const fn: FfiRef = f(
        boundary.function(
          [{ name: "match", type: withOwnership(t(types.integer), ownership.copy()) }],
          withOwnership(t(types.integer), ownership.copy()),
        ),
      );
      const result = build(toRustCAbi(fn, "type"));
      expect(result.exitCode, result.stderr).toBe(0);
    },
    30_000,
  );

  test(
    "an opaque-handle resource with a constructor, a method, and an auto-generated destructor compiles",
    () => {
      const readMethod: FfiRef = f(
        boundary.method(
          [],
          withOwnership(t(types.array(t(types.integer))), ownership.copy()),
          "FileHandle",
        ),
      );
      const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }));
      const openFn: FfiRef = f(
        boundary.function(
          [{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }],
          handleRef("FileHandle", "file_handle_free"),
        ),
      );
      const fsModule: FfiRef = f(
        boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }),
      );
      const result = build(toRustCAbi(fsModule));
      expect(result.exitCode, result.stderr).toBe(0);
    },
    30_000,
  );

  test(
    "a deliberately broken snippet (real type mismatch) fails the build — proves this check isn't vacuous",
    () => {
      const result = build('pub extern "C" fn broken() -> i64 { "this is a &str, not an i64" }');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("mismatched types");
    },
    30_000,
  );
});
