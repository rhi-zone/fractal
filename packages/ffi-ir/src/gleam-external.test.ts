import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t, types } from "@rhi-zone/fractal-type-ir";
import { toGleamFfi } from "./gleam-external.ts";
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts";

describe("toGleamFfi — function", () => {
  test("a simple free function renders @external(javascript, ...) + pub fn", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: t(types.integer) },
          { name: "b", type: t(types.integer) },
        ],
        t(types.integer),
      ),
      { jsModule: "./math.mjs" },
    );
    const src = toGleamFfi(addFn, "add");

    expect(src).toBe(
      ['@external(javascript, "./math.mjs", "add")', "pub fn add(a: Int, b: Int) -> Int"].join(
        "\n",
      ),
    );
  });

  test("meta.jsName overrides the exported JS binding name when it differs from the Gleam name", () => {
    const fn: FfiRef = f(
      boundary.function([{ name: "id", type: t(types.string) }], t(types.string)),
      {
        jsModule: "./dom_ffi.mjs",
        jsName: "getElementById",
      },
    );
    const src = toGleamFfi(fn, "get_element_by_id");
    expect(src).toContain('@external(javascript, "./dom_ffi.mjs", "getElementById")');
    expect(src).toContain("pub fn get_element_by_id(id: String) -> String");
  });

  test("camelCase ffi-ir name converts to snake_case for the Gleam-side declaration", () => {
    const fn: FfiRef = f(boundary.function([], t(types.void)), { jsModule: "./x.mjs" });
    const src = toGleamFfi(fn, "doTheThing");
    expect(src).toContain("pub fn do_the_thing() -> Nil");
  });

  test("description meta renders as a /// doc comment", () => {
    const fn: FfiRef = f(boundary.function([], t(types.void)), {
      jsModule: "./x.mjs",
      description: "Reverses a list.",
    });
    const src = toGleamFfi(fn, "reverse");
    expect(src).toContain("/// Reverses a list.");
  });

  test("a function requires a name", () => {
    const fn = f(boundary.function([], t(types.void)), { jsModule: "./x.mjs" });
    expect(() => toGleamFfi(fn)).toThrow(/"function" requires a name/);
  });

  test("missing meta.jsModule throws rather than guessing a path", () => {
    const fn: FfiRef = f(boundary.function([], t(types.void)));
    expect(() => toGleamFfi(fn, "greet")).toThrow(/missing required meta\.jsModule/);
  });

  // Reserved-word collision coverage — string-comparison only (this package
  // has no real `gleam` compiler wired into `nix develop`'s devShell, unlike
  // packages/type-ir/src/compile-check.test.ts's real-toolchain checks for
  // its own targets), so this asserts the escaped shape the Gleam compiler's
  // documented grammar requires, not an actual `gleam build` pass.
  test("a param named after a Gleam reserved word gets a trailing-underscore escape", () => {
    const fn: FfiRef = f(
      boundary.function([{ name: "type", type: t(types.string) }], t(types.void)),
      { jsModule: "./x.mjs" },
    );
    const src = toGleamFfi(fn, "describe");
    expect(src).toContain("pub fn describe(type_: String) -> Nil");
  });

  test("a function itself named after a Gleam reserved word gets a trailing-underscore escape, without changing the default jsName", () => {
    const fn: FfiRef = f(boundary.function([], t(types.void)), { jsModule: "./x.mjs" });
    const src = toGleamFfi(fn, "case");
    expect(src).toContain("pub fn case_() -> Nil");
    // the JS-side lookup name defaults to the real, unescaped snake_case
    // name — escaping the Gleam declaration must not retarget which JS
    // export `@external`'s 3rd argument binds against.
    expect(src).toContain('@external(javascript, "./x.mjs", "case")');
  });

  test("ownership discipline metadata does not change the emitted declaration at all — JS/Gleam have no", () => {
    // native ownership mechanism for @external to hook into (see gleam.ts's file header).
    const copyFn: FfiRef = f(
      boundary.function(
        [{ name: "n", type: withOwnership(t(types.integer), ownership.copy()) }],
        t(types.integer),
      ),
      {
        jsModule: "./x.mjs",
      },
    );
    const refcountFn: FfiRef = f(
      boundary.function(
        [{ name: "n", type: withOwnership(t(types.integer), ownership.refcount()) }],
        t(types.integer),
      ),
      { jsModule: "./x.mjs" },
    );
    expect(toGleamFfi(copyFn, "identity")).toBe(toGleamFfi(refcountFn, "identity"));
  });
});

describe("toGleamFfi — method (degrades to a free function with the receiver as an explicit first parameter)", () => {
  test("a method on a resource takes the receiver as its first parameter, named from the resource", () => {
    const greetMethod: FfiRef = f(boundary.method([], t(types.string), "Greeter"), {
      jsModule: "./greeter.mjs",
    });
    const src = toGleamFfi(greetMethod, "greet");
    expect(src).toBe(
      [
        '@external(javascript, "./greeter.mjs", "greet")',
        "pub fn greet(greeter: Greeter) -> String",
      ].join("\n"),
    );
  });

  test("a method's own params follow the receiver", () => {
    const setNameMethod: FfiRef = f(
      boundary.method([{ name: "name", type: t(types.string) }], t(types.void), "Greeter"),
      {
        jsModule: "./greeter.mjs",
      },
    );
    const src = toGleamFfi(setNameMethod, "set_name");
    expect(src).toContain("pub fn set_name(greeter: Greeter, name: String) -> Nil");
  });
});

describe("toGleamFfi — resource (degrades to a Gleam external type, per gleam.run/documentation/externals/)", () => {
  test("a resource emits `pub type Name` with no constructors, plus its methods as receiver-first free functions", () => {
    const greetMethod: FfiRef = f(boundary.method([], t(types.string), "Greeter"), {
      jsModule: "./greeter.mjs",
    });
    const greeter: FfiRef = f(boundary.resource("Greeter", { greet: greetMethod }));

    const src = toGleamFfi(greeter, "Greeter");

    expect(src).toContain("pub type Greeter");
    // no constructor body — Gleam's external-type idiom carries no Ctor(...) at all.
    expect(src).not.toContain("pub type Greeter {");
    expect(src).toContain('@external(javascript, "./greeter.mjs", "greet")');
    expect(src).toContain("pub fn greet(greeter: Greeter) -> String");
  });

  test("resource description renders as a /// doc comment on the external type", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"), {
      jsModule: "./fs.mjs",
    });
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }), {
      description: "An open file.",
    });
    const src = toGleamFfi(fileHandle, "FileHandle");
    expect(src).toContain("/// An open file.");
    expect(src).toContain("pub type FileHandle");
  });
});

describe("toGleamFfi — module (Gleam modules are files, not an inline construct)", () => {
  test("groups function and resource declarations under a file-path comment, not a synthesized Gleam block", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"), {
      jsModule: "./fs.mjs",
    });
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }));
    const openFn: FfiRef = f(
      boundary.function([{ name: "path", type: t(types.string) }], t(types.ref("FileHandle"))),
      {
        jsModule: "./fs.mjs",
      },
    );
    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }));

    const src = toGleamFfi(fsModule, "fs");

    expect(src).toContain("// module: fs (place these declarations in fs.gleam)");
    expect(src).toContain("pub type FileHandle");
    expect(src).toContain("pub fn open(path: String) -> FileHandle");
  });
});

// ============================================================================
// Real `gleam build` compile-check — proves the string-comparison assertions
// above against gleam's real compiler, not just shape matching. Gleam
// requires a real project (gleam.toml + src/<module>.gleam), unlike a bare
// single-file compile, per `gleam new --help`/`gleam build --help` (verified
// 2026-08-21 against gleam 1.14.0 in this repo's devShell). The scaffold
// below is trimmed to the smallest project gleam will actually accept:
// `gleam new` seeds gleam_stdlib/gleeunit dependencies neither generated
// fixture here needs, so this hand-writes a `gleam.toml` with an empty
// `[dependencies]` table instead — `gleam build` then never needs
// network/Hex resolution. `--target javascript` is required explicitly:
// gleam.toml has no target field, and `gleam build`'s default (erlang)
// rejects a `pub fn` with no body ("doesn't have an implementation for the
// Erlang target") since every `@external(javascript, ...)` declaration this
// file emits is JS-only by construction.
// ============================================================================

function runGleamBuild(source: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "gleam-external-cc-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "gleam.toml"), 'name = "cc"\nversion = "1.0.0"\n\n[dependencies]\n');
    writeFileSync(join(dir, "src", "cc.gleam"), source);
    const proc = Bun.spawnSync({
      cmd: ["gleam", "build", "--target", "javascript"],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { ok: proc.exitCode === 0, output: proc.stdout.toString() + proc.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("toGleamFfi — gleam build (real compile-check)", () => {
  test("a simple free function really compiles with `gleam build --target javascript`", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: t(types.integer) },
          { name: "b", type: t(types.integer) },
        ],
        t(types.integer),
      ),
      { jsModule: "./math.mjs" },
    );
    const result = runGleamBuild(toGleamFfi(addFn, "add"));
    expect(result.ok, result.output).toBe(true);
  });

  test("reserved-word escaping (a param and the function itself named after a Gleam keyword) really compiles", () => {
    const fn: FfiRef = f(
      boundary.function([{ name: "type", type: t(types.string) }], t(types.void)),
      { jsModule: "./x.mjs" },
    );
    const result = runGleamBuild(toGleamFfi(fn, "case"));
    expect(result.ok, result.output).toBe(true);
  });

  test("a resource's external type declaration plus its receiver-first method really compiles", () => {
    const greetMethod: FfiRef = f(boundary.method([], t(types.string), "Greeter"), {
      jsModule: "./greeter.mjs",
    });
    const greeter: FfiRef = f(boundary.resource("Greeter", { greet: greetMethod }));
    const result = runGleamBuild(toGleamFfi(greeter, "Greeter"));
    expect(result.ok, result.output).toBe(true);
  });

  // Proves the check above isn't vacuous: an unescaped reserved-word
  // identifier (what toGleamFfi's own escaping exists to prevent — see
  // escapeGleamIdent) is a genuine gleam parse error, verified directly
  // against `gleam build` rather than asserted from string shape.
  test("an unescaped reserved-word identifier is genuinely rejected by gleam build", () => {
    const result = runGleamBuild(
      ['@external(javascript, "./x.mjs", "type")', "pub fn type(a: Int) -> Int"].join("\n"),
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("reserved word");
  });
});
