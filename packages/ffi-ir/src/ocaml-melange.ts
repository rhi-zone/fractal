import { type TypeRef, type TypeShape } from "@rhi-zone/fractal-type-ir";
import { ancestors, type FfiParam, type FfiRef, type FfiShape } from "./index.ts";

// ffi-ir -> Melange (https://melange.re) `external`-declaration projector.
//
// Toolchain determination (this file's first job, per the task that
// produced it): "OCaml/Reason binds to JS" names TWO genuinely different,
// unrelated toolchains, not one syntax with two names —
//
//   - js_of_ocaml (https://ocsigen.org/js_of_ocaml) — compiles a whole
//     (already-typed, already-compiled-from-OCaml) program to JS. Its
//     idiomatic FFI story, per its own `Js.Unsafe`/`Js.t` machinery (verified
//     via web search against ocaml.org's published `Js_of_ocaml.Js` API docs
//     and a copy of `js.mli`, 2026-08-03 — the ocsigen.org manual pages
//     themselves were unreachable, DNS timeout from this sandbox), is either
//     (a) hand-written `class type ... = object method m : t1 -> t2 meth
//     ... end` declarations giving typed `Js.t` wrappers around JS objects,
//     or (b) untyped escape-hatch calls through `Js.Unsafe.meth_call`/
//     `Js.Unsafe.global`/`Js.Unsafe.inject`. Neither is a per-function
//     *attribute* syntax analogous to wasm-bindgen's `#[wasm_bindgen]` or
//     WIT's declarative shape — (a) requires synthesizing a class-type
//     declaration (a materially different generative shape from an
//     annotated `external`), and (b) is explicitly the "type safety isn't
//     critical" low-level path, not the documented primary binding idiom.
//   - Melange (https://melange.re, Reason's actively-maintained modern JS
//     backend, a BuckleScript fork) — binds via ordinary `external`
//     declarations plus a family of namespaced attributes (`[@mel.module]`,
//     `[@mel.send]`, `[@mel.get]`/`[@mel.set]`, `[@mel.new]`, `[@mel.scope]`,
//     `[@mel.obj]`), verified against melange.re's own "Communicate with
//     JavaScript" page (fetched 2026-08-03; concrete examples reproduced in
//     this file's comments below) — structurally the closest analog to
//     `wasm-bindgen.ts`'s attribute-decorated `external`/`#[wasm_bindgen]`
//     precedent this package already has two siblings for (rust-c-abi.ts,
//     wasm-bindgen.ts) and the one this file follows most directly.
//
// Given that structural match, THIS FILE implements Melange only. A
// js_of_ocaml backend is a genuinely separate, differently-shaped piece of
// work (either a class-type synthesizer or an untyped-call emitter) — not
// implemented here; flagged back to the task, not guessed at, per the
// "genuine unresolved ambiguity" instruction this task was given.
//
// ----------------------------------------------------------------------------
// Ownership-discipline scope for this target (mirrors the file-level
// reasoning `wasm-bindgen.ts` and `wit.ts` each give for their own target,
// re-derived here rather than copied — Melange's ownership story is NOT the
// same as either sibling's):
//
//   - `"copy"` (default when `meta.ownership` is absent, matching every
//     sibling projector's copy-by-default convention) — a plain passthrough.
//     Melange values erase to their underlying JS representation at compile
//     time; there is no serialization/marshalling boundary the way
//     wasm-bindgen's Rust<->JS boundary has, so "copy" here means exactly
//     "reference this TypeRef's rendered type, do nothing else" — not an
//     emitted `Clone`-equivalent (Melange/OCaml has no such attribute to
//     emit; value semantics are the host language's own, unmodified).
//   - `"opaque-handle"` — Melange's own well-documented idiom for "a JS
//     value this binding treats as opaque, released via an explicit call":
//     an abstract `type t` (no representation exposed) plus, when `freeFn`
//     is given, a normal `[@mel.send]`-bound external for it (the same
//     shape as any other bound method — e.g. Node's `fs` file-descriptor
//     `.close()`, DOM `WebSocket.close()`). This is the discipline this
//     target implements NATIVELY, unlike wasm-bindgen (no manual-free idiom
//     there) or WIT (redundant with `resource`).
//   - `"refcount"` — THROWS. Melange has no `Arc`/refcount-wrapper construct
//     and no bundled `FinalizationRegistry` pairing the way wasm-bindgen's
//     generated `.free()` gets one automatically; wiring a
//     `FinalizationRegistry` by hand is JS-interop glue code outside what
//     an `external` declaration can express, not a native Melange mechanism.
//   - `"resource"` (own/borrow) — THROWS, same reasoning `wit.ts` and
//     `wasm-bindgen.ts` both give: no host JS/Melange runtime enforces a
//     lend-count-and-trap discipline.
//
// ----------------------------------------------------------------------------
// Data-shape (type-ir TypeRef -> Melange type syntax) coverage is
// DELIBERATELY MINIMAL, the same scope-limiting call `wit.ts` makes and
// documents for the identical reason: no type-ir -> OCaml/Melange projector
// exists yet in packages/type-ir/src/ (confirmed by listing that directory —
// only `rescript-native.ts`, a different toolchain/syntax, is present), and
// building the full ~120-projector-equivalent OCaml/Melange data-shape
// projector is separate, not-yet-done work, out of scope for this file.
// What's implemented here: primitives, `option`-equivalent (OCaml's native
// `'a option`, from `meta.optional`/`meta.nullable`), `array` (OCaml
// `array`, not `list` — matches JS's mutable-indexable-sequence semantics
// more closely than OCaml's singly-linked `list`), `object` (hoisted to a
// named OCaml record — OCaml, like ReScript per `rescript-native.ts`'s own
// doc comment, has no anonymous inline record-type syntax), `enum`
// (hoisted to a named no-payload variant), and `ref` (a resource name,
// referencing the abstract `type t` generated for it — see `buildResource`).

// ============================================================================
// naming
// ============================================================================

// OCaml/Melange keywords that collide with a bare lowercase identifier —
// mirrors rescript-native.ts's own RESERVED set, adjusted for OCaml's
// (slightly different) keyword list.
const RESERVED = new Set([
  "and",
  "as",
  "asr",
  "assert",
  "begin",
  "class",
  "constraint",
  "do",
  "done",
  "downto",
  "else",
  "end",
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
  "land",
  "lazy",
  "let",
  "lor",
  "lsl",
  "lsr",
  "lxor",
  "match",
  "method",
  "mod",
  "module",
  "mutable",
  "new",
  "nonrec",
  "object",
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
]);

/** Valid-identifier check + sanitized fallback for an OCaml value/label
 * name (must start lowercase-or-underscore) — mirrors rescript-native.ts's
 * `sanitizeLabel`/`fieldLabel` pair, since OCaml's identifier-start rule is
 * the same as ReScript's. */
function sanitizeLower(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, "_");
  const lowered = /^[A-Z]/.test(cleaned)
    ? cleaned.charAt(0).toLowerCase() + cleaned.slice(1)
    : cleaned;
  const prefixed = /^[a-z_]/.test(lowered) ? lowered : `_${lowered}`;
  return prefixed || "_";
}

function ocamlLabel(name: string): string {
  const label = sanitizeLower(name);
  return RESERVED.has(label) ? `${label}_` : label;
}

// `@rhi-zone/fractal-type-ir/codegen-helpers` is an internal (unexported)
// module of a sibling package this file must not modify (per this task's own
// scope), so `splitWords`/`toPascalCase`/`toCamelCase` are reimplemented
// locally here rather than imported — the same "small local copy, not a
// cross-package reach into another package's internals" precedent
// `wasm-bindgen.ts`'s own local `toSnakeCase` already establishes in this
// package.
function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function toPascalCaseFromWords(name: string): string {
  return splitWords(name)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

function toCamelCaseFromWords(name: string): string {
  const pascal = toPascalCaseFromWords(name);
  return pascal.length === 0 ? pascal : pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// ============================================================================
// hoisting context — a nested object/enum is declared once (as a top-level
// `type ... = ...`) and every reference agrees on its name, same pattern
// rescript-native.ts's `Ctx` establishes for the same reason (OCaml, like
// ReScript, has no anonymous inline record/variant syntax).
// ============================================================================

interface Ctx {
  decls: string[];
  used: Set<string>;
  names: Map<TypeRef, string>;
}

function newCtx(): Ctx {
  return { decls: [], used: new Set(), names: new Map() };
}

function freshName(ctx: Ctx, hint: string): string {
  const base = toCamelCaseFromWords(hint) || "anonymous";
  if (!ctx.used.has(base)) {
    ctx.used.add(base);
    return base;
  }
  let n = 2;
  while (ctx.used.has(`${base}${n}`)) n++;
  const name = `${base}${n}`;
  ctx.used.add(name);
  return name;
}

function hoistedName(ctx: Ctx, ref: TypeRef, nameHint: string): string {
  const cached = ctx.names.get(ref);
  if (cached !== undefined) return cached;
  const name = freshName(ctx, nameHint);
  ctx.names.set(ref, name);
  ctx.decls.push(generateNamedType(ref, name, ctx));
  return name;
}

function generateNamedType(ref: TypeRef, name: string, ctx: Ctx): string {
  const shape = ref.shape;
  if (shape.kind === "object") {
    const s = shape as TypeShape & { kind: "object" };
    const fields = Object.entries(s.fields).map(([fieldName, fieldRef]) => {
      const label = ocamlLabel(fieldName);
      const fieldType = melangeType(fieldRef, ctx, `${name}_${fieldName}`);
      const optional = fieldRef.meta.optional === true || fieldRef.meta.nullable === true;
      return `  ${label} : ${optional ? `${fieldType} option` : fieldType};`;
    });
    return [`type ${name} = {`, ...fields, "}"].join("\n");
  }
  if (shape.kind === "enum") {
    const s = shape as TypeShape & { kind: "enum" };
    const ctors = s.members.map((m) => `  | ${toPascalCaseFromWords(m)}`);
    return [`type ${name} =`, ...ctors].join("\n");
  }
  throw new Error(
    `melange.ts: cannot hoist type-ir kind "${shape.kind}" — outside this file's minimal data-shape subset`,
  );
}

// ============================================================================
// type-expression rendering — DELIBERATELY MINIMAL, see file-level doc
// comment above.
// ============================================================================

const PRIMITIVES: Readonly<Record<string, string>> = {
  boolean: "bool",
  number: "float",
  integer: "int",
  string: "string",
  null: "unit",
  void: "unit",
};

function melangeType(ref: TypeRef, ctx: Ctx, nameHint: string): string {
  const shape = ref.shape;
  if (shape.kind in PRIMITIVES) return PRIMITIVES[shape.kind]!;
  if (shape.kind === "array") {
    const s = shape as TypeShape & { kind: "array" };
    return `${melangeType(s.element, ctx, `${nameHint}Item`)} array`;
  }
  if (shape.kind === "ref") {
    const s = shape as TypeShape & { kind: "ref" };
    // Convention (see index.ts's own doc comment on `resourceRef`): a `ref`
    // TypeRef carrying `meta.ownership.kind === "resource"` or wrapped by
    // `withOwnership(..., ownership.opaqueHandle(...))` names a resource
    // declared elsewhere in the enclosing module — `buildResource` below
    // generates that resource as its own OCaml module with an abstract
    // `type t`, so a reference to it renders as `<ResourceModule>.t`.
    return `${toPascalCaseFromWords(s.target)}.t`;
  }
  if (shape.kind === "object" || shape.kind === "enum") {
    return hoistedName(ctx, ref, nameHint);
  }
  throw new Error(
    `melange.ts: unsupported type-ir kind "${shape.kind}" — outside this file's minimal data-shape subset`,
  );
}

/** Renders one parameter's Melange type, applying `option` for
 * `meta.optional`/`meta.nullable` — the same convention every sibling
 * projector (wasm-bindgen.ts, wit.ts) already applies at parameter/return
 * position. */
function paramType(ref: TypeRef, ctx: Ctx, nameHint: string): string {
  const base = melangeType(ref, ctx, nameHint);
  return ref.meta.optional === true || ref.meta.nullable === true ? `${base} option` : base;
}

// ============================================================================
// ownership gate
// ============================================================================

/**
 * Throws for the two disciplines this target has no native mechanism for
 * (`refcount`, `resource`), matching the throw-not-degrade convention
 * `wasm-bindgen.ts`/`wit.ts` both already establish. `"copy"` (or no
 * `meta.ownership` at all) and `"opaque-handle"` pass through unchanged —
 * `opaque-handle`'s `freeFn` (if any) is consumed separately by
 * `buildResource`, not here; this function only gates a parameter/return
 * TypeRef's discipline, it doesn't transform.
 */
function requireSupportedOwnership(ref: TypeRef, where: string): void {
  const discipline = ref.meta.ownership as { readonly kind: string } | undefined;
  if (discipline === undefined) return;
  if (discipline.kind === "refcount" || discipline.kind === "resource") {
    throw new Error(
      `toMelange: unsupported ownership discipline "${discipline.kind}" for the Melange/JS target at ${where} — ` +
        (discipline.kind === "refcount"
          ? "Melange has no Arc-equivalent refcount wrapper and no bundled FinalizationRegistry pairing " +
            "(unlike wasm-bindgen's generated .free()); use ownership.opaqueHandle() with an explicit freeFn instead"
          : "no host JS/Melange runtime exists to enforce WIT-style lend-count-and-trap semantics") +
        '. Melange/JS in this projector implements only "copy" and "opaque-handle" — project this value to a target ' +
        "that natively supports this discipline instead (C for opaque-handle+free-fn done manually, WIT for resource+own/borrow).",
    );
  }
}

// ============================================================================
// function / method
// ============================================================================

function docComment(meta: Readonly<Record<string, unknown>>): string {
  return typeof meta.description === "string" ? `(** ${meta.description} *)\n` : "";
}

/**
 * Free function -> a plain `external` with no receiver, one arrow per
 * parameter, `[@@mel.val]` when no enclosing JS module is named (global
 * function) — verified against melange.re's own documented default
 * (a bare `external` with no module/scope attribute binds a global value by
 * its OCaml name, e.g. `external setTimeout : (unit -> unit) -> int ->
 * timeoutId = "setTimeout"` from the fetched examples) — or `[@@mel.module
 * "<jsModule>"]` when `jsModule` is given (this module's own JS import),
 * matching `[@@mel.module "path"]` verbatim from the same page.
 */
function buildFunction(
  name: string,
  shape: FfiShape & { kind: "function" },
  meta: Readonly<Record<string, unknown>>,
  ctx: Ctx,
  jsModule: string | undefined,
): string {
  for (const p of shape.params) requireSupportedOwnership(p.type, `parameter "${p.name}"`);
  requireSupportedOwnership(shape.returnType, "return type");

  const label = ocamlLabel(name);
  const paramTypes = shape.params.map((p) => paramType(p.type, ctx, `${name}_${p.name}`));
  const returnType = paramType(shape.returnType, ctx, `${name}Result`);
  const arrowChain = [...paramTypes, returnType.length > 0 ? returnType : "unit"];
  const signature = arrowChain.length === 1 ? `unit -> ${arrowChain[0]}` : arrowChain.join(" -> ");
  const attr =
    jsModule === undefined ? "[@@mel.val]" : `[@@mel.module ${JSON.stringify(jsModule)}]`;
  return `${docComment(meta)}external ${label} : ${signature} = ${JSON.stringify(name)} ${attr}`;
}

/**
 * Method on a resource -> `[@mel.send]`, verified against melange.re's own
 * documented pattern (`external get_by_id : document -> string ->
 * Dom.element = "getElementById" [@@mel.send]`, called as `document |.
 * get_by_id "my-id"`) — the receiver is the FIRST explicit parameter (typed
 * as the resource's abstract `t`), not an implicit `self`; Melange's
 * `external` mechanism has no receiver-binding syntax distinct from "first
 * argument", unlike wasm-bindgen's `&self` splice or WIT's implicit
 * resource-block receiver.
 */
function buildMethod(
  name: string,
  shape: FfiShape & { kind: "method" },
  meta: Readonly<Record<string, unknown>>,
  ctx: Ctx,
  receiverType: string,
): string {
  for (const p of shape.params) requireSupportedOwnership(p.type, `parameter "${p.name}"`);
  requireSupportedOwnership(shape.returnType, "return type");

  const label = ocamlLabel(name);
  const paramTypes = shape.params.map((p) => paramType(p.type, ctx, `${name}_${p.name}`));
  const returnType = paramType(shape.returnType, ctx, `${name}Result`);
  const arrowChain = [receiverType, ...paramTypes, returnType];
  return `${docComment(meta)}external ${label} : ${arrowChain.join(" -> ")} = ${JSON.stringify(name)} [@@mel.send]`;
}

// ============================================================================
// resource
// ============================================================================

/**
 * Resource -> a dedicated OCaml module (PascalCase, matching Melange/OCaml's
 * module-naming rule) wrapping an abstract `type t` (per index.ts's own doc
 * comment: "a resource exposes behavior only through its methods map... a
 * resource... 'cannot be plain data structures'" — an abstract type with no
 * exposed representation is the direct Melange analog) plus one `[@mel.send]`
 * external per method, receiver typed `t`. When the resource's OWN
 * `meta.ownership` names `opaque-handle` with a `freeFn`, an additional
 * `[@mel.send]`-bound external for that free function is emitted alongside
 * the declared methods (the same "explicit, separately-declared free
 * function" contract `OwnershipDiscipline`'s own doc comment describes).
 * `"refcount"`/`"resource"` on the resource's own ownership throw, matching
 * `requireSupportedOwnership`'s scope (`"copy"`, the default, and unset both
 * emit no extra free-function binding — nothing to add beyond the abstract
 * type and its methods).
 */
function buildResource(
  name: string,
  shape: FfiShape & { kind: "resource" },
  meta: Readonly<Record<string, unknown>>,
  ctx: Ctx,
): string {
  const discipline = meta.ownership as
    | { readonly kind: string; readonly freeFn?: string }
    | undefined;
  if (
    discipline !== undefined &&
    (discipline.kind === "refcount" || discipline.kind === "resource")
  ) {
    throw new Error(
      `toMelange: unsupported ownership discipline "${discipline.kind}" for the Melange/JS target on resource "${name}" — ` +
        'Melange/JS in this projector implements only "copy" and "opaque-handle" for resource declarations (see the file-level doc comment)',
    );
  }

  const moduleName = toPascalCaseFromWords(name);
  const description = docComment(meta);
  const methods = Object.entries(shape.methods).map(([methodName, methodRef]) =>
    buildResourceMethod(methodName, methodRef, ctx),
  );

  const freeFn = discipline?.kind === "opaque-handle" ? discipline.freeFn : undefined;
  const freeBinding =
    freeFn === undefined
      ? []
      : [`external ${ocamlLabel(freeFn)} : t -> unit = ${JSON.stringify(freeFn)} [@@mel.send]`];

  const body = ["type t", ...freeBinding, ...methods].join("\n\n");
  return [`${description}module ${moduleName} = struct`, indent2(body), "end"].join("\n");
}

function buildResourceMethod(methodName: string, methodRef: FfiRef, ctx: Ctx): string {
  const kind = methodRef.shape.kind;
  if (kind !== "method" && kind !== "function") {
    throw new Error(
      `toMelange: resource method "${methodName}" has unexpected kind "${kind}" (expected "method")`,
    );
  }
  const shape = methodRef.shape as FfiShape & {
    kind: "method";
    params: readonly FfiParam[];
    returnType: TypeRef;
  };
  return buildMethod(methodName, { ...shape, kind: "method" }, methodRef.meta, ctx, "t");
}

function indent2(block: string, prefix = "  "): string {
  return block
    .split("\n")
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join("\n");
}

// ============================================================================
// module
// ============================================================================

/**
 * Module -> an OCaml `module Name = struct ... end` purely for
 * organization (grouping the declarations this FFI boundary exports under
 * one namespace, the same organizing role `wasm-bindgen.ts`'s `pub mod`
 * plays) — every free function inside it additionally gets
 * `[@@mel.module "<name>"]` so it imports from the actual underlying JS
 * module of that name (verified pattern: `[@@mel.module "path"]` generates
 * `var Path = require("path")`), not just an OCaml-side namespace with no
 * runtime import behind it.
 */
function buildModule(name: string, shape: FfiShape & { kind: "module" }, ctx: Ctx): string {
  const resourceDecls = Object.entries(shape.resources).map(([resName, resRef]) =>
    renderFfi(resRef, resName, ctx),
  );
  const functionDecls = Object.entries(shape.functions).map(([fnName, fnRef]) => {
    const fnShape = fnRef.shape as FfiShape & { kind: "function" };
    return buildFunction(fnName, fnShape, fnRef.meta, ctx, name);
  });
  const body = [...resourceDecls, ...functionDecls].join("\n\n");
  return [`module ${toPascalCaseFromWords(name)} = struct`, indent2(body), "end"].join("\n");
}

// ============================================================================
// entry point
// ============================================================================

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target);
}

/** Dispatch shared by `toMelangeFfi` (which additionally prepends hoisted
 * type decls once, at the outermost call) and `buildModule` (which shares
 * one `ctx` across its nested resources/functions so hoisted names are
 * collected once for the whole module rather than duplicated per member). */
function renderFfi(ref: FfiRef, name: string, ctx: Ctx): string {
  const kind = ref.shape.kind;
  if (kind === "function") {
    return buildFunction(
      name,
      ref.shape as FfiShape & { kind: "function" },
      ref.meta,
      ctx,
      undefined,
    );
  }
  if (kind === "method") {
    throw new Error(
      `toMelangeFfi: a top-level "method" needs its receiver's resource type — call this via a "resource"'s methods map instead`,
    );
  }
  if (kind === "resource") {
    return buildResource(name, ref.shape as FfiShape & { kind: "resource" }, ref.meta, ctx);
  }
  if (kind === "module") {
    return buildModule(name, ref.shape as FfiShape & { kind: "module" }, ctx);
  }
  if (isA(kind, "function")) {
    return buildFunction(
      name,
      ref.shape as FfiShape & { kind: "function" },
      ref.meta,
      ctx,
      undefined,
    );
  }
  throw new Error(
    `toMelangeFfi: unhandled ffi-ir kind "${kind}" (no handler and no known ancestor)`,
  );
}

/**
 * Lower an ffi-ir `FfiRef` to Melange `external`-declaration source text.
 * `name` is required for every kind (`function`/`method`/`resource`/
 * `module` are all named declarations — mirrors `toWasmBindgenFfi`'s/
 * `toWit`'s own identical requirement). Any hoisted record/enum type
 * declarations a `function`/`method`/`resource` needed along the way are
 * collected once and prepended before the requested declaration.
 */
export function toMelangeFfi(ref: FfiRef, name?: string): string {
  if (name === undefined) {
    throw new Error(
      `toMelangeFfi: "${ref.shape.kind}" requires a name — Melange externals/modules are named declarations, not anonymous inline types`,
    );
  }
  const ctx = newCtx();
  const rendered = renderFfi(ref, name, ctx);
  return ctx.decls.length === 0 ? rendered : [...ctx.decls, rendered].join("\n\n");
}
