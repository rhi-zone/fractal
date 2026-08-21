import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { t, types } from "@rhi-zone/fractal-type-ir";
import { toBun, toBunFfiType } from "./typescript-bun.ts";
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts";

/** The C-target convention for referencing an opaque resource by pointer —
 * same helper `c-abi.test.ts` uses, duplicated here since ffi-ir's test
 * files are self-contained (matching the source files' own duplication
 * precedent). */
function handleRef(resourceName: string, freeFn?: string): ReturnType<typeof withOwnership> {
  return withOwnership(
    { shape: { kind: "ref", target: resourceName }, meta: {} },
    ownership.opaqueHandle(freeFn),
  );
}

describe("toBunFfiType", () => {
  test("copy discipline (or no ownership meta at all) maps primitives to their FFIType token", () => {
    expect(toBunFfiType(t(types.integer))).toBe("i64");
    expect(toBunFfiType(withOwnership(t(types.boolean), ownership.copy()))).toBe("bool");
    expect(toBunFfiType(t(types.string))).toBe("cstring");
    expect(toBunFfiType(t(types.void))).toBe("void");
    expect(toBunFfiType(t(types.null))).toBe("void");
  });

  test('opaque-handle discipline becomes "ptr", regardless of the underlying shape', () => {
    expect(toBunFfiType(handleRef("FileHandle"))).toBe("ptr");
  });

  test(
    'refcount discipline ALSO becomes "ptr" — not gated, unlike rust-c-abi.ts: the dlopen symbol-level ' +
      "representation of a refcounted handle and an opaque handle are identical (both raw pointers); only the " +
      "free-side bookkeeping differs, which this signature-only generator doesn't emit either way",
    () => {
      expect(toBunFfiType(withOwnership(t(types.integer), ownership.refcount()))).toBe("ptr");
    },
  );

  test("resource discipline (own/borrow) throws — WIT's Canonical ABI handle-table mechanism, not a raw C-ABI pointer a plain dlopen'd library speaks", () => {
    expect(() =>
      toBunFfiType(
        withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("own")),
      ),
    ).toThrow(/unsupported ownership discipline "resource"/);
    expect(() =>
      toBunFfiType(
        withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("borrow")),
      ),
    ).toThrow(/unsupported ownership discipline "resource"/);
  });

  test('struct-by-value (an "object" TypeRef under copy discipline) throws — bun:ffi\'s FFIType vocabulary has no struct token', () => {
    expect(() => toBunFfiType(t(types.object({ x: t(types.integer) })))).toThrow(
      /unhandled kind "object"/,
    );
  });

  test("other structurally-compound kinds also throw rather than guess a lossy encoding", () => {
    expect(() => toBunFfiType(t(types.array(t(types.integer))))).toThrow(/unhandled kind "array"/);
    expect(() => toBunFfiType(t(types.map(t(types.string), t(types.integer))))).toThrow(
      /unhandled kind "map"/,
    );
    expect(() => toBunFfiType(t(types.tuple([t(types.integer), t(types.string)])))).toThrow(
      /unhandled kind "tuple"/,
    );
  });
});

describe("toBun — function", () => {
  test("a simple free function: one dlopen call, one symbol entry, one wrapper", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const src = toBun(addFn, "./libmath.so", "add");

    expect(src).toContain('import { dlopen } from "bun:ffi"');
    expect(src).toContain('dlopen("./libmath.so", {');
    expect(src).toContain('"add": { args: ["i64", "i64"], returns: "i64" },');
    expect(src).toContain("export function add(a: unknown, b: unknown) {");
    expect(src).toContain('return symbols["add"](a, b)');
  });

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    expect(() => toBun(fn, "./lib.so")).toThrow(/"function" requires a name/);
  });

  test("a function taking a resource parameter uses the opaque-handle ptr token", () => {
    const closeFn: FfiRef = f(
      boundary.function(
        [{ name: "handle", type: handleRef("FileHandle", "file_handle_free") }],
        withOwnership(t(types.void), ownership.copy()),
      ),
    );
    const src = toBun(closeFn, "./lib.so", "close");
    expect(src).toContain('"close": { args: ["ptr"], returns: "void" },');
  });

  test("a bare method cannot be projected standalone — must go through its enclosing resource", () => {
    const method = f(
      boundary.method([], withOwnership(t(types.void), ownership.copy()), "FileHandle"),
    );
    expect(() => toBun(method, "./lib.so", "close")).toThrow(
      /bare "method" cannot be projected on its own/,
    );
  });
});

describe("toBun — reserved-word (JS keyword) identifiers get escaped", () => {
  test("a param named after a JS reserved word gets a trailing-underscore escape", () => {
    const fn: FfiRef = f(
      boundary.function(
        [{ name: "class", type: withOwnership(t(types.integer), ownership.copy()) }],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const src = toBun(fn, "./lib.so", "identify");
    expect(src).toContain("export function identify(class_: unknown) {");
    // the raw native symbol string stays exactly "identify" — quoted bracket
    // access, never a bare escaped identifier (see buildWrapper's own
    // comment on `symbolName`).
    expect(src).toContain('return symbols["identify"](class_)');
  });

  test("a wrapper function itself named after a JS reserved word gets a trailing-underscore escape", () => {
    const fn: FfiRef = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    const src = toBun(fn, "./lib.so", "delete");
    expect(src).toContain("export function delete_() {");
  });
});

describe("toBun — resource", () => {
  test("opaque-handle method receiver, plus an auto-generated free wrapper", () => {
    const readMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.integer), ownership.copy()), "FileHandle"),
    );
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }));
    const src = toBun(fileHandle, "./lib.so");

    // method: receiver synthesized as a leading "ptr" arg
    expect(src).toContain('"file_handle_read": { args: ["ptr"], returns: "i64" },');
    expect(src).toContain("export function FileHandle_read(handle: number");
    expect(src).toContain('return symbols["file_handle_read"](handle)');

    // paired free function, matching rust-c-abi.ts's `<resource>_free` convention
    expect(src).toContain('"file_handle_free": { args: ["ptr"], returns: "void" },');
    expect(src).toContain("export function FileHandle_free(handle: number) {");
    expect(src).toContain('return symbols["file_handle_free"](handle)');
  });

  test("a method whose data-shape return can't cross bun:ffi's FFIType vocabulary throws (e.g. array-by-value)", () => {
    const readMethod: FfiRef = f(
      boundary.method(
        [],
        withOwnership(t(types.array(t(types.integer))), ownership.copy()),
        "FileHandle",
      ),
    );
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }));
    expect(() => toBun(fileHandle, "./lib.so")).toThrow(/unhandled kind "array"/);
  });
});

describe("toBun — module", () => {
  test("one dlopen call grouping every function's and every resource's methods' symbols", () => {
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

    const src = toBun(fsModule, "./libfs.so");

    // exactly one dlopen call for the whole module
    expect(src.match(/dlopen\(/g)?.length).toBe(1);

    expect(src).toContain('"open": { args: ["cstring"], returns: "ptr" },');
    expect(src).toContain('"file_handle_close": { args: ["ptr"], returns: "void" },');
    expect(src).toContain('"file_handle_free": { args: ["ptr"], returns: "void" },');

    expect(src).toContain("export function open(path: unknown) {");
    expect(src).toContain("export function FileHandle_close(handle: number");
    expect(src).toContain("export function FileHandle_free(handle: number) {");
  });
});

// ============================================================================
// Real-toolchain check — tsc --noEmit against real `bun:ffi` ambient types.
//
// Unlike packages/type-ir/src/compile-check.test.ts's own `tscBin` (a local
// `node_modules/.bin/tsc` symlink, present there because packages/type-ir/
// package.json lists `typescript` directly as a devDependency), ffi-ir
// itself lists no `typescript` devDependency and has no local tsc binary —
// so this reaches up to the repo root's hoisted `node_modules/.bin/tsc`
// instead (same physical `typescript@6.0.3` binary, just resolved from a
// different node_modules directory up the tree).
//
// `bun-types` (which declares the ambient `declare module "bun:ffi"` this
// file's own generated `import { dlopen } from "bun:ffi"` needs) is only
// vendored at the *repo root*'s node_modules, not inside
// packages/ffi-ir/node_modules — so `--types bun-types` is passed explicitly
// (tsconfig.json's own `"types": ["bun-types"]` field is unreachable here
// since `--ignoreConfig` skips tsconfig.json entirely, same reason type-ir's
// own runTsc passes `--ignoreConfig`). The generated file still has to live
// inside packages/ffi-ir/ itself (not the OS tmpdir) so tsc's node-style
// `--types` package resolution walks upward from the file's own directory
// through packages/ffi-ir/node_modules (not found) to the repo root's
// node_modules (found) — the exact same "resolution walks up to real
// node_modules" reasoning type-ir's own file-level comment documents for
// its typebox check, just one extra directory level up.
const tscBin = join(import.meta.dir, "..", "..", "..", "node_modules", ".bin", "tsc");

type RunResult = { ok: boolean; output: string };

function runTsc(files: string[]): RunResult {
  const proc = Bun.spawnSync({
    cmd: [
      tscBin,
      "--noEmit",
      "--ignoreConfig",
      "--strict",
      "--target",
      "es2022",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "--types",
      "bun-types",
      ...files,
    ],
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    output: proc.stdout.toString() + proc.stderr.toString(),
  };
}

function checkBunFfi(src: string): RunResult {
  const dir = mkdtempSync(join(import.meta.dir, ".cc-bun-"));
  try {
    const file = join(dir, "generated.ts");
    writeFileSync(file, src);
    return runTsc([file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("toBun (tsc --noEmit, real bun:ffi ambient types)", () => {
  test("a zero-parameter function typechecks cleanly", () => {
    const pingFn: FfiRef = f(
      boundary.function([], withOwnership(t(types.void), ownership.copy())),
    );
    const result = checkBunFfi(toBun(pingFn, "./lib.so", "ping"));
    expect(result.ok, result.output).toBe(true);
  });

  test("a reserved-word (JS keyword) function name, zero params, typechecks cleanly — proves escapeJsIdent's trailing-underscore escape produces real, valid TS syntax, not just a string that merely looks right", () => {
    const fn: FfiRef = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    const src = toBun(fn, "./lib.so", "delete");
    expect(src).toContain("export function delete_() {");
    const result = checkBunFfi(src);
    expect(result.ok, result.output).toBe(true);
  });

  test("a hand-written, deliberately-broken TS file is genuinely rejected by tsc (proves this check isn't vacuous)", () => {
    const result = checkBunFfi("const x: number = 'not a number'\n");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("error TS2322");
  });

  // ==========================================================================
  // Real bug this real-compiler check surfaces, that the string-comparison
  // tests above structurally cannot see: `buildWrapper`'s generated wrapper
  // functions are fundamentally not type-safe against bun:ffi's own real
  // FFIType-derived TS signatures — confirmed via two independent probes
  // against the real `bun-types` ambient declarations (bun-types version
  // pinned by the repo root's `typescript`/`bun-types` lockfile entries,
  // verified 2026-08-21):
  //
  //   1. Every non-receiver parameter is typed as bare `unknown`
  //      (`buildWrapper`: `params.push(`${escapeJsIdent(p.name)}: unknown`)`)
  //      then passed directly into the strongly-typed `symbols[...]` call.
  //      `unknown` is never assignable to another type without a narrowing
  //      check or a cast, so tsc rejects this for *every* FFIType regardless
  //      of which one — confirmed against `i64` (`args: ["i64", "i64"]`):
  //        "error TS2345: Argument of type 'unknown' is not assignable to
  //         parameter of type 'number | bigint'."
  //
  //   2. A resource method's synthesized receiver parameter is typed as bare
  //      `number` (`buildWrapper`'s `selfParam` branch:
  //      `params.push(`handle: number /* ${selfParam} */`)`), but bun:ffi's
  //      real `FFIType` "ptr" token maps to its own branded `Pointer` type
  //      (not assignable from a bare `number` without a cast) — confirmed:
  //        "error TS2345: Argument of type 'number' is not assignable to
  //         parameter of type 'TypedArray<ArrayBufferLike> | Pointer |
  //         CString | null'."
  //
  // Net effect: essentially every `toBun`-generated function/method that
  // takes at least one parameter fails `tsc --noEmit --strict` against the
  // real `bun:ffi` ambient types, today — only zero-parameter functions
  // (the two tests directly above) currently typecheck cleanly. Recorded
  // here as `test.todo` (mirroring packages/type-ir/src/compile-check.test.ts's
  // own convention) rather than silently fixed, since fixing `typescript-bun.ts`
  // itself is a real, separate change outside this test-coverage task's scope.
  // ==========================================================================
  test.todo(
    "a simple function with primitive int params/return (e.g. add(a: int, b: int): int) — FAILS: params typed `unknown` aren't assignable to bun:ffi's real `number | bigint` FFIType parameter type",
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
      const result = checkBunFfi(toBun(addFn, "./libmath.so", "add"));
      expect(result.ok, result.output).toBe(true);
    },
  );

  test.todo(
    "a resource method call (opaque-handle receiver) — FAILS: the synthesized `handle: number` receiver isn't assignable to bun:ffi's real branded `Pointer` type for the `ptr` FFIType",
    () => {
      const readMethod: FfiRef = f(
        boundary.method([], withOwnership(t(types.integer), ownership.copy()), "FileHandle"),
      );
      const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }));
      const result = checkBunFfi(toBun(fileHandle, "./lib.so"));
      expect(result.ok, result.output).toBe(true);
    },
  );
});
