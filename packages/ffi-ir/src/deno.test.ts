import { describe, expect, test } from "bun:test"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts"
import { denoFfiType, toDenoFfi } from "./deno.ts"

function handleRef(resourceName: string, freeFn?: string): ReturnType<typeof withOwnership> {
  return withOwnership({ shape: { kind: "ref", target: resourceName }, meta: {} }, ownership.opaqueHandle(freeFn))
}

describe("denoFfiType", () => {
  test("copy discipline (or no ownership meta at all) maps primitives to Deno's FFI type vocabulary", () => {
    expect(denoFfiType(t(types.integer))).toBe("i64")
    expect(denoFfiType(t(types.number))).toBe("f64")
    expect(denoFfiType(withOwnership(t(types.boolean), ownership.copy()))).toBe("u8")
    expect(denoFfiType(t(types.void))).toBe("void")
  })

  test("bytes maps to Deno's native buffer type", () => {
    expect(denoFfiType(t({ kind: "bytes" }))).toBe("buffer")
  })

  test("opaque-handle, refcount, and resource disciplines all collapse to \"pointer\" — Deno's raw FFI layer has no ownership model of its own to distinguish them", () => {
    expect(denoFfiType(handleRef("FileHandle"))).toBe("pointer")
    expect(denoFfiType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.refcount()))).toBe("pointer")
    expect(denoFfiType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("own")))).toBe("pointer")
    expect(denoFfiType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("borrow")))).toBe("pointer")
  })

  test('"string" throws — no native Deno FFI type and no established fractal C-ABI string-encoding convention', () => {
    expect(() => denoFfiType(t(types.string))).toThrow(/no native Deno FFI type/)
  })

  test('"object" (struct-shaped) throws — Deno supports struct-by-value natively via `{ struct: [...] }` but this minimal projector does not compute C-ABI layout', () => {
    expect(() => denoFfiType(t(types.object({ n: t(types.integer) })))).toThrow(/no mapping in this minimal projector/)
  })
})

describe("toDenoFfi — simple function", () => {
  test("a free function with copy-discipline primitive params/return", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
      { libPath: "./libmath.so" },
    )

    const src = toDenoFfi(addFn, "add")

    expect(src).toContain('Deno.dlopen("./libmath.so"')
    expect(src).toContain('"add": { parameters: ["i64", "i64"], result: "i64" }')
    expect(src).toContain("export function add(a: bigint, b: bigint): bigint {")
    expect(src).toContain("return lib.symbols.add(a, b) as bigint")
  })

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())), { libPath: "./lib.so" })
    expect(() => toDenoFfi(fn)).toThrow(/"function" requires a name/)
  })

  test("a function without meta.libPath throws — no derivable dlopen path", () => {
    const fn = f(boundary.function([], t(types.void)))
    expect(() => toDenoFfi(fn, "noop")).toThrow(/missing required meta\.libPath/)
  })
})

describe("toDenoFfi — resource with an opaque-handle method", () => {
  test("methods take/return a pointer-typed handle; a paired free wrapper is synthesized", () => {
    // "string" isn't crossable per denoFfiType's own throw (see the dedicated describe block
    // above) — "path" is typed as bytes here to build a realistic module without hitting that
    // unrelated, separately-tested limitation.
    const openFnBytes: FfiRef = f(
      boundary.function([{ name: "path", type: t({ kind: "bytes" }) }], handleRef("FileHandle")),
      { libPath: "./libfile.so" },
    )

    const readMethod: FfiRef = f(boundary.method([], t({ kind: "bytes" }), "FileHandle"))
    const closeMethod: FfiRef = f(boundary.method([], t(types.void), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod, close: closeMethod }))
    const fsModule: FfiRef = f(boundary.module("fs", { open: openFnBytes }, { FileHandle: fileHandle }), {
      libPath: "./libfile.so",
    })

    const src = toDenoFfi(fsModule)

    expect(src).toContain('"open": { parameters: ["buffer"], result: "pointer" }')
    expect(src).toContain('"file_handle_read": { parameters: ["pointer"], result: "buffer" }')
    expect(src).toContain('"file_handle_close": { parameters: ["pointer"], result: "void" }')
    expect(src).toContain('"file_handle_free": { parameters: ["pointer"], result: "void" }')

    expect(src).toContain("export function open(path: Uint8Array | null): Pointer {")
    expect(src).toContain("export function fileHandleRead(handle: Pointer): Uint8Array | null {")
    expect(src).toContain("export function fileHandleClose(handle: Pointer): void {")
    expect(src).toContain("export function fileHandleFree(handle: Pointer): void {")
    expect(src).toContain("lib.symbols.file_handle_free(handle)")
  })
})

describe("toDenoFfi — refcount/resource disciplines produce identical codegen to opaque-handle", () => {
  test("a method returning a refcount- or resource-disciplined reference emits the same pointer-typed wrapper", () => {
    const shareMethodRefcount: FfiRef = f(
      boundary.method([], withOwnership(t({ kind: "ref", target: "Node" }), ownership.refcount()), "Node"),
    )
    const shareMethodResource: FfiRef = f(
      boundary.method([], withOwnership(t({ kind: "ref", target: "Node" }), ownership.resource("own")), "Node"),
    )
    const nodeRefcount: FfiRef = f(boundary.resource("Node", { share: shareMethodRefcount }), { libPath: "./libtree.so" })
    const nodeResource: FfiRef = f(boundary.resource("Node", { share: shareMethodResource }), { libPath: "./libtree.so" })

    const srcRefcount = toDenoFfi(nodeRefcount, "Node")
    const srcResource = toDenoFfi(nodeResource, "Node")

    // Same symbol/parameter/result shape either way — Deno's raw FFI layer draws no
    // distinction between refcount and own/borrow resource disciplines (see deno.ts's
    // file header); only the ownership metadata differs between the two fixtures above,
    // and it produces byte-identical generated source.
    expect(srcRefcount).toBe(srcResource);
    expect(srcRefcount).toContain('"node_share": { parameters: ["pointer"], result: "pointer" }')
    expect(srcRefcount).toContain("export function nodeShare(handle: Pointer): Pointer {")
  })
})
