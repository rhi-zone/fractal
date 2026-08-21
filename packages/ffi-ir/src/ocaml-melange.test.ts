import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { t, types } from "@rhi-zone/fractal-type-ir";
import { toMelangeFfi } from "./ocaml-melange.ts";
import { boundary, f, ownership, resourceRef, withOwnership, type FfiRef } from "./index.ts";

describe("toMelangeFfi — function", () => {
  test("a simple free function with copy-discipline params/return emits a plain [@@mel.val] external", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const src = toMelangeFfi(addFn, "add");

    expect(src).toBe(`external add : int -> int -> int = "add" [@@mel.val]`);
  });

  test("a function with no ownership meta at all also emits (unannotated = copy-by-value default)", () => {
    const fn: FfiRef = f(
      boundary.function([{ name: "n", type: t(types.integer) }], t(types.string)),
    );
    const src = toMelangeFfi(fn, "greet");
    expect(src).toBe(`external greet : int -> string = "greet" [@@mel.val]`);
  });

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())));
    expect(() => toMelangeFfi(fn)).toThrow(/requires a name/);
  });

  test("a description on the function's meta renders as an OCaml doc comment", () => {
    const fn: FfiRef = f(boundary.function([], t(types.void)), { description: "does a thing" });
    const src = toMelangeFfi(fn, "doThing");
    expect(src).toContain("(** does a thing *)");
  });
});

// Reserved-word collision coverage — string-comparison only here (the
// reserved-word case IS additionally covered against the real toolchain, see
// the "real dune/melange compile check" describe block near the bottom of
// this file, which flake.nix now provisions ocaml/dune/melange for).
describe("toMelangeFfi — reserved-word (OCaml keyword) function names get a trailing-underscore escape", () => {
  test("a function itself named after an OCaml keyword", () => {
    const fn: FfiRef = f(boundary.function([], t(types.void)));
    const src = toMelangeFfi(fn, "type");
    expect(src).toBe('external type_ : unit -> unit = "type" [@@mel.val]');
  });

  // No param-name escaping test: an OCaml `external` declaration has no bare
  // param identifiers at all (a curried type-only arrow signature, per this
  // file's own `buildFunction`), so there is no param-name collision surface
  // to test — matches this task's ruby-ffi.ts precedent (a target with no
  // bare-identifier surface for a different structural reason).
});

describe("toMelangeFfi — ownership gating", () => {
  test("refcount discipline on a parameter throws — no Arc-equivalent in Melange", () => {
    const fn: FfiRef = f(
      boundary.function(
        [{ name: "h", type: withOwnership(t(types.integer), ownership.refcount()) }],
        t(types.void),
      ),
    );
    expect(() => toMelangeFfi(fn, "use")).toThrow(/unsupported ownership discipline "refcount"/);
  });

  test("resource (own/borrow) discipline on a return type throws — no lend-count-and-trap runtime in JS", () => {
    const fn: FfiRef = f(boundary.function([], resourceRef("Thing", "own")));
    expect(() => toMelangeFfi(fn, "make")).toThrow(/unsupported ownership discipline "resource"/);
  });

  test("opaque-handle discipline on a parameter passes through unchanged", () => {
    const fn: FfiRef = f(
      boundary.function(
        [{ name: "h", type: withOwnership(t(types.integer), ownership.opaqueHandle()) }],
        t(types.void),
      ),
    );
    const src = toMelangeFfi(fn, "use");
    expect(src).toBe(`external use : int -> unit = "use" [@@mel.val]`);
  });
});

describe("toMelangeFfi — resource", () => {
  test("emits a module with an abstract `type t` and [@mel.send] methods", () => {
    const greetMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.string), ownership.copy()), "Greeter"),
    );
    const greeter: FfiRef = f(boundary.resource("Greeter", { greet: greetMethod }));

    const src = toMelangeFfi(greeter, "Greeter");

    expect(src).toContain("module Greeter = struct");
    expect(src).toContain("type t");
    expect(src).toContain(`external greet : t -> string = "greet" [@@mel.send]`);
    expect(src.trim().endsWith("end")).toBe(true);
  });

  test("opaque-handle discipline with a freeFn emits an extra [@mel.send]-bound free binding", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"));
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }), {
      ownership: ownership.opaqueHandle("file_free"),
    });
    const src = toMelangeFfi(fileHandle, "FileHandle");
    expect(src).toContain(`external file_free : t -> unit = "file_free" [@@mel.send]`);
    expect(src).toContain(`external close : t -> unit = "close" [@@mel.send]`);
  });

  test("refcount discipline on the resource's own meta throws", () => {
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", {}), {
      ownership: ownership.refcount(),
    });
    expect(() => toMelangeFfi(fileHandle, "FileHandle")).toThrow(
      /unsupported ownership discipline "refcount"/,
    );
  });
});

describe("toMelangeFfi — module", () => {
  test("groups functions/resources into an OCaml module, functions carrying [@@mel.module]", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"));
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }));
    // Uses copy discipline, the only discipline this target supports for a
    // returned resource reference (see the ownership-gating describe block
    // above for why resource/own throws).
    const openFn: FfiRef = f(
      boundary.function(
        [{ name: "path", type: t(types.string) }],
        withOwnership(t(types.string), ownership.copy()),
      ),
    );

    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }));
    const src = toMelangeFfi(fsModule, "fs");

    expect(src).toContain("module Fs = struct");
    expect(src).toContain("module FileHandle = struct");
    expect(src).toContain(`external open_ : string -> string = "open" [@@mel.module "fs"]`);
  });
});

describe("toMelangeFfi — object/enum data-shape hoisting", () => {
  test("an object-shaped return type hoists a named record declaration", () => {
    const returnType = t(types.object({ id: t(types.string), count: t(types.integer) }));
    const fn: FfiRef = f(boundary.function([], returnType));
    const src = toMelangeFfi(fn, "getStats");
    expect(src).toContain("type getStatsResult = {");
    expect(src).toContain("id : string;");
    expect(src).toContain("count : int;");
    expect(src).toContain("external getStats : unit -> getStatsResult");
  });

  test("an enum-shaped parameter hoists a named no-payload variant", () => {
    const paramType = t(types.enum(["red", "green", "blue"]));
    const fn: FfiRef = f(boundary.function([{ name: "color", type: paramType }], t(types.void)));
    const src = toMelangeFfi(fn, "setColor");
    expect(src).toContain("| Red");
    expect(src).toContain("| Green");
    expect(src).toContain("| Blue");
  });
});

// ============================================================================
// Real-toolchain check — `dune build` against a real `(melange.emit)`
// stanza, using flake.nix's ocaml/dune_3/melange/findlib (added specifically
// for this suite).
//
// Melange has no standalone `melange` binary — it compiles only via dune's
// `(melange.emit)` stanza (verified against melange.re's own "Getting
// started" docs and confirmed directly against the installed
// ocamlPackages.melange 6.0.1-54 here) — so each check writes a minimal
// throwaway dune project: `dune-project` needs `(using melange 1.0)`
// (without it, dune rejects the `(melange.emit)` stanza outright: "melange.emit
// is available only when melange is enabled in the dune-project file"), and
// the `src/dune` stanza needs `(preprocess (pps melange.ppx))` — omitting it
// makes every `[@mel.*]` attribute an unprocessed-alert hard error ("Did you
// forget to preprocess with `melange.ppx'?"), confirmed by trial.
//
// One fresh dune project per fixture (unlike the Rust/cargo compile-check
// in packages/type-ir/src/compile-check.test.ts, which reuses one project
// across fixtures to dodge a slow first-build dependency resolution):
// melange has no external deps to fetch/resolve here, so a cold `dune build`
// of one small file is fast enough per-fixture, with no bun:test timeout
// pressure the Rust case has.
// ============================================================================

type MelangeRunResult = { ok: boolean; output: string };

function checkMelange(src: string): MelangeRunResult {
  const dir = mkdtempSync(join(import.meta.dir, ".cc-mel-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "dune-project"), "(lang dune 3.20)\n(using melange 1.0)\n");
    writeFileSync(
      join(dir, "src", "dune"),
      "(melange.emit\n (target dist)\n (emit_stdlib false)\n (preprocess (pps melange.ppx))\n (modules fixture))\n",
    );
    writeFileSync(join(dir, "src", "fixture.ml"), src);
    const proc = Bun.spawnSync({
      cmd: ["dune", "build"],
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

function assertMelangeCompiles(result: MelangeRunResult): void {
  expect(result.ok, result.output).toBe(true);
}

describe("toMelangeFfi (dune build, real melange.ppx + melange.emit)", () => {
  test("a function nested in a module (real [@@mel.module] attribute), with plain int params/return, compiles", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    );
    const mathModule: FfiRef = f(boundary.module("math", { add: addFn }, {}));
    const src = toMelangeFfi(mathModule, "math");
    expect(src).toContain('[@@mel.module "math"]');
    assertMelangeCompiles(checkMelange(src));
  });

  test("a resource method named after an OCaml keyword (real [@mel.send] attribute) compiles, proving ocamlLabel's trailing-underscore escape is real, valid OCaml syntax", () => {
    const typeMethod: FfiRef = f(boundary.method([], t(types.void), "Thing"));
    const thing: FfiRef = f(boundary.resource("Thing", { type: typeMethod }));
    const src = toMelangeFfi(thing, "Thing");
    expect(src).toContain(`external type_ : t -> unit = "type" [@@mel.send]`);
    assertMelangeCompiles(checkMelange(src));
  });

  test("an object-shaped return type hoisted to a named record, inside a module-scoped function, compiles", () => {
    const returnType = t(types.object({ id: t(types.string), count: t(types.integer) }));
    const getStatsFn: FfiRef = f(boundary.function([], returnType));
    const statsModule: FfiRef = f(boundary.module("stats", { getStats: getStatsFn }, {}));
    assertMelangeCompiles(checkMelange(toMelangeFfi(statsModule, "stats")));
  });

  test("a hand-written, deliberately-broken OCaml file is genuinely rejected by dune/melange (proves this check isn't vacuous)", () => {
    const result = checkMelange(
      'external add : int -> int -> string = "add" [@@mel.module "math"]\n' +
        "let bad = add 1 2 + 1\n",
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Error:");
  });

  // ==========================================================================
  // Real bug this real-compiler check surfaces, that the string-comparison
  // tests above structurally cannot see: `buildFunction`'s no-`jsModule`
  // branch (every standalone, non-module-nested "function"/"resource" kind —
  // i.e. `toMelangeFfi`'s single most basic documented case, "a simple free
  // function... emits a plain [@@mel.val] external") emits `[@@mel.val]`.
  // `[@@mel.val]` is not a recognized attribute in the installed Melange
  // 6.0.1-54 toolchain at all — confirmed by reading
  // ast_external_process.ml's own attribute-matching table (`site-lib/
  // melange/ppx/ast_external_process.ml`), which recognizes `mel.module`,
  // `mel.scope`, `mel.variadic`, `mel.send`, `mel.send.pipe`, `mel.set`,
  // `mel.get`, `mel.new`, `mel.set_index`, `mel.get_index`, `mel.obj`, and
  // `mel.return` — no `mel.val` case exists; a *plain* `external` with *no*
  // attribute at all is what already binds a global value (`kind = Val` is
  // the unconditional default), so no attribute should be emitted here at
  // all when `jsModule` is undefined. Confirmed directly:
  //
  //   external add : int -> int -> int = "add" [@@mel.val]
  //
  //   File "src/fixture.ml", line 1, characters 44-51:
  //   Alert unused: Unused attribute [@mel.val]
  //   File "src/fixture.ml", line 1, characters 0-52:
  //   Error (alert unprocessed): `[@mel.*]' attributes found in external
  //   declaration. Did you forget to preprocess with `melange.ppx'?
  //
  // Net effect: every standalone `toMelangeFfi` function/resource NOT nested
  // inside a `module` fails real dune/melange compilation, today. Recorded
  // here as `test.todo` (mirroring packages/type-ir/src/compile-check.test.ts's
  // own convention) rather than silently fixed, since fixing `ocaml-melange.ts`
  // itself is a real, separate change outside this test-coverage task's scope.
  // ==========================================================================
  test.todo(
    "a standalone (non-module-nested) free function — FAILS: emits `[@@mel.val]`, which is not a real Melange 6 attribute (a bare `external` with no attribute is already the correct/default global-value binding)",
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
      assertMelangeCompiles(checkMelange(toMelangeFfi(addFn, "add")));
    },
  );
});
