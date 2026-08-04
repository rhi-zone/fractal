import { describe, expect, test } from "bun:test"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { toJniFfi, toJniType } from "./java-jni.ts"
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts"

/** The JNI-target convention for referencing a native-owned resource by its
 * long-native-pointer-field handle: a plain `ref` TypeRef carrying
 * `opaque-handle` ownership — NOT the `resource`-discipline `resourceRef`
 * helper, which is WIT's own own/borrow lend-count convention this target
 * does not implement (no citable JNI/Android NDK mechanism enforces it; see
 * jni.ts's file header). Mirrors c-abi.test.ts's identical local helper. */
function handleRef(resourceName: string): ReturnType<typeof withOwnership> {
  return withOwnership({ shape: { kind: "ref", target: resourceName }, meta: {} }, ownership.opaqueHandle())
}

describe("toJniType", () => {
  test("copy discipline (or no ownership meta at all) maps to Java's primitive/reference vocabulary", () => {
    expect(toJniType(t(types.integer))).toBe("long")
    expect(toJniType(withOwnership(t(types.boolean), ownership.copy()))).toBe("boolean")
    expect(toJniType(withOwnership(t(types.number), ownership.copy()))).toBe("double")
    expect(toJniType(withOwnership(t(types.string), ownership.copy()))).toBe("String")
  })

  test("bytes maps to byte[]", () => {
    expect(toJniType(t({ kind: "bytes" }))).toBe("byte[]")
  })

  test("void/null map to Java's void", () => {
    expect(toJniType(t(types.void))).toBe("void")
    expect(toJniType(t(types.null))).toBe("void")
  })

  test("fixed-width int/float kinds map to Java's exact-width counterpart", () => {
    expect(toJniType(t({ kind: "int32" }))).toBe("int")
    expect(toJniType(t({ kind: "int64" }))).toBe("long")
    expect(toJniType(t({ kind: "float32" }))).toBe("float")
    expect(toJniType(t({ kind: "float64" }))).toBe("double")
  })

  test("opaque-handle discipline becomes Java's long — the Android-documented native-pointer-field idiom", () => {
    expect(toJniType(handleRef("FileHandle"))).toBe("long")
  })

  test("refcount discipline throws — no native JNI/JVM shared-refcount mechanism", () => {
    expect(() => toJniType(withOwnership(t(types.integer), ownership.refcount()))).toThrow(
      /unsupported ownership discipline "refcount" for JNI target/,
    )
  })

  test("resource discipline (own/borrow) throws — WIT-only, no JNI/Android NDK convention enforces it", () => {
    expect(() => toJniType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("own")))).toThrow(
      /unsupported ownership discipline "resource" for JNI target/,
    )
    expect(() => toJniType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("borrow")))).toThrow(
      /unsupported ownership discipline "resource" for JNI target/,
    )
  })
})

describe("toJniFfi — function", () => {
  test("a simple free function becomes a public static native method", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    )
    const src = toJniFfi(addFn, "add")

    expect(src).toBe("public static native long add(long a, long b);")
  })

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())))
    expect(() => toJniFfi(fn)).toThrow(/"function" requires a name/)
  })

  test("a function taking a resource parameter uses the long native-handle convention", () => {
    const closeFn: FfiRef = f(
      boundary.function([{ name: "handle", type: handleRef("FileHandle") }], withOwnership(t(types.void), ownership.copy())),
    )
    const src = toJniFfi(closeFn, "close")

    expect(src).toBe("public static native void close(long handle);")
  })
})

describe("toJniFfi — method", () => {
  test("a resource method becomes a public (non-static) native method with no explicit receiver parameter", () => {
    const read: FfiRef = f(
      boundary.method(
        [{ name: "length", type: withOwnership(t(types.integer), ownership.copy()) }],
        withOwnership(t({ kind: "bytes" }), ownership.copy()),
        "FileHandle",
      ),
    )
    const src = toJniFfi(read, "read")

    expect(src).toBe("public native byte[] read(long length);")
  })

  test("a no-arg method still needs no receiver parameter — JNI supplies it as the implicit jobject this", () => {
    const closeMethod: FfiRef = f(boundary.method([], withOwnership(t(types.void), ownership.copy()), "FileHandle"))
    const src = toJniFfi(closeMethod, "close")
    expect(src).toBe("public native void close();")
  })

  test("a method requires a name", () => {
    const m = f(boundary.method([], withOwnership(t(types.void), ownership.copy()), "FileHandle"))
    expect(() => toJniFfi(m)).toThrow(/"method" requires a name/)
  })
})

describe("toJniFfi — resource", () => {
  test("emits a class with a private long nativeHandle field and one instance native method per entry in methods", () => {
    const readMethod: FfiRef = f(
      boundary.method([], withOwnership(t({ kind: "bytes" }), ownership.copy()), "FileHandle"),
    )
    const closeMethod: FfiRef = f(boundary.method([], withOwnership(t(types.void), ownership.copy()), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod, close: closeMethod }))

    const src = toJniFfi(fileHandle, "FileHandle")

    expect(src).toContain("public class FileHandle {")
    expect(src).toContain("private long nativeHandle;")
    expect(src).toContain("public native byte[] read();")
    expect(src).toContain("public native void close();")
    // no invented constructor — ffi-ir's `resource` kind has no constructor
    // field, only a methods map (same gap rust-c-abi.ts/rescript.ts/
    // wasm-bindgen.ts already document and decline to paper over).
    expect(src).not.toMatch(/FileHandle\s*\(/)
  })

  test("resource emission ignores an explicit name argument in favor of the shape's own name", () => {
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", {}))
    const src = toJniFfi(fileHandle, "SomeOtherName")
    expect(src).toContain("public class FileHandle {")
    expect(src).not.toContain("SomeOtherName")
  })
})

describe("toJniFfi — module", () => {
  test("groups static native functions and nested resource classes into one class, with a System.loadLibrary block", () => {
    const closeMethod: FfiRef = f(boundary.method([], withOwnership(t(types.void), ownership.copy()), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }))
    const openFn: FfiRef = f(
      boundary.function([{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }], handleRef("FileHandle")),
    )
    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }))

    const src = toJniFfi(fsModule, "fs")

    expect(src).toContain("public class Fs {")
    expect(src).toContain('System.loadLibrary("fs");')
    expect(src).toContain("public static native long open(String path);")
    expect(src).toContain("public static class FileHandle {")
    expect(src).toContain("public native void close();")
  })
})
