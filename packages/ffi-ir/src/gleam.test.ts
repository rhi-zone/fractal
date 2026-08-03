import { describe, expect, test } from "bun:test"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { toGleamFfi } from "./gleam.ts"
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts"

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
    )
    const src = toGleamFfi(addFn, "add")

    expect(src).toBe(
      ['@external(javascript, "./math.mjs", "add")', "pub fn add(a: Int, b: Int) -> Int"].join("\n"),
    )
  })

  test("meta.jsName overrides the exported JS binding name when it differs from the Gleam name", () => {
    const fn: FfiRef = f(boundary.function([{ name: "id", type: t(types.string) }], t(types.string)), {
      jsModule: "./dom_ffi.mjs",
      jsName: "getElementById",
    })
    const src = toGleamFfi(fn, "get_element_by_id")
    expect(src).toContain('@external(javascript, "./dom_ffi.mjs", "getElementById")')
    expect(src).toContain("pub fn get_element_by_id(id: String) -> String")
  })

  test("camelCase ffi-ir name converts to snake_case for the Gleam-side declaration", () => {
    const fn: FfiRef = f(boundary.function([], t(types.void)), { jsModule: "./x.mjs" })
    const src = toGleamFfi(fn, "doTheThing")
    expect(src).toContain("pub fn do_the_thing() -> Nil")
  })

  test("description meta renders as a /// doc comment", () => {
    const fn: FfiRef = f(boundary.function([], t(types.void)), { jsModule: "./x.mjs", description: "Reverses a list." })
    const src = toGleamFfi(fn, "reverse")
    expect(src).toContain("/// Reverses a list.")
  })

  test("a function requires a name", () => {
    const fn = f(boundary.function([], t(types.void)), { jsModule: "./x.mjs" })
    expect(() => toGleamFfi(fn)).toThrow(/"function" requires a name/)
  })

  test("missing meta.jsModule throws rather than guessing a path", () => {
    const fn: FfiRef = f(boundary.function([], t(types.void)))
    expect(() => toGleamFfi(fn, "greet")).toThrow(/missing required meta\.jsModule/)
  })

  test("ownership discipline metadata does not change the emitted declaration at all — JS/Gleam have no", () => {
    // native ownership mechanism for @external to hook into (see gleam.ts's file header).
    const copyFn: FfiRef = f(boundary.function([{ name: "n", type: withOwnership(t(types.integer), ownership.copy()) }], t(types.integer)), {
      jsModule: "./x.mjs",
    })
    const refcountFn: FfiRef = f(
      boundary.function([{ name: "n", type: withOwnership(t(types.integer), ownership.refcount()) }], t(types.integer)),
      { jsModule: "./x.mjs" },
    )
    expect(toGleamFfi(copyFn, "identity")).toBe(toGleamFfi(refcountFn, "identity"))
  })
})

describe("toGleamFfi — method (degrades to a free function with the receiver as an explicit first parameter)", () => {
  test("a method on a resource takes the receiver as its first parameter, named from the resource", () => {
    const greetMethod: FfiRef = f(boundary.method([], t(types.string), "Greeter"), { jsModule: "./greeter.mjs" })
    const src = toGleamFfi(greetMethod, "greet")
    expect(src).toBe(
      ['@external(javascript, "./greeter.mjs", "greet")', "pub fn greet(greeter: Greeter) -> String"].join("\n"),
    )
  })

  test("a method's own params follow the receiver", () => {
    const setNameMethod: FfiRef = f(boundary.method([{ name: "name", type: t(types.string) }], t(types.void), "Greeter"), {
      jsModule: "./greeter.mjs",
    })
    const src = toGleamFfi(setNameMethod, "set_name")
    expect(src).toContain("pub fn set_name(greeter: Greeter, name: String) -> Nil")
  })
})

describe("toGleamFfi — resource (degrades to a Gleam external type, per gleam.run/documentation/externals/)", () => {
  test("a resource emits `pub type Name` with no constructors, plus its methods as receiver-first free functions", () => {
    const greetMethod: FfiRef = f(boundary.method([], t(types.string), "Greeter"), { jsModule: "./greeter.mjs" })
    const greeter: FfiRef = f(boundary.resource("Greeter", { greet: greetMethod }))

    const src = toGleamFfi(greeter, "Greeter")

    expect(src).toContain("pub type Greeter")
    // no constructor body — Gleam's external-type idiom carries no Ctor(...) at all.
    expect(src).not.toContain("pub type Greeter {")
    expect(src).toContain('@external(javascript, "./greeter.mjs", "greet")')
    expect(src).toContain("pub fn greet(greeter: Greeter) -> String")
  })

  test("resource description renders as a /// doc comment on the external type", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"), { jsModule: "./fs.mjs" })
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }), { description: "An open file." })
    const src = toGleamFfi(fileHandle, "FileHandle")
    expect(src).toContain("/// An open file.")
    expect(src).toContain("pub type FileHandle")
  })
})

describe("toGleamFfi — module (Gleam modules are files, not an inline construct)", () => {
  test("groups function and resource declarations under a file-path comment, not a synthesized Gleam block", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"), { jsModule: "./fs.mjs" })
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }))
    const openFn: FfiRef = f(boundary.function([{ name: "path", type: t(types.string) }], t(types.ref("FileHandle"))), {
      jsModule: "./fs.mjs",
    })
    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }))

    const src = toGleamFfi(fsModule, "fs")

    expect(src).toContain("// module: fs (place these declarations in fs.gleam)")
    expect(src).toContain("pub type FileHandle")
    expect(src).toContain("pub fn open(path: String) -> FileHandle")
  })
})
