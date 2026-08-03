import { describe, expect, test } from "bun:test"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { toCAbi, toCAbiType } from "./c-abi.ts"
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts"

/** The C-target convention for referencing an opaque resource by pointer:
 * a plain `ref` TypeRef carrying `opaque-handle` ownership (NOT the
 * `resource`-discipline `resourceRef` helper, which is the WIT-oriented own/
 * borrow convention this target explicitly does not implement). */
function handleRef(resourceName: string, freeFn?: string): ReturnType<typeof withOwnership> {
  return withOwnership({ shape: { kind: "ref", target: resourceName }, meta: {} }, ownership.opaqueHandle(freeFn))
}

describe("toCAbiType", () => {
  test("copy discipline (or no ownership meta at all) maps straight through rust-serde's toRustType", () => {
    expect(toCAbiType(t(types.integer))).toBe("i64")
    expect(toCAbiType(withOwnership(t(types.boolean), ownership.copy()))).toBe("bool")
  })

  test("opaque-handle discipline becomes a raw *mut pointer to the underlying Rust type", () => {
    expect(toCAbiType(handleRef("FileHandle"))).toBe("*mut FileHandle")
  })

  test("refcount discipline throws — no native C mechanism, out of scope by design", () => {
    expect(() => toCAbiType(withOwnership(t(types.integer), ownership.refcount()))).toThrow(
      /unsupported ownership discipline "refcount" for C target/,
    )
  })

  test('resource discipline (own/borrow) throws — WIT-only, out of scope for C', () => {
    expect(() => toCAbiType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("own")))).toThrow(
      /unsupported ownership discipline "resource" for C target/,
    )
    expect(() => toCAbiType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("borrow")))).toThrow(
      /unsupported ownership discipline "resource" for C target/,
    )
  })
})

describe("toCAbi — function", () => {
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
    const src = toCAbi(addFn, "add")

    expect(src).toContain("#[no_mangle]")
    expect(src).toContain('pub extern "C" fn add(a: i64, b: i64) -> i64 {')
    expect(src).toContain("todo!(")
  })

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())))
    expect(() => toCAbi(fn)).toThrow(/"function" requires a name/)
  })

  test("a function taking a resource parameter uses the opaque-handle pointer convention", () => {
    const closeFn: FfiRef = f(
      boundary.function([{ name: "handle", type: handleRef("FileHandle", "file_handle_free") }], withOwnership(t(types.void), ownership.copy())),
    )
    const src = toCAbi(closeFn, "close")

    expect(src).toContain('pub extern "C" fn close(handle: *mut FileHandle) {')
    // void return omits the arrow entirely
    expect(src).not.toContain("->")
  })
})

describe("toCAbi — resource", () => {
  test("a resource with a constructor, methods, and an auto-generated destructor", () => {
    const readMethod: FfiRef = f(
      boundary.method(
        [],
        withOwnership(t(types.array(t(types.integer))), ownership.copy()),
        "FileHandle",
      ),
    )
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }))

    const openFn: FfiRef = f(
      boundary.function([{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }], handleRef("FileHandle", "file_handle_free")),
    )

    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }))
    const src = toCAbi(fsModule)

    // opaque struct
    expect(src).toContain("#[repr(C)]");
    expect(src).toContain("pub struct FileHandle {");
    expect(src).toContain("_private: [u8; 0],");

    // constructor (a plain module function returning an opaque-handle pointer)
    expect(src).toContain('pub extern "C" fn open(path: String) -> *mut FileHandle {');

    // method, receiver-prefixed with a synthesized handle parameter
    expect(src).toContain('pub extern "C" fn file_handle_read(handle: *mut FileHandle) -> Vec<i64> {');

    // auto-generated destructor
    expect(src).toContain('pub extern "C" fn file_handle_free(handle: *mut FileHandle) {');
    expect(src).toContain("drop(Box::from_raw(handle));");
  })

  test("resource emission ignores an explicit name argument in favor of the shape's own name", () => {
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", {}))
    const src = toCAbi(fileHandle, "SomeOtherName")
    expect(src).toContain("pub struct FileHandle {")
    expect(src).not.toContain("SomeOtherName")
  })
})

describe("toCAbi — module", () => {
  test("concatenates all contained functions and resources with no module wrapper (C has no module system)", () => {
    const closeMethod: FfiRef = f(boundary.method([], withOwnership(t(types.void), ownership.copy()), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }))
    const openFn: FfiRef = f(
      boundary.function([{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }], handleRef("FileHandle")),
    )
    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }))

    const src = toCAbi(fsModule)
    expect(src).toContain('pub extern "C" fn open(');
    expect(src).toContain("pub struct FileHandle {");
    expect(src).toContain('pub extern "C" fn file_handle_close(');
    expect(src).toContain('pub extern "C" fn file_handle_free(');
    // no "mod fs" or namespace wrapper of any kind
    expect(src).not.toContain("mod fs");
  })
})
