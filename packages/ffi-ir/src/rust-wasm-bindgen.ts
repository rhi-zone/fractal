import { t, type TypeRef } from "@rhi-zone/fractal-type-ir";
// Side-effect import: registers type-ir's extension kinds (incl. "bytes")
// into the shared `TypeKinds` interface via declaration merging. Required
// here because `wasm-bindgen.ts` below references `TypeShape`'s "bytes"
// member (in its own `vecElementType` handling) but this package's tsc
// program doesn't otherwise reach `kinds/bytes.ts` through any import
// edge — type-ir's own `wasm-bindgen.test.ts` establishes the same
// convention for the same reason (see `@rhi-zone/fractal-type-ir/kinds/common`).
import "@rhi-zone/fractal-type-ir/kinds/common";
import { toWasmBindgen, toWasmBindgenType } from "@rhi-zone/fractal-type-ir/rust-wasm-bindgen";
import { ancestors, type FfiParam, type FfiRef, type FfiShape } from "./index.ts";

// Rust codegen targeting wasm-bindgen for ffi-ir's boundary layer —
// module/function/resource/ownership-discipline shapes — layered on top of
// type-ir's `wasm-bindgen.ts` (data-shape-only: primitives/structs/fieldless
// enums/plain functions, throws on union/map/tuple/intersection/interface/
// method-with-receiver/never). That file is unmodified; this one imports and
// calls into its exported `toWasmBindgen`/`toWasmBindgenType` for every
// data-shape position (params, return types, hoisted struct/enum
// declarations) and adds only what ffi-ir carries that type-ir doesn't:
// function/module boundaries, resource declarations, and
// ownership-discipline-aware handling.
//
// Per docs/design/ffi-ir-architecture-options.md's Fork C
// "discipline-per-target: decided" section, JS/wasm-bindgen implements two
// of the four disciplines `OwnershipDiscipline` can express:
//   - `"copy"` — `wasm-bindgen.ts`'s existing `Clone` + `getter_with_clone`
//     pattern, reused directly here for resources too.
//   - `"refcount"` — an `Arc<...>`-wrapped struct. See the doc comment on
//     `buildRefcountResource` for how it interacts with wasm-bindgen's
//     generated `free()`/weak-refs machinery.
// `"opaque-handle"` (no native manual-free idiom in JS; refcount already
// covers shared ownership) and `"resource"`/own-borrow (no host runtime in
// JS enforces lend-count-and-trap semantics) are not implemented —
// `requireSupportedOwnership` throws for both, matching the
// throw-on-unsupported convention `wasm-bindgen.ts` already uses for type-ir
// kinds it can't realize.

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function indent(block: string, prefix = "    "): string {
  return block
    .split("\n")
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join("\n");
}

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target);
}

/**
 * Ownership-discipline gate for a single type-ir `TypeRef` crossing this
 * target's boundary (a parameter's type or a return type). Throws for the
 * two disciplines JS/wasm-bindgen has no native mechanism for
 * (`opaque-handle`, `resource`), per the per-target scope in Fork C above.
 * `"copy"` and `"refcount"` (and no `meta.ownership` at all, which defaults
 * to copy-by-value the same way the underlying type-ir projector treats an
 * unannotated value) pass through unchanged; this function gates, it doesn't
 * transform.
 *
 * Checks the TypeRef handed to it directly (a param's `.type`, a
 * `returnType`), not a recursive walk into e.g. an object shape's own field
 * TypeRefs — `wasm-bindgen.ts`'s `bareType`/`buildStruct`, where that
 * recursion happens, aren't exported from that file, so a field carrying its
 * own `meta.ownership` inside a struct isn't independently gated here.
 * Ownership discipline is conventionally attached at parameter/return/
 * resource-reference positions (see `@rhi-zone/fractal-ffi-ir`'s doc comment
 * on `withOwnership`), not on nested fields.
 */
function requireSupportedOwnership(ref: TypeRef, where: string): void {
  const discipline = ref.meta.ownership as { readonly kind: string } | undefined;
  if (discipline === undefined) return;
  if (discipline.kind === "opaque-handle" || discipline.kind === "resource") {
    throw new Error(
      `toWasmBindgenFfi: unsupported ownership discipline "${discipline.kind}" for wasm-bindgen/JS target at ${where} — ` +
        (discipline.kind === "opaque-handle"
          ? "JS has no native manual-free idiom; if shared ownership is needed, use ownership.refcount() instead"
          : "no host runtime exists in JS to enforce WIT-style lend-count-and-trap semantics") +
        '. Per docs/design/ffi-ir-architecture-options.md Fork C "discipline-per-target: decided", ' +
        'JS/wasm-bindgen implements only "copy" and "refcount" — project this value to a target that ' +
        "natively supports this discipline instead (C for opaque-handle+free-fn, WIT for resource+own/borrow).",
    );
  }
}

/** Builds a synthetic type-ir `function` `TypeRef` from ffi-ir params/return.
 * ffi-ir's `FfiParam`/`function`/`method` shapes are structurally identical
 * to type-ir's own `function` kind (same `{ name, type }[]` params +
 * `returnType`, minus `thisType`/`receiver`), so the reconstruction lets
 * `toWasmBindgen` (imported, unmodified) do the actual signature/hoisting/
 * doc-comment/rename work for both `function` and `method` (methods get
 * their receiver spliced in afterward — see `buildMethod`).
 */
function syntheticFunctionRef(
  params: readonly FfiParam[],
  returnType: TypeRef,
  meta: Readonly<Record<string, unknown>>,
): TypeRef {
  for (const p of params) requireSupportedOwnership(p.type, `parameter "${p.name}"`);
  requireSupportedOwnership(returnType, "return type");
  return t(
    { kind: "function", params: params.map((p) => ({ name: p.name, type: p.type })), returnType },
    meta,
  ) as TypeRef;
}

/** Free function -> delegates entirely to `toWasmBindgen` (imported from
 * type-ir's unmodified `wasm-bindgen.ts`) via a reconstructed type-ir
 * `function` TypeRef (see `syntheticFunctionRef`). */
function buildFunction(
  name: string,
  shape: FfiShape & { kind: "function" },
  meta: Readonly<Record<string, unknown>>,
): string {
  const ref = syntheticFunctionRef(shape.params, shape.returnType, meta);
  return toWasmBindgen(ref, name);
}

/**
 * Method -> reuses `toWasmBindgen`'s free-function emission (decls,
 * `todo!()` stub, `js_name` renaming, doc comments — everything
 * `buildFunction` in `wasm-bindgen.ts` does) via the same synthetic-ref
 * reconstruction, then splices a `&self` receiver into the generated
 * signature and wraps the result in an `impl Receiver { ... }` block.
 * `wasm-bindgen.ts` doesn't export its internal `buildFunction`/`bareType`,
 * so string manipulation on the rendered output is the reuse path here.
 *
 * Methods are spliced with `&self` (shared reference), never `&mut self`.
 * ffi-ir's `FfiKinds.method` carries no mutability signal (no field on
 * `FfiParam`/`method` distinguishes a read from a write), so there is no
 * schema-driven way to pick `&mut self` for some methods and `&self` for
 * others. `&self` compiles for both read-only access and, via the refcount
 * resource's `Arc` without interior mutability, shared-but-immutable access.
 * A method that needs mutation requires the resource's backing data to be
 * wrapped in `Mutex`/`RwLock` by hand and its emitted method body edited
 * accordingly — this projector does not infer that need (same judgment call
 * as `buildRefcountResource`'s Arc-vs-Arc<Mutex<_>> choice below).
 */
function buildMethod(
  name: string,
  shape: FfiShape & { kind: "method" },
  meta: Readonly<Record<string, unknown>>,
): string {
  const ref = syntheticFunctionRef(shape.params, shape.returnType, meta);
  const rendered = toWasmBindgen(ref, name);
  const withReceiver = rendered.replace(
    /pub fn (\w+)\(/,
    shape.params.length === 0 ? "pub fn $1(&self" : "pub fn $1(&self, ",
  );
  return withReceiver;
}

/**
 * `copy`-discipline resource -> the same `#[derive(Clone)]` struct pattern
 * `wasm-bindgen.ts` uses, applied to a fieldless struct: ffi-ir's `resource`
 * kind — per its own doc comment in `index.ts` ("a resource exposes
 * behavior only through its methods map... mirroring WIT's own constraint
 * that resources 'cannot be plain data structures'") — carries no
 * field/data shape at all, unlike an `object` TypeRef. The struct's private
 * Rust-side storage is implementation detail outside ffi-ir's boundary
 * contract, the same "signature is the contract, body is a stub" precedent
 * `wasm-bindgen.ts`'s own `todo!()` function bodies establish for behavior.
 * No `getter_with_clone` attribute is emitted since it only matters for
 * non-Copy fields and there are none.
 */
function buildCopyResource(
  name: string,
  shape: FfiShape & { kind: "resource" },
  meta: Readonly<Record<string, unknown>>,
): string {
  const description = typeof meta.description === "string" ? [`/// ${meta.description}`] : [];
  const structLines = [
    ...description,
    "// Fields are implementation-internal — ffi-ir's `resource` kind models",
    "// only the boundary's method surface, not private storage (see the",
    "// FfiKinds.resource doc comment in @rhi-zone/fractal-ffi-ir). Fill in",
    "// the actual fields this resource wraps.",
    "#[derive(Clone)]",
    "#[wasm_bindgen]",
    `pub struct ${name} {}`,
  ];
  const methods = Object.entries(shape.methods).map(([methodName, methodRef]) =>
    buildResourceMethod(methodName, methodRef),
  );
  const implBlock = [
    `#[wasm_bindgen]`,
    `impl ${name} {`,
    ...methods.map((m) => indent(m)),
    "}",
  ].join("\n");
  return [structLines.join("\n"), implBlock].join("\n\n");
}

/**
 * `refcount`-discipline resource. Emits a struct wrapping the resource's
 * (implementation-internal, per the same fieldless reasoning as
 * `buildCopyResource`) data in `Arc<NameData>`, an explicit `share()` method
 * (`Arc::clone` — the increment path; JS callers that want a second owning
 * handle to the same underlying value call this rather than relying on any
 * implicit copy), and wasm-bindgen's own generated `free()` for the
 * decrement path: dropping the struct drops its `Arc` field, decrementing
 * the strong count via `Arc`'s own `Drop` impl.
 *
 * wasm-bindgen auto-generates a `.free()` method for every
 * `#[wasm_bindgen]`-exported struct and, by default, pairs it with a
 * wasm-bindgen-internal `FinalizationRegistry` when the TC39 weak
 * references proposal is supported (all major browsers), with no
 * `--weak-refs` flag or Cargo feature required — no custom Rust release
 * function and no hand-written JS `FinalizationRegistry` glue is needed to
 * decrement the Arc when the JS-side handle is GC'd. Automatic GC-driven
 * cleanup is non-deterministic and, per wasm-bindgen issue #3917, does not
 * run in fully synchronous code — the struct carries a comment noting that a
 * JS caller wanting deterministic release should call the generated
 * `.free()` explicitly.
 *
 * Plain `Arc<NameData>` (no interior mutability) is emitted, not
 * `Arc<Mutex<NameData>>`. ffi-ir's `method` kind carries no mutability
 * signal to decide this from (same gap as `buildMethod`'s `&self`-only
 * splice above). `Arc<Mutex<_>>` is the alternative if any of the
 * resource's methods need to mutate shared state, at the cost of lock
 * overhead/deadlock risk for methods that don't; a caller whose resource
 * methods need mutation changes `Arc<NameData>` to `Arc<Mutex<NameData>>`
 * (and threads `.lock()` calls through the generated method bodies) by
 * hand.
 */
function buildRefcountResource(
  name: string,
  shape: FfiShape & { kind: "resource" },
  meta: Readonly<Record<string, unknown>>,
): string {
  const description = typeof meta.description === "string" ? [`/// ${meta.description}`] : [];
  const dataName = `${name}Data`;
  const dataStruct = [
    "// Fields are implementation-internal — ffi-ir's `resource` kind models",
    "// only the boundary's method surface, not private storage (see the",
    "// FfiKinds.resource doc comment in @rhi-zone/fractal-ffi-ir). Fill in",
    "// the actual fields this resource wraps.",
    `struct ${dataName} {}`,
  ].join("\n");
  const structLines = [
    ...description,
    "// Shared ownership via Arc — wasm-bindgen already generates a `free()`",
    "// for this struct and (per the TC39 weak-references proposal, on by",
    "// default when the JS runtime supports it) pairs it with its own",
    "// FinalizationRegistry, so dropping the last JS-side handle decrements",
    "// this Arc automatically. GC timing is non-deterministic and does not",
    "// run in fully synchronous code (wasm-bindgen#3917) — call `.free()`",
    "// explicitly from JS when deterministic release matters.",
    "#[wasm_bindgen]",
    `pub struct ${name} {`,
    `    inner: std::sync::Arc<${dataName}>,`,
    "}",
  ];
  const shareMethod = [
    "/// Returns a new handle sharing ownership of the same underlying value",
    "/// (increments the refcount — the explicit share path for this",
    "/// discipline; there is no implicit/automatic clone across the JS",
    "/// boundary).",
    "#[wasm_bindgen]",
    "pub fn share(&self) -> Self {",
    `    Self { inner: std::sync::Arc::clone(&self.inner) }`,
    "}",
  ].join("\n");
  const methods = Object.entries(shape.methods).map(([methodName, methodRef]) =>
    buildResourceMethod(methodName, methodRef),
  );
  const implBlock = [
    `#[wasm_bindgen]`,
    `impl ${name} {`,
    indent(shareMethod),
    ...methods.map((m) => indent(m)),
    "}",
  ].join("\n");
  return [dataStruct, structLines.join("\n"), implBlock].join("\n\n");
}

function buildResourceMethod(methodName: string, methodRef: FfiRef): string {
  const kind = methodRef.shape.kind;
  if (kind !== "method" && kind !== "function") {
    throw new Error(
      `toWasmBindgenFfi: resource method "${methodName}" has unexpected kind "${kind}" (expected "method")`,
    );
  }
  const shape = methodRef.shape as FfiShape & {
    kind: "method";
    params: readonly FfiParam[];
    returnType: TypeRef;
  };
  return buildMethod(methodName, { ...shape, kind: "method" }, methodRef.meta);
}

/** Resource dispatch by ownership discipline. `meta.ownership` on the
 * resource's own `FfiRef` (not a reference to it) names which discipline
 * this declaration itself is emitted under — `"copy"` is the default when
 * unset, matching `wasm-bindgen.ts`'s existing copy-by-default behavior. */
function buildResource(
  name: string,
  shape: FfiShape & { kind: "resource" },
  meta: Readonly<Record<string, unknown>>,
): string {
  const discipline = (meta.ownership as { readonly kind: string } | undefined)?.kind ?? "copy";
  if (discipline === "copy") return buildCopyResource(name, shape, meta);
  if (discipline === "refcount") return buildRefcountResource(name, shape, meta);
  throw new Error(
    `toWasmBindgenFfi: unsupported ownership discipline "${discipline}" for wasm-bindgen/JS target on resource "${name}" — ` +
      'JS/wasm-bindgen implements only "copy" and "refcount" for resource declarations (see the file-level doc comment)',
  );
}

/** Module -> groups its functions/resources into a `pub mod name { ... }`.
 * wasm-bindgen has no dedicated module-scoping attribute of its own;
 * `#[wasm_bindgen]` items work unmodified inside an ordinary Rust `mod`
 * block, per the guide's own multi-file examples nesting exports under
 * plain Rust modules. */
function buildModule(name: string, shape: FfiShape & { kind: "module" }): string {
  const functionDecls = Object.entries(shape.functions).map(([fnName, fnRef]) =>
    toWasmBindgenFfi(fnRef, fnName),
  );
  const resourceDecls = Object.entries(shape.resources).map(([resName, resRef]) =>
    toWasmBindgenFfi(resRef, resName),
  );
  const body = [...resourceDecls, ...functionDecls].join("\n\n");
  return [
    `pub mod ${toSnakeCase(name)} {`,
    "    use wasm_bindgen::prelude::*;",
    "",
    indent(body),
    "}",
  ].join("\n");
}

/**
 * Lower an ffi-ir `FfiRef` to `#[wasm_bindgen]`-annotated Rust source.
 * `name` is required for `function`/`method`/`resource` (all are named
 * top-level/impl-scoped declarations, mirroring `toWasmBindgen`'s own
 * "wasm-bindgen exports are named JS bindings, not anonymous inline types"
 * requirement) and for `module` (the `pub mod` name). Throws — rather than
 * degrading — for ownership disciplines this target has no native mechanism
 * for (`opaque-handle`, `resource`/own-borrow); see `requireSupportedOwnership`
 * and `buildResource`.
 */
export function toWasmBindgenFfi(ref: FfiRef, name?: string): string {
  const kind = ref.shape.kind;

  if (name === undefined) {
    throw new Error(
      `toWasmBindgenFfi: "${kind}" requires a name — wasm-bindgen exports are named JS bindings/modules, not anonymous inline declarations`,
    );
  }

  if (kind === "function") {
    return buildFunction(name, ref.shape as FfiShape & { kind: "function" }, ref.meta);
  }
  if (kind === "method") {
    return buildMethod(name, ref.shape as FfiShape & { kind: "method" }, ref.meta);
  }
  if (kind === "resource") {
    return buildResource(name, ref.shape as FfiShape & { kind: "resource" }, ref.meta);
  }
  if (kind === "module") {
    return buildModule(name, ref.shape as FfiShape & { kind: "module" });
  }
  if (isA(kind, "function")) {
    // A consumer-registered kind whose nearest ancestor is "function" (e.g.
    // ffi-ir's own registerParent-extension mechanism) falls back to the
    // free-function path, mirroring index.ts's method->function ancestry.
    return buildFunction(name, ref.shape as FfiShape & { kind: "function" }, ref.meta);
  }
  throw new Error(
    `toWasmBindgenFfi: unhandled ffi-ir kind "${kind}" (no handler and no known ancestor)`,
  );
}

export { toWasmBindgenType };
