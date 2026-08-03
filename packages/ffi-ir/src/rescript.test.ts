import { describe, expect, test } from "bun:test"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { toReScriptFfi } from "./rescript.ts"
import { boundary, f, ownership, resourceRef, withOwnership, type FfiRef } from "./index.ts"

describe("toReScriptFfi — function", () => {
  test("a simple free function with no module context binds via @val", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: t(types.integer) },
          { name: "b", type: t(types.integer) },
        ],
        t(types.integer),
      ),
    )
    const src = toReScriptFfi(addFn, "add")

    expect(src).toContain("@val")
    expect(src).toContain('external add: (int, int) => int = "add"')
    expect(src).not.toContain("@module")
  })

  test("a free function reached through a module binds via @module, naming the module's raw JS name", () => {
    const openParams = [{ name: "path", type: t(types.string) }]
    const openFn: FfiRef = f(boundary.function(openParams, t(types.boolean)))
    const fsModule: FfiRef = f(boundary.module("node:fs", { open: openFn }, {}))

    const src = toReScriptFfi(fsModule, "node:fs")

    expect(src).toContain('@module("node:fs")')
    // "open" is a ReScript reserved word — the binding identifier is
    // sanitized to "open_" while the JS-side name (string literal) stays
    // exactly "open".
    expect(src).toContain('external open_: (string) => bool = "open"')
  })

  test("a function requires a name", () => {
    const fn = f(boundary.function([], t(types.void)))
    expect(() => toReScriptFfi(fn)).toThrow(/requires a name/)
  })
})

describe("toReScriptFfi — method", () => {
  test("a method on a resource binds via @send, with the receiver as the first positional parameter", () => {
    const readMethod: FfiRef = f(
      boundary.method(
        [{ name: "length", type: t(types.integer) }],
        t(types.array(t(types.integer))),
        "FileHandle",
      ),
    )
    const src = toReScriptFfi(readMethod, "read")

    expect(src).toContain("@send")
    expect(src).toContain('external read: (FileHandle, int) => array<int> = "read"')
  })

  test("a no-arg method still gets the receiver as its sole parameter", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"))
    const src = toReScriptFfi(closeMethod, "close")
    expect(src).toContain('external close: (FileHandle) => unit = "close"')
  })
})

describe("toReScriptFfi — resource", () => {
  test("emits an opaque type plus @send externals per method, JS-side names preserved, ReScript-side names prefixed to avoid cross-resource collisions", () => {
    const readMethod: FfiRef = f(boundary.method([], t(types.array(t(types.integer))), "FileHandle"))
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod, close: closeMethod }))

    const src = toReScriptFfi(fileHandle, "FileHandle")

    expect(src).toContain("type FileHandle")
    expect(src).toContain('external fileHandleRead: (FileHandle) => array<int> = "read"')
    expect(src).toContain('external fileHandleClose: (FileHandle) => unit = "close"')
    // no invented constructor — ffi-ir's `resource` kind has no constructor
    // field, only a methods map (same gap wasm-bindgen.ts's buildResource
    // lives with).
    expect(src).not.toContain("@new")
  })

  test("ownership discipline never gates or throws for this target — copy/opaque-handle/refcount/resource all lower identically", () => {
    const readMethod: FfiRef = f(boundary.method([], withOwnership(t(types.string), ownership.copy()), "Handle"))
    const forCopy: FfiRef = f(boundary.resource("Handle", { read: readMethod }), { ownership: ownership.copy() })
    const forRefcount: FfiRef = f(boundary.resource("Handle", { read: readMethod }), { ownership: ownership.refcount() })

    expect(() => toReScriptFfi(forCopy, "Handle")).not.toThrow()
    expect(() => toReScriptFfi(forRefcount, "Handle")).not.toThrow()
    expect(toReScriptFfi(forCopy, "Handle")).toBe(toReScriptFfi(forRefcount, "Handle"))
  })

  test("a resourceRef used as a parameter/return type resolves to the same identifier the resource's own type declares", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }))
    const resourceDecl = toReScriptFfi(fileHandle, "FileHandle")

    const openParams = [{ name: "path", type: t(types.string) }]
    const openReturn = withOwnership(resourceRef("FileHandle", "own"), ownership.resource("own"))
    const openFn: FfiRef = f(boundary.function(openParams, openReturn))
    const fnDecl = toReScriptFfi(openFn, "open_")

    expect(resourceDecl).toContain("type FileHandle")
    expect(fnDecl).toContain("=> FileHandle")
  })
})

describe("toReScriptFfi — module", () => {
  test("groups resources and functions into a ReScript module block", () => {
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }))
    const openParams = [{ name: "path", type: t(types.string) }]
    const openReturn = withOwnership(resourceRef("FileHandle", "own"), ownership.resource("own"))
    const openFn: FfiRef = f(boundary.function(openParams, openReturn))
    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }))

    const src = toReScriptFfi(fsModule, "fs")

    expect(src).toContain("module Fs = {")
    expect(src).toContain("type FileHandle")
    expect(src).toContain('@module("fs")')
    // "open" is a ReScript reserved word — sanitized to "open_" on the
    // ReScript side; the JS-side literal stays "open".
    expect(src).toContain('external open_: (string) => FileHandle = "open"')
    expect(src).toContain('external fileHandleClose: (FileHandle) => unit = "close"')
  })
})
