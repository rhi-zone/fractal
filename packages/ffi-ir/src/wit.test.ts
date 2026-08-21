import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t, types } from "@rhi-zone/fractal-type-ir";
import { boundary, f, ownership, resourceRef, withOwnership, type FfiRef } from "./index.ts";
import { toWit } from "./wit.ts";

describe("toWit — module with a simple copy-discipline function", () => {
  test("a module with one free function of copy-discipline primitive params/return", () => {
    const params = [
      { name: "path", type: withOwnership(t(types.string), ownership.copy()) },
      { name: "mode", type: withOwnership(t(types.string), ownership.copy()) },
    ];
    const returnType = withOwnership(t(types.boolean), ownership.copy());
    const existsFn = f(boundary.function(params, returnType));
    const fsModule = f(boundary.module("fs", { fileExists: existsFn }, {}));

    const wit = toWit(fsModule);

    expect(wit).toBe(
      ["interface fs {", "    file-exists: func(path: string, mode: string) -> bool;", "}"].join(
        "\n",
      ),
    );
  });

  test("a copy-discipline record (object) return type hoists a named `record` declaration", () => {
    const contentType = withOwnership(
      t(types.object({ bytes: t(types.array(t(types.integer))), length: t(types.integer) })),
      ownership.copy(),
    );
    const params = [{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }];
    const readFn = f(boundary.function(params, contentType));
    const fsModule = f(boundary.module("fs", { readFile: readFn }, {}));

    const wit = toWit(fsModule);

    expect(wit).toContain("record read-file-result {");
    expect(wit).toContain("bytes: list<s64>,");
    expect(wit).toContain("length: s64,");
    expect(wit).toContain("read-file: func(path: string) -> read-file-result;");
  });
});

describe("toWit — resource with own/borrow-style methods", () => {
  function buildFileHandleModule(): FfiRef {
    const readMethod = f(
      boundary.method(
        [],
        withOwnership(t(types.array(t(types.integer))), ownership.copy()),
        "FileHandle",
      ),
    );
    const closeMethod = f(boundary.method([], t(types.void), "FileHandle"));
    const fileHandle = f(boundary.resource("FileHandle", { read: readMethod, close: closeMethod }));

    const openParams = [{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }];
    const openReturn = withOwnership(resourceRef("FileHandle", "own"), ownership.resource("own"));
    const openFn = f(boundary.function(openParams, openReturn));

    return f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }));
  }

  test("a resource emits a nested `resource` block with implicit-receiver methods", () => {
    const wit = toWit(buildFileHandleModule());

    expect(wit).toContain("resource file-handle {");
    expect(wit).toContain("    read: func() -> list<s64>;");
    expect(wit).toContain("    close: func();");
  });

  test("an owned resource return type renders as the bare resource name", () => {
    const wit = toWit(buildFileHandleModule());

    expect(wit).toContain("open: func(path: string) -> file-handle;");
  });

  test("a borrowed resource parameter renders as borrow<name>", () => {
    const closeMethod = f(boundary.method([], t(types.void), "FileHandle"));
    const fileHandle = f(boundary.resource("FileHandle", { close: closeMethod }));

    const releaseParams = [{ name: "handle", type: resourceRef("FileHandle", "borrow") }];
    const releaseFn = f(boundary.function(releaseParams, t(types.void)));
    const fsModule = f(boundary.module("fs", { release: releaseFn }, { FileHandle: fileHandle }));

    const wit = toWit(fsModule);

    expect(wit).toContain("release: func(handle: borrow<file-handle>);");
  });

  test("a standalone resource (not wrapped in a module) also emits a `resource` block", () => {
    const closeMethod = f(boundary.method([], t(types.void), "FileHandle"));
    const fileHandle = f(boundary.resource("FileHandle", { close: closeMethod }));

    const wit = toWit(fileHandle);

    expect(wit).toBe(["resource file-handle {", "    close: func();", "}"].join("\n"));
  });
});

// Reserved-word collision coverage — string-comparison only (no real `wit`/
// `wasm-tools` toolchain is wired into `nix develop`'s devShell for this
// package, unlike packages/type-ir/src/compile-check.test.ts's real-compiler
// checks for its own targets), so these assert the `%`-escaped shape the
// WIT grammar's own documented keyword-escape mechanism requires
// (component-model.bytecodealliance.org's WIT.md — "An identifier may be
// preceded by a single `%` sign... required if the identifier would
// otherwise be a WIT keyword"), not an actual `wasm-tools` parse.
describe("toWit — reserved-word (WIT keyword) identifiers get the %-escape", () => {
  test("a function named after a WIT keyword", () => {
    const fn = f(boundary.function([], t(types.void)));
    const wit = toWit(fn, "type");
    expect(wit).toBe("%type: func();");
  });

  test("a param named after a WIT keyword", () => {
    const fn = f(
      boundary.function(
        [{ name: "list", type: withOwnership(t(types.string), ownership.copy()) }],
        t(types.void),
      ),
    );
    const wit = toWit(fn, "process");
    expect(wit).toBe("process: func(%list: string);");
  });

  test("a resource named after a WIT keyword", () => {
    const closeMethod = f(boundary.method([], t(types.void), "resource"));
    const resource = f(boundary.resource("resource", { close: closeMethod }));
    const wit = toWit(resource);
    expect(wit).toContain("resource %resource {");
  });

  test("an interface (module) named after a WIT keyword", () => {
    const module = f(boundary.module("interface", {}, {}));
    const wit = toWit(module);
    expect(wit).toContain("interface %interface {");
  });
});

describe("toWit — unsupported ownership disciplines throw for this target", () => {
  test("opaque-handle ownership throws", () => {
    const params = [
      {
        name: "buffer",
        type: withOwnership(t(types.string), ownership.opaqueHandle("buffer_free")),
      },
    ];
    const fn = f(boundary.function(params, t(types.void)));
    const module = f(boundary.module("m", { useBuffer: fn }, {}));

    expect(() => toWit(module)).toThrow(/unsupported ownership discipline "opaque-handle"/);
  });

  test("refcount ownership throws", () => {
    const params = [{ name: "handle", type: withOwnership(t(types.string), ownership.refcount()) }];
    const fn = f(boundary.function(params, t(types.void)));
    const module = f(boundary.module("m", { useHandle: fn }, {}));

    expect(() => toWit(module)).toThrow(/unsupported ownership discipline "refcount"/);
  });

  test("opaque-handle on a return type throws, not just on params", () => {
    const returnType = withOwnership(t(types.string), ownership.opaqueHandle());
    const fn = f(boundary.function([], returnType));
    const module = f(boundary.module("m", { getHandle: fn }, {}));

    expect(() => toWit(module)).toThrow(/unsupported ownership discipline "opaque-handle"/);
  });
});

describe("toWit — error cases", () => {
  test("a standalone function/method requires a name", () => {
    const fn = boundary.function([], t(types.void));
    expect(() => toWit(f(fn))).toThrow(/requires a name/);
  });

  test("resource ownership metadata on a non-ref TypeRef throws", () => {
    const badType = withOwnership(t(types.string), ownership.resource("own"));
    const fn = f(boundary.function([], badType));
    const module = f(boundary.module("m", { bad: fn }, {}));

    expect(() => toWit(module)).toThrow(/requires a \{ kind: "ref" \} TypeRef/);
  });
});

// ============================================================================
// Real `wasm-tools component wit` compile-check — proves the string-
// comparison assertions above against a real WIT parser/validator, not just
// shape matching. `toWit`'s own `module` output is already a bare
// `interface name { ... }` block, which per `wasm-tools component wit
// --help`'s own documented single-`*.wit`-file input is a complete WIT
// *document* on its own — but a WIT *package* additionally requires a
// leading `package <namespace>:<name>;` header ("no `package` header was
// found in any WIT file for this package", confirmed directly against
// wasm-tools 1.245.1 in this repo's devShell, 2026-08-21); that header names
// information no ffi-ir `FfiRef`/`FfiShape` carries (ffi-ir's own `module`
// name maps to a WIT `interface`, not a WIT `package`), so this test file's
// own helper supplies a throwaway one, the same "consuming file's
// responsibility, not the codegen snippet's" split
// packages/type-ir/src/compile-check.test.ts's Go/Rust import-line helpers
// already use for their own targets.
// ============================================================================

function runWasmToolsWit(witSource: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "wit-cc-"));
  try {
    const file = join(dir, "package.wit");
    writeFileSync(file, `package fractal:cc;\n\n${witSource}\n`);
    const proc = Bun.spawnSync({
      cmd: ["wasm-tools", "component", "wit", file],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { ok: proc.exitCode === 0, output: proc.stdout.toString() + proc.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("toWit — wasm-tools component wit (real compile-check)", () => {
  test("a module with a simple copy-discipline function really parses/validates", () => {
    const params = [
      { name: "path", type: withOwnership(t(types.string), ownership.copy()) },
      { name: "mode", type: withOwnership(t(types.string), ownership.copy()) },
    ];
    const returnType = withOwnership(t(types.boolean), ownership.copy());
    const existsFn = f(boundary.function(params, returnType));
    const fsModule = f(boundary.module("fs", { fileExists: existsFn }, {}));

    const result = runWasmToolsWit(toWit(fsModule));
    expect(result.ok, result.output).toBe(true);
  });

  test("a resource with own/borrow-style methods really parses/validates", () => {
    const readMethod = f(
      boundary.method(
        [],
        withOwnership(t(types.array(t(types.integer))), ownership.copy()),
        "FileHandle",
      ),
    );
    const closeMethod = f(boundary.method([], t(types.void), "FileHandle"));
    const fileHandle = f(boundary.resource("FileHandle", { read: readMethod, close: closeMethod }));
    const openParams = [{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }];
    const openReturn = withOwnership(resourceRef("FileHandle", "own"), ownership.resource("own"));
    const openFn = f(boundary.function(openParams, openReturn));
    const fsModule = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }));

    const result = runWasmToolsWit(toWit(fsModule));
    expect(result.ok, result.output).toBe(true);
  });

  test("%-escaped keyword-collision function and param names really parse/validate", () => {
    const typeFn = f(boundary.function([], t(types.void)));
    const listParamFn = f(
      boundary.function(
        [{ name: "list", type: withOwnership(t(types.string), ownership.copy()) }],
        t(types.void),
      ),
    );
    const module = f(boundary.module("m", { type: typeFn, process: listParamFn }, {}));

    const result = runWasmToolsWit(toWit(module));
    expect(result.ok, result.output).toBe(true);
  });

  test("a %-escaped keyword-collision resource name really parses/validates", () => {
    const closeMethod = f(boundary.method([], t(types.void), "resource"));
    const resourceShape = f(boundary.resource("resource", { close: closeMethod }));
    const module = f(boundary.module("m", {}, { resource: resourceShape }));

    const result = runWasmToolsWit(toWit(module));
    expect(result.ok, result.output).toBe(true);
  });

  // Proves the checks above aren't vacuous: a real WIT syntax error is
  // genuinely rejected by wasm-tools, not just asserted from string shape.
  test("deliberately malformed WIT (a missing comma between params) is genuinely rejected", () => {
    const result = runWasmToolsWit(
      ["interface broken {", "  bad: func(a: string b: string);", "}"].join("\n"),
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("error");
  });
});
