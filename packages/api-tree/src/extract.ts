// Build-time extractor: types + JSDoc are the source of truth. This module
// reads op source via the TypeScript compiler API — read-only type analysis,
// not a code transform — and derives two things a runtime projection cannot
// see:
//
//   1. a JSON-Schema for an op's input parameter type
//   2. the op's leading JSDoc description text
//
// Scope: obvious shapes only. Object types with primitive fields
// (string/number/boolean), optional (`?` / `| undefined`), arrays, and nested
// objects are lowered structurally. Callable types (arrow/function values,
// callback params, method-shaped fields) lower to `types.function`. Anything
// still exotic (unions, generics, constructable types, …) punts to
// `t(types.unknown, { $comment })` carrying a `$comment` that names the
// unhandled case — self-documenting rather than silently lossy. Extraction
// goes TS type → TypeRef → JSON Schema; the TypeRef is produced here and
// projected via `@rhi-zone/fractal-type-ir/json-schema`'s `toJsonSchema`.
//
// Derived from types only: there is no hand-authored schema anywhere. If a
// shape isn't recovered here, it degrades to the MCP spec minimum, never to a
// second source of truth.
//
// See:
//   packages/api-tree/src/node.ts    — the op model (`op(fn, meta)`)
//   packages/mcp-api-projector/src/project.ts  — the consumer (toTools inputSchema/description)

import ts from "typescript";
import { t, types, type TypeRef } from "@rhi-zone/fractal-type-ir";
import { toJsonSchema } from "@rhi-zone/fractal-type-ir/json-schema";
import {
  createExtractorProgram,
  createSharingRegistry,
  defaultShouldShare,
  finalizeSharedDefs,
  type SharingRegistry,
  type ShouldShare,
  typeRefFromType,
} from "@rhi-zone/fractal-type-ir/from-typescript";

// Re-exported here for API compatibility: the canonical definitions live in
// `@rhi-zone/fractal-type-ir/from-typescript` (the general-purpose ts.Type →
// TypeRef ingester; see that module's header comment for the full rationale).
// This package's own callers (`tree.ts`, `build.ts`) and its test suite
// import these names from "./extract.ts" directly.
export {
  createExtractorProgram,
  createSharingRegistry,
  defaultShouldShare,
  finalizeSharedDefs,
  type SharingRegistry,
  type ShouldShare,
  typeRefFromType,
};

/** The TypeRef punt: `unknown` tagged with the unhandled case. Used only by
 * this module's own api-tree-specific extraction paths (op function-node
 * input, `Result<T, E>` return-type unwrapping) — `typeRefFromType`'s own
 * internal punts live with it in `@rhi-zone/fractal-type-ir/from-typescript`. */
const puntRef = (reason: string): TypeRef =>
  t(types.unknown, { $comment: `TODO(type-ir): unhandled type — ${reason}` });

// ============================================================================
// JSON-Schema value (structural subset we emit)
// ============================================================================

/**
 * The JSON-Schema shapes this extractor produces. `$comment` carries a
 * `TODO(codegen): …` marker on any punted node so the fallback is visible in
 * the emitted value itself. Punted nodes now come from `types.unknown` via
 * the TypeRef projector, so `type` is no longer guaranteed present.
 *
 * This type's field set must stay a superset of everything
 * `@rhi-zone/fractal-type-ir/json-schema`'s `toJsonSchema` can actually
 * emit (that module's own `JsonSchema` is intentionally the fully-open
 * `Record<string, unknown>` — a codegen-time projector, not a validated
 * value — so this type is the one place a consumer gets real field-level
 * structure). Every field below is either a shape-kind's own base rendering
 * (`type`/`properties`/`items`/…) or one of `json-schema.ts`'s
 * `withMeta`/`passthroughKeys` meta-driven additions (numeric/string
 * constraints, `readOnly`/`writeOnly`, `$comment`, …) — see that module for
 * the authoritative emission list. `$ref`/`discriminator` are the two
 * structural-sharing/union-tag fields (`json-schema.ts`'s `ref`-kind
 * rendering and `discriminatedUnion` handling respectively).
 *
 * Keeping this field set in sync with `toJsonSchema`'s actual emission is a
 * manual invariant, not a compiler-checked one: a consumer that reads the
 * result as loosely-typed data (an `as JsonSchema` cast inside this module,
 * or JSON serialized straight through) never type-checks a concrete
 * extracted value's literal shape against this type. A consumer that treats
 * the value structurally instead — e.g. the sibling codebase's
 * `codegen-fractal-validators.ts` schema-artifact codegen, which emits
 * `export const schemas: SchemaMap = <object literal>` — will catch a drift
 * here that the loose `as`-cast path does not.
 */
export type JsonSchema = {
  type?: "string" | "number" | "boolean" | "array" | "object";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | false;
  prefixItems?: JsonSchema[];
  additionalProperties?: JsonSchema;
  const?: string | number | boolean | null;
  enum?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  /** Structural intersection (`json-schema.ts`'s `intersection` shape kind
   * — draft 2020-12 §10.2.1.1: every listed schema must validate). */
  allOf?: JsonSchema[];
  discriminator?: { propertyName: string };
  // Vendor-extension keys (`x-`-prefixed, same convention across
  // `json-schema.ts`'s degrade-honestly shape kinds — a callable/
  // interface/class-instance/stream/paginated-sequence type has no native
  // JSON-Schema vocabulary, so each degrades to the closest structural
  // shape (`object`/`array`/untyped) plus one of these markers so tooling
  // that cares can still tell what it degraded from).
  "x-function"?: boolean;
  "x-method"?: boolean;
  "x-interface"?: boolean;
  "x-class-name"?: string;
  "x-declaration-file"?: string;
  "x-stream"?: boolean;
  "x-page-style"?: string;
  /** Structural-sharing reference (`json-schema.ts`'s `ref`-kind rendering)
   * — `#/$defs/<name>`, resolved against the containing document's
   * `$defs` (see `toJsonSchema`'s own doc comment on how `defs` surfaces
   * at the document root vs. inline). */
  $ref?: string;
  $comment?: string;
  // Numeric/string constraint passthroughs — `json-schema.ts`'s
  // `passthroughKeys`, copied verbatim from a TypeRef's `meta` onto the
  // projected schema whenever present (branded numeric/string kinds,
  // `t(types.string, { minLength: 1 })`-style meta, …).
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  multipleOf?: number;
  /** String/number sub-format (`json-schema.ts`'s tagged leaf kinds —
   * `int32`/`int64`/`float32`/`float64`/`uuid`/`uri`/`email`/`datetime`/
   * `date`/`time`/`duration`). */
  format?: string;
  readOnly?: boolean;
  writeOnly?: boolean;
  title?: string;
  deprecated?: boolean;
  examples?: unknown[];
  // `description`/`default` are emitted by the underlying type-ir projector
  // (json-schema.ts's `withMeta`) whenever a TypeRef carries
  // `meta.description`/`meta.default`. `typeRefFromType` (in
  // `@rhi-zone/fractal-type-ir/from-typescript`) populates both per
  // object-type property from source JSDoc: a leading `/** … */` comment →
  // `description`, an `@default` tag → `default` (see that module's
  // `propertyDescriptionOf` / `propertyDefaultOf`). Declared here so
  // consumers (e.g. the CLI projector's help text / default-value
  // application) can read them without an `as Record<string, unknown>`
  // escape hatch at every read site.
  description?: string;
  default?: string | number | boolean;
};

// ============================================================================
// Core: TypeScript type → JSON-Schema
// ============================================================================

/**
 * Lower a resolved `ts.Type` to a JSON-Schema value.
 *
 * Handles the obvious cases; punts everything else to `unknown` with a
 * `$comment` naming the case. `loc` anchors symbol-type resolution.
 */
export function schemaFromType(type: ts.Type, checker: ts.TypeChecker, loc: ts.Node): JsonSchema {
  return toJsonSchema(typeRefFromType(type, checker, loc)) as JsonSchema;
}

// ============================================================================
// Function/op input → JSON-Schema
// ============================================================================

/**
 * True when `fileName` is one of TypeScript's own bundled ambient
 * declaration files (`lib.es5.d.ts`, `lib.dom.d.ts`, `lib.esnext.d.ts`, …) —
 * the files a `ts.Program` implicitly includes for every project regardless
 * of `node_modules` layout (a global/bare install, a `.bun` hoisted path, a
 * pnpm content-addressed store, …), always shaped
 * `<…>/typescript/lib/lib.<name>.d.ts`. These declare TypeScript's own
 * global utility types (`Record`, `Partial`, `Pick`, `Omit`, `Readonly`,
 * `Array`, `ReadonlyArray`, `Map`, `Set`, `Promise`, …) as ambient ("no
 * export") declarations — ones a generated `import type { X } from "…"`
 * can never actually reach (`TS2306: File '…' is not a module`), because
 * they were never a module's *export* to import in the first place; they're
 * globally in scope everywhere already, no import needed at all. Matched by
 * path rather than by an enumerated type-name list so the whole class of
 * built-in/global TS utility types is covered generally (see
 * `typeProvenanceOf`'s doc comment below), not just the ones observed to
 * trip this so far.
 */
function isTsBuiltinLibFile(fileName: string): boolean {
  return /[\\/]typescript[\\/]lib[\\/]lib\.[a-z0-9.]+\.d\.ts$/i.test(fileName);
}

/**
 * The declared-type provenance of a top-level extracted type: its name and
 * the absolute path of the file it's declared in — recoverable only when the
 * type is named (a `type X = …` alias or an `interface X {…}`), not for an
 * anonymous/inline shape (`(input: { q: string }) => …`).
 *
 * Read only at the top level (a handler's own parameter type), not while
 * descending into `typeRefFromType`'s structural walk — nested named types
 * (e.g. a field typed `Address`) are still inlined structurally there; only
 * the outer type gets a name worth importing, since that's the one a
 * generated type-guard annotation needs to reference.
 *
 * Anonymous object-shaped types resolve to a symbol TypeScript itself names
 * `"__type"` — its own universal synthesized placeholder for "an object type
 * with no user-given name," emitted uniformly regardless of what produced
 * the shape: a literal `{ … }` (`ts.TypeLiteralNode`), a mapped type
 * (`{ [K in keyof T]: … }`, `ts.MappedTypeNode`), or any other combinator
 * that resolves to a fresh anonymous object type. Excluded here by name
 * (`symbol.name === "__type"`) — general across every AST node kind that can
 * produce it, not narrowed to `ts.TypeLiteralNode` — so it falls through to
 * structural inlining instead of being treated as "named". `"__type"` is
 * TypeScript's own compiler-internal convention (a double-underscore-prefixed
 * synthesized name), never a real project export, so the exclusion is safe
 * unconditionally.
 *
 * A TS builtin/global utility type used directly as a handler's whole input
 * (`(input: Record<string, unknown>) => …`, `(input: Partial<Foo>) => …`, …)
 * is excluded the same way: its alias/symbol declaration lives in one of
 * TypeScript's own bundled `lib.*.d.ts` files (`isTsBuiltinLibFile` above),
 * which is nameable (`type.aliasSymbol.name === "Record"`) but never
 * importable — there is no module at that path to import from. Falling
 * through here (returning `undefined`) routes it to the same structural
 * inlining every anonymous type already gets, which is always correct:
 * every builtin utility type has a real structural TypeScript rendering
 * (`toTypeScript` — `compile.ts`'s `guardAnnotation` fallback).
 *
 * A type alias whose body resolves through a generic mapped type — e.g.
 * `type X = SomeLibrary.InferOutput<typeof schema>` (valibot's
 * `InferOutput`, a `MappedTypeNode`-shaped conditional/mapped utility) — can
 * have `aliasSymbol` undefined at the parameter-type reference site, since TS
 * does not always preserve the outer alias symbol through a generic
 * mapped-type instantiation; resolution falls to the `symbol` branch, whose
 * declaration is a `MappedTypeNode` rather than a `TypeLiteralNode`. The
 * name-based `"__type"` exclusion above covers this case too, since it
 * matches on the symbol name regardless of which AST node kind declared it —
 * a check narrowed to `ts.TypeLiteralNode` would treat `"__type"` as a real,
 * importable name and emit an unresolvable `import type { __type } from
 * "…"` (as happened for valibot's `InferOutput`, which never exports
 * `__type`, producing `TS2305`).
 */
function typeProvenanceOf(
  type: ts.Type,
  _checker: ts.TypeChecker,
): { name: string; declarationFile: string } | undefined {
  const aliasSymbol = type.aliasSymbol;
  const aliasDecl = aliasSymbol?.declarations?.[0];
  if (aliasSymbol && aliasDecl && aliasSymbol.name !== "__type") {
    const declarationFile = aliasDecl.getSourceFile().fileName;
    if (isTsBuiltinLibFile(declarationFile)) return undefined;
    return { name: aliasSymbol.name, declarationFile };
  }
  const symbol = type.getSymbol();
  const decl = symbol?.declarations?.[0];
  if (symbol && decl && symbol.name !== "__type") {
    const declarationFile = decl.getSourceFile().fileName;
    if (isTsBuiltinLibFile(declarationFile)) return undefined;
    return { name: symbol.name, declarationFile };
  }
  return undefined;
}

/**
 * Derive the input TypeRef from a function-typed node (arrow or function
 * expression): its first parameter's type is the op input. A niladic op
 * lowers to an empty object TypeRef.
 *
 * When the parameter type is a named type (alias/interface, not an inline
 * object literal), the returned TypeRef carries `meta.typeName` +
 * `meta.declarationFile` — provenance a codegen consumer (e.g.
 * `@rhi-zone/fractal-type-ir`'s `compileWireEntryFragment`, via
 * `guardAnnotation`) can use to `import type { X } from "…"` instead of
 * inlining the type's structure into a generated annotation. See index.ts's
 * meta-bag convention doc comment.
 */
export function typeRefFromFunctionNode(
  fn: ts.Node,
  checker: ts.TypeChecker,
  registry?: SharingRegistry,
): TypeRef {
  const fnType = checker.getTypeAtLocation(fn);
  const [sig] = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call);
  if (!sig) return puntRef("no call signature on op fn");
  const [param] = sig.getParameters();
  if (!param) return t(types.object({}));
  const paramType = checker.getTypeOfSymbolAtLocation(param, fn);
  const ref = typeRefFromType(paramType, checker, fn, undefined, registry);
  const provenance = typeProvenanceOf(paramType, checker);
  return provenance
    ? t(ref.shape, {
        ...ref.meta,
        typeName: provenance.name,
        declarationFile: provenance.declarationFile,
      })
    : ref;
}

/**
 * Derive the input schema from a function-typed node (arrow or function
 * expression): its first parameter's type is the op input. A niladic op
 * lowers to an empty object schema.
 */
export function schemaFromFunctionNode(fn: ts.Node, checker: ts.TypeChecker): JsonSchema {
  return toJsonSchema(typeRefFromFunctionNode(fn, checker)) as JsonSchema;
}

// ============================================================================
// Result<T, E> recognition — AST-level syntax approach
// ============================================================================

//
// Result<T, E> unwrapping under skipLibCheck.
//
// With `skipLibCheck: true`, the TypeScript compiler keeps alias
// instantiations in an "unresolved" state (`type.flags === TypeFlags.Any`
// internally): `type.isUnion()` is false for `Result<T, E>` even though it
// is a union alias, `aliasSymbol.declarations` is always undefined, and
// `getAliasedSymbol()` resolves to `unknown` with no declarations. That
// rules out structural matching on the resolved union and file-path
// nominal checks.
//
// What is available on the unresolved type: `aliasSymbol.name`,
// `aliasTypeArguments`, the AST syntax nodes of an explicit return type
// annotation (the TypeReferenceNode's typeName identifier and its
// typeArguments), and local TypeAlias declarations — for an alias like
// `type ApiResult<T> = Result<T, E>`, the declaration lives in the same
// file and is accessible.
//
// Two paths follow from this:
//   1. Syntax path (primary, annotated returns) — walks the function's
//      return type annotation node (fn.type). A TypeReference named
//      "Result" with ≥ 2 type args, or one pointing to a local TypeAlias
//      whose body is `Result<T, ...>`, yields T = the first type arg.
//      Promise<Result<T,E>> is handled by stripping the Promise
//      TypeReference first. Covers: (a) direct import, (b) barrel import
//      (no rename), (c) further-generic alias.
//   2. Structural path (fallback, inferred returns or fully-resolved
//      types) — matches the exact discriminated-union shape
//      `{ kind: "ok"; value: T } | { kind: "err"; error: E }` when the
//      return type is already a proper union.
//
// The "Result" name is the discriminant for path 1, so an arbitrary union
// without an alias named "Result" never triggers it. Path 2's exact field
// match (kind/value/error with "ok"/"err" string-literal discriminants) is
// specific enough to avoid accidental collisions on unrelated unions.

/**
 * Given a TypeReferenceNode (possibly `Promise<ResultRef<T,E>>`), try to find
 * the inner TypeReferenceNode that represents `Result<T,E>` and return the
 * first type argument node (the `T` in `Result<T,E>`).
 *
 * Unwrapping order:
 *   1. If the outermost ref is "Promise", descend to its first type argument.
 *   2. If the (possibly descended) ref is named "Result" with ≥ 2 type args →
 *      return the first type arg node.
 *      Nominal: covers (a) direct import and (b) barrel with no rename.
 *   3. If the ref's identifier is an import alias (ImportSpecifier) and the
 *      original exported name is "Result" → it's a renamed barrel re-export
 *      (`import { Result as X } from "..."`). Extract the call site's first arg.
 *      Nominal: covers (b) barrel with rename.
 *   4. If the ref points to a local TypeAlias (declarations accessible in the
 *      same file) whose body is a TypeReference named "Result" with ≥ 1 type
 *      parameter → the first alias type parameter maps positionally to the call
 *      site's first type argument. Extract it.
 *      Covers (c) further-generic aliases like `type ApiResult<T> = Result<T, E>`.
 *
 * Returns the T typeNode on success, undefined if the pattern doesn't match.
 */
function resultTypeArgNodeFrom(
  typeRefNode: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  if (!ts.isIdentifier(typeRefNode.typeName)) return undefined;

  // Strip Promise<X> → recurse into X
  if (typeRefNode.typeName.text === "Promise") {
    const inner = typeRefNode.typeArguments?.[0];
    if (!inner || !ts.isTypeReferenceNode(inner)) return undefined;
    return resultTypeArgNodeFrom(inner, checker);
  }

  // (a) / (b-no-rename): direct "Result" name with ≥ 2 type arguments.
  //   Covers: `import { Result } from "@rhi-zone/fractal-api-tree"` (a)
  //           `import { Result } from "./barrel"`               (b, no rename)
  if (typeRefNode.typeName.text === "Result" && (typeRefNode.typeArguments?.length ?? 0) >= 2) {
    return typeRefNode.typeArguments![0];
  }

  // Resolve the identifier's symbol for remaining cases.
  const sym = checker.getSymbolAtLocation(typeRefNode.typeName);
  if (!sym) return undefined;

  // (b-rename): import alias → `import { Result as X } from "..."`.
  //   The import specifier's declarations are accessible (same file) even with
  //   skipLibCheck. The specifier's original name (propertyName) must be
  //   "Result", confirming the barrel re-exports core's Result under a
  //   different local name.
  if (sym.flags & ts.SymbolFlags.Alias) {
    const specDecl = sym.declarations?.[0];
    if (specDecl && ts.isImportSpecifier(specDecl)) {
      // propertyName is set when renamed (`Result as X`); name is the local name.
      const originalName = specDecl.propertyName?.text ?? specDecl.name.text;
      if (originalName === "Result" && (typeRefNode.typeArguments?.length ?? 0) >= 1) {
        return typeRefNode.typeArguments![0];
      }
    }
  }

  // (c): local TypeAlias → `type ApiResult<T> = Result<T, SomeError>`.
  //   Local alias declarations are accessible (same file, not behind skipLibCheck).
  //   If the alias's body is a TypeReference to "Result" with ≥ 1 type parameter,
  //   the first type parameter maps positionally to the call site's first type arg.
  if (sym.flags & ts.SymbolFlags.TypeAlias && sym.declarations?.[0]) {
    const decl = sym.declarations[0];
    if (
      ts.isTypeAliasDeclaration(decl) &&
      ts.isTypeReferenceNode(decl.type) &&
      ts.isIdentifier(decl.type.typeName) &&
      decl.type.typeName.text === "Result" &&
      (decl.typeParameters?.length ?? 0) >= 1
    ) {
      return typeRefNode.typeArguments?.[0];
    }
  }

  return undefined;
}

/**
 * Structural fallback: detect the exact Result discriminated-union shape.
 *
 * Fires only when the return type is already a proper union — which happens
 * for inferred return types or when types are fully resolved (not under
 * skipLibCheck). Does not fire for the alias-instantiation case, since those
 * types stay "unresolved" under this extractor's program configuration.
 *
 * Exact shape from packages/api-tree/src/index.ts:
 *   `{ readonly kind: "ok"; readonly value: T } | { readonly kind: "err"; readonly error: E }`
 *
 * Match criteria (all must hold to avoid false positives on arbitrary unions):
 *   1. Union of exactly 2 members
 *   2. Each member has property `kind` typed as a StringLiteral ("ok" or "err")
 *   3. The `kind: "ok"` member has a `value` property → T extracted from it
 *   4. The `kind: "err"` member has an `error` property (guards against accidental matches)
 *
 * Returns the type of the `value` property (T), or undefined on mismatch.
 */
function structuralResultValueType(
  type: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
): ts.Type | undefined {
  if (!type.isUnion()) return undefined;
  const members = type.types;
  if (members.length !== 2) return undefined;

  let okMember: ts.Type | undefined;
  let errMember: ts.Type | undefined;

  for (const member of members) {
    const kindProp = member.getProperty("kind");
    if (!kindProp) return undefined;
    const kindType = checker.getTypeOfSymbolAtLocation(kindProp, loc);
    if (!kindType.isStringLiteral()) return undefined;
    if (kindType.value === "ok") okMember = member;
    else if (kindType.value === "err") errMember = member;
    else return undefined;
  }

  if (!okMember || !errMember) return undefined;

  // kind:"ok" branch must have `value` (T)
  const valueProp = okMember.getProperty("value");
  if (!valueProp) return undefined;

  // kind:"err" branch must have `error` (E) — guards against accidental matches
  const errorProp = errMember.getProperty("error");
  if (!errorProp) return undefined;

  return checker.getTypeOfSymbolAtLocation(valueProp, loc);
}

// ============================================================================
// Function/op return type → JSON-Schema
// ============================================================================

/**
 * Derive the output schema from a function-typed node by inspecting its return
 * type. Unwraps `Result<T, E>` and `Promise<Result<T, E>>` to yield T's schema.
 * Exotic/unresolvable return types punt to `unknown` with a TODO $comment,
 * consistent with the input-side fallback.
 *
 * Unwrapping uses two paths (see the note on Result<T, E> unwrapping above):
 *
 *   Syntax path (primary): reads the explicit return type annotation node.
 *     Handles `Result<T,E>` directly, barrel re-exports (no rename), and
 *     further-generic local aliases like `type ApiResult<T> = Result<T, E>`.
 *
 *   Structural path (fallback): matches the exact DU shape when the return
 *     type is a proper union — covers inferred-return cases or fully-resolved
 *     contexts outside of skipLibCheck.
 */
export function typeRefFromReturnType(
  fn: ts.Node,
  checker: ts.TypeChecker,
  registry?: SharingRegistry,
): TypeRef {
  const fnType = checker.getTypeAtLocation(fn);
  const [sig] = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call);
  if (!sig) return puntRef("no call signature on op fn");

  // ── Syntax path: explicit return type annotation on the function node ────
  //
  // When the function has an explicit `: ReturnType` annotation, that type
  // node is read from the AST directly, giving the full structure (including
  // type argument positions) without relying on the checker's alias
  // resolution, which skipLibCheck blocks.
  //
  // `Promise<Result<T,E>>` is detected by stripping the outer Promise TypeRef
  // and recursing; `Result<T,E>` by name + 2 type args; local aliases like
  // `ApiResult<T>` by checking their declaration's body.
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const retTypeNode = fn.type;
    if (retTypeNode && ts.isTypeReferenceNode(retTypeNode)) {
      const tNode = resultTypeArgNodeFrom(retTypeNode, checker);
      if (tNode !== undefined) {
        const tType = checker.getTypeAtLocation(tNode);
        return typeRefFromType(tType, checker, fn, undefined, registry);
      }
    }
  }

  // ── Type-level path: inferred returns or non-annotated functions ─────────
  //
  // Fall through to the resolved return type from the call signature.
  let returnType = checker.getReturnTypeOfSignature(sig);

  // Strip Promise<T> at the type level (concrete Promise objects resolve fine).
  if (returnType.symbol?.name === "Promise") {
    const args = checker.getTypeArguments(returnType as ts.TypeReference);
    const inner = args[0];
    if (inner === undefined) return puntRef("Promise with no type argument");
    returnType = inner;
  }

  // Structural path: match the exact DU shape from core/src/index.ts.
  // Fires when the type is a proper union (not an unresolved alias instantiation).
  const structuralValue = structuralResultValueType(returnType, checker, fn);
  if (structuralValue !== undefined) {
    returnType = structuralValue;
  }

  return typeRefFromType(returnType, checker, fn, undefined, registry);
}

/**
 * Derive the output schema from a function-typed node by inspecting its return
 * type. Unwraps `Result<T, E>` and `Promise<Result<T, E>>` to yield T's schema.
 */
export function schemaFromReturnType(fn: ts.Node, checker: ts.TypeChecker): JsonSchema {
  return toJsonSchema(typeRefFromReturnType(fn, checker)) as JsonSchema;
}

// ============================================================================
// JSDoc → description
// ============================================================================

/** Read the flattened JSDoc comment text off a single node, if present. */
function jsDocTextOf(node: ts.Node): string | undefined {
  for (const j of ts.getJSDocCommentsAndTags(node)) {
    if (ts.isJSDoc(j)) {
      const text = ts.getTextOfJSDocComment(j.comment);
      if (text && text.trim().length > 0) return text.trim();
    }
  }
  return undefined;
}

/**
 * Extract the leading JSDoc description of a node, flattened to a single
 * trimmed string. JSDoc attaches to the owning declaration statement, so this
 * climbs to the nearest statement if the node itself carries none. Returns
 * undefined when absent.
 */
export function extractJsDoc(node: ts.Node): string | undefined {
  const own = jsDocTextOf(node);
  if (own) return own;
  let cur: ts.Node | undefined = node.parent;
  while (cur && !ts.isSourceFile(cur)) {
    const text = jsDocTextOf(cur);
    if (text) return text;
    if (ts.isStatement(cur)) break;
    cur = cur.parent;
  }
  return undefined;
}

// ============================================================================
// Op-value extraction
// ============================================================================
//
// `createExtractorProgram` lives in `@rhi-zone/fractal-type-ir/from-typescript`
// (general-purpose `ts.Program` factory) and is re-exported above.

/**
 * Given an op value expression from source, return the function node it wraps.
 * Supports `op(fn, meta)` calls and bare arrow/function expressions. `op` need
 * not resolve — only the arrow's own parameter annotation is read.
 */
export function opFunctionNode(expr: ts.Expression): ts.Node | undefined {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return expr;
  if (ts.isCallExpression(expr)) {
    const [first] = expr.arguments;
    if (first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))) {
      return first;
    }
  }
  return undefined;
}
