import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t, types } from "@rhi-zone/fractal-type-ir";
import { toWasmBindgenFfi } from "./rust-wasm-bindgen.ts";
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts";

describe("toWasmBindgenFfi — function", () => {
  test("a simple free function with copy-discipline params/return delegates to type-ir's toWasmBindgen", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const src = toWasmBindgenFfi(addFn, "add");

    expect(src).toContain("#[wasm_bindgen]");
    expect(src).toContain("pub fn add(a: i64, b: i64) -> i64 {");
    expect(src).toContain("todo!(");
  });

  test("a function with no ownership meta at all also delegates (unannotated = copy-by-value default)", () => {
    const fn: FfiRef = f(
      boundary.function([{ name: "n", type: t(types.integer) }], t(types.string)),
    );
    const src = toWasmBindgenFfi(fn, "greet");
    expect(src).toContain("pub fn greet(n: i64) -> String {");
  });

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    expect(() => toWasmBindgenFfi(fn)).toThrow(/"function" requires a name/);
  });
});

// Reserved-word collision coverage — string-comparison only here; the same
// keyword-escaping case is re-verified against a real `cargo build` (with
// the actual wasm-bindgen crate from crates.io) in the "real cargo build
// (compile-check)" describe block at the bottom of this file.
describe("toWasmBindgenFfi — reserved-word (Rust keyword) identifiers get the r#-raw-identifier escape", () => {
  test("a param named after a Rust keyword", () => {
    const fn: FfiRef = f(
      boundary.function(
        [{ name: "match", type: withOwnership(t(types.integer), ownership.copy()) }],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const src = toWasmBindgenFfi(fn, "identify");
    expect(src).toContain("r#match: i64");
  });

  test("a function itself named after a Rust keyword gets escaped, with #[wasm_bindgen(js_name = ...)] preserving the original exported JS name", () => {
    const fn: FfiRef = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    const src = toWasmBindgenFfi(fn, "type");
    expect(src).toContain("pub fn r#type()");
    expect(src).toContain('js_name = "type"');
  });
});

describe("toWasmBindgenFfi — resource, copy discipline", () => {
  test("emits #[derive(Clone)] struct + impl block with methods, no ownership meta needed (copy is the default)", () => {
    const greetMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.string), ownership.copy()), "Greeter"),
    );
    const greeter: FfiRef = f(boundary.resource("Greeter", { greet: greetMethod }));

    const src = toWasmBindgenFfi(greeter, "Greeter");

    expect(src).toContain("#[derive(Clone)]");
    expect(src).toContain("#[wasm_bindgen]");
    expect(src).toContain("pub struct Greeter {}");
    expect(src).toContain("impl Greeter {");
    expect(src).toContain("pub fn greet(&self) -> String {");
    // copy discipline never emits a share() method — that's refcount-only.
    expect(src).not.toContain("pub fn share(");
  });

  test("explicit ownership.copy() on the resource's own meta produces the same output as the default", () => {
    const counterMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.integer), ownership.copy()), "Counter"),
    );
    const counter: FfiRef = f(boundary.resource("Counter", { value: counterMethod }), {
      ownership: ownership.copy(),
    });
    const src = toWasmBindgenFfi(counter, "Counter");
    expect(src).toContain("pub struct Counter {}");
    expect(src).toContain("pub fn value(&self) -> i64 {");
  });
});

describe("toWasmBindgenFfi — resource, refcount discipline", () => {
  test("emits an Arc-wrapped struct, a share() method (Arc::clone), and no custom release/registry code", () => {
    const readMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.string), ownership.copy()), "Handle"),
    );
    const handle: FfiRef = f(boundary.resource("Handle", { read: readMethod }), {
      ownership: ownership.refcount(),
    });

    const src = toWasmBindgenFfi(handle, "Handle");

    expect(src).toContain("struct HandleData {}");
    expect(src).toContain("pub struct Handle {");
    expect(src).toContain("inner: std::sync::Arc<HandleData>,");
    expect(src).toContain("pub fn share(&self) -> Self {");
    expect(src).toContain("Self { inner: std::sync::Arc::clone(&self.inner) }");
    expect(src).toContain("pub fn read(&self) -> String {");

    // No hand-rolled release()/FinalizationRegistry glue is emitted —
    // wasm-bindgen's own generated free() plus its internal weak-refs
    // machinery covers deterministic/GC-driven cleanup. The struct's doc
    // comment references "free()"/GC timing in prose, but no `fn release`
    // or `new FinalizationRegistry` construct appears in the output.
    expect(src).not.toContain("pub fn release");
    expect(src).not.toContain("new FinalizationRegistry");
  });

  test("methods are spliced with a leading &self and comma only when the method itself takes params", () => {
    const setMethod: FfiRef = f(
      boundary.method(
        [{ name: "value", type: withOwnership(t(types.integer), ownership.copy()) }],
        t(types.void),
        "Counter",
      ),
    );
    const counter: FfiRef = f(boundary.resource("Counter", { set: setMethod }), {
      ownership: ownership.refcount(),
    });
    const src = toWasmBindgenFfi(counter, "Counter");
    expect(src).toContain("pub fn set(&self, value: i64) {");
  });
});

describe("toWasmBindgenFfi — unsupported ownership disciplines", () => {
  test("opaque-handle discipline on a parameter throws explicitly", () => {
    const handleParam = withOwnership(
      t({ kind: "ref", target: "FileHandle" }),
      ownership.opaqueHandle("file_handle_free"),
    );
    const fn: FfiRef = f(boundary.function([{ name: "handle", type: handleParam }], t(types.void)));
    expect(() => toWasmBindgenFfi(fn, "close")).toThrow(
      /unsupported ownership discipline "opaque-handle" for wasm-bindgen\/JS target at parameter "handle"/,
    );
  });

  test("opaque-handle discipline on a return type throws explicitly", () => {
    const fn: FfiRef = f(
      boundary.function(
        [],
        withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.opaqueHandle()),
      ),
    );
    expect(() => toWasmBindgenFfi(fn, "open")).toThrow(
      /unsupported ownership discipline "opaque-handle" for wasm-bindgen\/JS target at return type/,
    );
  });

  test("resource (own/borrow) discipline throws explicitly, for both own and borrow modes", () => {
    const ownedParam = withOwnership(
      t({ kind: "ref", target: "FileHandle" }),
      ownership.resource("own"),
    );
    const borrowedParam = withOwnership(
      t({ kind: "ref", target: "FileHandle" }),
      ownership.resource("borrow"),
    );

    const ownFn: FfiRef = f(boundary.function([{ name: "h", type: ownedParam }], t(types.void)));
    const borrowFn: FfiRef = f(
      boundary.function([{ name: "h", type: borrowedParam }], t(types.void)),
    );

    expect(() => toWasmBindgenFfi(ownFn, "take")).toThrow(
      /unsupported ownership discipline "resource" for wasm-bindgen\/JS target/,
    );
    expect(() => toWasmBindgenFfi(borrowFn, "peek")).toThrow(
      /unsupported ownership discipline "resource" for wasm-bindgen\/JS target/,
    );
  });

  test("a resource declared with an unsupported discipline (opaque-handle/resource) throws when the declaration itself is emitted", () => {
    const method: FfiRef = f(boundary.method([], t(types.void), "Thing"));
    const opaqueThing: FfiRef = f(boundary.resource("Thing", { m: method }), {
      ownership: ownership.opaqueHandle(),
    });
    const resourceThing: FfiRef = f(boundary.resource("Thing", { m: method }), {
      ownership: ownership.resource("own"),
    });

    expect(() => toWasmBindgenFfi(opaqueThing, "Thing")).toThrow(
      /unsupported ownership discipline "opaque-handle" for wasm-bindgen\/JS target on resource "Thing"/,
    );
    expect(() => toWasmBindgenFfi(resourceThing, "Thing")).toThrow(
      /unsupported ownership discipline "resource" for wasm-bindgen\/JS target on resource "Thing"/,
    );
  });
});

describe("toWasmBindgenFfi — module", () => {
  test("groups functions and resources into a pub mod block", () => {
    const greetMethod: FfiRef = f(boundary.method([], t(types.string), "Greeter"));
    const greeter: FfiRef = f(boundary.resource("Greeter", { greet: greetMethod }));
    const helloFn: FfiRef = f(boundary.function([], t(types.string)));

    const mod: FfiRef = f(boundary.module("MyModule", { hello: helloFn }, { Greeter: greeter }));
    const src = toWasmBindgenFfi(mod, "MyModule");

    expect(src).toContain("pub mod my_module {");
    expect(src).toContain("use wasm_bindgen::prelude::*;");
    expect(src).toContain("pub struct Greeter {}");
    expect(src).toContain("pub fn hello() -> String {");
  });
});

// ============================================================================
// Real-toolchain compile-check — actually runs the generated Rust source
// through `cargo build` against a real `wasm-bindgen` dependency resolved
// from crates.io (rustc/cargo from flake.nix's devShell; network access to
// crates.io at test time, same requirement as type-ir's compile-check.test.ts
// "rust-serde (cargo build)" block). Catches the bug class string-comparison
// assertions cannot see — f0e258e fixed a fn-name escaping bug in this exact
// file that a substring check alone wouldn't have caught if the fix had left
// the rest of the emitted item invalid.
//
// This deliberately builds for the host target, not wasm32 — wasm-bindgen's
// attribute macro expands and typechecks on any target; the wasm32-specific
// JS glue it *also* generates for a real wasm32 build isn't needed to prove
// the emitted Rust is syntactically and type-correct, and adding a wasm32
// target to flake.nix is out of scope for this check.
//
// One shared temp Cargo project reused across fixtures (only src/lib.rs is
// rewritten per test) for the same reason as the rust-c-abi.test.ts and
// type-ir suites: a cold build resolving+compiling wasm-bindgen and its
// proc-macro deps from scratch takes several seconds, well past bun:test's
// default 5s per-test timeout if repeated per fixture from an empty target
// dir.
// ============================================================================

describe("toWasmBindgenFfi — real cargo build (compile-check)", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "ffi-ir-compile-check-rust-wasm-bindgen-"));
  mkdirSync(join(projectDir, "src"));
  writeFileSync(
    join(projectDir, "Cargo.toml"),
    '[package]\nname = "compile-check"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nwasm-bindgen = "0.2"\n',
  );
  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  function build(src: string): { exitCode: number; stderr: string } {
    writeFileSync(
      join(projectDir, "src", "lib.rs"),
      `#![allow(dead_code, non_snake_case, unused_variables)]\nuse wasm_bindgen::prelude::*;\n\n${src}\n`,
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
      const result = build(toWasmBindgenFfi(addFn, "add"));
      expect(result.exitCode, result.stderr).toBe(0);
    },
    60_000,
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
      const result = build(toWasmBindgenFfi(fn, "type"));
      expect(result.exitCode, result.stderr).toBe(0);
    },
    60_000,
  );

  test(
    "a copy-discipline resource with a method compiles",
    () => {
      const greetMethod: FfiRef = f(
        boundary.method([], withOwnership(t(types.string), ownership.copy()), "Greeter"),
      );
      const greeter: FfiRef = f(boundary.resource("Greeter", { greet: greetMethod }));
      const result = build(toWasmBindgenFfi(greeter, "Greeter"));
      expect(result.exitCode, result.stderr).toBe(0);
    },
    60_000,
  );

  test(
    "a deliberately broken snippet (real type mismatch) fails the build — proves this check isn't vacuous",
    () => {
      const result = build(
        '#[wasm_bindgen]\npub fn broken() -> i64 { "this is a &str, not an i64" }',
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("mismatched types");
    },
    60_000,
  );
});
