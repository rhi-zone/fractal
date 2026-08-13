import { type TypeRef, type TypeShape } from "@rhi-zone/fractal-type-ir";
import type { FfiKinds, FfiParam, FfiRef, OwnershipDiscipline } from "./index.ts";

// ffi-ir -> WIT (.wit source text) projector.
//
// Scope and decisions this file follows, made in
// docs/design/ffi-ir-architecture-options.md (Fork B follow-up, Fork C
// "discipline-per-target: decided"):
//
//   - WIT is one more target for fractal (a `.wit` emission projector, the
//     same shape as the ~120 type-ir projectors), not a shared IR fractal's
//     own C/JS backends sit on top of. See the doc's Fork B follow-up, "Net
//     finding" (line ~469-489).
//   - The only ownership discipline this projector implements is
//     `resource` + `own`/`borrow` (WIT's own shipped mechanism, which
//     already subsumes copy-by-value for every non-resource type for
//     free). `opaque-handle` and `refcount` throw, per the doc's "Fork C,
//     discipline-per-target: decided" subsection: opaque-handle+free-fn is
//     redundant with `resource` (which provides strictly more — a
//     lend-count/trap safety net `opaque-handle` lacks), and refcount is a
//     structural mismatch (WIT's Canonical ABI is lend-count-and-trap, not
//     reference counting).
//
// `module` -> WIT `interface`, not `world`, per
// component-model.bytecodealliance.org/design/worlds.html (quoted in the
// design doc line ~371-378): "an interface groups named types+functions"
// while "a world describes the functionality a component provides, and the
// functionality it requires in order to work" via import/export
// declarations. ffi-ir's `module` kind (per index.ts) is a flat `{
// functions, resources }` map with no import/export/binding concept at
// all — structurally an `interface`, not a `world`.
//
// `resource` methods use WIT's own nested method syntax
// (component-model.bytecodealliance.org/design/wit.html): a resource
// block's methods "implicitly take a `self` (AKA `this`) parameter that is
// a handle" and are written `name: func(params) -> ret;` inside the
// `resource { ... }` block, with no explicit receiver parameter — e.g.
// `resource blob { write: func(bytes: list<u8>); }`, not `write:
// func(self: borrow<blob>, bytes: list<u8>);` as a free function. This
// lines up with ffi-ir's own `method` shape, whose `params` already
// excludes the receiver (the receiver is carried separately, as
// `FfiKinds.method.receiver`) — so `function` and `method` emit the same
// func-line syntax here; the only difference is where that line is placed
// (top-level in an `interface`, vs. nested in a `resource` block).
//
// WIT identifiers are ASCII kebab-case ("sequences of words, separated by
// single hyphens", per wit.html); `toKebabCase` below converts
// ffi-ir/type-ir's camelCase-by-convention names to match.
//
// Data-shape (type-ir TypeRef -> WIT type syntax) coverage is minimal
// here — primitives, `record` (from type-ir's `object`), `list<T>` (from
// `array`), `option<T>` (from `meta.optional`/`meta.nullable`), plus
// `ref`/resource-handle syntax for the ownership cases above. No
// standalone `type-ir -> WIT` data-shape projector exists in
// packages/type-ir/src/; the full same-shape addition other targets get
// (elm-json.ts, rust-serde.ts, ...) — variant/enum/flags/tuple/map/result
// etc. — is separate, not-yet-done work, out of scope for this file, which
// only implements what ffi-ir's own function/method/resource/module
// projection needs.

function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function isVoidType(ref: TypeRef): boolean {
  return ref.shape.kind === "void" || ref.shape.kind === "null";
}

const PRIMITIVES: Readonly<Record<string, string>> = {
  boolean: "bool",
  string: "string",
  int8: "s8",
  int16: "s16",
  int32: "s32",
  int64: "s64",
  integer: "s64",
  uint8: "u8",
  uint16: "u16",
  uint32: "u32",
  uint64: "u64",
  float32: "f32",
  float64: "f64",
  number: "f64",
};

/** The structural (ownership-metadata-independent) WIT type expression for
 * `ref`. Hoists a fresh `record` declaration into `decls` (keyed by its
 * kebab-case name, to dedupe repeat references) when `ref` is an `object`
 * shape — mirrors the hoisting pattern `wasm-bindgen.ts`'s `bareType` uses
 * for the same reason (WIT, like Rust, has no anonymous inline record
 * syntax). Throws for any kind this minimal subset doesn't implement. */
function baseType(ref: TypeRef, decls: Map<string, string>, nameHint: string): string {
  const kind = ref.shape.kind;

  if (kind in PRIMITIVES) return PRIMITIVES[kind]!;

  if (kind === "array") {
    const shape = ref.shape as TypeShape & { kind: "array"; element: TypeRef };
    return `list<${witType(shape.element, decls, nameHint)}>`;
  }

  if (kind === "ref") {
    return toKebabCase((ref.shape as TypeShape & { kind: "ref"; target: string }).target);
  }

  if (kind === "object") {
    const shape = ref.shape as TypeShape & {
      kind: "object";
      fields: Readonly<Record<string, TypeRef>>;
    };
    const recordName = toKebabCase(nameHint);
    if (!decls.has(recordName)) {
      decls.set(recordName, ""); // reserve the slot before recursing, in case a field self-references
      const lines = [`record ${recordName} {`];
      for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
        lines.push(`    ${toKebabCase(fieldName)}: ${witType(fieldRef, decls, fieldName)},`);
      }
      lines.push("}");
      decls.set(recordName, lines.join("\n"));
    }
    return recordName;
  }

  throw new Error(
    `toWit: kind "${kind}" has no WIT mapping in this minimal data-shape subset — only primitives, "object" (-> record), "array" (-> list<T>), and "ref" are implemented; a full type-ir -> WIT data-shape projector is separate, not-yet-done work`,
  );
}

/** Full WIT type expression for `ref`, including ownership-discipline
 * handling (`meta.ownership`, per ffi-ir's `OwnershipDiscipline`) and
 * `option<T>` wrapping for `meta.optional`/`meta.nullable`. `"copy"`
 * ownership (or no ownership metadata at all) falls through to
 * `baseType`'s plain structural conversion — WIT crosses non-`resource`
 * types by value natively, so a copy-discipline value needs no wrapper.
 * `"resource"` ownership renders the WIT-native `own`/`borrow<T>` call-site
 * qualifier (an unqualified resource name for `"own"`, `borrow<name>` for
 * `"borrow"`) and requires `ref` to be a `{ kind: "ref" }` TypeRef naming
 * the resource — the documented `resourceRef()` convention from
 * `./index.ts`. `"opaque-handle"` and `"refcount"` throw — see the
 * file-level doc comment for why those two are out of scope for this
 * target. */
function witType(ref: TypeRef, decls: Map<string, string>, nameHint: string): string {
  const discipline = ref.meta.ownership as OwnershipDiscipline | undefined;
  let base: string;
  if (discipline !== undefined && discipline.kind !== "copy") {
    if (discipline.kind === "opaque-handle" || discipline.kind === "refcount") {
      throw new Error(
        `toWit: unsupported ownership discipline "${discipline.kind}" for the WIT target — WIT's decided scope (docs/design/ffi-ir-architecture-options.md, Fork C "discipline-per-target: decided") implements only "resource" (own/borrow) and "copy"; "${discipline.kind}" has no WIT-native realization and is explicitly excluded, not silently degraded`,
      );
    }
    // discipline.kind === "resource"
    if (ref.shape.kind !== "ref") {
      throw new Error(
        `toWit: "resource" ownership metadata requires a { kind: "ref" } TypeRef naming the resource (the resourceRef() convention from ./index.ts), got shape kind "${ref.shape.kind}"`,
      );
    }
    const target = toKebabCase((ref.shape as TypeShape & { kind: "ref"; target: string }).target);
    base = discipline.mode === "borrow" ? `borrow<${target}>` : target;
  } else {
    base = baseType(ref, decls, nameHint);
  }

  const optional = ref.meta.optional === true || ref.meta.nullable === true;
  return optional ? `option<${base}>` : base;
}

/** `name: func(param: type, ...) -> return-type;` per
 * component-model.bytecodealliance.org/design/wit.html (`"add: func(a: u64,
 * b: u64) -> u64;"`). The return-type arrow is omitted entirely for a
 * void/null return — WIT's function grammar has no unit/void return type
 * to spell out; a function that returns nothing has no `-> ...` clause
 * (matches the docs' `draw-line: func(...);` example, which has no arrow
 * at all). */
function funcLine(
  name: string,
  shape: { readonly params: readonly FfiParam[]; readonly returnType: TypeRef },
  decls: Map<string, string>,
): string {
  const fnName = toKebabCase(name);
  const params = shape.params.map(
    (p) => `${toKebabCase(p.name)}: ${witType(p.type, decls, p.name)}`,
  );
  const returnClause = isVoidType(shape.returnType)
    ? ""
    : ` -> ${witType(shape.returnType, decls, `${name}-result`)}`;
  return `${fnName}: func(${params.join(", ")})${returnClause};`;
}

function isFunctionLike(kind: string): kind is "function" | "method" {
  return kind === "function" || kind === "method";
}

/** `resource name { method: func(...) -> ...; ... }` per
 * component-model.bytecodealliance.org/design/wit.html (`"resource blob {
 * constructor(init: list<u8>); write: func(bytes: list<u8>); ... }"`).
 * ffi-ir's `resource` schema (index.ts)
 * has no constructor/static-function concept distinct from its flat
 * `methods` map, so every entry here emits as an ordinary WIT resource
 * method line — a WIT `constructor(...)`/`static func` distinction is not
 * modeled by ffi-ir today and is not synthesized here. */
function resourceBlock(shape: FfiKinds["resource"], decls: Map<string, string>): string {
  const resourceName = toKebabCase(shape.name);
  const lines = [`resource ${resourceName} {`];
  for (const [methodName, methodRef] of Object.entries(shape.methods)) {
    if (!isFunctionLike(methodRef.shape.kind)) {
      throw new Error(
        `toWit: resource "${shape.name}"'s method "${methodName}" has shape kind "${methodRef.shape.kind}", not "function"/"method" — a resource's methods map must contain callable shapes`,
      );
    }
    const callable = methodRef.shape as {
      readonly params: readonly FfiParam[];
      readonly returnType: TypeRef;
    };
    lines.push(`    ${funcLine(methodName, callable, decls)}`);
  }
  lines.push("}");
  return lines.join("\n");
}

function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : `    ${line}`))
    .join("\n");
}

/**
 * Project an `FfiShape` (`module`/`function`/`method`/`resource`) into
 * `.wit` source text.
 *
 * - `module` -> a WIT `interface name { ... }` block, containing its
 *   resources (as nested `resource` blocks) and functions (as func lines),
 *   preceded by any `record` declarations hoisted out of nested
 *   object-shaped params/fields. See the file-level doc comment for why
 *   `interface`, not `world`, is the correct mapping.
 * - `resource` -> a standalone `resource name { ... }` block (when called
 *   directly rather than via a `module`), preceded by hoisted `record`
 *   declarations.
 * - `function`/`method` -> a standalone func line; requires `name` (ffi-ir's
 *   `function`/`method` shapes carry no name of their own — the name lives
 *   in the enclosing `module.functions`/`resource.methods` map key, same as
 *   `wasm-bindgen.ts`'s `toWasmBindgen(ref, name)` convention).
 *
 * Throws — never silently degrades — for: any ownership discipline other
 * than `"copy"`/`"resource"` (see `witType`), any data-shape kind outside
 * this file's minimal primitives/record/list/option subset (see
 * `baseType`), and a `function`/`method` shape called without a `name`.
 */
export function toWit(ref: FfiRef, name?: string): string {
  const kind = ref.shape.kind;
  const decls = new Map<string, string>();

  if (kind === "module") {
    const shape = ref.shape as FfiKinds["module"];
    const ifaceName = toKebabCase(shape.name);
    const body: string[] = [];
    for (const [resName, resRef] of Object.entries(shape.resources)) {
      if (resRef.shape.kind !== "resource") {
        throw new Error(
          `toWit: module "${shape.name}"'s resource "${resName}" has shape kind "${resRef.shape.kind}", not "resource"`,
        );
      }
      body.push(resourceBlock(resRef.shape as FfiKinds["resource"], decls));
    }
    for (const [fnName, fnRef] of Object.entries(shape.functions)) {
      if (!isFunctionLike(fnRef.shape.kind)) {
        throw new Error(
          `toWit: module "${shape.name}"'s function "${fnName}" has shape kind "${fnRef.shape.kind}", not "function"/"method"`,
        );
      }
      const callable = fnRef.shape as {
        readonly params: readonly FfiParam[];
        readonly returnType: TypeRef;
      };
      body.push(funcLine(fnName, callable, decls));
    }
    const inner = [...decls.values(), ...body].join("\n\n");
    return `interface ${ifaceName} {\n${indentBlock(inner)}\n}`;
  }

  if (kind === "resource") {
    const block = resourceBlock(ref.shape as FfiKinds["resource"], decls);
    return [...decls.values(), block].join("\n\n");
  }

  if (isFunctionLike(kind)) {
    if (name === undefined) {
      throw new Error(
        `toWit: a standalone "${kind}" shape requires a name — its own schema carries no name (see index.ts's FfiKinds.function/method)`,
      );
    }
    const callable = ref.shape as {
      readonly params: readonly FfiParam[];
      readonly returnType: TypeRef;
    };
    const line = funcLine(name, callable, decls);
    return [...decls.values(), line].join("\n\n");
  }

  throw new Error(`toWit: kind "${kind}" is not a boundary construct this projector emits`);
}
