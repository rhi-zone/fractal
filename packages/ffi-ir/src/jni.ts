import type { TypeRef } from "@rhi-zone/fractal-type-ir"
import type { FfiRef, FfiShape, OwnershipDiscipline } from "./index.ts"

// JNI (Java Native Interface) projector — the Java-side `native` method
// declaration surface for calling into native code, the human-facing
// counterpart of ReScript's `external`/Gleam's `@external`/C-ABI's `extern
// "C" fn`, NOT the auto-generated `JNIEnv*`/`jobject`-shaped C glue header.
//
// Why JNI needs its own file rather than reusing rust-c-abi.ts (verified this
// session, not assumed): [VERIFIED-EXTERNAL:
// docs.oracle.com/en/java/javase/17/docs/specs/jni/design.html, fetched
// 2026-08-03] a native method is declared in Java as `native ReturnType
// name(Params...);`; the corresponding native function's REQUIRED first two
// parameters are `JNIEnv *env` plus `jobject`/`jclass` (the implicit
// receiver), with the function's exact C name deterministically derived from
// the fully-qualified class + method name (`Java_p_q_r_A_f`, or with a
// `__<descriptor>` suffix for overloads). That signature shape — `JNIEnv*`,
// opaque `jobject`/`jclass`/`jstring` handles, VM-managed reference lifetime
// — has no analogue in a plain `extern "C"` function signature, matching
// this session's earlier §5 target-inventory finding
// (docs/design/ffi-ir-architecture-options.md, item 4): "categorically
// different from [LuaJIT/Deno/Bun]: not 'a C-ABI library plus a loader,' a
// distinct glue-generation target."
//
// Header generation IS genuinely automatic tooling, confirmed this session
// (not assumed by analogy to cbindgen): `javac -h <dir>` (the JDK 8+
// replacement for the deprecated standalone `javah` utility) generates the
// `JNIEnv*`-shaped C header directly from a compiled class's `native` method
// declarations — [VERIFIED-EXTERNAL, via search: docs.oracle.com javah
// history + JDK 8 `javac -h` documentation, cross-checked against multiple
// independent tutorial/reference sources, fetched 2026-08-03]. Exactly like
// `rust-c-abi.ts` not emitting the cbindgen-generated C header (that file's own
// header comment: "a header would be a downstream artifact of this file's
// output, not something fractal emits directly"), this file emits ONLY the
// Java-side `native` declarations — the `javac -h` header is a downstream
// artifact of compiling them, not something fractal emits here.
//
// Resource idiom — verified, not assumed identical to C's opaque pointer:
// [VERIFIED-EXTERNAL: developer.android.com/training/articles/perf-jni,
// "64-bit considerations" section, fetched 2026-08-03] "To support
// architectures that use 64-bit pointers, use a `long` field rather than an
// `int` when storing a pointer to a native structure in a Java field." This
// is a DIFFERENT mechanism from JNI's own `jobject`/local-ref/global-ref
// reference-type system (which the same JNI spec page describes as
// VM-managed handles into a per-thread/per-critical-section reference table,
// freed automatically on native-method return for locals, requiring explicit
// `NewGlobalRef`/`DeleteGlobalRef` for anything outstanding beyond one call)
// — that system governs how the JVM tracks *Java objects* handed to native
// code, a GC-safety concern with no free/ownership decision for fractal's
// IR to make at all (the VM handles it unconditionally). The native-pointer-
// as-a-long-field idiom is the one with a citable, established convention
// answering the actual question this session's ownership vocabulary asks
// ("how does a native-owned resource cross the boundary"), so that is what
// `buildResource` below implements — a `private long nativeHandle;` field on
// a generated wrapper class, not an attempt to reproduce jobject/local-ref
// semantics (which the IR's `OwnershipDiscipline` vocabulary was never
// modeling in the first place; see the ownership note below).
//
// Ownership discipline coverage — mirrors rust-c-abi.ts's decided split exactly,
// for closely related reasons:
//   - `"copy"` (or no ownership meta at all) — plain by-value primitive/
//     String/byte[], via `toJniType` below.
//   - `"opaque-handle"` — the long-native-pointer-field idiom verified
//     above: an opaque handle crossing as a bare value (a parameter, a
//     return, or the resource wrapper class's own internal field) is
//     rendered as Java's `long`. This is the closest real match to `c-abi.
//     ts`'s `*mut T` -> raw pointer mapping, just wearing a fixed-width
//     integer instead of a pointer type, per the Android-documented
//     convention.
//   - `"refcount"` — throws, same as `rust-c-abi.ts`. No native JNI/JVM
//     mechanism performs shared reference counting at the boundary; Java's
//     own GC-triggered cleanup facilities (`finalize()`, `java.lang.ref.
//     Cleaner`) are a single-owner "run this when the JVM decides to
//     collect it" callback, not an increment/decrement shared-count
//     discipline — forcing that into "refcount" would be inventing a
//     mapping this session found no citable convention for, not reporting
//     an established one.
//   - `"resource"` (own/borrow) — throws. This mode is WIT's own
//     Canonical-ABI per-instance handle-table + lend-count-and-trap
//     mechanism (see `./index.ts`'s doc comment on `OwnershipDiscipline`);
//     nothing in the JNI spec or the Android NDK docs verified this session
//     enforces an own/borrow distinction or traps on a lend-count
//     violation — same "no native mechanism" reasoning `rust-c-abi.ts` already
//     applies to this exact discipline. A `resourceRef(...)`-built
//     TypeRef (which sets `ownership.resource(mode)` by convention, per
//     `./index.ts`) is therefore NOT the right constructor to reach for
//     targeting JNI, mirroring `c-abi.test.ts`'s own local `handleRef`
//     helper (built with `ownership.opaqueHandle()` instead) — this file's
//     test suite does the same.
//
// Type mapping is intentionally minimal, per the task's own scope: Java's
// primitive vocabulary (`boolean`, `int`/`long`, `float`/`double`) plus
// `String` and `byte[]` for the `bytes` kind. Bare `integer`/`number` (no
// declared width) default to the WIDEST native form (`long`/`double`),
// matching the same "no width info -> widest safe default" precedent
// type-ir's own `cpp-nlohmann.ts` documents for its bare-`integer` case;
// `int32`/`int64`/`float32`/`float64` (type-ir's optional fixed-width
// extension kinds, `@rhi-zone/fractal-type-ir/kinds/int-widths` and
// `.../float-widths`) map to their exact-width Java counterpart when used.
//
// Naming: unlike `rust-c-abi.ts` (free to rewrite an exported symbol's spelling
// to `snake_case` with no external constraint) or `rescript.ts` (whose
// `external` syntax keeps the ReScript-side identifier and the JS-side
// string-literal target independently spellable), a JNI `native` method's
// Java name and its JNI-mandated linkable C symbol name are THE SAME STRING,
// deterministically derived (verified above) — there is no separate
// "wire name" to decouple through. This file therefore does NOT camelCase-
// or snake_case-transform an incoming name; it only sanitizes characters
// that would not compile as a Java identifier and escapes exact Java
// reserved words, since either would otherwise be a hard compile error, not
// a style preference.

const JAVA_RESERVED = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
  "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float",
  "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native",
  "new", "package", "private", "protected", "public", "return", "short", "static", "strictfp",
  "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void",
  "volatile", "while", "true", "false", "null",
])

/** A valid Java identifier for `name` — replaces characters that cannot
 * appear in a Java identifier, prefixes a leading digit, and escapes exact
 * Java reserved words. Deliberately NOT a casing transform (see file header:
 * a `native` method's Java name IS the linkable JNI symbol name, so this
 * file does not rewrite spelling beyond what's needed to compile). */
function sanitizeIdent(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_")
  const based = /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`
  return JAVA_RESERVED.has(based) ? `${based}_` : based
}

function toPascalCase(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w.length > 0)
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("")
}

function indent(block: string, prefix = "    "): string {
  return block
    .split("\n")
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join("\n")
}

function quote(value: string): string {
  return JSON.stringify(value)
}

/**
 * The Java-declaration-surface type for one boundary position (a
 * parameter's or return's `TypeRef`), applying the JNI target's ownership
 * rule (see file header):
 *   - `{ kind: "opaque-handle" }` — Java's `long` (the Android-documented
 *     native-pointer-field idiom), regardless of the referenced type-ir
 *     shape's own kind — an opaque handle is opaque, its Rust/C++-side
 *     layout is not Java's concern.
 *   - `{ kind: "refcount" }` / `{ kind: "resource", mode }` — throws (see
 *     file header for the per-discipline reasoning).
 *   - no `meta.ownership`, or `{ kind: "copy" }` — the minimal
 *     boolean/integer/number/string/bytes/void mapping below.
 */
export function toJniType(ref: TypeRef): string {
  const discipline = ref.meta.ownership as OwnershipDiscipline | undefined
  if (discipline !== undefined) {
    if (discipline.kind === "opaque-handle") return "long"
    if (discipline.kind === "refcount") {
      throw new Error(
        'toJniType: unsupported ownership discipline "refcount" for JNI target — no native JNI/JVM shared-refcount mechanism ' +
          "(Java's GC-triggered finalize()/Cleaner is a single-owner collection callback, not reference counting; see jni.ts's file header)",
      )
    }
    if (discipline.kind === "resource") {
      throw new Error(
        'toJniType: unsupported ownership discipline "resource" for JNI target — WIT-only own/borrow lend-count-and-trap mechanism, ' +
          "no citable JNI/Android NDK convention enforces it (see jni.ts's file header; use ownership.opaqueHandle() instead)",
      )
    }
    // "copy" falls through to the plain mapping below.
  }

  const kind = ref.shape.kind
  if (kind === "boolean") return "boolean"
  if (kind === "integer") return "long"
  if (kind === "int32") return "int"
  if (kind === "int64") return "long"
  if (kind === "number") return "double"
  if (kind === "float32") return "float"
  if (kind === "float64") return "double"
  if (kind === "string") return "String"
  if (kind === "bytes") return "byte[]"
  if (kind === "void" || kind === "null") return "void"

  throw new Error(
    `toJniType: unsupported type-ir kind "${kind}" for JNI target — this minimal projector maps only ` +
      "boolean/integer(+int32/int64)/number(+float32/float64)/string/bytes/void to Java's native-declaration vocabulary",
  )
}

function docComment(meta: Readonly<Record<string, unknown>>): string {
  return typeof meta.description === "string" ? `/** ${meta.description} */\n` : ""
}

type FfiFunctionLike = {
  readonly params: readonly { readonly name: string; readonly type: TypeRef }[]
  readonly returnType: TypeRef
}

/**
 * One `native` method declaration. `isStatic` distinguishes a module-level
 * free function (`public static native`, no receiver) from a resource
 * method (`public native`, no `static` — the receiver is JNI's own implicit
 * `jobject this`, requiring NO explicit handle parameter in the Java-side
 * declaration, unlike `rust-c-abi.ts`'s synthesized `handle: *mut T` first
 * parameter for the same case: JNI supplies the receiver itself, per the
 * Oracle spec's documented native-function signature shape verified in the
 * file header).
 */
function buildDecl(javaName: string, ref: FfiRef, shape: FfiFunctionLike, isStatic: boolean): string {
  const params = shape.params.map((p) => `${toJniType(p.type)} ${sanitizeIdent(p.name)}`).join(", ")
  const returnType = toJniType(shape.returnType)
  const modifiers = isStatic ? "public static native" : "public native"
  return `${docComment(ref.meta)}${modifiers} ${returnType} ${sanitizeIdent(javaName)}(${params});`
}

/**
 * Resource -> a Java class holding a `private long nativeHandle;` field
 * (the Android-documented native-pointer-field idiom, see file header) plus
 * one instance `native` method per entry in `methods`. `isNested`, when
 * true, adds `static` to the class modifier (used when this resource is
 * emitted inside an enclosing module's wrapper class — a Java nested class
 * needs `static` to avoid an implicit, unwanted enclosing-instance
 * reference; a top-level resource class needs no such modifier).
 *
 * Deliberately does NOT synthesize a constructor: ffi-ir's `resource` kind
 * (`./index.ts`) carries only a `methods` map, no separate constructor
 * field — the same gap `rust-c-abi.ts`/`rescript.ts`/`wasm-bindgen.ts` already
 * document and decline to invent one for, rather than guessing at a
 * constructor signature the schema does not express.
 */
function buildResource(
  name: string,
  ref: FfiRef,
  shape: FfiShape & { kind: "resource"; methods: Readonly<Record<string, FfiRef>> },
  isNested: boolean,
): string {
  const classModifiers = isNested ? "public static class" : "public class"
  const lines: string[] = [`${docComment(ref.meta)}${classModifiers} ${name} {`, "    private long nativeHandle;", ""]

  const methodDecls = Object.entries(shape.methods).map(([methodName, methodRef]) => {
    const kind = methodRef.shape.kind
    if (kind !== "method" && kind !== "function") {
      throw new Error(`toJniFfi: resource method "${methodName}" has unexpected kind "${kind}" (expected "method")`)
    }
    const methodShape = methodRef.shape as FfiShape & { kind: "method"; params: readonly { name: string; type: TypeRef }[]; returnType: TypeRef }
    return buildDecl(methodName, methodRef, methodShape, false)
  })

  lines.push(indent(methodDecls.join("\n\n")))
  lines.push("}")
  return lines.join("\n")
}

/**
 * Module -> a `public class ModuleName { ... }` grouping the module's
 * static native functions and nested resource classes, plus a `static {
 * System.loadLibrary("..."); }` block — the standard JNI idiom for loading
 * the backing native library before any native method on the class is
 * invoked.
 *
 * Naming judgment call, flagged per the task (not guessed silently): ffi-ir's
 * `FfiKinds.module.name` carries no field distinguishing "a Java class name"
 * from "a native shared-library name" (they are conventionally DIFFERENT
 * strings — e.g. class `MyModule` loading library `"mymodule"`, without the
 * platform's `lib`/`.so`/`.dll` decoration, which `System.loadLibrary`
 * itself adds). This projector uses the SAME `name` for both the generated
 * class (PascalCased) and the `loadLibrary` argument (passed through
 * verbatim, undecorated) since the schema gives no second name to draw the
 * library name from — the same kind of naming gap `rescript.ts`'s file
 * header already flags for its own `@module`-vs-`@val` judgment call.
 */
function buildModule(
  name: string,
  shape: FfiShape & { kind: "module"; functions: Readonly<Record<string, FfiRef>>; resources: Readonly<Record<string, FfiRef>> },
): string {
  const className = toPascalCase(name)

  const functionDecls = Object.entries(shape.functions).map(([fnName, fnRef]) => {
    const fnShape = fnRef.shape
    if (fnShape.kind !== "function" && fnShape.kind !== "method") {
      throw new Error(`toJniFfi: module function "${fnName}" has unexpected kind "${fnShape.kind}" (expected "function")`)
    }
    return buildDecl(fnName, fnRef, fnShape as FfiShape & { kind: "function" }, true)
  })

  const resourceDecls = Object.entries(shape.resources).map(([resName, resRef]) =>
    buildResource(resName, resRef, resRef.shape as FfiShape & { kind: "resource"; methods: Readonly<Record<string, FfiRef>> }, true),
  )

  const loadLibrary = ["static {", `    System.loadLibrary(${quote(name)});`, "}"].join("\n")
  const body = [loadLibrary, ...functionDecls, ...resourceDecls].join("\n\n")
  return [`public class ${className} {`, indent(body), "}"].join("\n")
}

/**
 * Lower one ffi-ir `FfiRef` to Java `native`-declaration source text.
 *   - `function` -> `public static native ReturnType name(params...);` (a
 *     free function has no JNI-implicit receiver, so it is emitted as a
 *     static native method — the conventional JNI mapping for a boundary
 *     entry point not tied to any resource).
 *   - `method` -> `public native ReturnType name(params...);` (instance
 *     native method — no explicit receiver parameter; JNI supplies it as
 *     the implicit `jobject this`).
 *   - `resource` -> the wrapper-class-with-long-field group (see
 *     `buildResource`; `name` argument, if given, is ignored in favor of the
 *     shape's own `name` field, matching `rust-c-abi.ts`'s identical precedent).
 *   - `module` -> the class-plus-loadLibrary group (see `buildModule`).
 *
 * Throws for `refcount`/`resource`-discipline ownership metadata anywhere in
 * a crossed `TypeRef` (see `toJniType`) — same explicit-throw-on-unsupported
 * pattern `rust-c-abi.ts` already uses for disciplines it can't realize on its
 * own target.
 */
export function toJniFfi(ref: FfiRef, name?: string): string {
  const kind = ref.shape.kind

  if (kind === "function") {
    if (name === undefined) {
      throw new Error('toJniFfi: "function" requires a name — a Java native method is a named declaration, not an anonymous inline type')
    }
    const shape = ref.shape as FfiShape & { kind: "function" }
    return buildDecl(name, ref, shape, true)
  }

  if (kind === "method") {
    if (name === undefined) {
      throw new Error('toJniFfi: "method" requires a name — the method\'s own key in its resource\'s methods map')
    }
    const shape = ref.shape as FfiShape & { kind: "method" }
    return buildDecl(name, ref, shape, false)
  }

  if (kind === "resource") {
    const shape = ref.shape as FfiShape & { kind: "resource"; name: string; methods: Readonly<Record<string, FfiRef>> }
    return buildResource(shape.name, ref, shape, false)
  }

  if (kind === "module") {
    const shape = ref.shape as FfiShape & {
      kind: "module"
      name: string
      functions: Readonly<Record<string, FfiRef>>
      resources: Readonly<Record<string, FfiRef>>
    }
    return buildModule(shape.name, shape)
  }

  throw new Error(`toJniFfi: unhandled ffi-ir kind "${kind}" — no JNI mapping implemented for this backend`)
}
