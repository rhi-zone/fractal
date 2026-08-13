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
// module/function/resource/ownership-discipline shapes — layered ON TOP of
// type-ir's `wasm-bindgen.ts` (data-shape-only: primitives/structs/fieldless
// enums/plain functions, throws on union/map/tuple/intersection/interface/
// method-with-receiver/never). That file is NOT modified here; this file
// imports and calls into its exported `toWasmBindgen`/`toWasmBindgenType` for
// every data-shape position (params, return types, hoisted struct/enum
// declarations) rather than reimplementing type mapping, and adds only what
// ffi-ir carries that type-ir doesn't: function/module boundaries, resource
// declarations, and ownership-discipline-aware handling.
//
// Target-discipline scope, confirmed against
// docs/design/ffi-ir-architecture-options.md's Fork C "discipline-per-target:
// decided" section (2026-08-03): JS/wasm-bindgen implements exactly two of
// the four disciplines `OwnershipDiscipline` can express —
//   - `"copy"` — already how `wasm-bindgen.ts` works today (`Clone` +
//     `getter_with_clone`); reused directly here for resources too.
//   - `"refcount"` — NEW in this file: an `Arc<...>`-wrapped struct. See the
//     "FinalizationRegistry, verified" comment on `buildRefcountResource`
//     below for what was confirmed about wasm-bindgen's own free()/weak-refs
//     machinery and why no custom JS glue is emitted.
// `"opaque-handle"` (no native manual-free idiom in JS — refcount already
// covers shared ownership) and `"resource"`/own-borrow (no host runtime JS
// can enforce lend-count-and-trap against) are explicitly NOT implemented —
// `requireSupportedOwnership` throws for both, matching the
// throw-on-unsupported convention `wasm-bindgen.ts` already uses for type-ir
// kinds it can't realize, rather than approximating either discipline.

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
 * target's boundary (a parameter's type or a return type) — throws for the
 * two disciplines JS/wasm-bindgen has no native mechanism for
 * (`opaque-handle`, `resource`), matching the exact per-target scope decided
 * in Fork C above. `"copy"` and `"refcount"` (and no `meta.ownership` at all,
 * which defaults to copy-by-value the same way the underlying type-ir
 * projector already treats an unannotated value) pass through unchanged —
 * this function only gates, it doesn't transform.
 *
 * Scope note: this checks the TypeRef handed to it directly (a param's
 * `.type`, a `returnType`), not a deep recursive walk into e.g. an object
 * shape's own field TypeRefs — `wasm-bindgen.ts`'s `bareType`/`buildStruct`
 * (where that recursion happens) are not exported from that file, so a field
 * carrying its own `meta.ownership` inside a struct is not independently
 * gated here. In practice this matches how the existing data-shape projector
 * already treats struct fields (plain data, no ownership concept crosses
 * struct field boundaries in wasm-bindgen's ABI) — ownership discipline is
 * conventionally attached at parameter/return/resource-reference positions
 * (see `@rhi-zone/fractal-ffi-ir`'s own doc comment on `withOwnership`), not
 * on arbitrary nested fields.
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

/** Builds a synthetic type-ir `function` `TypeRef` from ffi-ir params/return —
 * ffi-ir's `FfiParam`/`function`/`method` shapes are structurally identical
 * to type-ir's own `function` kind (same `{ name, type }[]` params +
 * `returnType`, minus `thisType`/`receiver`), so this is a faithful
 * reconstruction, not an approximation — letting `toWasmBindgen` (imported,
 * unmodified) do 100% of the actual signature/hoisting/doc-comment/rename
 * work for both `function` and `method` (methods get their receiver spliced
 * in afterward — see `buildMethod`).
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
 * signature and wraps the result in an `impl Receiver { ... }` block. String
 * manipulation, not re-derivation: `wasm-bindgen.ts` doesn't export its
 * internal `buildFunction`/`bareType`, so this is the only reuse path that
 * doesn't reimplement type mapping or struct-hoisting from scratch.
 *
 * Receiver mutability judgment call: methods are spliced with `&self`
 * (shared reference), never `&mut self` — ffi-ir's `FfiKinds.method` carries
 * no mutability signal (no field on `FfiParam`/`method` distinguishes a
 * read from a write), so there is no schema-driven way to pick `&mut self`
 * for some methods and `&self` for others. `&self` is the safer default
 * (compiles for both read-only and, via the refcount resource's `Arc`
 * without interior mutability, for shared-but-immutable access); a method
 * that genuinely needs mutation requires the resource's backing data to be
 * wrapped in `Mutex`/`RwLock` by hand and its emitted method body edited
 * accordingly — this projector does not infer that need. Named explicitly
 * here as a judgment call, same as `buildRefcountResource`'s Arc-vs-
 * Arc<Mutex<_>> call below.
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
 * `copy`-discipline resource -> the existing wasm-bindgen.ts struct pattern
 * (`#[derive(Clone)]`), reused by name only (not re-derived) since ffi-ir's
 * `resource` kind — per its own doc comment in `index.ts` ("a resource
 * exposes behavior only through its methods map... mirroring WIT's own
 * constraint that resources 'cannot be plain data structures'") — carries no
 * field/data shape at all, unlike an `object` TypeRef. The generated struct
 * is therefore intentionally fieldless: its private Rust-side storage is
 * implementation detail outside ffi-ir's boundary contract (the same
 * "signature is the contract, body is a stub" precedent `wasm-bindgen.ts`'s
 * own `todo!()` function bodies already establish for behavior). No
 * `getter_with_clone` attribute is emitted since it only matters for
 * non-Copy fields and there are no fields.
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
 * `refcount`-discipline resource -> NEW. Emits a struct wrapping the
 * resource's (implementation-internal, per the same fieldless reasoning as
 * `buildCopyResource`) data in `Arc<NameData>`, an explicit `share()` method
 * (`Arc::clone`, the increment path — JS callers that want a second owning
 * handle to the same underlying value call this rather than any implicit
 * copy), and relies on wasm-bindgen's own generated `free()` for the
 * decrement path (dropping the struct drops its `Arc` field, decrementing
 * the strong count via `Arc`'s own `Drop` impl — ordinary Rust semantics,
 * nothing custom needed there).
 *
 * FinalizationRegistry, verified (WebFetch against
 * rustwasm.github.io/docs/wasm-bindgen's "Support for Weak References" page,
 * 2026-08-03): wasm-bindgen already auto-generates a `.free()` method for
 * every `#[wasm_bindgen]`-exported struct, AND — since the TC39 weak-refs
 * proposal shipped — "by default wasm-bindgen does use the TC39 weak
 * references proposal if support is detected" (all major browsers do),
 * pairing that generated `free()` with a wasm-bindgen-internal
 * `FinalizationRegistry` automatically, with no `--weak-refs` flag or Cargo
 * feature required. This means the task's initially assumed shape
 * ("wasm-bindgen doesn't auto-generate FinalizationRegistry wiring... needs
 * Rust-side release fn AND JS-side glue") does not hold for the
 * already-shipped struct-free path — no custom Rust release function
 * distinct from the default `free()`, and no hand-written JS
 * `FinalizationRegistry` snippet, is needed to get the Arc decremented when
 * the JS-side handle is GC'd.
 * What IS still worth emitting (and is emitted, as a comment on the struct)
 * is the caveat the same research surfaced: automatic GC-driven cleanup is
 * non-deterministic and — per a still-open wasm-bindgen issue (#3917) —
 * does not run at all in fully synchronous code, so a JS caller wanting
 * deterministic release should call the generated `.free()` explicitly
 * rather than rely solely on GC.
 *
 * Arc vs. Arc<Mutex<_>>, judgment call: plain `Arc<NameData>` (no interior
 * mutability) is emitted, not `Arc<Mutex<NameData>>`. ffi-ir's `method` kind
 * carries no mutability signal to decide this from (same gap noted on
 * `buildMethod`'s `&self`-only splice above) — `Arc<Mutex<_>>` would be a
 * defensible alternative if any of the resource's methods need to mutate
 * shared state, at the cost of lock overhead/deadlock risk for methods that
 * don't. Named explicitly rather than guessed; a caller whose resource
 * methods need mutation should change `Arc<NameData>` to
 * `Arc<Mutex<NameData>>` (and thread `.lock()` calls through the generated
 * method bodies) by hand.
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

/** Module -> groups its functions/resources into a `pub mod name { ... }` —
 * wasm-bindgen has no dedicated module-scoping attribute of its own;
 * `#[wasm_bindgen]` items work unmodified inside an ordinary Rust `mod`
 * block (confirmed by the guide's own multi-file examples nesting exports
 * under plain Rust modules), so this is the direct, unsurprising mapping. */
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
