import { describe, expect, test } from "bun:test"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { toRubyFfi, toRubyFfiType } from "./ruby-ffi.ts"
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts"

/** The opaque-handle convention shared with c-abi.test.ts: a plain `ref`
 * TypeRef carrying `opaque-handle` ownership metadata. */
function handleRef(resourceName: string, freeFn?: string): ReturnType<typeof withOwnership> {
  return withOwnership({ shape: { kind: "ref", target: resourceName }, meta: {} }, ownership.opaqueHandle(freeFn))
}

describe("toRubyFfiType", () => {
  test("copy discipline (or no ownership meta at all) maps to the base ffi-gem primitive symbols", () => {
    expect(toRubyFfiType(t(types.integer))).toBe(":int64")
    expect(toRubyFfiType(t(types.number))).toBe(":double")
    expect(toRubyFfiType(t(types.string))).toBe(":string")
    expect(toRubyFfiType(withOwnership(t(types.boolean), ownership.copy()))).toBe(":bool")
    expect(toRubyFfiType(t(types.void))).toBe(":void")
  })

  test("opaque-handle, refcount, and resource disciplines all collapse to the identical bare :pointer symbol", () => {
    expect(toRubyFfiType(handleRef("FileHandle"))).toBe(":pointer")
    expect(toRubyFfiType(withOwnership(t(types.integer), ownership.refcount()))).toBe(":pointer")
    expect(toRubyFfiType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("own")))).toBe(":pointer")
    expect(toRubyFfiType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("borrow")))).toBe(":pointer")
  })

  test("a structural shape with no minimal ffi-gem mapping throws explicitly", () => {
    expect(() => toRubyFfiType(t(types.object({ x: t(types.integer) })))).toThrow(
      /no minimal ffi-gem type-symbol mapping/,
    )
  })
})

describe("toRubyFfi — function", () => {
  test("a simple free function with copy-discipline params/return", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    )
    const src = toRubyFfi(addFn, "add")
    expect(src).toBe('attach_function "add", [:int64, :int64], :int64')
  })

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())))
    expect(() => toRubyFfi(fn)).toThrow(/"function" requires a name/)
  })
})

describe("toRubyFfi — resource with an opaque-handle method", () => {
  test("a resource's method takes the receiver as a synthesized leading :pointer, plus an auto-generated free binding", () => {
    const readMethod: FfiRef = f(boundary.method([], withOwnership(t(types.integer), ownership.copy()), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }))

    const src = toRubyFfi(fileHandle)

    expect(src).toContain('attach_function "file_handle_read", [:pointer], :int64')
    expect(src).toContain('attach_function "file_handle_free", [:pointer], :void')
  })

  test("resource emission ignores an explicit name argument in favor of the shape's own name", () => {
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", {}))
    const src = toRubyFfi(fileHandle, "SomeOtherName")
    expect(src).toContain('attach_function "file_handle_free"')
    expect(src).not.toContain("SomeOtherName")
  })
})

describe("toRubyFfi — module", () => {
  test("wraps functions and resources in a Ruby module extending FFI::Library, requiring meta.libPath", () => {
    const closeMethod: FfiRef = f(boundary.method([], withOwnership(t(types.void), ownership.copy()), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }))
    const openFn: FfiRef = f(
      boundary.function([{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }], handleRef("FileHandle")),
    )
    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }), { libPath: "./libfs.so" })

    const src = toRubyFfi(fsModule, "fs")

    expect(src).toContain("module Fs")
    expect(src).toContain('extend FFI::Library')
    expect(src).toContain('ffi_lib "./libfs.so"')
    expect(src).toContain('attach_function "open", [:string], :pointer')
    expect(src).toContain('attach_function "file_handle_close", [:pointer], :void')
    expect(src).toContain('attach_function "file_handle_free", [:pointer], :void')
    expect(src.trim().endsWith("end")).toBe(true)
  })

  test("a module without meta.libPath throws explicitly rather than guessing a library path", () => {
    const fsModule: FfiRef = f(boundary.module("fs", {}, {}))
    expect(() => toRubyFfi(fsModule, "fs")).toThrow(/missing required meta\.libPath/)
  })

  test("a module requires a name", () => {
    const fsModule: FfiRef = f(boundary.module("fs", {}, {}), { libPath: "./libfs.so" })
    expect(() => toRubyFfi(fsModule)).toThrow(/"module" requires a name/)
  })
})
