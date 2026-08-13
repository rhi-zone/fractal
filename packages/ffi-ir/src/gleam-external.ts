import type { TypeRef } from "@rhi-zone/fractal-type-ir";
import { toGleamType } from "@rhi-zone/fractal-type-ir/gleam";
import type { FfiParam, FfiRef, FfiShape } from "./index.ts";

// `toSnakeCaseStripSeparators` duplicated here (not imported) — type-ir's
// `codegen-helpers.ts` is an internal-only shared module across type-ir's own
// projector files, not part of type-ir's public package.json `exports` map,
// so it isn't reachable from this package. Same "each projector file is
// self-contained" duplication precedent `wasm-bindgen.ts`/`rust-c-abi.ts` already
// use for their own copy of `toSnakeCase` in this package.
function toSnakeCaseStripSeparators(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

// Gleam `@external` codegen for ffi-ir's boundary layer — module/function/
// resource/ownership-discipline shapes — the JS-target analogue of
// wasm-bindgen.ts (which does the same thing for Rust/wasm-bindgen). Reuses
// type-ir's already-merged `gleam-native.ts` (`toGleamType`) for every
// data-shape position (params, return types) rather than reimplementing type
// mapping, and adds only what ffi-ir carries that type-ir doesn't: function/
// module boundaries, resource declarations, and the JS-source-path
// information Gleam's `@external` attribute itself requires.
//
// `@external` syntax, verified 2026-08-03 against gleam.run/documentation/
// externals/ and tour.gleam.run/advanced-features/externals/:
//
//   @external(javascript, "<module-path-or-package>", "<exported-name>")
//   pub fn <name>(<params>) -> <ReturnType>
//
// Three positional arguments in that fixed order — target (`"javascript"` or
// `"erlang"`; only `"javascript"` is relevant here), the JS module the
// function is imported from (a relative `.mjs` path or an npm package name),
// and the name of the exported binding in that module. Type annotations on
// the Gleam-side signature are mandatory (the compiler cannot infer external
// function types), and multiple `@external` attributes can stack on one
// function to cover both targets — not used here since this file emits only
// the `javascript` target. Both examples found in the docs (`get_element_by_
// id`, `reverse_list`) are ordinary top-level function declarations with
// named parameters — `@external` decorates a normal `pub fn`, not a bare
// `fn(...)  -> ...` type expression.
//
// JS-source-path convention (this file's own addition, following the "open
// metadata bag" precedent `withOwnership`/`meta.ownership` already
// established in `./index.ts`): `@external`'s second and third arguments
// name information ffi-ir's `FfiRef`/`FfiShape` schema has no field for (the
// schema was deliberately kept target-agnostic — see index.ts's file header).
// This projector reads them from the `FfiRef`'s own `meta` bag:
//   - `meta.jsModule` (required `string`) — the JS module path/package
//     `@external`'s 2nd argument names. No default is defensible (there is
//     no way to derive a JS import path from a Gleam/ffi-ir name), so this
//     throws when absent rather than guessing a path.
//   - `meta.jsName` (optional `string`, defaults to the Gleam function's own
//     snake_case name) — the exported JS binding name, `@external`'s 3rd
//     argument. Defaulting to the same name is the common case in the docs'
//     own examples (`reverse_list`/`reverse_list`), so this only needs
//     overriding when the JS export is actually named differently.
//
// Ownership metadata (`meta.ownership`, ffi-ir's `OwnershipDiscipline`) is
// not gated or branched on anywhere in this file, unlike wasm-bindgen.ts/
// rust-c-abi.ts (both of which throw for disciplines their target can't
// realize). Those two throw because ownership discipline changes the
// emitted Rust code shape itself (`*mut T` vs a plain value, `Arc<T>`
// wrapping, a paired free function). Here it doesn't: JS has no
// manual-free/refcount/lend-count-and-trap machinery of its own for
// `@external` to hook into (the JS side of an external binding is opaque,
// hand-written glue code this projector doesn't generate), and Gleam's own
// type system has nothing an ownership qualifier could attach to (no
// borrow-checking, no linear types, no subtyping, no inheritance) — so every
// one of the four disciplines produces the exact same Gleam declaration: a
// value crossing this boundary is simply an opaque, GC-managed reference
// either way, with no code-shape difference to fail to produce and
// therefore no "unsupported" branch to take.

function docComment(meta: Readonly<Record<string, unknown>>): string[] {
  return typeof meta.description === "string" ? [`/// ${meta.description}`] : [];
}

function jsModuleOf(meta: Readonly<Record<string, unknown>>, where: string): string {
  const jsModule = meta.jsModule;
  if (typeof jsModule !== "string") {
    throw new Error(
      `toGleamFfi: "${where}" is missing required meta.jsModule (the JS module path/package @external's 2nd ` +
        'argument names — e.g. "./math.mjs" or an npm package name) — there is no derivable default, so this must ' +
        "be supplied explicitly on the FfiRef's meta bag",
    );
  }
  return jsModule;
}

function jsNameOf(meta: Readonly<Record<string, unknown>>, gleamName: string): string {
  return typeof meta.jsName === "string" ? meta.jsName : gleamName;
}

/** One `@external(javascript, ...) \n pub fn name(...)` declaration for a
 * `function` shape. `extraParam`, when given, is prepended ahead of the
 * shape's own params — used by `buildMethod` to splice in the receiver (see
 * that function's doc comment for why). */
function buildFunctionDecl(
  gleamName: string,
  params: readonly FfiParam[],
  returnType: TypeRef,
  meta: Readonly<Record<string, unknown>>,
  where: string,
  extraParam?: { readonly name: string; readonly type: TypeRef },
): string {
  const jsModule = jsModuleOf(meta, where);
  const jsName = jsNameOf(meta, gleamName);
  const allParams = extraParam === undefined ? params : [extraParam, ...params];
  const paramList = allParams
    .map((p) => `${toSnakeCaseStripSeparators(p.name)}: ${toGleamType(p.type)}`)
    .join(", ");
  const lines = [
    ...docComment(meta),
    `@external(javascript, ${JSON.stringify(jsModule)}, ${JSON.stringify(jsName)})`,
    `pub fn ${gleamName}(${paramList}) -> ${toGleamType(returnType)}`,
  ];
  return lines.join("\n");
}

function buildFunction(
  name: string,
  shape: FfiShape & { kind: "function" },
  meta: Readonly<Record<string, unknown>>,
): string {
  const gleamName = toSnakeCaseStripSeparators(name);
  return buildFunctionDecl(gleamName, shape.params, shape.returnType, meta, `function "${name}"`);
}

/**
 * Method -> free function taking the receiver as an explicit first
 * parameter, matching Gleam's own type system. gleam.run/documentation/
 * externals/ and tour.gleam.run/advanced-features/externals/ show
 * `@external` binding only free functions in every example found
 * (`get_element_by_id`, `reverse_list`, `halt`) — no method/receiver syntax
 * of any kind is documented, and Gleam's own type system has no
 * method-on-a-type/receiver concept at all (custom types carry no attached
 * functions; a Gleam "method" is conventionally just a function taking the
 * value as its first argument, e.g. `list.map(my_list, f)`). Degrading a
 * `method` shape to that same "receiver as first explicit parameter"
 * convention is the idiomatic Gleam shape for this — every Gleam
 * stdlib/ecosystem "method" is already written this way. The receiver's own
 * type is the resource's external-type name (see `buildResource`),
 * referenced here by `types.ref`-style PascalCase name via a synthetic ref
 * TypeRef so it flows through `toGleamType` unchanged.
 */
function buildMethod(
  name: string,
  shape: FfiShape & { kind: "method" },
  meta: Readonly<Record<string, unknown>>,
): string {
  const gleamName = toSnakeCaseStripSeparators(name);
  const receiverParamName = toSnakeCaseStripSeparators(shape.receiver);
  const receiverType: TypeRef = { shape: { kind: "ref", target: shape.receiver }, meta: {} };
  return buildFunctionDecl(gleamName, shape.params, shape.returnType, meta, `method "${name}"`, {
    name: receiverParamName,
    type: receiverType,
  });
}

/**
 * Resource -> a Gleam "external type" declaration: `pub type Name` with no
 * constructors. Verified against gleam.run/documentation/externals/, which
 * names exactly this construct as Gleam's idiom for an opaque foreign value
 * ("Gleam doesn't know anything about this type other than its existence
 * and the name it has been given... it cannot be constructed or manipulated
 * directly in Gleam code. External functions must be used instead."). Each of the
 * resource's own methods is emitted as a `buildMethod`-style free function
 * (see that function's doc comment) alongside the type declaration, since
 * Gleam's external types carry no attached-function/impl-block syntax of
 * their own for this projector to hook into.
 */
function buildResource(
  name: string,
  shape: FfiShape & { kind: "resource" },
  meta: Readonly<Record<string, unknown>>,
): string {
  const typeDecl = [...docComment(meta), `pub type ${name}`].join("\n");
  const methods = Object.entries(shape.methods).map(([methodName, methodRef]) => {
    const methodShape = methodRef.shape;
    if (methodShape.kind !== "method" && methodShape.kind !== "function") {
      throw new Error(
        `toGleamFfi: resource method "${methodName}" has unexpected kind "${methodShape.kind}" (expected "method")`,
      );
    }
    const asMethod = { ...methodShape, kind: "method", receiver: name } as FfiShape & {
      kind: "method";
    };
    return buildMethod(methodName, asMethod, methodRef.meta);
  });
  return [typeDecl, ...methods].join("\n\n");
}

/**
 * Module -> concatenated declarations, not an inline wrapping construct.
 * Verified against Gleam's own project-layout convention (gleam.run/
 * documentation/externals/'s own examples import across files by path,
 * e.g. `./my_app/pokemon.mjs`, and the Gleam Tour's project-structure
 * material): a Gleam module is a source file located by its path in
 * `src/`, not an inline `module name { ... }`/`mod name { ... }` block the
 * way Rust or many other targets support (contrast wasm-bindgen.ts's
 * `pub mod name { ... }`, which C-ABI-analogue targets can express inline).
 * There is therefore no idiomatic single-expression Gleam construct this
 * `name` could become — the concatenated declarations are the content of
 * the file at that module's path (`<name>.gleam`), noted here as a comment
 * rather than synthesized as Gleam syntax that doesn't exist.
 */
function buildModule(name: string, shape: FfiShape & { kind: "module" }): string {
  const header = `// module: ${name} (place these declarations in ${toSnakeCaseStripSeparators(name)}.gleam)`;
  const resourceDecls = Object.entries(shape.resources).map(([resName, resRef]) =>
    toGleamFfi(resRef, resName),
  );
  const functionDecls = Object.entries(shape.functions).map(([fnName, fnRef]) =>
    toGleamFfi(fnRef, fnName),
  );
  return [header, ...resourceDecls, ...functionDecls].join("\n\n");
}

/**
 * Lower an ffi-ir `FfiRef` to Gleam `@external(javascript, ...)` source.
 * `name` is required for every kind (a Gleam `pub fn`/`pub type` is always a
 * named top-level declaration, and `module` uses it as the file-path
 * comment's label) — mirrors wasm-bindgen.ts's/rust-c-abi.ts's identical
 * requirement.
 */
export function toGleamFfi(ref: FfiRef, name?: string): string {
  const kind = ref.shape.kind;

  if (name === undefined) {
    throw new Error(
      `toGleamFfi: "${kind}" requires a name — a Gleam \`@external\` binding is always a named top-level declaration, not an anonymous inline type`,
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
  throw new Error(
    `toGleamFfi: unhandled ffi-ir kind "${kind}" — no Gleam @external mapping implemented for this backend`,
  );
}
