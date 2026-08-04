import { describe, expect, test } from "bun:test"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { toCtypes, toCtypesShape, toCtypesType } from "./python-ctypes.ts"
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts"

/** The C-target convention for referencing an opaque resource by pointer:
 * a plain `ref` TypeRef carrying `opaque-handle` ownership — matches
 * `c-abi.test.ts`'s identical `handleRef` helper for the producer side. */
function handleRef(resourceName: string, freeFn?: string): ReturnType<typeof withOwnership> {
  return withOwnership({ shape: { kind: "ref", target: resourceName }, meta: {} }, ownership.opaqueHandle(freeFn))
}

describe("toCtypesShape", () => {
  test("primitive kinds map to ctypes' own vocabulary", () => {
    expect(toCtypesShape(t(types.integer))).toBe("c_int64")
    expect(toCtypesShape(t(types.number))).toBe("c_double")
    expect(toCtypesShape(t(types.boolean))).toBe("c_bool")
    expect(toCtypesShape(t(types.string))).toBe("c_char_p")
    expect(toCtypesShape(t(types.void))).toBe("None")
    expect(toCtypesShape(t(types.null))).toBe("None")
  })

  test("a ref TypeRef passes the target name through, trusting a Structure of that name exists", () => {
    expect(toCtypesShape(t({ kind: "ref", target: "FileHandle" }))).toBe("FileHandle")
  })

  test("an object TypeRef requires meta.typeName", () => {
    expect(() => toCtypesShape(t(types.object({})))).toThrow(/requires meta\.typeName/)
  })

  test("array/tuple/map/union — no native ctypes representation, throws", () => {
    expect(() => toCtypesShape(t(types.array(t(types.integer))))).toThrow(/no ctypes representation/)
    expect(() => toCtypesShape(t(types.tuple([t(types.integer), t(types.string)])))).toThrow(/no ctypes representation/)
    expect(() => toCtypesShape(t(types.map(t(types.string), t(types.integer))))).toThrow(/no ctypes representation/)
    expect(() => toCtypesShape(t(types.union([t(types.integer), t(types.string)])))).toThrow(/no ctypes representation/)
  })
})

describe("toCtypesType — ownership discipline", () => {
  test("copy discipline (or no ownership meta at all) is the plain ctype", () => {
    expect(toCtypesType(t(types.integer))).toBe("c_int64")
    expect(toCtypesType(withOwnership(t(types.boolean), ownership.copy()))).toBe("c_bool")
  })

  test("opaque-handle discipline becomes POINTER(<T>)", () => {
    expect(toCtypesType(handleRef("FileHandle"))).toBe("POINTER(FileHandle)")
  })

  test("refcount and resource(own/borrow) disciplines produce the SAME POINTER(<T>) declaration as opaque-handle — " +
    "ctypes has no type-level way to distinguish them (see ctypes.ts file header)", () => {
    expect(toCtypesType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.refcount()))).toBe("POINTER(FileHandle)")
    expect(toCtypesType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("own")))).toBe("POINTER(FileHandle)")
    expect(toCtypesType(withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("borrow")))).toBe("POINTER(FileHandle)")
  })
})

describe("toCtypes — function", () => {
  test("a simple free function: argtypes/restype wiring plus a thin wrapper", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    )
    const src = toCtypes(addFn, "add")

    expect(src).toContain("lib.add.argtypes = [c_int64, c_int64]")
    expect(src).toContain("lib.add.restype = c_int64")
    expect(src).toContain("def add(a, b):")
    expect(src).toContain("return lib.add(a, b)")
  })

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())))
    expect(() => toCtypes(fn)).toThrow(/"function" requires a name/)
  })

  test("a void-returning function gets restype = None", () => {
    const closeFn: FfiRef = f(
      boundary.function([{ name: "handle", type: handleRef("FileHandle") }], withOwnership(t(types.void), ownership.copy())),
    )
    const src = toCtypes(closeFn, "close")
    expect(src).toContain("lib.close.argtypes = [POINTER(FileHandle)]")
    expect(src).toContain("lib.close.restype = None")
  })
})

describe("toCtypes — resource, opaque-handle discipline", () => {
  test("a resource with a constructor and a method: opaque Structure, method wiring, free-function wiring, wrapper class", () => {
    const readMethod: FfiRef = f(boundary.method([], withOwnership(t(types.integer), ownership.copy()), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { read: readMethod }))

    const openFn: FfiRef = f(
      boundary.function([{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }], handleRef("FileHandle")),
    )

    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }))
    const src = toCtypes(fsModule)

    // opaque Structure, permanently incomplete (no _fields_)
    expect(src).toContain("class FileHandle(Structure):")
    expect(src).toContain("    pass")

    // constructor returns a pointer to the opaque struct
    expect(src).toContain("lib.open.restype = POINTER(FileHandle)")
    expect(src).toContain("def open(path):")

    // method wiring, receiver-prefixed with a synthesized handle parameter
    expect(src).toContain("lib.file_handle_read.argtypes = [POINTER(FileHandle)]")
    expect(src).toContain("lib.file_handle_read.restype = c_int64")
    expect(src).toContain("def file_handle_read(handle):")

    // auto-generated free-function wiring
    expect(src).toContain("lib.file_handle_free.argtypes = [POINTER(FileHandle)]")
    expect(src).toContain("lib.file_handle_free.restype = None")

    // wrapper class: stores the handle, delegates read(), frees on __del__
    expect(src).toContain("class FileHandle:")
    expect(src).toContain("def __init__(self, handle):")
    expect(src).toContain("self._handle = handle")
    expect(src).toContain("def read(self):")
    expect(src).toContain("return file_handle_read(self._handle)")
    expect(src).toContain("def __del__(self):")
    expect(src).toContain("file_handle_free(self._handle)")
  })

  test("resource emission ignores an explicit name argument in favor of the shape's own name", () => {
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", {}))
    const src = toCtypes(fileHandle, "SomeOtherName")
    expect(src).toContain("class FileHandle(Structure):")
    expect(src).not.toContain("SomeOtherName")
  })
})

describe("toCtypes — resource, other ownership disciplines (refcount / resource own-borrow)", () => {
  test(
    "a function taking a refcount- or resource-discipline handle produces the IDENTICAL POINTER(<T>) argtype as " +
      "opaque-handle — ctypes has no ownership model of its own, so it cannot distinguish these at the declaration level " +
      "(see ctypes.ts file header for the full reasoning)",
    () => {
      const refcountFn: FfiRef = f(
        boundary.function(
          [{ name: "handle", type: withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.refcount()) }],
          withOwnership(t(types.void), ownership.copy()),
        ),
      )
      const resourceFn: FfiRef = f(
        boundary.function(
          [{ name: "handle", type: withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("borrow")) }],
          withOwnership(t(types.void), ownership.copy()),
        ),
      )
      const opaqueFn: FfiRef = f(
        boundary.function([{ name: "handle", type: handleRef("FileHandle") }], withOwnership(t(types.void), ownership.copy())),
      )

      const refcountSrc = toCtypes(refcountFn, "release")
      const resourceSrc = toCtypes(resourceFn, "borrow_use")
      const opaqueSrc = toCtypes(opaqueFn, "close")

      expect(refcountSrc).toContain("lib.release.argtypes = [POINTER(FileHandle)]")
      expect(resourceSrc).toContain("lib.borrow_use.argtypes = [POINTER(FileHandle)]")
      expect(opaqueSrc).toContain("lib.close.argtypes = [POINTER(FileHandle)]")
    },
  )
})

describe("toCtypes — module", () => {
  test("emits a CDLL load block followed by resources then functions", () => {
    const closeMethod: FfiRef = f(boundary.method([], withOwnership(t(types.void), ownership.copy()), "FileHandle"))
    const fileHandle: FfiRef = f(boundary.resource("FileHandle", { close: closeMethod }))
    const openFn: FfiRef = f(
      boundary.function([{ name: "path", type: withOwnership(t(types.string), ownership.copy()) }], handleRef("FileHandle")),
    )
    const fsModule: FfiRef = f(boundary.module("fs", { open: openFn }, { FileHandle: fileHandle }))

    const src = toCtypes(fsModule)
    expect(src).toContain("from ctypes import *")
    expect(src).toContain('lib = CDLL("./libfs.so")')
    expect(src).toContain("class FileHandle(Structure):")
    expect(src).toContain("def open(path):")
    expect(src).toContain("def file_handle_close(handle):")

    // opaque struct/resource block appears before the module-level open() function
    expect(src.indexOf("class FileHandle(Structure):")).toBeLessThan(src.indexOf("def open(path):"))
  })

  test("libraryPath overrides the default ./lib<name>.so placeholder", () => {
    const fsModule: FfiRef = f(boundary.module("fs", {}, {}))
    const src = toCtypes(fsModule, undefined, "/usr/local/lib/libfs.so.1")
    expect(src).toContain('lib = CDLL("/usr/local/lib/libfs.so.1")')
  })
})
