import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t, types } from "@rhi-zone/fractal-type-ir";
import { toCtypes, toCtypesShape, toCtypesType } from "./python-ctypes.ts";
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts";

/** The C-target convention for referencing an opaque resource by pointer:
 * a plain `ref` TypeRef carrying `opaque-handle` ownership — matches
 * `c-abi.test.ts`'s identical `handleRef` helper for the producer side. */
function handleRef(resourceName: string, freeFn?: string): ReturnType<typeof withOwnership> {
  return withOwnership(
    { shape: { kind: "ref", target: resourceName }, meta: {} },
    ownership.opaqueHandle(freeFn),
  );
}

describe("toCtypesShape", () => {
  test("primitive kinds map to ctypes' own vocabulary", () => {
    expect(toCtypesShape(t(types.integer))).toBe("c_int64");
    expect(toCtypesShape(t(types.number))).toBe("c_double");
    expect(toCtypesShape(t(types.boolean))).toBe("c_bool");
    expect(toCtypesShape(t(types.string))).toBe("c_char_p");
    expect(toCtypesShape(t(types.void))).toBe("None");
    expect(toCtypesShape(t(types.null))).toBe("None");
  });

  test("a ref TypeRef passes the target name through, trusting a Structure of that name exists", () => {
    expect(toCtypesShape(t({ kind: "ref", target: "FileHandle" }))).toBe("FileHandle");
  });

  test("an object TypeRef requires meta.typeName", () => {
    expect(() => toCtypesShape(t(types.object({})))).toThrow(/requires meta\.typeName/);
  });

  test("array/tuple/map/union — no native ctypes representation, throws", () => {
    expect(() => toCtypesShape(t(types.array(t(types.integer))))).toThrow(
      /no ctypes representation/,
    );
    expect(() => toCtypesShape(t(types.tuple([t(types.integer), t(types.string)])))).toThrow(
      /no ctypes representation/,
    );
    expect(() => toCtypesShape(t(types.map(t(types.string), t(types.integer))))).toThrow(
      /no ctypes representation/,
    );
    expect(() => toCtypesShape(t(types.union([t(types.integer), t(types.string)])))).toThrow(
      /no ctypes representation/,
    );
  });
});

describe("toCtypesType — ownership discipline", () => {
  test("copy discipline (or no ownership meta at all) is the plain ctype", () => {
    expect(toCtypesType(t(types.integer))).toBe("c_int64");
    expect(toCtypesType(withOwnership(t(types.boolean), ownership.copy()))).toBe("c_bool");
  });

  test("opaque-handle discipline becomes POINTER(<T>)", () => {
    expect(toCtypesType(handleRef("FileHandle"))).toBe("POINTER(FileHandle)");
  });

  test(
    "refcount and resource(own/borrow) disciplines produce the SAME POINTER(<T>) declaration as opaque-handle — " +
      "ctypes has no type-level way to distinguish them (see ctypes.ts file header)",
    () => {
      expect(
        toCtypesType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.refcount())),
      ).toBe("POINTER(FileHandle)");
      expect(
        toCtypesType(
          withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("own")),
        ),
      ).toBe("POINTER(FileHandle)");
      expect(
        toCtypesType(
          withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("borrow")),
        ),
      ).toBe("POINTER(FileHandle)");
    },
  );
});

describe("toCtypes — function", () => {
  test("a simple free function: argtypes/restype wiring plus a thin wrapper", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const src = toCtypes(addFn, "add");

    expect(src).toContain('getattr(lib, "add").argtypes = [c_int64, c_int64]');
    expect(src).toContain('getattr(lib, "add").restype = c_int64');
    expect(src).toContain("def add(a, b):");
    expect(src).toContain('return getattr(lib, "add")(a, b)');
  });

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    expect(() => toCtypes(fn)).toThrow(/"function" requires a name/);
  });

  test("a void-returning function gets restype = None", () => {
    const closeFn: FfiRef = f(
      boundary.function(
        [{ name: "handle", type: handleRef("FileHandle") }],
        withOwnership(t(types.void), ownership.copy()),
      ),
    );
    const src = toCtypes(closeFn, "close");
    expect(src).toContain('getattr(lib, "close").argtypes = [POINTER(FileHandle)]');
    expect(src).toContain('getattr(lib, "close").restype = None');
  });
});

// Reserved-word collision coverage — string-comparison only here; the
// keyword-collision case is exercised again below against a real compiled
// symbol (see "toCtypes — real python3 execution against a compiled stub
// .so").
describe("toCtypes — reserved-word (Python keyword) identifiers get a trailing-underscore escape", () => {
  test("a param named after a Python reserved word", () => {
    const fn: FfiRef = f(
      boundary.function(
        [{ name: "class", type: withOwnership(t(types.integer), ownership.copy()) }],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const src = toCtypes(fn, "identify");
    expect(src).toContain("def identify(class_):");
    expect(src).toContain('return getattr(lib, "identify")(class_)');
  });

  test("a standalone/module-level function itself named after a Python reserved word — the native-symbol access stays getattr(lib, ...), never a bare lib.<keyword> (a SyntaxError in Python)", () => {
    const fn: FfiRef = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    const src = toCtypes(fn, "class");
    expect(src).toContain('getattr(lib, "class").argtypes = []');
    expect(src).toContain("def class_():");
    expect(src).toContain('return getattr(lib, "class")()');
  });
});

describe("toCtypes — resource, opaque-handle discipline", () => {
  test("a resource with a constructor and a method: opaque Structure, method wiring, free-function wiring, wrapper class", () => {
    const readMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.integer), ownership.copy()), "FileHandle"),
    );
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }));

    const openFn: FfiRef = f(
      boundary.function(
        [{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }],
        handleRef("FileHandle"),
      ),
    );

    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }));
    const src = toCtypes(fsModule);

    // opaque Structure, permanently incomplete (no _fields_)
    expect(src).toContain("class FileHandle(Structure):");
    expect(src).toContain("    pass");

    // constructor returns a pointer to the opaque struct
    expect(src).toContain('getattr(lib, "open").restype = POINTER(FileHandle)');
    expect(src).toContain("def open(path):");

    // method wiring, receiver-prefixed with a synthesized handle parameter
    expect(src).toContain('getattr(lib, "file_handle_read").argtypes = [POINTER(FileHandle)]');
    expect(src).toContain('getattr(lib, "file_handle_read").restype = c_int64');
    expect(src).toContain("def file_handle_read(handle):");

    // auto-generated free-function wiring — `buildFreeFunction` (not
    // `buildFunction`) synthesizes this one, and its `<resource>_free` name
    // is always concatenated (never a bare keyword collision risk), so it
    // stays a plain `lib.` dot-access rather than `getattr(lib, ...)`.
    expect(src).toContain("lib.file_handle_free.argtypes = [POINTER(FileHandle)]");
    expect(src).toContain("lib.file_handle_free.restype = None");

    // wrapper class: stores the handle, delegates read(), frees on __del__
    expect(src).toContain("class FileHandle:");
    expect(src).toContain("def __init__(self, handle):");
    expect(src).toContain("self._handle = handle");
    expect(src).toContain("def read(self):");
    expect(src).toContain("return file_handle_read(self._handle)");
    expect(src).toContain("def __del__(self):");
    expect(src).toContain("file_handle_free(self._handle)");
  });

  test("resource emission ignores an explicit name argument in favor of the shape's own name", () => {
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", {}));
    const src = toCtypes(fileHandle, "SomeOtherName");
    expect(src).toContain("class FileHandle(Structure):");
    expect(src).not.toContain("SomeOtherName");
  });
});

describe("toCtypes — resource, other ownership disciplines (refcount / resource own-borrow)", () => {
  test(
    "a function taking a refcount- or resource-discipline handle produces the IDENTICAL POINTER(<T>) argtype as " +
      "opaque-handle — ctypes has no ownership model of its own, so it cannot distinguish these at the declaration level " +
      "(see ctypes.ts file header for the full reasoning)",
    () => {
      const refcountFn: FfiRef = f(
        boundary.function(
          [
            {
              name: "handle",
              type: withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.refcount()),
            },
          ],
          withOwnership(t(types.void), ownership.copy()),
        ),
      );
      const resourceFn: FfiRef = f(
        boundary.function(
          [
            {
              name: "handle",
              type: withOwnership(
                t({ kind: "ref", target: "FileHandle" }),
                ownership.resource("borrow"),
              ),
            },
          ],
          withOwnership(t(types.void), ownership.copy()),
        ),
      );
      const opaqueFn: FfiRef = f(
        boundary.function(
          [{ name: "handle", type: handleRef("FileHandle") }],
          withOwnership(t(types.void), ownership.copy()),
        ),
      );

      const refcountSrc = toCtypes(refcountFn, "release");
      const resourceSrc = toCtypes(resourceFn, "borrow_use");
      const opaqueSrc = toCtypes(opaqueFn, "close");

      expect(refcountSrc).toContain('getattr(lib, "release").argtypes = [POINTER(FileHandle)]');
      expect(resourceSrc).toContain('getattr(lib, "borrow_use").argtypes = [POINTER(FileHandle)]');
      expect(opaqueSrc).toContain('getattr(lib, "close").argtypes = [POINTER(FileHandle)]');
    },
  );
});

describe("toCtypes — module", () => {
  test("emits a CDLL load block followed by resources then functions", () => {
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

    const src = toCtypes(fsModule);
    expect(src).toContain("from ctypes import *");
    expect(src).toContain('lib = CDLL("./libfs.so")');
    expect(src).toContain("class FileHandle(Structure):");
    expect(src).toContain("def open(path):");
    expect(src).toContain("def file_handle_close(handle):");

    // opaque struct/resource block appears before the module-level open() function
    expect(src.indexOf("class FileHandle(Structure):")).toBeLessThan(
      src.indexOf("def open(path):"),
    );
  });

  test("libraryPath overrides the default ./lib<name>.so placeholder", () => {
    const fsModule: FfiRef = f(boundary.module("fs", {}, {}));
    const src = toCtypes(fsModule, undefined, "/usr/local/lib/libfs.so.1");
    expect(src).toContain('lib = CDLL("/usr/local/lib/libfs.so.1")');
  });
});

// ============================================================================
// Real-toolchain compile-check coverage — python3 actually *running* the
// generated ctypes source (not just this file's string-comparison tests
// above), the same real-execution bar packages/type-ir/src/compile-check.test.ts
// holds its python-pydantic/python-attrs sections to.
//
// Why not the same bare `python3 file.py` those sections use, unconditionally:
// every module-level toCtypes() output does `lib = CDLL(<path>)` at import
// time. Every fixture's path is a placeholder (`./lib<name>.so` or whatever
// `libraryPath` is passed) with no real shared library behind it anywhere in
// this repo — producing one is rust-c-abi.ts's job, a different target
// entirely — so a bare `python3 file.py` run would raise `OSError: cannot
// load library` on 100% of fixtures regardless of whether python-ctypes.ts's
// own output is correct. Not useful: it would never fail for the right
// reason.
//
// Two real, non-vacuous alternatives were weighed:
//   (a) `python3 -m py_compile` — syntax-only, mirroring the
//       ruby-sorbet/ruby-dry-types precedent below in this same repo
//       ("parse-only is still a real check when full execution isn't
//       feasible").
//   (b) actually compile a tiny stub .so via gcc (present in the nix
//       devshell through stdenv's default cc — flake.nix's `buildInputs`)
//       exporting symbols matching a fixture's function name(s) and C-ABI
//       signature, point `CDLL` at that real file, and run the generated
//       module for real.
//
// (b) is used below, for a small, fixed set of hand-matched fixtures (a
// plain function, a function+param both named a Python keyword, and an
// opaque-handle resource's open/method/free triple) — each needs only a
// handful of lines of matching C, so the setup stays scoped, and the payoff
// is real: these tests exercise actual ctypes argtypes/restype marshaling
// and symbol resolution end to end (wrong arg count/order, wrong restype,
// wrong POINTER wrapping, or a keyword-collision escape that doesn't
// actually round-trip through getattr(lib, ...) would all surface as a
// real Python-level failure here, not just a string mismatch). This is
// deliberately NOT extended to hand-match every string-comparison fixture
// above — matching C stubs one by one doesn't scale, and a large,
// fragile native-symbol-matching scheme blocking the whole suite would be
// worse than falling back to (a)'s weaker but unconditionally-real
// syntax-only check.
// ============================================================================

type RunResult = { ok: boolean; output: string };

function run(cmd: string[], cwd: string): RunResult {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: proc.exitCode === 0, output: proc.stdout.toString() + proc.stderr.toString() };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ffi-ir-ctypes-compile-check-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertRuns(result: RunResult): void {
  expect(result.ok, result.output).toBe(true);
}

/** Compiles a tiny C shared library from inline source, for `ctypes.CDLL` to
 * load for real. Throws (a test-setup failure, not a test-subject failure)
 * if the stub itself fails to compile — that would indicate a bug in this
 * test file's own hand-written C, not in python-ctypes.ts. */
function buildStubLib(dir: string, cSource: string): string {
  const cFile = join(dir, "stub.c");
  writeFileSync(cFile, cSource);
  const soFile = join(dir, "libstub.so");
  const compiled = run(["gcc", "-shared", "-fPIC", "-o", soFile, cFile], dir);
  if (!compiled.ok) {
    throw new Error(`test setup: stub .so failed to compile:\n${compiled.output}`);
  }
  return soFile;
}

describe("toCtypes — real python3 execution against a compiled stub .so", () => {
  test("a plain function: argtypes/restype marshaling round-trips through an actual compiled symbol", () => {
    withTempDir((dir) => {
      const soFile = buildStubLib(
        dir,
        "#include <stdint.h>\nint64_t add(int64_t a, int64_t b) { return a + b; }\n",
      );
      const addFn: FfiRef = f(
        boundary.function(
          [
            { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
            { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
          ],
          withOwnership(t(types.integer), ownership.copy()),
        ),
      );
      const generated = toCtypes(addFn, "add");
      const file = join(dir, "root.py");
      writeFileSync(
        file,
        [
          "from ctypes import *",
          `lib = CDLL(${JSON.stringify(soFile)})`,
          "",
          generated,
          "",
          "assert add(2, 3) == 5, f'add(2, 3) == {add(2, 3)}'",
        ].join("\n"),
      );
      assertRuns(run(["python3", file], dir));
    });
  });

  test("a function AND its own param both named a Python keyword: the escaped def/getattr(lib, ...) pair actually resolves and calls the real symbol", () => {
    withTempDir((dir) => {
      // "class" is not a reserved word in C, so this is a legal C symbol —
      // it collides with Python's keyword, not C's.
      const soFile = buildStubLib(
        dir,
        "#include <stdint.h>\nint64_t class(int64_t class_arg) { return class_arg + 1; }\n",
      );
      const fn: FfiRef = f(
        boundary.function(
          [{ name: "class", type: withOwnership(t(types.integer), ownership.copy()) }],
          withOwnership(t(types.integer), ownership.copy()),
        ),
      );
      const generated = toCtypes(fn, "class");
      const file = join(dir, "root.py");
      writeFileSync(
        file,
        [
          "from ctypes import *",
          `lib = CDLL(${JSON.stringify(soFile)})`,
          "",
          generated,
          "",
          "assert class_(41) == 42, f'class_(41) == {class_(41)}'",
        ].join("\n"),
      );
      assertRuns(run(["python3", file], dir));
    });
  });

  test("an opaque-handle resource in isolation: .read() -> a real int64 and __del__ -> a real free call, both through compiled symbols", () => {
    // `make_handle` is test scaffolding only (hand-written glue calling a
    // manually-declared ctypes function), standing in for a real
    // constructor so this test can obtain a genuine pointer to call methods
    // against. It deliberately reads the already-resolved pointer TYPE back
    // off `file_handle_read.argtypes[0]` rather than writing `POINTER(FileHandle)`
    // again — see the `test.todo` below this block: the bare name
    // `FileHandle` is already shadowed by that point (the wrapper class of
    // the same name, emitted as the LAST line of `buildResource`'s own
    // output), so re-evaluating `POINTER(FileHandle)` after it would hit the
    // exact same real bug this scaffolding is working around, not testing.
    withTempDir((dir) => {
      const soFile = buildStubLib(
        dir,
        [
          "#include <stdint.h>",
          "#include <stdlib.h>",
          "typedef struct { int64_t value; } FileHandleImpl;",
          "void* make_handle(void) {",
          "  FileHandleImpl* h = malloc(sizeof(FileHandleImpl));",
          "  h->value = 99;",
          "  return h;",
          "}",
          "int64_t file_handle_read(void* handle) {",
          "  return ((FileHandleImpl*)handle)->value;",
          "}",
          "void file_handle_free(void* handle) {",
          "  free(handle);",
          "}",
          "",
        ].join("\n"),
      );

      const readMethod: FfiRef = f(
        boundary.method([], withOwnership(t(types.integer), ownership.copy()), "FileHandle"),
      );
      const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }));
      const generated = toCtypes(fileHandle);

      const file = join(dir, "root.py");
      writeFileSync(
        file,
        [
          "from ctypes import *",
          `lib = CDLL(${JSON.stringify(soFile)})`,
          "",
          generated,
          "",
          'ptr_type = getattr(lib, "file_handle_read").argtypes[0]',
          'make_handle = getattr(lib, "make_handle")',
          "make_handle.restype = ptr_type",
          "h = FileHandle(make_handle())",
          "assert h.read() == 99, f'h.read() == {h.read()}'",
          "del h",
        ].join("\n"),
      );
      assertRuns(run(["python3", file], dir));
    });
  });

  // `buildResource` itself has a real, standing name-collision bug: it emits
  // the opaque `class FileHandle(Structure): pass` declaration, then (inside
  // the SAME resource block) the plain wrapper `class FileHandle:` — both
  // bound to the identical name `FileHandle`, the wrapper permanently
  // shadowing the Structure at module scope from that line on. This is
  // harmless for anything already resolved *before* the shadow (e.g. each
  // method's own `POINTER(FileHandle)` argtype, built earlier in the same
  // block — see the isolated-resource test above, which works around
  // exactly this by reading that already-resolved pointer type back off
  // `argtypes[0]` instead of re-evaluating `POINTER(FileHandle)`), but it
  // breaks any code emitted or written *after* the resource block that
  // needs to spell `POINTER(FileHandle)` again — most realistically a
  // constructor function elsewhere in the same module returning
  // `handleRef("FileHandle")` (e.g. an `open` function whose restype is
  // `POINTER(FileHandle)`), since `buildModule` emits every contained
  // function after every contained resource. Reproduced directly:
  //   TypeError: _type_ must have storage info
  // at `getattr(lib, "open").restype = POINTER(FileHandle)`. Not fixed here
  // per this suite's own "record, don't silently fix" convention (see
  // packages/type-ir/src/compile-check.test.ts's identical use of
  // `test.todo`, and this package's own typescript-deno.test.ts for the
  // same convention already established in ffi-ir).
  test.todo(
    "a module containing both a resource and a function returning a handle to that resource really runs (currently fails — the resource's own wrapper class shadows its opaque Structure class of the same name, see comment above)",
    () => {},
  );

  // CRITICAL: proves the check above is a real check, not a vacuous one — a
  // deliberately-broken FfiRef input (an "object" TypeRef naming a
  // ctypes.Structure that is never actually declared anywhere in the
  // generated module — a realistic user error: the type-ir input claims a
  // struct exists by name without ffi-ir having any way to verify that
  // claim, since a `meta.typeName` is just a bare string, not a reference
  // this package can resolve) is genuinely rejected by real python3
  // execution (a real `NameError`), the same class of defect the
  // string-comparison tests above cannot see at all (the generated string
  // "looks fine" — `NeverDeclared` renders as valid-looking Python syntax;
  // only running it reveals the name doesn't resolve).
  test("CRITICAL: a deliberately-broken input (an undeclared Structure name) is genuinely rejected by real python3 execution", () => {
    withTempDir((dir) => {
      const soFile = buildStubLib(
        dir,
        "#include <stdint.h>\nint64_t noop(void) { return 0; }\n",
      );
      const brokenFn: FfiRef = f(
        boundary.function(
          [{ name: "thing", type: t(types.object({}), { typeName: "NeverDeclared" }) }],
          withOwnership(t(types.void), ownership.copy()),
        ),
      );
      const generated = toCtypes(brokenFn, "noop");
      const file = join(dir, "root.py");
      writeFileSync(
        file,
        ["from ctypes import *", `lib = CDLL(${JSON.stringify(soFile)})`, "", generated].join(
          "\n",
        ),
      );
      const result = run(["python3", file], dir);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("NameError");
    });
  });
});
