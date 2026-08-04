import { describe, expect, test } from "bun:test"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { toMelangeFfi } from "./ocaml-melange.ts"
import { boundary, f, ownership, resourceRef, withOwnership, type FfiRef } from "./index.ts"

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
    )
    const src = toMelangeFfi(addFn, "add")

    expect(src).toBe(`external add : int -> int -> int = "add" [@@mel.val]`)
  })

  test("a function with no ownership meta at all also emits (unannotated = copy-by-value default)", () => {
    const fn: FfiRef = f(boundary.function([{ name: "n", type: t(types.integer) }], t(types.string)))
    const src = toMelangeFfi(fn, "greet")
    expect(src).toBe(`external greet : int -> string = "greet" [@@mel.val]`)
  })

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())))
    expect(() => toMelangeFfi(fn)).toThrow(/requires a name/)
  })

  test("a description on the function's meta renders as an OCaml doc comment", () => {
    const fn: FfiRef = f(boundary.function([], t(types.void)), { description: "does a thing" })
    const src = toMelangeFfi(fn, "doThing")
    expect(src).toContain("(** does a thing *)")
  })
})

describe("toMelangeFfi — ownership gating", () => {
  test("refcount discipline on a parameter throws — no Arc-equivalent in Melange", () => {
    const fn: FfiRef = f(
      boundary.function([{ name: "h", type: withOwnership(t(types.integer), ownership.refcount()) }], t(types.void)),
    )
    expect(() => toMelangeFfi(fn, "use")).toThrow(/unsupported ownership discipline "refcount"/)
  })

  test("resource (own/borrow) discipline on a return type throws — no lend-count-and-trap runtime in JS", () => {
    const fn: FfiRef = f(boundary.function([], resourceRef("Thing", "own")))
    expect(() => toMelangeFfi(fn, "make")).toThrow(/unsupported ownership discipline "resource"/)
  })

  test("opaque-handle discipline on a parameter passes through unchanged", () => {
    const fn: FfiRef = f(
      boundary.function([{ name: "h", type: withOwnership(t(types.integer), ownership.opaqueHandle()) }], t(types.void)),
    )
    const src = toMelangeFfi(fn, "use")
    expect(src).toBe(`external use : int -> unit = "use" [@@mel.val]`)
  })
})

describe("toMelangeFfi — resource", () => {
  test("emits a module with an abstract `type t` and [@mel.send] methods", () => {
    const greetMethod: FfiRef = f(boundary.method([], withOwnership(t(types.string), ownership.copy()), "Greeter"))
    const greeter: FfiRef = f(boundary.resource("Greeter", { greet: greetMethod }))

    const src = toMelangeFfi(greeter, "Greeter")

    expect(src).toContain("module Greeter = struct")
    expect(src).toContain("type t")
    expect(src).toContain(`external greet : t -> string = "greet" [@@mel.send]`)
    expect(src.trim().endsWith("end")).toBe(true)
  })

  test("opaque-handle discipline with a freeFn emits an extra [@mel.send]-bound free binding", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }), {
      ownership: ownership.opaqueHandle("file_free"),
    })
    const src = toMelangeFfi(fileHandle, "FileHandle")
    expect(src).toContain(`external file_free : t -> unit = "file_free" [@@mel.send]`)
    expect(src).toContain(`external close : t -> unit = "close" [@@mel.send]`)
  })

  test("refcount discipline on the resource's own meta throws", () => {
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", {}), { ownership: ownership.refcount() })
    expect(() => toMelangeFfi(fileHandle, "FileHandle")).toThrow(/unsupported ownership discipline "refcount"/)
  })
})

describe("toMelangeFfi — module", () => {
  test("groups functions/resources into an OCaml module, functions carrying [@@mel.module]", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }))
    // A resource returned "own" would throw (resource discipline unsupported
    // on this target, see the ownership-gating describe block above) — copy
    // discipline is used here instead, matching what this target actually
    // supports.
    const openFn: FfiRef = f(
      boundary.function([{ name: "path", type: t(types.string) }], withOwnership(t(types.string), ownership.copy())),
    )

    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }))
    const src = toMelangeFfi(fsModule, "fs")

    expect(src).toContain("module Fs = struct")
    expect(src).toContain("module FileHandle = struct")
    expect(src).toContain(`external open_ : string -> string = "open" [@@mel.module "fs"]`)
  })
})

describe("toMelangeFfi — object/enum data-shape hoisting", () => {
  test("an object-shaped return type hoists a named record declaration", () => {
    const returnType = t(types.object({ id: t(types.string), count: t(types.integer) }))
    const fn: FfiRef = f(boundary.function([], returnType))
    const src = toMelangeFfi(fn, "getStats")
    expect(src).toContain("type getStatsResult = {")
    expect(src).toContain("id : string;")
    expect(src).toContain("count : int;")
    expect(src).toContain("external getStats : unit -> getStatsResult")
  })

  test("an enum-shaped parameter hoists a named no-payload variant", () => {
    const paramType = t(types.enum(["red", "green", "blue"]))
    const fn: FfiRef = f(boundary.function([{ name: "color", type: paramType }], t(types.void)))
    const src = toMelangeFfi(fn, "setColor")
    expect(src).toContain("| Red")
    expect(src).toContain("| Green")
    expect(src).toContain("| Blue")
  })
})
