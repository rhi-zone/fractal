import { describe, expect, test } from "bun:test"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { toBun, toBunFfiType } from "./typescript-bun.ts"
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts"

/** The C-target convention for referencing an opaque resource by pointer —
 * same helper `c-abi.test.ts` uses, duplicated here since ffi-ir's test
 * files are self-contained (matching the source files' own duplication
 * precedent). */
function handleRef(resourceName: string, freeFn?: string): ReturnType<typeof withOwnership> {
  return withOwnership({ shape: { kind: "ref", target: resourceName }, meta: {} }, ownership.opaqueHandle(freeFn))
}

describe("toBunFfiType", () => {
  test("copy discipline (or no ownership meta at all) maps primitives to their FFIType token", () => {
    expect(toBunFfiType(t(types.integer))).toBe("i64")
    expect(toBunFfiType(withOwnership(t(types.boolean), ownership.copy()))).toBe("bool")
    expect(toBunFfiType(t(types.string))).toBe("cstring")
    expect(toBunFfiType(t(types.void))).toBe("void")
    expect(toBunFfiType(t(types.null))).toBe("void")
  })

  test("opaque-handle discipline becomes \"ptr\", regardless of the underlying shape", () => {
    expect(toBunFfiType(handleRef("FileHandle"))).toBe("ptr")
  })

  test("refcount discipline ALSO becomes \"ptr\" — not gated, unlike rust-c-abi.ts: the dlopen symbol-level " +
    "representation of a refcounted handle and an opaque handle are identical (both raw pointers); only the " +
    "free-side bookkeeping differs, which this signature-only generator doesn't emit either way", () => {
    expect(toBunFfiType(withOwnership(t(types.integer), ownership.refcount()))).toBe("ptr")
  })

  test('resource discipline (own/borrow) throws — WIT\'s Canonical ABI handle-table mechanism, not a raw C-ABI pointer a plain dlopen\'d library speaks', () => {
    expect(() => toBunFfiType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("own")))).toThrow(
      /unsupported ownership discipline "resource"/,
    )
    expect(() => toBunFfiType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("borrow")))).toThrow(
      /unsupported ownership discipline "resource"/,
    )
  })

  test("struct-by-value (an \"object\" TypeRef under copy discipline) throws — bun:ffi's FFIType vocabulary has no struct token", () => {
    expect(() => toBunFfiType(t(types.object({ x: t(types.integer) })))).toThrow(/unhandled kind "object"/)
  })

  test("other structurally-compound kinds also throw rather than guess a lossy encoding", () => {
    expect(() => toBunFfiType(t(types.array(t(types.integer))))).toThrow(/unhandled kind "array"/)
    expect(() => toBunFfiType(t(types.map(t(types.string), t(types.integer))))).toThrow(/unhandled kind "map"/)
    expect(() => toBunFfiType(t(types.tuple([t(types.integer), t(types.string)])))).toThrow(/unhandled kind "tuple"/)
  })
})

describe("toBun — function", () => {
  test("a simple free function: one dlopen call, one symbol entry, one wrapper", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    )
    const src = toBun(addFn, "./libmath.so", "add")

    expect(src).toContain('import { dlopen } from "bun:ffi"')
    expect(src).toContain('dlopen("./libmath.so", {')
    expect(src).toContain('"add": { args: ["i64", "i64"], returns: "i64" },')
    expect(src).toContain("export function add(a: unknown, b: unknown) {")
    expect(src).toContain('return symbols["add"](a, b)')
  })

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())))
    expect(() => toBun(fn, "./lib.so")).toThrow(/"function" requires a name/)
  })

  test("a function taking a resource parameter uses the opaque-handle ptr token", () => {
    const closeFn: FfiRef = f(
      boundary.function([{ name: "handle", type: handleRef("FileHandle", "file_handle_free") }], withOwnership(t(types.void), ownership.copy())),
    )
    const src = toBun(closeFn, "./lib.so", "close")
    expect(src).toContain('"close": { args: ["ptr"], returns: "void" },')
  })

  test("a bare method cannot be projected standalone — must go through its enclosing resource", () => {
    const method = f(boundary.method([], withOwnership(t(types.void), ownership.copy()), "FileHandle"))
    expect(() => toBun(method, "./lib.so", "close")).toThrow(/bare "method" cannot be projected on its own/)
  })
})

describe("toBun — resource", () => {
  test("opaque-handle method receiver, plus an auto-generated free wrapper", () => {
    const readMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.integer), ownership.copy()), "FileHandle"),
    )
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }))
    const src = toBun(fileHandle, "./lib.so")

    // method: receiver synthesized as a leading "ptr" arg
    expect(src).toContain('"file_handle_read": { args: ["ptr"], returns: "i64" },')
    expect(src).toContain("export function FileHandle_read(handle: number")
    expect(src).toContain('return symbols["file_handle_read"](handle)')

    // paired free function, matching rust-c-abi.ts's `<resource>_free` convention
    expect(src).toContain('"file_handle_free": { args: ["ptr"], returns: "void" },')
    expect(src).toContain("export function FileHandle_free(handle: number) {")
    expect(src).toContain('return symbols["file_handle_free"](handle)')
  })

  test("a method whose data-shape return can't cross bun:ffi's FFIType vocabulary throws (e.g. array-by-value)", () => {
    const readMethod: FfiRef = f(
      boundary.method([], withOwnership(t(types.array(t(types.integer))), ownership.copy()), "FileHandle"),
    )
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }))
    expect(() => toBun(fileHandle, "./lib.so")).toThrow(/unhandled kind "array"/)
  })
})

describe("toBun — module", () => {
  test("one dlopen call grouping every function's and every resource's methods' symbols", () => {
    const closeMethod: FfiRef = f(boundary.method([], withOwnership(t(types.void), ownership.copy()), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }))
    const openFn: FfiRef = f(
      boundary.function([{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }], handleRef("FileHandle")),
    )
    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }))

    const src = toBun(fsModule, "./libfs.so")

    // exactly one dlopen call for the whole module
    expect(src.match(/dlopen\(/g)?.length).toBe(1)

    expect(src).toContain('"open": { args: ["cstring"], returns: "ptr" },')
    expect(src).toContain('"file_handle_close": { args: ["ptr"], returns: "void" },')
    expect(src).toContain('"file_handle_free": { args: ["ptr"], returns: "void" },')

    expect(src).toContain("export function open(path: unknown) {")
    expect(src).toContain("export function FileHandle_close(handle: number")
    expect(src).toContain("export function FileHandle_free(handle: number) {")
  })
})
