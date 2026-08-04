import type { TypeRef } from "@rhi-zone/fractal-type-ir"
import type { FfiRef, FfiShape, OwnershipDiscipline } from "./index.ts"

// Ruby `ffi` gem projector — the consumer side of `rust-c-abi.ts`: where rust-c-abi.ts
// emits the Rust source implementing a plain C ABI, this file emits the
// Ruby-side loader code that calls INTO a compiled C-ABI shared library
// through the `ffi` gem (https://github.com/ffi/ffi). This is a different
// shape of task than every other projector in this package: those all target
// languages with their own native FFI-declaration syntax embedded in the
// producer language itself (Rust's `#[wasm_bindgen]`, WIT text, ReScript's
// `external`, Gleam's `@external`); the `ffi` gem is a pure *consumer*-side
// runtime library — Ruby has no calling-into-C syntax of its own, so binding
// declarations are ordinary Ruby method calls (`ffi_lib`, `attach_function`)
// evaluated at load time, not a compiler-recognized attribute/keyword.
//
// `ffi` gem API, verified 2026-08-03 against github.com/ffi/ffi's wiki (not
// carried over from memory):
//   - Basic-Usage (github.com/ffi/ffi/wiki/Basic-Usage): the canonical
//     pattern is `module Foo; extend FFI::Library; ffi_lib 'libname_or_path';
//     attach_function :symbol, [:argtype, ...], :returntype; end` — `extend
//     FFI::Library` "enables you to attach native functions to the module",
//     `ffi_lib` "specifies which C library to load", `attach_function`
//     "locates the C function in a specific external library and maps it to
//     Ruby". `attach_function` also accepts a two-name form (`attach_function
//     :ruby_name, :c_symbol, [...], :return`) when the Ruby-side method name
//     should differ from the C symbol — not used here since this projector
//     always derives both from the same ffi-ir name via the same snake_case
//     convention `rust-c-abi.ts` already uses for its Rust exports, so the two
//     names always coincide.
//   - Types (github.com/ffi/ffi/wiki/Types): confirmed type-symbol
//     vocabulary includes `:bool`, `:string`, `:pointer`, `:void`, and the
//     sized integer family `:int8`/`:uint8`/`:int16`/`:uint16`/`:int32`/
//     `:uint32`/`:int64`/`:uint64` (plus platform aliases `:int`/`:long`/
//     etc, not used here in favor of the explicitly-sized forms), and
//     `:float`/`:double` for floating point.
//   - Structs (github.com/ffi/ffi/wiki/Structs): `class Foo < FFI::Struct;
//     layout :field, :type, ...; end` for structs with known field layout —
//     NOT used for opaque handles here (see below).
//   - Pointers (github.com/ffi/ffi/wiki/Pointers): no documented
//     typedef-to-a-named-handle-type convention, and Structs' own page
//     doesn't address opaque (fields-unknown) handles either. The
//     confirmed, documented idiom for an opaque handle in both pages is a
//     bare `:pointer` used directly in `attach_function`'s type list — NOT
//     an `FFI::Struct` subclass with an empty `layout` (no such convention is
//     documented anywhere fetched; a struct's whole purpose per the Structs
//     page is exposing named fields, which an opaque handle by definition
//     has none of). This resolves the task's flagged ambiguity: bare
//     `:pointer`, not a struct wrapper.
//
// Ownership-discipline mapping (see `OwnershipDiscipline` in ./index.ts):
// unlike gleam.ts (where JS's GC means literally every discipline produces
// the same declaration) this target has ONE real branch, not zero — `"copy"`
// crosses as the value's own mapped type (`toRubyFfiType`'s base-type table
// below), because the ffi gem's type-symbol vocabulary genuinely
// distinguishes value types from `:pointer`. But `"opaque-handle"`,
// `"refcount"`, and `"resource"` (own/borrow) all collapse to the exact same
// `:pointer` declaration as each other: the `ffi` gem's type vocabulary (see
// Types above) has no ownership-aware pointer variant — refcounting and
// WIT-style own/borrow are memory-management PROTOCOLS a caller or generated
// wrapper follows on top of a plain pointer, not something `attach_function`'s
// type-symbol list itself distinguishes. So this is the "declaration is
// identical regardless of discipline" case for three of the four, not a
// throw — there is no unsupported case here at all, since every discipline
// maps onto something the gem can genuinely express (unlike rust-c-abi.ts, which
// throws for refcount/resource because plain C itself has no refcounting or
// lend-count runtime).
//
// Resource -> free function: since this projector's stated purpose is
// calling into a rust-c-abi.ts-produced shared library specifically, it mirrors
// that file's own `<resource>_free` naming convention (see rust-c-abi.ts's
// `buildFreeFunction`/`buildResource`) by attaching that same paired free
// function as an ordinary `attach_function` alongside the resource's own
// methods — the Ruby-side counterpart callers need to actually release a
// handle obtained from this library, not a new convention invented here.

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
}

function pascalCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("")
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function docComment(meta: Readonly<Record<string, unknown>>): string[] {
  return typeof meta.description === "string" ? [`# ${meta.description}`] : []
}

/**
 * Base (no-ownership-metadata, or `"copy"` discipline) type mapping —
 * intentionally minimal, per the task's own framing: only the type-ir kinds
 * that map onto a genuine `ffi`-gem primitive symbol. Anything structural
 * (`object`, `array`, `tuple`, `map`, `union`, `enum`, a bare unannotated
 * `ref`, ...) would require synthesizing an `FFI::Struct` subclass or a
 * richer per-shape convention this task didn't ask for, so it throws
 * explicitly rather than guessing at one — same throw-not-degrade precedent
 * `rust-c-abi.ts`/`wasm-bindgen.ts` already use for shapes/disciplines they don't
 * implement.
 */
function toBaseRubyFfiType(ref: TypeRef): string {
  const kind = ref.shape.kind
  switch (kind) {
    case "boolean":
      return ":bool"
    case "number":
      return ":double"
    case "integer":
      return ":int64"
    case "string":
      return ":string"
    case "void":
    case "null":
      return ":void"
    default:
      throw new Error(
        `toRubyFfiType: type-ir kind "${kind}" has no minimal ffi-gem type-symbol mapping — only boolean/number/integer/string/void/null are implemented ` +
          "(structural shapes would need a synthesized FFI::Struct subclass, out of scope for this minimal mapping)",
      )
  }
}

/**
 * The `ffi`-gem type symbol for one boundary position (a parameter's or
 * return's `TypeRef`), applying the ownership rule documented in the file
 * header: `"opaque-handle"`/`"refcount"`/`"resource"` all become a bare
 * `:pointer` (identical to each other — no ownership-aware pointer variant
 * exists in the gem's vocabulary); `"copy"` (or no ownership metadata at
 * all) falls through to `toBaseRubyFfiType`'s primitive mapping.
 */
export function toRubyFfiType(ref: TypeRef): string {
  const discipline = ref.meta.ownership as OwnershipDiscipline | undefined
  if (discipline !== undefined && discipline.kind !== "copy") return ":pointer"
  return toBaseRubyFfiType(ref)
}

type FfiFunctionLike = {
  readonly params: readonly { readonly name: string; readonly type: TypeRef }[]
  readonly returnType: TypeRef
}

/** One `attach_function :name, [:type, ...], :returntype` declaration.
 * `handleParam`, when given, is prepended as the receiver parameter — a
 * resource method's implicit `self`, synthesized the same way `rust-c-abi.ts`'s
 * `buildFunction` synthesizes its `handle: *mut T` parameter, since ffi-ir's
 * `method` kind names its receiver by resource name only and carries no
 * parameter of its own. Body: `attach_function` binds directly against the
 * loaded shared library — there is no Ruby-side stub body to write, unlike
 * `rust-c-abi.ts`'s `todo!()` (this file emits only the binding declaration, not
 * an implementation, since the C-ABI side already carries the implementation
 * this loader calls into). */
function buildAttachFunction(fnName: string, ref: FfiRef, shape: FfiFunctionLike, handleParam?: string): string {
  const symbol = toSnakeCase(fnName)
  const paramTypes: string[] = []
  if (handleParam !== undefined) paramTypes.push(":pointer")
  for (const p of shape.params) paramTypes.push(toRubyFfiType(p.type))

  const returnType = toRubyFfiType(shape.returnType)
  const lines: string[] = [...docComment(ref.meta)]
  lines.push(`attach_function ${quote(symbol)}, [${paramTypes.join(", ")}], ${returnType}`)
  return lines.join("\n")
}

/**
 * Resource -> its own methods plus the paired `<resource>_free` binding (see
 * file header). No `FFI::Struct` subclass is emitted for the resource itself
 * — per the verified `:pointer`-is-the-idiom finding above, an opaque
 * resource handle needs no struct wrapper; every method and the free
 * function simply take/return `:pointer` for this resource's positions.
 */
function buildResource(name: string, shape: FfiShape & { kind: "resource"; methods: Readonly<Record<string, FfiRef>> }): string {
  const resourceSnake = toSnakeCase(name)
  const decls: string[] = []

  for (const [methodName, methodRef] of Object.entries(shape.methods)) {
    const methodShape = methodRef.shape as FfiShape & { kind: "method" }
    const fnName = `${resourceSnake}_${toSnakeCase(methodName)}`
    decls.push(buildAttachFunction(fnName, methodRef, methodShape, name))
  }

  decls.push(`attach_function ${quote(`${resourceSnake}_free`)}, [:pointer], :void`)
  return decls.join("\n")
}

/**
 * Required `ffi_lib` argument — the shared library name/path `ffi_lib`
 * loads (see Basic-Usage above: `ffi_lib 'libname_or_path'`). ffi-ir's
 * schema has no field for this (deliberately target-agnostic, per
 * index.ts's file header), so this projector reads it from the module
 * `FfiRef`'s own `meta` bag under `meta.libPath` — same "open metadata bag"
 * convention `gleam.ts` already established for its own `meta.jsModule` —
 * and throws when absent rather than guessing a path (there is no
 * derivable default: a shared library's install location/name is
 * deployment-specific information no ffi-ir shape carries).
 */
function libPathOf(meta: Readonly<Record<string, unknown>>, where: string): string {
  const libPath = meta.libPath
  if (typeof libPath !== "string") {
    throw new Error(
      `toRubyFfi: "${where}" is missing required meta.libPath (the shared library name/path ffi_lib loads, e.g. "./libfoo.so" ` +
        'or "foo") — there is no derivable default, so this must be supplied explicitly on the module FfiRef\'s meta bag',
    )
  }
  return libPath
}

function buildModule(name: string, ref: FfiRef, shape: FfiShape & { kind: "module" }): string {
  const rubyName = pascalCase(name)
  const libPath = libPathOf(ref.meta, `module "${name}"`)

  const body: string[] = [`extend FFI::Library`, `ffi_lib ${quote(libPath)}`, ""]
  const decls: string[] = [
    ...Object.entries(shape.functions).map(([fnName, fnRef]) => {
      const fnShape = fnRef.shape as FfiShape & { kind: "function" }
      return buildAttachFunction(fnName, fnRef, fnShape)
    }),
    ...Object.entries(shape.resources).map(([resName, resRef]) => {
      const resShape = resRef.shape as FfiShape & { kind: "resource"; methods: Readonly<Record<string, FfiRef>> }
      return buildResource(resName, resShape)
    }),
  ]
  body.push(...decls)

  const indented = body.map((line) => (line.length === 0 ? "" : `  ${line}`))
  return [...docComment(ref.meta), `module ${rubyName}`, ...indented, "end"].join("\n")
}

/**
 * Lower one ffi-ir `FfiRef` to `ffi`-gem Ruby source.
 *   - `function` -> a single `attach_function` declaration (requires `name`,
 *     mirroring `rust-c-abi.ts`'s/`wasm-bindgen.ts`'s identical requirement — a
 *     free function's name lives as the key in the enclosing
 *     `module.functions` map, not on the shape itself). Emitted BARE (no
 *     enclosing `extend FFI::Library`/`ffi_lib`) when called directly on a
 *     `function` outside a `module` context — same as `rust-c-abi.ts`'s bare
 *     `#[no_mangle] fn`, since `attach_function` is only meaningful inside a
 *     module/class that has already called `ffi_lib`, which this projector
 *     cannot synthesize without a `meta.libPath` — call `toRubyFfi` on the
 *     enclosing `module` `FfiRef` to get a complete, loadable declaration.
 *   - `method` -> the same, plus a synthesized `:pointer` first parameter and
 *     a `<receiver>_<method>` symbol name (requires `name`, the method's own
 *     key in its resource's `methods` map) — `ffi_lib`'s ordinary
 *     `attach_function` has no receiver/method syntax of its own (verified:
 *     Basic-Usage/Structs show only flat free-function bindings), so a
 *     method degrades to a free function taking the handle explicitly, the
 *     same flattening `rust-c-abi.ts` already does for the same reason.
 *   - `resource` -> its methods plus the paired `<resource>_free` binding
 *     (`name` argument, if given, is ignored — the shape carries its own
 *     `name` field, matching `rust-c-abi.ts`'s identical behavior).
 *   - `module` -> a `module Name; extend FFI::Library; ffi_lib '...'; ...;
 *     end` block (requires `meta.libPath` on the module `FfiRef` — see
 *     `libPathOf`).
 *
 * No ownership discipline causes a throw for this target (see file header):
 * `"copy"`/absent-metadata uses the base type mapping, and
 * `"opaque-handle"`/`"refcount"`/`"resource"` all become `:pointer` — every
 * discipline maps onto something the `ffi` gem can genuinely express.
 */
export function toRubyFfi(ref: FfiRef, name?: string): string {
  const kind = ref.shape.kind

  if (kind === "function") {
    if (name === undefined) {
      throw new Error('toRubyFfi: "function" requires a name — an attach_function binding is always a named declaration, not an anonymous inline type')
    }
    const shape = ref.shape as FfiShape & { kind: "function" }
    return buildAttachFunction(name, ref, shape)
  }

  if (kind === "method") {
    if (name === undefined) {
      throw new Error('toRubyFfi: "method" requires a name — the method\'s own key in its resource\'s methods map')
    }
    const shape = ref.shape as FfiShape & { kind: "method" }
    const fnName = `${toSnakeCase(shape.receiver)}_${toSnakeCase(name)}`
    return buildAttachFunction(fnName, ref, shape, shape.receiver)
  }

  if (kind === "resource") {
    const shape = ref.shape as FfiShape & { kind: "resource"; name: string; methods: Readonly<Record<string, FfiRef>> }
    return buildResource(shape.name, shape)
  }

  if (kind === "module") {
    if (name === undefined) {
      throw new Error('toRubyFfi: "module" requires a name — a Ruby module declaration is always named')
    }
    const shape = ref.shape as FfiShape & {
      kind: "module"
      name: string
      functions: Readonly<Record<string, FfiRef>>
      resources: Readonly<Record<string, FfiRef>>
    }
    return buildModule(name, ref, shape)
  }

  throw new Error(`toRubyFfi: unhandled ffi-ir kind "${kind}" — no ffi-gem mapping implemented for this backend`)
}
