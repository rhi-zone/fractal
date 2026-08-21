import { t, type TypeRef } from "@rhi-zone/fractal-type-ir";
import { toReScriptType } from "@rhi-zone/fractal-type-ir/rescript";
import { ancestors, type FfiParam, type FfiRef, type FfiShape } from "./index.ts";

// ReScript codegen for ffi-ir's boundary layer — module/function/method/
// resource/ownership-discipline shapes — targeting ReScript's `external`
// declaration syntax for binding to JS
// (https://v11.rescript-lang.org/docs/manual/v11.0.0/bind-to-js-function,
// https://v11.rescript-lang.org/docs/manual/v11.0.0/bind-to-js-object).
// This is the direct structural sibling of `wasm-bindgen.ts` (which generates
// the `#[wasm_bindgen]` annotations a human would otherwise hand-write for
// the Rust/JS boundary): this file generates the
// `external`/`@module`/`@val`/`@send`/`@new` declarations a ReScript
// developer would otherwise hand-write for the ReScript/JS boundary.
//
// Per the manual (both pages above):
//   - `@module("name") external x: T = "jsName"` — binds a named export of a
//     JS module.
//   - `@val external x: T = "jsName"` — binds a global JS value/function (no
//     enclosing module).
//   - `@send external f: (t, ...params) => ret = "jsMethodName"` — calls a
//     method on a JS value; the receiver is the function type's first
//     positional parameter, not a special calling form.
//   - `@new external make: (...params) => t = "JsClassName"` — constructs via
//     JS's `new`; combines with `@module` for a class exported from a module.
//   - `@get`/`@set` (property read/write) and `@get_index`/`@set_index`
//     (indexed access) also exist but have no counterpart in ffi-ir's current
//     kind vocabulary (`function`/`method`/`resource`/`module` only — no
//     "property" kind), so they are not emitted here; see the file-level note
//     on `resource` below.
//   - Opaque JS object type: `type t` with no definition, the manual's own
//     documented idiom for "this type exists in JS, structure not modeled."
//
// Type-shape reuse: every parameter/return-type position is rendered via
// type-ir's already-merged `toReScriptType` (`@rhi-zone/fractal-type-ir/rescript`),
// not reimplemented — mirroring `wasm-bindgen.ts`'s reuse of `toWasmBindgen`/
// `toWasmBindgenType` from type-ir's own wasm-bindgen projector. In particular,
// a `method`'s receiver is expressed by constructing a synthetic type-ir
// `function` TypeRef with `thisType` set to a `ref` TypeRef naming the
// receiver resource — type-ir's `rescript-native.ts` `function` handler
// already prepends `thisType` as a leading positional parameter (the same
// convention it uses for TypeScript/Flow `this` parameters), which is exactly
// ReScript's own "@send takes the receiver as its first parameter" shape.
// This is a closer structural match than `wasm-bindgen.ts` gets from Rust's
// `toWasmBindgen` (which has no `this`-splicing at all, forcing that file
// into a regex string-splice).
//
// Ownership: JS/ReScript's FFI docs say nothing about ownership discipline at
// all (both sides are garbage-collected; `external` bindings are plain type
// signatures with no lifetime/ownership annotation anywhere in the syntax
// verified above). This target does not force an artificial ownership
// mapping: every `OwnershipDiscipline` — `copy`, `opaque-handle`, `refcount`,
// `resource` — is treated identically, as just a reference/value crossing the
// boundary, and none of them gates or throws (contrast `wasm-bindgen.ts`'s
// `requireSupportedOwnership`, which throws for two of the four disciplines
// it can't realize in Rust). `"copy"` on a `TypeRef` whose shape is already a
// ReScript-native by-value primitive (`bool`/`float`/`int`/`string`) needs no
// special handling either — those types are already immutable values in both
// JS and ReScript, so "copy discipline" and "no discipline at all" render
// identically.
//
// Naming — function vs. global binding: ffi-ir's `FfiKinds.function` carries
// no field saying where in JS the function lives (a module export vs. a
// global). The enclosing `FfiKinds.module`'s `name` is the only place that
// information could come from, and only when a function is actually reached
// through a module's `functions` map. When `toReScriptFfi` lowers a
// function/method as part of a `module` (via `buildModule`, threading the
// module's `name` down), it emits `@module(moduleName)` — never `@val` —
// even though the schema can't truly distinguish "this JS module export"
// from "this is secretly a global"; `@module` is the default there. When
// `toReScriptFfi` is called directly on a bare `function`/`method` `FfiRef`
// with no enclosing module context at all (no name to put in `@module(...)`),
// there is nothing to reference, so it falls back to `@val` — the only
// attribute that needs no module name.

function toPascalCase(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w.length > 0);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
}

function decapitalize(name: string): string {
  return name.length === 0 ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

// ReScript reserved words that cannot be used as an `external`'s binding
// identifier (the left-hand name) — mirrors type-ir's `rescript-native.ts`
// RESERVED set, duplicated here because that file doesn't export its set
// (unlike `codegen-helpers.ts`'s helpers, which this package now imports
// directly via `@rhi-zone/fractal-type-ir/codegen-helpers`).
const RESERVED = new Set([
  "and",
  "as",
  "assert",
  "constraint",
  "else",
  "exception",
  "external",
  "false",
  "for",
  "fun",
  "function",
  "functor",
  "if",
  "in",
  "include",
  "inherit",
  "initializer",
  "lazy",
  "let",
  "module",
  "mutable",
  "new",
  "of",
  "open",
  "or",
  "private",
  "rec",
  "sig",
  "struct",
  "then",
  "to",
  "true",
  "try",
  "type",
  "val",
  "virtual",
  "when",
  "while",
  "with",
  "switch",
]);

/** A valid ReScript lowercase-leading identifier for `name`, used as the
 * left-hand binding identifier of an `external` declaration — the JS-side
 * name (right-hand string literal) is untouched, since `external x: T =
 * "actualName"` already separates "what ReScript calls it" from "what JS
 * calls it" (unlike a struct field label, no `@as`-style attribute is needed
 * here — the string literal already is that mechanism). */
function externalIdent(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, "_");
  const lowered = /^[A-Z]/.test(cleaned) ? decapitalize(cleaned) : cleaned;
  const based = /^[a-z_]/.test(lowered) && lowered.length > 0 ? lowered : `_${lowered}`;
  return RESERVED.has(based) ? `${based}_` : based;
}

function indent(block: string, prefix = "  "): string {
  return block
    .split("\n")
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join("\n");
}

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target);
}

function docComment(meta: Readonly<Record<string, unknown>>): string {
  const description = typeof meta.description === "string" ? meta.description : undefined;
  return description === undefined ? "" : `/** ${description} */\n`;
}

function deprecatedAttr(meta: Readonly<Record<string, unknown>>): string {
  const deprecated = meta.deprecated;
  if (deprecated === true) return "@deprecated\n";
  if (typeof deprecated === "string") return `@deprecated(${JSON.stringify(deprecated)})\n`;
  return "";
}

/** Builds a synthetic type-ir `function` TypeRef from ffi-ir params/return
 * (+ optional receiver as `thisType`) so `toReScriptType` — imported,
 * unmodified from type-ir's already-merged ReScript projector — does 100% of
 * the actual signature rendering, including prepending the receiver as a
 * leading positional parameter for methods. Mirrors `wasm-bindgen.ts`'s
 * `syntheticFunctionRef`. */
function syntheticFunctionRef(
  params: readonly FfiParam[],
  returnType: TypeRef,
  receiver?: string,
): TypeRef {
  const thisType: TypeRef | undefined =
    receiver === undefined ? undefined : { shape: { kind: "ref", target: receiver }, meta: {} };
  return t(
    {
      kind: "function",
      params: params.map((p) => ({ name: p.name, type: p.type })),
      returnType,
      ...(thisType === undefined ? {} : { thisType }),
    },
    {},
  ) as TypeRef;
}

/** Free function -> `@module`/`@val` external, per the file-level "Naming —
 * function vs. global binding" note above. `moduleName`, when given, is the
 * enclosing `FfiKinds.module`'s raw JS name (passed through to `@module(...)`
 * verbatim, not PascalCased — that's a JS module specifier / npm package /
 * relative path string, not a ReScript identifier). */
function buildFunction(
  name: string,
  shape: FfiShape & { kind: "function" },
  meta: Readonly<Record<string, unknown>>,
  moduleName?: string,
): string {
  const ref = syntheticFunctionRef(shape.params, shape.returnType);
  const signature = toReScriptType(ref);
  const ident = externalIdent(name);
  const attr = moduleName === undefined ? "@val" : `@module(${JSON.stringify(moduleName)})`;
  return `${docComment(meta)}${deprecatedAttr(meta)}${attr}\nexternal ${ident}: ${signature} = ${JSON.stringify(name)}`;
}

/**
 * Method -> `@send` external. Verified above: the receiver is the function
 * type's first positional parameter, not a special calling form — realized
 * here by giving `syntheticFunctionRef` the receiver as `thisType`, which
 * type-ir's `rescript-native.ts` `function` handler already prepends.
 */
function buildMethod(
  name: string,
  shape: FfiShape & { kind: "method" },
  meta: Readonly<Record<string, unknown>>,
): string {
  const ref = syntheticFunctionRef(shape.params, shape.returnType, shape.receiver);
  const signature = toReScriptType(ref);
  const ident = externalIdent(name);
  return `${docComment(meta)}${deprecatedAttr(meta)}@send\nexternal ${ident}: ${signature} = ${JSON.stringify(name)}`;
}

/**
 * Resource -> an opaque `type Name` (the manual's own documented "this type
 * exists in JS, structure not modeled" idiom — verified above) plus one
 * `@send` external per entry in `methods`, all at the same nesting level the
 * resource's own `type` declaration is emitted at (see `buildModule`, which
 * wraps a whole `FfiKinds.module`'s resources/functions together in one
 * ReScript `module` block — that's the namespacing unit, not a per-resource
 * wrapper here).
 *
 * No constructor/`@new` binding is emitted: ffi-ir's `resource` kind (see
 * `index.ts`) has no separate constructor field, only a `methods` map,
 * uniformly receiver-based — the same gap `wasm-bindgen.ts`'s `buildResource`
 * lives with (it wraps every entry in `methods` as a `&self`-receiving impl
 * method too, no constructor concept).
 *
 * Naming: `type` is named `decapitalize(toPascalCase(name))` — a
 * lowercase-leading camelCase identifier, since ReScript type identifiers
 * (unlike module/variant/constructor names) must start with a lowercase
 * letter or underscore; a capitalized one is a hard parse error, not just an
 * unidiomatic style choice — to match exactly how `toReScriptType`'s `ref`
 * handler renders a `{ kind: "ref", target }` TypeRef
 * (`toCamelCaseFromWords`-equivalent) — this is what lets a
 * `resourceRef(name, ...)` used as a parameter/return type elsewhere resolve
 * to the same identifier this opaque type declares, with no string-patching
 * needed to bridge the two. Method binding identifiers are prefixed with the
 * decapitalized resource name (`bufferRead`, not bare `read`) since ffi-ir's
 * `resource.methods` keys are only unique within one resource, not across a
 * whole module's flat ReScript declaration namespace — two resources with a
 * same-named method (e.g. both having `close`) would otherwise collide at
 * the top level; this prefixing avoids that collision.
 */
function buildResource(
  name: string,
  shape: FfiShape & { kind: "resource" },
  meta: Readonly<Record<string, unknown>>,
): string {
  // Lowercase-leading: ReScript type identifiers must start lowercase
  // (unlike module/variant names) — see the naming note above.
  const typeName = decapitalize(toPascalCase(name));
  const description = typeof meta.description === "string" ? [`/** ${meta.description} */`] : [];
  const typeDecl = [...description, `type ${typeName}`].join("\n");
  const methodDecls = Object.entries(shape.methods).map(([methodName, methodRef]) => {
    const kind = methodRef.shape.kind;
    if (kind !== "method" && kind !== "function") {
      throw new Error(
        `toReScriptFfi: resource method "${methodName}" has unexpected kind "${kind}" (expected "method")`,
      );
    }
    const methodShape = methodRef.shape as FfiShape & {
      kind: "method";
      params: readonly FfiParam[];
      returnType: TypeRef;
    };
    const prefixedName = `${decapitalize(typeName)}${toPascalCase(methodName)}`;
    // Bind the receiver explicitly to this resource's own name (not
    // `methodShape.receiver`, which may be unset when built via
    // `boundary.method` without wiring `receiver` through the resource) —
    // `buildResource`'s caller already knows which resource this is.
    return buildMethod(
      prefixedName,
      { ...methodShape, kind: "method", receiver: name },
      methodRef.meta,
    ).replace(
      // keep the JS-side name literal as the original unprefixed method name
      // (`"read"`, not `"bufferRead"`) — only the ReScript-side identifier
      // gets prefixed, the JS call target must stay exact.
      new RegExp(`= ${JSON.stringify(prefixedName)}$`),
      `= ${JSON.stringify(methodName)}`,
    );
  });
  return [typeDecl, ...methodDecls].join("\n\n");
}

/** Module -> a ReScript `module Name = { ... }` block grouping the
 * resources/functions exported at one FFI boundary — ReScript modules are a
 * core, always-available grouping construct (not itself a binding-specific
 * attribute needing separate verification), and this mirrors the same
 * "wrap the boundary's declarations in the target's native grouping
 * construct" choice `wasm-bindgen.ts`'s `buildModule` makes with `pub mod`.
 * The module's raw `name` (a JS module specifier/package name, e.g. `"fs"`,
 * `"node:path"`) is threaded down as `moduleName` for `@module(...)`
 * attributes on the functions inside — see `buildFunction` and the
 * file-level naming note. */
function buildModule(name: string, shape: FfiShape & { kind: "module" }): string {
  const resourceDecls = Object.entries(shape.resources).map(([resName, resRef]) =>
    buildResource(resName, resRef.shape as FfiShape & { kind: "resource" }, resRef.meta),
  );
  const functionDecls = Object.entries(shape.functions).map(([fnName, fnRef]) => {
    const fnShape = fnRef.shape;
    if (!isA(fnShape.kind, "function")) {
      throw new Error(
        `toReScriptFfi: module function "${fnName}" has unexpected kind "${fnShape.kind}" (expected "function")`,
      );
    }
    return buildFunction(fnName, fnShape as FfiShape & { kind: "function" }, fnRef.meta, name);
  });
  const body = [...resourceDecls, ...functionDecls].join("\n\n");
  return [`module ${toPascalCase(name)} = {`, indent(body), `}`].join("\n");
}

/**
 * Lower an ffi-ir `FfiRef` to ReScript `external`/`type` declaration source
 * text. `name` is required for `function`/`method`/`resource` (all are named
 * declarations) and for `module` (the ReScript module name). Never throws for
 * ownership discipline (see the file-level ownership note) — every
 * discipline lowers identically since JS/ReScript's FFI has no ownership
 * concept of its own to gate against.
 */
export function toReScriptFfi(ref: FfiRef, name?: string): string {
  const kind = ref.shape.kind;

  if (name === undefined) {
    throw new Error(
      `toReScriptFfi: "${kind}" requires a name — ReScript externals/types/modules are named declarations, not anonymous inline expressions`,
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
    return buildFunction(name, ref.shape as FfiShape & { kind: "function" }, ref.meta);
  }
  throw new Error(
    `toReScriptFfi: unhandled ffi-ir kind "${kind}" (no handler and no known ancestor)`,
  );
}

export { toReScriptType };
