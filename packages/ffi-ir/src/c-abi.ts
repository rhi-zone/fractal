import type { TypeRef } from "@rhi-zone/fractal-type-ir"
import { toRustType } from "@rhi-zone/fractal-type-ir/rust-serde"
import type { FfiRef, FfiShape, OwnershipDiscipline } from "./index.ts"

// C ABI projector — Rust source (`#[repr(C)]` structs, `#[no_mangle] pub
// extern "C" fn` functions) as the emission side of a plain-C FFI boundary.
// Rust-as-source matches the established precedent in this monorepo
// (type-ir's `wasm-bindgen.ts` emits Rust targeting a *different* consumer,
// JS via wasm-bindgen; this file emits Rust targeting a C consumer via
// cbindgen). A C header itself is NOT emitted here — cbindgen's own
// documented job is generating that header FROM compiled Rust source
// (docs.md, confirmed in docs/design/ffi-ir-architecture-options.md's Fork C
// deeper pass, point 1: cbindgen covers "type layout, header config, type
// mappings, and function declarations", reading FROM Rust, not the reverse),
// so a header would be a downstream artifact of this file's output, not
// something fractal emits directly. type-ir has no existing "type-ir ->
// Rust with repr(C)" projector to build on other than `rust-serde.ts` (serde
// derives, not repr(C)) — this is the first backend file in ffi-ir.
//
// Implements exactly the two ownership disciplines the design doc's Fork C
// "discipline-per-target: decided" subsection names for the C target:
//   - `copy` — plain by-value parameter/return, reusing rust-serde.ts's
//     primitive/struct type mapping directly (`toRustType`).
//   - `opaque-handle` — a raw pointer (`*mut T`) plus the paired
//     explicit-free-function convention, matching cbindgen's own documented
//     opaque-pointer pattern (the doc's Fork C, point 1: cbindgen prescribes
//     no alloc/free convention itself, so fractal adopts this one as its own
//     convention rather than inventing a different one) and the Rustonomicon's
//     documented opaque-struct idiom for FFI
//     (https://doc.rust-lang.org/nomicon/ffi.html#representing-opaque-structs —
//     `pub struct Foo { _private: [u8; 0] }`, a zero-sized-field marker type
//     with no C-visible layout).
// `refcount` and `resource` (own/borrow) are explicitly OUT OF SCOPE for this
// target per the same decided subsection — "no native mechanism" for
// refcount (would be entirely fractal/author-maintained bookkeeping cbindgen
// doesn't generate or verify) and "no host runtime exists for plain C to
// enforce" the resource/lend-count model (would require fractal to generate
// a full handle-table runtime from scratch). Both throw explicitly rather
// than silently approximating — same throw-not-degrade convention
// `wasm-bindgen.ts` already uses for kinds/values it can't realize on its
// own target's ABI.

// Same conventions as rust-serde.ts/wasm-bindgen.ts (duplicated here — each
// projector file in this package is self-contained, same precedent
// wasm-bindgen.ts's own file header documents for its duplication of these
// exact helpers relative to rust-serde.ts).
function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
}

const RUST_KEYWORDS = new Set([
  "type", "struct", "enum", "fn", "let", "mut", "ref", "self", "super", "crate",
  "mod", "pub", "use", "impl", "trait", "where", "loop", "while", "for", "if",
  "else", "match", "return", "break", "continue", "as", "in", "move", "box",
  "dyn", "abstract", "async", "await", "become", "const", "do", "extern",
  "final", "macro", "override", "priv", "static", "try", "typeof", "unsafe",
  "unsized", "virtual", "yield", "union",
])

function escapeRustIdent(rustName: string): string {
  return RUST_KEYWORDS.has(rustName) ? `r#${rustName}` : rustName
}

function quote(value: string): string {
  return JSON.stringify(value)
}

/**
 * The type-ir-level Rust expression for one boundary position (a parameter's
 * or return's `TypeRef`), applying the C target's ownership rule:
 *   - no `meta.ownership` at all, or `{ kind: "copy" }` — plain by-value,
 *     delegating straight to rust-serde.ts's `toRustType` (reused, not
 *     re-derived, per the task's own instruction to mirror that mapping).
 *   - `{ kind: "opaque-handle" }` — `*mut <T>`, where `<T>` is the same
 *     `toRustType` expression (for the documented `resourceRef`/`ref`
 *     convention this collapses to the bare resource name, e.g. `*mut
 *     FileHandle`, but the mapping is general: an opaque-handle TypeRef of
 *     any structural kind becomes a raw pointer to its Rust type).
 *   - `{ kind: "refcount" }` / `{ kind: "resource", mode }` — explicitly
 *     unsupported for this target (see file header) — throws rather than
 *     silently approximating as a pointer or a copy.
 */
export function toCAbiType(ref: TypeRef): string {
  const discipline = ref.meta.ownership as OwnershipDiscipline | undefined
  if (discipline === undefined || discipline.kind === "copy") return toRustType(ref)
  if (discipline.kind === "opaque-handle") return `*mut ${toRustType(ref)}`
  throw new Error(
    `toCAbi: unsupported ownership discipline "${discipline.kind}" for C target — the C backend implements only "copy" and "opaque-handle" ` +
      '(docs/design/ffi-ir-architecture-options.md, Fork C "discipline-per-target: decided": no native C mechanism for refcounting or a resource/lend-count handle table; both are explicitly out of scope for this target, not an oversight)',
  )
}

function docComment(indent: string, meta: Readonly<Record<string, unknown>>): string[] {
  return typeof meta.description === "string" ? [`${indent}/// ${meta.description}`] : []
}

type FfiFunctionLike = {
  readonly params: readonly { readonly name: string; readonly type: TypeRef }[]
  readonly returnType: TypeRef
}

/** One `#[no_mangle] pub extern "C" fn` for a `function`/`method` shape.
 * `selfParam`, when given, is prepended as the receiver parameter (a
 * resource method's implicit `self` — ffi-ir's `method` kind names its
 * receiver by resource name only, carrying no parameter of its own, so the
 * pointer parameter is synthesized here using the same `opaque-handle`
 * pointer convention `toCAbiType` uses for any other opaque handle
 * position). Body is a `todo!()` stub — ffi-ir carries only the signature,
 * matching wasm-bindgen.ts's identical stub-body convention for the same
 * reason (no implementation in the IR to emit). */
function buildFunction(fnName: string, ref: FfiRef, shape: FfiFunctionLike, selfParam?: string): string {
  const params: string[] = []
  if (selfParam !== undefined) params.push(`handle: *mut ${selfParam}`)
  for (const p of shape.params) {
    const ident = escapeRustIdent(toSnakeCase(p.name))
    params.push(`${ident}: ${toCAbiType(p.type)}`)
  }

  const isVoidReturn = shape.returnType.shape.kind === "void" || shape.returnType.shape.kind === "null"
  const returnType = isVoidReturn ? "" : ` -> ${toCAbiType(shape.returnType)}`

  const lines: string[] = [...docComment("", ref.meta)]
  lines.push("#[no_mangle]")
  lines.push(`pub extern "C" fn ${fnName}(${params.join(", ")})${returnType} {`)
  lines.push(`    todo!(${quote(`implement ${fnName}`)})`)
  lines.push("}")
  return lines.join("\n")
}

/** The Rustonomicon-documented opaque-struct idiom for a C-ABI handle: a
 * zero-sized private field means the type has no C-visible layout (callers
 * can only ever hold `*mut Foo`/`*const Foo`, never a by-value `Foo`), which
 * is exactly the "opaque pointer" cbindgen itself documents as its own
 * convention (see file header). `#[repr(C)]` is required so the struct's
 * (empty) layout is well-defined across the FFI boundary rather than left to
 * Rust's default unspecified-layout `repr(Rust)`. */
function buildOpaqueStruct(name: string, ref: FfiRef): string {
  const lines: string[] = [...docComment("", ref.meta), "#[repr(C)]", `pub struct ${name} {`, "    _private: [u8; 0],", "}"]
  return lines.join("\n")
}

/** The paired explicit free function cbindgen's opaque-pointer convention
 * requires (see `OwnershipDiscipline`'s `opaque-handle` case in
 * `./index.ts`, which documents `freeFn` as "the exported free function a
 * backend should emit a call to, when known" — this is that function,
 * synthesized by this backend for every resource). Null-checks before
 * freeing (a defensive, standard C-FFI convention) and reclaims the heap
 * allocation via `Box::from_raw` + `drop` — the Rust-side counterpart of
 * whatever allocation produced the `*mut T` in the first place (a
 * constructor function returning `Box::into_raw(Box::new(...))`,
 * conventionally). */
function buildFreeFunction(freeFnName: string, structName: string): string {
  return [
    "#[no_mangle]",
    `pub extern "C" fn ${freeFnName}(handle: *mut ${structName}) {`,
    "    if handle.is_null() {",
    "        return;",
    "    }",
    "    unsafe {",
    "        drop(Box::from_raw(handle));",
    "    }",
    "}",
  ].join("\n")
}

function buildResource(
  name: string,
  ref: FfiRef,
  shape: FfiShape & { kind: "resource"; methods: Readonly<Record<string, FfiRef>> },
): string {
  const resourceSnake = toSnakeCase(name)
  const decls: string[] = [buildOpaqueStruct(name, ref)]

  for (const [methodName, methodRef] of Object.entries(shape.methods)) {
    const methodShape = methodRef.shape as FfiShape & { kind: "method" }
    const fnName = `${resourceSnake}_${toSnakeCase(methodName)}`
    decls.push(buildFunction(fnName, methodRef, methodShape, name))
  }

  decls.push(buildFreeFunction(`${resourceSnake}_free`, name))
  return decls.join("\n\n")
}

/**
 * Lower one ffi-ir `FfiRef` to C-ABI-oriented Rust source.
 *   - `function` -> a top-level `#[no_mangle] pub extern "C" fn` (requires
 *     `name`, mirroring wasm-bindgen.ts's identical requirement — a free
 *     function's name lives as the key in the enclosing `module.functions`
 *     map, not on the shape itself).
 *   - `method` -> the same, plus a synthesized `handle: *mut <receiver>`
 *     first parameter and a `<receiver>_<method>` name (requires `name`, the
 *     method's own key in its resource's `methods` map).
 *   - `resource` -> the opaque-struct-plus-methods-plus-free-function group
 *     (`name` argument, if given, is ignored — the shape carries its own
 *     `name` field, matching ffi-ir's `FfiKinds.resource` shape).
 *   - `module` -> all contained functions then all contained resources,
 *     concatenated — C has no module/namespace construct of its own, so
 *     this is the "no special module wrapper" case the task calls out.
 *
 * Throws for `refcount`/`resource`-discipline ownership metadata anywhere in
 * a crossed `TypeRef` (see `toCAbiType`) — same explicit-throw-on-unsupported
 * pattern `wasm-bindgen.ts` already uses for kinds/values it can't realize on
 * its own target.
 */
export function toCAbi(ref: FfiRef, name?: string): string {
  const kind = ref.shape.kind

  if (kind === "function") {
    if (name === undefined) {
      throw new Error('toCAbi: "function" requires a name — a C export is a named symbol, not an anonymous inline type')
    }
    const shape = ref.shape as FfiShape & { kind: "function" }
    return buildFunction(toSnakeCase(name), ref, shape)
  }

  if (kind === "method") {
    if (name === undefined) {
      throw new Error('toCAbi: "method" requires a name — the method\'s own key in its resource\'s methods map')
    }
    const shape = ref.shape as FfiShape & { kind: "method" }
    const fnName = `${toSnakeCase(shape.receiver)}_${toSnakeCase(name)}`
    return buildFunction(fnName, ref, shape, shape.receiver)
  }

  if (kind === "resource") {
    const shape = ref.shape as FfiShape & { kind: "resource"; name: string; methods: Readonly<Record<string, FfiRef>> }
    return buildResource(shape.name, ref, shape)
  }

  if (kind === "module") {
    const shape = ref.shape as FfiShape & {
      kind: "module"
      name: string
      functions: Readonly<Record<string, FfiRef>>
      resources: Readonly<Record<string, FfiRef>>
    }
    const decls: string[] = [
      ...Object.entries(shape.functions).map(([fnName, fnRef]) => toCAbi(fnRef, fnName)),
      ...Object.entries(shape.resources).map(([resName, resRef]) => toCAbi(resRef, resName)),
    ]
    return decls.join("\n\n")
  }

  throw new Error(`toCAbi: unhandled ffi-ir kind "${kind}" — no C-ABI mapping implemented for this backend`)
}
