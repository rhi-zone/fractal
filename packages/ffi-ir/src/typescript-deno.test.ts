import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t, types } from "@rhi-zone/fractal-type-ir";
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts";
import { denoFfiType, toDenoFfi } from "./typescript-deno.ts";

function handleRef(resourceName: string, freeFn?: string): ReturnType<typeof withOwnership> {
  return withOwnership(
    { shape: { kind: "ref", target: resourceName }, meta: {} },
    ownership.opaqueHandle(freeFn),
  );
}

describe("denoFfiType", () => {
  test("copy discipline (or no ownership meta at all) maps primitives to Deno's FFI type vocabulary", () => {
    expect(denoFfiType(t(types.integer))).toBe("i64");
    expect(denoFfiType(t(types.number))).toBe("f64");
    expect(denoFfiType(withOwnership(t(types.boolean), ownership.copy()))).toBe("u8");
    expect(denoFfiType(t(types.void))).toBe("void");
  });

  test("bytes maps to Deno's native buffer type", () => {
    expect(denoFfiType(t({ kind: "bytes" }))).toBe("buffer");
  });

  test('opaque-handle, refcount, and resource disciplines all collapse to "pointer" — Deno\'s raw FFI layer has no ownership model of its own to distinguish them', () => {
    expect(denoFfiType(handleRef("FileHandle"))).toBe("pointer");
    expect(
      denoFfiType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.refcount())),
    ).toBe("pointer");
    expect(
      denoFfiType(
        withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("own")),
      ),
    ).toBe("pointer");
    expect(
      denoFfiType(
        withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("borrow")),
      ),
    ).toBe("pointer");
  });

  test('"string" throws — no native Deno FFI type and no established fractal C-ABI string-encoding convention', () => {
    expect(() => denoFfiType(t(types.string))).toThrow(/no native Deno FFI type/);
  });

  test('"object" (struct-shaped) throws — Deno supports struct-by-value natively via `{ struct: [...] }` but this minimal projector does not compute C-ABI layout', () => {
    expect(() => denoFfiType(t(types.object({ n: t(types.integer) })))).toThrow(
      /no mapping in this minimal projector/,
    );
  });
});

describe("toDenoFfi — simple function", () => {
  test("a free function with copy-discipline primitive params/return", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
      { libPath: "./libmath.so" },
    );

    const src = toDenoFfi(addFn, "add");

    expect(src).toContain('Deno.dlopen("./libmath.so"');
    expect(src).toContain('"add": { parameters: ["i64", "i64"], result: "i64" }');
    expect(src).toContain("export function add(a: bigint, b: bigint): bigint {");
    expect(src).toContain("return lib.symbols.add(a, b) as bigint");
  });

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())), {
      libPath: "./lib.so",
    });
    expect(() => toDenoFfi(fn)).toThrow(/"function" requires a name/);
  });

  test("a function without meta.libPath throws — no derivable dlopen path", () => {
    const fn = f(boundary.function([], t(types.void)));
    expect(() => toDenoFfi(fn, "noop")).toThrow(/missing required meta\.libPath/);
  });
});

describe("toDenoFfi — reserved-word (JS keyword) identifiers get escaped", () => {
  test("a param named after a JS reserved word gets a trailing-underscore escape", () => {
    const fn: FfiRef = f(
      boundary.function(
        [{ name: "class", type: withOwnership(t(types.integer), ownership.copy()) }],
        withOwnership(t(types.integer), ownership.copy()),
      ),
      { libPath: "./lib.so" },
    );
    const src = toDenoFfi(fn, "identify");
    expect(src).toContain("export function identify(class_: bigint): bigint {");
    // the raw native symbol key is left untouched — reserved words are
    // legal in JS's `object.property` dot-access position (unlike a bare
    // declaration/parameter), so escaping it would only mismatch dlsym for
    // no benefit; same reasoning `renderWrapper`'s own comment gives.
    expect(src).toContain("lib.symbols.identify(class_)");
  });

  test("a wrapper function itself named after a JS reserved word gets a trailing-underscore escape", () => {
    const fn: FfiRef = f(boundary.function([], withOwnership(t(types.void), ownership.copy())), {
      libPath: "./lib.so",
    });
    const src = toDenoFfi(fn, "delete");
    expect(src).toContain("export function delete_(): void {");
  });
});

describe("toDenoFfi — resource with an opaque-handle method", () => {
  test("methods take/return a pointer-typed handle; a paired free wrapper is synthesized", () => {
    // "string" isn't crossable per denoFfiType's own throw (see the dedicated describe block
    // above) — "path" is typed as bytes here to build a realistic module without hitting that
    // unrelated, separately-tested limitation.
    const openFnBytes: FfiRef = f(
      boundary.function([{ name: "path", type: t({ kind: "bytes" }) }], handleRef("FileHandle")),
      { libPath: "./libfile.so" },
    );

    const readMethod: FfiRef = f(boundary.method([], t({ kind: "bytes" }), "FileHandle"));
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"));
    const fileHandle: FfiRef = f(
      boundary.resource("FileHandle", { read: readMethod, close: closeMethod }),
    );
    const fsModule: FfiRef = f(
      boundary.module("fs", { open: openFnBytes }, { FileHandle: fileHandle }),
      {
        libPath: "./libfile.so",
      },
    );

    const src = toDenoFfi(fsModule);

    expect(src).toContain('"open": { parameters: ["buffer"], result: "pointer" }');
    expect(src).toContain('"file_handle_read": { parameters: ["pointer"], result: "buffer" }');
    expect(src).toContain('"file_handle_close": { parameters: ["pointer"], result: "void" }');
    expect(src).toContain('"file_handle_free": { parameters: ["pointer"], result: "void" }');

    expect(src).toContain("export function open(path: Uint8Array | null): Pointer {");
    expect(src).toContain("export function fileHandleRead(handle: Pointer): Uint8Array | null {");
    expect(src).toContain("export function fileHandleClose(handle: Pointer): void {");
    expect(src).toContain("export function fileHandleFree(handle: Pointer): void {");
    expect(src).toContain("lib.symbols.file_handle_free(handle)");
  });
});

describe("toDenoFfi — refcount/resource disciplines produce identical codegen to opaque-handle", () => {
  test("a method returning a refcount- or resource-disciplined reference emits the same pointer-typed wrapper", () => {
    const shareMethodRefcount: FfiRef = f(
      boundary.method(
        [],
        withOwnership(t({ kind: "ref", target: "Node" }), ownership.refcount()),
        "Node",
      ),
    );
    const shareMethodResource: FfiRef = f(
      boundary.method(
        [],
        withOwnership(t({ kind: "ref", target: "Node" }), ownership.resource("own")),
        "Node",
      ),
    );
    const nodeRefcount: FfiRef = f(boundary.resource("Node", { share: shareMethodRefcount }), {
      libPath: "./libtree.so",
    });
    const nodeResource: FfiRef = f(boundary.resource("Node", { share: shareMethodResource }), {
      libPath: "./libtree.so",
    });

    const srcRefcount = toDenoFfi(nodeRefcount, "Node");
    const srcResource = toDenoFfi(nodeResource, "Node");

    // Same symbol/parameter/result shape either way — Deno's raw FFI layer draws no
    // distinction between refcount and own/borrow resource disciplines (see deno.ts's
    // file header); only the ownership metadata differs between the two fixtures above,
    // and it produces byte-identical generated source.
    expect(srcRefcount).toBe(srcResource);
    expect(srcRefcount).toContain('"node_share": { parameters: ["pointer"], result: "pointer" }');
    expect(srcRefcount).toContain("export function nodeShare(handle: Pointer): Pointer {");
  });
});

// ============================================================================
// Real `deno check` compile-check — proves the string-comparison assertions
// above against Deno's own type-checker, not just shape matching.
// `Deno.dlopen`/its FFI type vocabulary are ambient globals in Deno's own lib
// (`lib.deno.ns.d.ts`), so no import is needed for a generated file to
// type-check — this is a genuinely different checking pass from
// typescript-deno.ts's sibling typescript-bun.ts (Bun's own dlopen typings
// are a different ambient surface entirely), verified 2026-08-21 against
// deno 2.6.10 in this repo's devShell. `--no-lock` avoids deno looking for/
// writing a `deno.lock` next to each disposable temp file.
// ============================================================================

function runDenoCheck(source: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "typescript-deno-cc-"));
  try {
    const file = join(dir, "generated.ts");
    writeFileSync(file, source);
    const proc = Bun.spawnSync({
      cmd: ["deno", "check", "--no-lock", file],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { ok: proc.exitCode === 0, output: proc.stdout.toString() + proc.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("toDenoFfi — deno check (real compile-check)", () => {
  test("a simple free function with copy-discipline primitive params/return really type-checks", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
      { libPath: "./libmath.so" },
    );
    const result = runDenoCheck(toDenoFfi(addFn, "add"));
    expect(result.ok, result.output).toBe(true);
  });

  test("reserved-word escaping (a param and the wrapper function itself named after a JS keyword) really type-checks", () => {
    const fn: FfiRef = f(
      boundary.function(
        [{ name: "class", type: withOwnership(t(types.integer), ownership.copy()) }],
        withOwnership(t(types.integer), ownership.copy()),
      ),
      { libPath: "./lib.so" },
    );
    const result = runDenoCheck(toDenoFfi(fn, "delete"));
    expect(result.ok, result.output).toBe(true);
  });

  // A real bug the real `deno check` pass surfaces that the string-comparison
  // tests above cannot see: `POINTER_TYPE_ALIAS`'s local `type Pointer = {} |
  // null` (typescript-deno.ts's own literal spelling of the docs.deno.com FFI
  // page's *prose* description of the pointer type) does not structurally
  // match Deno's real ambient type, `Deno.PointerValue<T>` — the actual
  // `lib.deno.ns.d.ts` declares it as a branded
  // `PointerObject<T> = { readonly [brand]: T } | null`, and passing this
  // file's own `Pointer` alias where `Deno.dlopen`'s real symbol signatures
  // expect `PointerValue` fails with "Property '[brand]' is missing in type
  // '{}' but required in type 'PointerObject<unknown>'". The `buffer`
  // parameter type has a matching mismatch: a wrapper typed `Uint8Array |
  // null` fails against the real symbol call's `BufferSource | null`
  // parameter ("Type 'Uint8Array<ArrayBufferLike>' is not assignable to type
  // 'ArrayBufferView<ArrayBuffer>'"). Reproduced directly against `deno
  // check` 2026-08-21; not fixed here per this suite's own "record, don't
  // silently fix" convention (see packages/type-ir/src/compile-check.test.ts's
  // identical use of `test.todo` for its own real-toolchain findings).
  test.todo(
    "a resource's pointer/buffer-typed methods and its paired free wrapper really type-check (currently fails — Pointer/buffer alias mismatch vs. Deno's real PointerValue/BufferSource types, see comment above)",
    () => {},
  );

  // Proves the checks above aren't vacuous: a real type mismatch (declaring
  // a `bigint`-returning symbol call as `string`) is genuinely rejected by
  // `deno check`, not just asserted from string shape.
  test("a deliberate type mismatch is genuinely rejected by deno check", () => {
    const broken = [
      'const lib = Deno.dlopen("./libmath.so", {',
      '    "add": { parameters: ["i64", "i64"], result: "i64" },',
      "})",
      "",
      "export function add(a: bigint, b: bigint): string {",
      "  return lib.symbols.add(a, b) as bigint",
      "}",
    ].join("\n");
    const result = runDenoCheck(broken);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("error");
  });
});
