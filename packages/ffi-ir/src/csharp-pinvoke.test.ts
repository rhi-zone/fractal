import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t, types } from "@rhi-zone/fractal-type-ir";
import { toDotNet, toDotNetType } from "./csharp-pinvoke.ts";
import {
  boundary,
  f,
  ownership,
  withOwnership,
  type FfiRef,
  type OwnershipDiscipline,
} from "./index.ts";

/** The C-target convention for referencing an opaque resource by pointer:
 * a plain `ref` TypeRef carrying ownership metadata — matches
 * `c-abi.test.ts`'s own `handleRef` helper for the exact same reason (this
 * is the consumer-side counterpart to that producer). Defaults to
 * `opaque-handle`, the discipline `rust-c-abi.ts` actually emits; other
 * disciplines are passed explicitly where the uniform-IntPtr behavior is
 * under test. */
function handleRef(
  resourceName: string,
  discipline: OwnershipDiscipline = ownership.opaqueHandle(),
) {
  return withOwnership({ shape: { kind: "ref", target: resourceName }, meta: {} }, discipline);
}

describe("toDotNetType", () => {
  test("copy discipline (or no ownership meta at all) maps scalar kinds to their closest C# type", () => {
    expect(toDotNetType(t(types.integer))).toBe("long");
    expect(toDotNetType(withOwnership(t(types.boolean), ownership.copy()))).toBe("bool");
    expect(toDotNetType(t(types.string))).toBe("string");
    expect(toDotNetType(t(types.number))).toBe("double");
  });

  test("fixed-width int/float kinds map to their exact-width C# counterpart", () => {
    expect(toDotNetType(t({ kind: "int32" }))).toBe("int");
    expect(toDotNetType(t({ kind: "uint64" }))).toBe("ulong");
    expect(toDotNetType(t({ kind: "float32" }))).toBe("float");
  });

  test("opaque-handle discipline becomes IntPtr", () => {
    expect(toDotNetType(handleRef("FileHandle", ownership.opaqueHandle()))).toBe("IntPtr");
  });

  test("refcount and resource(own/borrow) disciplines ALSO become IntPtr — uniform handle representation, since ownership discipline is a caller-side bookkeeping concern, not a marshaling one (see dotnet.ts file header)", () => {
    expect(toDotNetType(handleRef("FileHandle", ownership.refcount()))).toBe("IntPtr");
    expect(toDotNetType(handleRef("FileHandle", ownership.resource("own")))).toBe("IntPtr");
    expect(toDotNetType(handleRef("FileHandle", ownership.resource("borrow")))).toBe("IntPtr");
  });

  test("a structural kind with no P/Invoke-compatible scalar mapping throws, rather than guessing a struct layout", () => {
    expect(() => toDotNetType(t(types.array(t(types.integer))))).toThrow(
      /unsupported type-ir kind "array"/,
    );
    expect(() => toDotNetType(t(types.object({})))).toThrow(/unsupported type-ir kind "object"/);
  });
});

describe("toDotNet — function", () => {
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
    const src = toDotNet(addFn, "add", "my_native_lib");

    expect(src).toContain('[LibraryImport("my_native_lib", EntryPoint = "add")]');
    expect(src).toContain("internal static partial long add(long a, long b);");
  });

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    expect(() => toDotNet(fn, undefined, "my_native_lib")).toThrow(/"function" requires a name/);
  });

  test("a function requires a libraryName when projected standalone", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    expect(() => toDotNet(fn, "doThing")).toThrow(/"function" requires a libraryName/);
  });

  test("a bool parameter/return gets [MarshalAs(UnmanagedType.U1)] on both sides", () => {
    const isEvenFn: FfiRef = f(
      boundary.function(
        [{ name: "n", type: withOwnership(t(types.integer), ownership.copy()) }],
        withOwnership(t(types.boolean), ownership.copy()),
      ),
    );
    const src = toDotNet(isEvenFn, "is_even", "my_native_lib");

    expect(src).toContain("[return: MarshalAs(UnmanagedType.U1)]");
    expect(src).toContain("internal static partial bool is_even(long n);");
  });

  test("a bool parameter (not just a return) gets the same MarshalAs annotation, inline", () => {
    const setFlagFn: FfiRef = f(
      boundary.function(
        [{ name: "flag", type: withOwnership(t(types.boolean), ownership.copy()) }],
        withOwnership(t(types.void), ownership.copy()),
      ),
    );
    const src = toDotNet(setFlagFn, "set_flag", "my_native_lib");

    expect(src).toContain(
      "internal static partial void set_flag([MarshalAs(UnmanagedType.U1)] bool flag);",
    );
  });

  test("a string parameter/return adds StringMarshalling = StringMarshalling.Utf8 to the attribute", () => {
    const greetFn: FfiRef = f(
      boundary.function(
        [{ name: "name", type: withOwnership(t(types.string), ownership.copy()) }],
        withOwnership(t(types.string), ownership.copy()),
      ),
    );
    const src = toDotNet(greetFn, "greet", "my_native_lib");

    expect(src).toContain(
      '[LibraryImport("my_native_lib", EntryPoint = "greet", StringMarshalling = StringMarshalling.Utf8)]',
    );
    expect(src).toContain("internal static partial string greet(string name);");
  });

  test("a function with no string in its signature omits StringMarshalling entirely", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [{ name: "a", type: withOwnership(t(types.integer), ownership.copy()) }],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const src = toDotNet(addFn, "identity", "my_native_lib");
    expect(src).not.toContain("StringMarshalling");
  });

  test("a function taking a resource parameter uses the IntPtr handle convention", () => {
    const closeFn: FfiRef = f(
      boundary.function(
        [{ name: "handle", type: handleRef("FileHandle") }],
        withOwnership(t(types.void), ownership.copy()),
      ),
    );
    const src = toDotNet(closeFn, "close", "my_native_lib");

    expect(src).toContain("internal static partial void close(IntPtr handle);");
  });
});

// Reserved-word collision coverage — string-comparison only. See the
// "toDotNet (dotnet build compile-check)" describe block below for the real
// `dotnet build`-backed check (dotnet-sdk is present in flake.nix's
// devShell, same SDK packages/type-ir/src/compile-check.test.ts's
// csharp-systemtextjson block already uses) covering the same reserved-word
// escaping plus other targets/broken-input cases.
describe("toDotNet — reserved-word (C# keyword) identifiers get the @-escape", () => {
  test("a param named after a C# reserved word", () => {
    const fn: FfiRef = f(
      boundary.function(
        [{ name: "class", type: withOwnership(t(types.integer), ownership.copy()) }],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const src = toDotNet(fn, "identify", "my_native_lib");
    expect(src).toContain("internal static partial long identify(long @class);");
  });

  test("a function itself named after a C# reserved word — the EntryPoint stays the real, unescaped native symbol name", () => {
    const fn: FfiRef = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    const src = toDotNet(fn, "new", "my_native_lib");
    expect(src).toContain('EntryPoint = "new"');
    expect(src).toContain("internal static partial void @new();");
  });
});

describe("toDotNet — resource", () => {
  test("a resource with an opaque-handle method gets an IntPtr receiver plus an auto-generated free declaration", () => {
    const readMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.integer), ownership.copy()), "FileHandle"),
    );
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }));

    const src = toDotNet(fileHandle, undefined, "my_native_lib");

    expect(src).toContain("internal static partial class FileHandle");
    expect(src).toContain("internal static partial long file_handle_read(IntPtr handle);");
    expect(src).toContain('[LibraryImport("my_native_lib", EntryPoint = "file_handle_free")]');
    expect(src).toContain("internal static partial void file_handle_free(IntPtr handle);");
  });

  test("resource emission ignores an explicit name argument in favor of the shape's own name", () => {
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", {}));
    const src = toDotNet(fileHandle, "SomeOtherName", "my_native_lib");
    expect(src).toContain("internal static partial class FileHandle");
    expect(src).not.toContain("SomeOtherName");
  });

  test("a resource requires a libraryName when projected standalone", () => {
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", {}));
    expect(() => toDotNet(fileHandle)).toThrow(/"resource" requires a libraryName/);
  });
});

describe("toDotNet — module", () => {
  test("wraps functions and resources into one static partial class, defaulting libraryName from the module's own name", () => {
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

    const src = toDotNet(fsModule);

    expect(src).toContain("using System;");
    expect(src).toContain("using System.Runtime.InteropServices;");
    expect(src).toContain("internal static partial class Fs");
    expect(src).toContain('[LibraryImport("fs", EntryPoint = "open"');
    expect(src).toContain("internal static partial IntPtr open(string path);");
    expect(src).toContain("internal static partial class FileHandle");
    expect(src).toContain("internal static partial void file_handle_close(IntPtr handle);");
    expect(src).toContain("internal static partial void file_handle_free(IntPtr handle);");
  });

  test("an explicit libraryName override wins over the module-name default", () => {
    const noopFn: FfiRef = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    const fsModule: FfiRef = f(boundary.module("fs", { noop: noopFn }, {}));
    const src = toDotNet(fsModule, undefined, "custom_lib_name");
    expect(src).toContain("custom_lib_name");
    expect(src).not.toContain('"fs"');
  });
});

// ============================================================================
// Real `dotnet build` compile-check — unlike every string-comparison test
// above, this shells out to the actual `dotnet` from flake.nix's devShell
// (dotnet-sdk 8) and asserts the generated C# source genuinely compiles,
// catching bugs (wrong keyword escaping, invalid attribute combinations,
// bogus type names, etc.) a string-comparison assertion structurally cannot
// see. Mirrors packages/type-ir/src/compile-check.test.ts's own
// csharp-systemtextjson block exactly (throwaway .csproj targeting
// net8.0/Library, no NuGet package needed — `[LibraryImport]`/
// `System.Runtime.InteropServices` ship in the .NET runtime itself, and
// `dotnet build` never actually loads the native library the attribute
// names, so no native .so/.dll needs to exist for this check).
// ============================================================================

type RunResult = { ok: boolean; output: string };

function run(cmd: string[], cwd: string): RunResult {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: proc.exitCode === 0, output: proc.stdout.toString() + proc.stderr.toString() };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ffi-ir-dotnet-build-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeCsproj(dir: string): void {
  writeFileSync(
    join(dir, "compile-check.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><OutputType>Library</OutputType><Nullable>disable</Nullable><AllowUnsafeBlocks>true</AllowUnsafeBlocks></PropertyGroup></Project>\n',
  );
}

function assertCompiles(result: RunResult): void {
  expect(result.ok, result.output).toBe(true);
}

function assertRejected(result: RunResult): void {
  expect(
    result.ok,
    "expected `dotnet build` to reject this deliberately-broken input, but it compiled cleanly",
  ).toBe(false);
}

describe("toDotNet (dotnet build compile-check)", () => {
  test("a module wrapping a free function plus a resource with an opaque-handle method compiles for real", () => {
    const readMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.integer), ownership.copy()), "FileHandle"),
    );
    const closeMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.void), ownership.copy()), "FileHandle"),
    );
    const fileHandle: FfiRef = f(
      boundary.resource("FileHandle", { read: readMethod, close: closeMethod }),
    );
    const openFn: FfiRef = f(
      boundary.function(
        [{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }],
        handleRef("FileHandle"),
      ),
    );
    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }));

    // toDotNet(module) already emits its own `using` directives, so this is
    // a complete, standalone .cs file.
    const src = toDotNet(fsModule);

    withTempDir((dir) => {
      writeCsproj(dir);
      writeFileSync(join(dir, "Root.cs"), src);
      assertCompiles(run(["dotnet", "build", "-v", "quiet"], dir));
    });
  });

  test("reserved-word (C# keyword) parameter and function names — the @-escaping asserted by string comparison above — actually compile", () => {
    const identifyFn: FfiRef = f(
      boundary.function(
        [{ name: "class", type: withOwnership(t(types.integer), ownership.copy()) }],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const newFn: FfiRef = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    const mod: FfiRef = f(boundary.module("kw", { identify: identifyFn, new: newFn }, {}));

    const src = toDotNet(mod);

    withTempDir((dir) => {
      writeCsproj(dir);
      writeFileSync(join(dir, "Root.cs"), src);
      assertCompiles(run(["dotnet", "build", "-v", "quiet"], dir));
    });
  });

  test("a deliberately broken declaration (bogus, undeclared type name) is genuinely rejected by dotnet build — proves this check is not a rubber stamp", () => {
    const broken = [
      "using System;",
      "using System.Runtime.InteropServices;",
      "",
      "internal static partial class Broken",
      "{",
      '    [LibraryImport("my_native_lib", EntryPoint = "add")]',
      "    internal static partial Frobnicate add(long a, long b);",
      "}",
    ].join("\n");

    withTempDir((dir) => {
      writeCsproj(dir);
      writeFileSync(join(dir, "Root.cs"), broken);
      assertRejected(run(["dotnet", "build", "-v", "quiet"], dir));
    });
  });
});
