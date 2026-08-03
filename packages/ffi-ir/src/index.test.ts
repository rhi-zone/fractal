import { describe, expect, test } from "bun:test"
import { t, types } from "@rhi-zone/fractal-type-ir"
import {
  ancestors,
  boundary,
  f,
  ownership,
  registerParent,
  resolve,
  resourceRef,
  withOwnership,
  type FfiRef,
} from "./index.ts"

describe("ownership", () => {
  test("copy discipline", () => {
    expect(ownership.copy()).toEqual({ kind: "copy" })
  })

  test("opaque-handle discipline, with and without a named free function", () => {
    expect(ownership.opaqueHandle()).toEqual({ kind: "opaque-handle" })
    expect(ownership.opaqueHandle("buffer_free")).toEqual({ kind: "opaque-handle", freeFn: "buffer_free" })
  })

  test("refcount discipline", () => {
    expect(ownership.refcount()).toEqual({ kind: "refcount" })
  })

  test("resource discipline distinguishes own vs. borrow per reference", () => {
    expect(ownership.resource("own")).toEqual({ kind: "resource", mode: "own" })
    expect(ownership.resource("borrow")).toEqual({ kind: "resource", mode: "borrow" })
  })
})

describe("withOwnership", () => {
  test("attaches meta.ownership onto an existing TypeRef's metadata bag without disturbing other meta", () => {
    const ref = t(types.string, { description: "a buffer handle" })
    const owned = withOwnership(ref, ownership.opaqueHandle("buffer_free"))
    expect(owned.meta).toEqual({
      description: "a buffer handle",
      ownership: { kind: "opaque-handle", freeFn: "buffer_free" },
    })
    // shape is untouched — ownership is metadata, not a wrapping constructor
    // (Fork C, "ownership representation: decided").
    expect(owned.shape).toEqual({ kind: "string" })
  })
})

describe("resourceRef", () => {
  test("builds a type-ir ref TypeRef carrying resource ownership metadata", () => {
    const ref = resourceRef("Buffer", "own")
    expect(ref.shape).toEqual({ kind: "ref", target: "Buffer" })
    expect(ref.meta).toEqual({ ownership: { kind: "resource", mode: "own" } })
  })

  test("the same resource name can be referenced owned in one signature and borrowed in another", () => {
    const owned = resourceRef("Buffer", "own")
    const borrowed = resourceRef("Buffer", "borrow")
    expect((owned.shape as { target: string }).target).toBe((borrowed.shape as { target: string }).target)
    expect(owned.meta.ownership).toEqual({ kind: "resource", mode: "own" })
    expect(borrowed.meta.ownership).toEqual({ kind: "resource", mode: "borrow" })
  })
})

describe("boundary kind hierarchy", () => {
  test("method falls back to function, mirroring type-ir's method -> function ancestry", () => {
    expect(ancestors("method")).toEqual(["function"])
    expect(ancestors("function")).toEqual([])
    expect(ancestors("resource")).toEqual([])
    expect(ancestors("module")).toEqual([])
  })

  test("resolve finds an exact handler before falling back to an ancestor", () => {
    expect(resolve("method", { function: "FN", method: "METHOD" })).toBe("METHOD")
    expect(resolve("method", { function: "FN" })).toBe("FN")
    expect(resolve("resource", { function: "FN" })).toBeUndefined()
  })

  test("registerParent extends the hierarchy for a consumer-added kind", () => {
    registerParent("staticFunction", "function")
    expect(ancestors("staticFunction")).toEqual(["function"])
  })
})

describe("function/method signature construction", () => {
  test("a free function referencing type-ir TypeRefs for its params and return type", () => {
    const params = [
      { name: "path", type: t(types.string) },
      { name: "mode", type: t(types.string) },
    ]
    const returnType = withOwnership(resourceRef("FileHandle", "own"), ownership.resource("own"))
    const openFn: FfiRef = f(boundary.function(params, returnType), { description: "open a file, owning the handle" })

    expect(openFn.shape.kind).toBe("function")
    expect((openFn.shape as { params: unknown }).params).toHaveLength(2)
    expect(openFn.meta.description).toBe("open a file, owning the handle")
  })

  test("a method on a resource carries a receiver naming that resource", () => {
    const readMethod = f(
      boundary.method(
        [{ name: "length", type: withOwnership(t(types.integer), ownership.copy()) }],
        withOwnership(t(types.array(t(types.integer))), ownership.copy()),
        "FileHandle",
      ),
    )
    expect(readMethod.shape.kind).toBe("method")
    expect((readMethod.shape as { receiver: string }).receiver).toBe("FileHandle")
  })

  test("an owned parameter alongside a copy-discipline return value in one signature", () => {
    const params = [{ name: "handle", type: resourceRef("FileHandle", "own") }]
    const returnType = withOwnership(t(types.boolean), ownership.copy())
    const closeFn = boundary.function(params, returnType)

    expect(closeFn.params[0]!.type.meta.ownership).toEqual({ kind: "resource", mode: "own" })
    expect(closeFn.returnType.meta.ownership).toEqual({ kind: "copy" })
  })
})

describe("resource construction", () => {
  test("a resource exposes behavior only through its methods map", () => {
    const readMethod = f(
      boundary.method(
        [],
        withOwnership(t(types.array(t(types.integer))), ownership.copy()),
        "FileHandle",
      ),
    )
    const closeMethod = f(boundary.method([], t(types.void), "FileHandle"))

    const fileHandle = f(boundary.resource("FileHandle", { read: readMethod, close: closeMethod }))

    expect(fileHandle.shape.kind).toBe("resource")
    const shape = fileHandle.shape as { methods: Record<string, FfiRef> }
    expect(Object.keys(shape.methods)).toEqual(["read", "close"])
    expect(shape.methods.read!.shape.kind).toBe("method")
  })
})

describe("module construction", () => {
  test("groups exported functions and resources for one FFI boundary", () => {
    const closeMethod = f(boundary.method([], t(types.void), "FileHandle"))
    const fileHandle = f(boundary.resource("FileHandle", { close: closeMethod }))

    const openParams = [{ name: "path", type: t(types.string) }]
    const openReturn = withOwnership(resourceRef("FileHandle", "own"), ownership.resource("own"))
    const openFn = f(boundary.function(openParams, openReturn))

    const fsModule = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }))

    expect(fsModule.shape.kind).toBe("module")
    const shape = fsModule.shape as {
      name: string
      functions: Record<string, FfiRef>
      resources: Record<string, FfiRef>
    }
    expect(shape.name).toBe("fs")
    expect(Object.keys(shape.functions)).toEqual(["open"])
    expect(Object.keys(shape.resources)).toEqual(["FileHandle"])
    expect(shape.functions.open!.shape.kind).toBe("function")
    expect(shape.resources.FileHandle!.shape.kind).toBe("resource")
  })

  test("the whole module round-trips through JSON (no functions/classes hiding in the data)", () => {
    const closeMethod = f(boundary.method([], t(types.void), "FileHandle"))
    const fileHandle = f(boundary.resource("FileHandle", { close: closeMethod }))
    const fsModule = f(boundary.module("fs", {}, { FileHandle: fileHandle }))

    const roundTripped = JSON.parse(JSON.stringify(fsModule))
    expect(roundTripped).toEqual(fsModule)
  })
})
