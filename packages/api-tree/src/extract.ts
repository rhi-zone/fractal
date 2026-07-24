// packages/api-tree/src/extract.ts — @rhi-zone/fractal-api-tree
//
// BUILD-TIME EXTRACTOR: types + JSDoc are the truth. This module reads op
// source (via the TypeScript compiler API — read-only analysis, NOT a
// transformer) and DERIVES two things a runtime projection cannot see:
//
//   1. a JSON-Schema for an op's input parameter type
//   2. the op's leading JSDoc description text
//
// Scope: obvious shapes only. Object types with primitive fields
// (string/number/boolean), optional (`?` / `| undefined`), arrays, and nested
// objects are lowered structurally. Callable types (arrow/function values,
// callback params, method-shaped fields) lower to `types.function`. Anything
// still exotic (unions, generics, constructable types, …) is PUNTED to
// `t(types.unknown, { $comment })` carrying a `$comment` that names the
// unhandled case — self-documenting rather than silently lossy. Extraction
// goes TS type → TypeRef → JSON Schema; the
// TypeRef is produced here and projected via
// `@rhi-zone/fractal-type-ir/json-schema`'s `toJsonSchema`.
//
// Derived-from-type ONLY: there is no hand-authored schema anywhere. If a shape
// isn't recovered here, it degrades to the MCP spec minimum, never to a second
// source of truth.
//
// See:
//   packages/api-tree/src/node.ts    — the op model (`op(fn, meta)`)
//   packages/mcp-api-projector/src/project.ts  — the consumer (toTools inputSchema/description)

import ts from "typescript"
import { t, types, type TypeRef } from "@rhi-zone/fractal-type-ir"
import { toJsonSchema } from "@rhi-zone/fractal-type-ir/json-schema"
import {
  createExtractorProgram,
  createSharingRegistry,
  defaultShouldShare,
  finalizeSharedDefs,
  type SharingRegistry,
  type ShouldShare,
  typeRefFromType,
} from "@rhi-zone/fractal-type-ir/from-typescript"

// Re-exported for backward compatibility — every symbol below moved to
// `@rhi-zone/fractal-type-ir/from-typescript` (the general-purpose ts.Type →
// TypeRef ingester; see that module's header comment for the full rationale).
// This package's own callers (`tree.ts`, `build.ts`) and its test suite still
// import these names from "./extract.ts", so they're re-exported here rather
// than requiring every call site to be repointed at the new module.
export {
  createExtractorProgram,
  createSharingRegistry,
  defaultShouldShare,
  finalizeSharedDefs,
  type SharingRegistry,
  type ShouldShare,
  typeRefFromType,
}

/** The TypeRef punt: `unknown` tagged with the unhandled case. Used only by
 * this module's own api-tree-specific extraction paths (op function-node
 * input, `Result<T, E>` return-type unwrapping) — `typeRefFromType`'s own
 * internal punts live with it in `@rhi-zone/fractal-type-ir/from-typescript`. */
const puntRef = (reason: string): TypeRef =>
  t(types.unknown, { $comment: `TODO(type-ir): unhandled type — ${reason}` })

// ============================================================================
// JSON-Schema value (structural subset we emit)
// ============================================================================

/**
 * The JSON-Schema shapes this extractor produces. `$comment` carries a
 * `TODO(codegen): …` marker on any punted node so the fallback is visible in
 * the emitted value itself. Punted nodes now come from `types.unknown` via
 * the TypeRef projector, so `type` is no longer guaranteed present.
 */
export type JsonSchema = {
  type?: "string" | "number" | "boolean" | "array" | "object"
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema | false
  prefixItems?: JsonSchema[]
  additionalProperties?: JsonSchema
  const?: string | number | boolean | null
  enum?: string[]
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  discriminator?: { propertyName: string }
  $comment?: string
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
  description?: string
  default?: string | number | boolean
}

// ============================================================================
// Core: TypeScript type → JSON-Schema
// ============================================================================

/**
 * Lower a resolved `ts.Type` to a JSON-Schema value.
 *
 * Handles the obvious cases; punts everything else to `unknown` with a
 * `$comment` naming the case. `loc` anchors symbol-type resolution.
 */
export function schemaFromType(
  type: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
): JsonSchema {
  return toJsonSchema(typeRefFromType(type, checker, loc)) as JsonSchema
}

// ============================================================================
// Function/op input → JSON-Schema
// ============================================================================

/**
 * The declared-type provenance of a top-level extracted type: its name and
 * the absolute path of the file it's declared in — recoverable only when the
 * type is NAMED (a `type X = …` alias or an `interface X {…}`), not for an
 * anonymous/inline shape (`(input: { q: string }) => …`).
 *
 * Read only at the top level (a handler's own parameter type), not while
 * descending into `typeRefFromType`'s structural walk — nested named types
 * (e.g. a field typed `Address`) are still inlined structurally there, same
 * as before; only the OUTER type gets a name worth importing, since that's
 * the one a generated type-guard annotation needs to reference.
 *
 * Anonymous object-literal types resolve to a symbol whose sole declaration
 * is a `ts.TypeLiteralNode` (the `{ … }` syntax itself, not a named
 * declaration) — excluded here so those fall through to structural inlining
 * instead of being treated as "named".
 */
function typeProvenanceOf(
  type: ts.Type,
  _checker: ts.TypeChecker,
): { name: string; declarationFile: string } | undefined {
  const aliasSymbol = type.aliasSymbol
  const aliasDecl = aliasSymbol?.declarations?.[0]
  if (aliasSymbol && aliasDecl) {
    return { name: aliasSymbol.name, declarationFile: aliasDecl.getSourceFile().fileName }
  }
  const symbol = type.getSymbol()
  const decl = symbol?.declarations?.[0]
  if (symbol && decl && !ts.isTypeLiteralNode(decl)) {
    return { name: symbol.name, declarationFile: decl.getSourceFile().fileName }
  }
  return undefined
}

/**
 * Derive the input TypeRef from a function-typed node (arrow or function
 * expression): its first parameter's type is the op input. A niladic op
 * lowers to an empty object TypeRef.
 *
 * When the parameter type is a NAMED type (alias/interface, not an inline
 * object literal), the returned TypeRef carries `meta.typeName` +
 * `meta.declarationFile` — provenance a codegen consumer (e.g.
 * `@rhi-zone/fractal-type-ir`'s `compileValidatorModule`) can use to `import
 * type { X } from "…"` instead of inlining the type's structure into a
 * generated annotation. See index.ts's meta-bag convention doc comment.
 */
export function typeRefFromFunctionNode(
  fn: ts.Node,
  checker: ts.TypeChecker,
  registry?: SharingRegistry,
): TypeRef {
  const fnType = checker.getTypeAtLocation(fn)
  const [sig] = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call)
  if (!sig) return puntRef("no call signature on op fn")
  const [param] = sig.getParameters()
  if (!param) return t(types.object({}))
  const paramType = checker.getTypeOfSymbolAtLocation(param, fn)
  const ref = typeRefFromType(paramType, checker, fn, undefined, registry)
  const provenance = typeProvenanceOf(paramType, checker)
  return provenance
    ? t(ref.shape, { ...ref.meta, typeName: provenance.name, declarationFile: provenance.declarationFile })
    : ref
}

/**
 * Derive the input schema from a function-typed node (arrow or function
 * expression): its first parameter's type is the op input. A niladic op
 * lowers to an empty object schema.
 */
export function schemaFromFunctionNode(
  fn: ts.Node,
  checker: ts.TypeChecker,
): JsonSchema {
  return toJsonSchema(typeRefFromFunctionNode(fn, checker)) as JsonSchema
}

// ============================================================================
// Result<T, E> recognition — AST-level syntax approach
// ============================================================================

//
// ARCHITECTURE NOTE: The TypeScript compiler, when run with `skipLibCheck: true`
// on this project, keeps alias instantiations in an "unresolved" state
// (`type.flags === TypeFlags.Any` internally). This means:
//   - `type.isUnion()` is false for `Result<T, E>` even though it IS a union alias
//   - `aliasSymbol.declarations` is always undefined (modules not fully resolved)
//   - `getAliasedSymbol()` resolves to `unknown` with no declarations
//
// This rules out:
//   - Structural matching on the resolved union (type isn't a union yet)
//   - File-path nominal checks (no declarations to read)
//
// WHAT DOES WORK:
//   - `aliasSymbol.name` — the alias name is available on the unresolved type
//   - `aliasTypeArguments` — the type arguments are available
//   - AST syntax nodes — when an explicit return type annotation exists, the
//     TypeReferenceNode's typeName identifier and its typeArguments are accessible
//   - Local TypeAlias declarations — for local aliases like `type ApiResult<T> = Result<T, E>`,
//     the declaration IS in the same file and IS accessible (sym.declarations is defined)
//
// STRATEGY:
//   1. SYNTAX PATH (primary, for annotated returns):
//      Walk the function's return type annotation node (fn.type).
//      For a TypeReference named "Result" with ≥ 2 typeArgs → T = typeArgs[0].
//      For a TypeReference to a LOCAL TypeAlias whose body is Result<T,...> → T = typeRef's typeArgs[0].
//      Also handles Promise<Result<T,E>>: strip the Promise TypeReference first.
//      This covers: (a) direct import, (b) barrel import (no rename), (c) further-generic alias.
//
//   2. STRUCTURAL PATH (fallback, for INFERRED returns or fully-resolved types):
//      When the return type IS a proper union (rare in this extractor's usage but
//      possible when types resolve fully), check the exact DU shape:
//        `{ kind: "ok"; value: T } | { kind: "err"; error: E }`
//      This fires when the type was genuinely expanded to a union.
//
//   3. FALSE-POSITIVE GUARD:
//      The name check ("Result") is the primary discriminant. Arbitrary unions
//      without an alias named "Result" never trigger path 1.
//      The structural path (2) matches the exact DU fields (kind/value/error with
//      string literal discriminants "ok"/"err") — too specific for accidental collisions.

/**
 * Given a TypeReferenceNode (possibly `Promise<ResultRef<T,E>>`), try to find
 * the inner TypeReferenceNode that represents `Result<T,E>` and return the
 * first type argument node (the `T` in `Result<T,E>`).
 *
 * Unwrapping order:
 *   1. If the outermost ref is "Promise", descend to its first type argument.
 *   2. If the (possibly descended) ref is named "Result" with ≥ 2 type args →
 *      return the first type arg node.
 *      NOMINAL: covers (a) direct import and (b) barrel with no rename.
 *   3. If the ref's identifier is an IMPORT ALIAS (ImportSpecifier) and the
 *      original exported name is "Result" → it's a renamed barrel re-export
 *      (`import { Result as X } from "..."`). Extract the call site's first arg.
 *      NOMINAL: covers (b) barrel with rename.
 *   4. If the ref points to a LOCAL TypeAlias (declarations accessible in the
 *      same file) whose body is a TypeReference named "Result" with ≥ 1 type
 *      parameter → the first alias type parameter maps positionally to the call
 *      site's first type argument. Extract it.
 *      COVERS (c) further-generic aliases like `type ApiResult<T> = Result<T, E>`.
 *
 * Returns the T typeNode on success, undefined if the pattern doesn't match.
 */
function resultTypeArgNodeFrom(
  typeRefNode: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  if (!ts.isIdentifier(typeRefNode.typeName)) return undefined

  // Strip Promise<X> → recurse into X
  if (typeRefNode.typeName.text === "Promise") {
    const inner = typeRefNode.typeArguments?.[0]
    if (!inner || !ts.isTypeReferenceNode(inner)) return undefined
    return resultTypeArgNodeFrom(inner, checker)
  }

  // (a) / (b-no-rename): direct "Result" name with ≥ 2 type arguments.
  //   Covers: `import { Result } from "@rhi-zone/fractal-api-tree"` (a)
  //           `import { Result } from "./barrel"`               (b, no rename)
  if (
    typeRefNode.typeName.text === "Result" &&
    (typeRefNode.typeArguments?.length ?? 0) >= 2
  ) {
    return typeRefNode.typeArguments![0]
  }

  // Resolve the identifier's symbol for remaining cases.
  const sym = checker.getSymbolAtLocation(typeRefNode.typeName)
  if (!sym) return undefined

  // (b-rename): import alias → `import { Result as X } from "..."`.
  //   The import specifier's declarations ARE accessible (same file) even with
  //   skipLibCheck. We check that the specifier's ORIGINAL name (propertyName)
  //   is "Result". This verifies the barrel re-exports core's Result under a
  //   different local name.
  if (sym.flags & ts.SymbolFlags.Alias) {
    const specDecl = sym.declarations?.[0]
    if (specDecl && ts.isImportSpecifier(specDecl)) {
      // propertyName is set when renamed (`Result as X`); name is the local name.
      const originalName = specDecl.propertyName?.text ?? specDecl.name.text
      if (
        originalName === "Result" &&
        (typeRefNode.typeArguments?.length ?? 0) >= 1
      ) {
        return typeRefNode.typeArguments![0]
      }
    }
  }

  // (c): local TypeAlias → `type ApiResult<T> = Result<T, SomeError>`.
  //   Local alias declarations are accessible (same file, not behind skipLibCheck).
  //   If the alias's body is a TypeReference to "Result" with ≥ 2 type parameters,
  //   the first type parameter maps positionally to the call site's first type arg.
  if ((sym.flags & ts.SymbolFlags.TypeAlias) && sym.declarations?.[0]) {
    const decl = sym.declarations[0]
    if (
      ts.isTypeAliasDeclaration(decl) &&
      ts.isTypeReferenceNode(decl.type) &&
      ts.isIdentifier(decl.type.typeName) &&
      decl.type.typeName.text === "Result" &&
      (decl.typeParameters?.length ?? 0) >= 1
    ) {
      return typeRefNode.typeArguments?.[0]
    }
  }

  return undefined
}

/**
 * STRUCTURAL fallback: detect the exact Result discriminated-union shape.
 *
 * Fires only when the return type IS already a proper union — which happens
 * for inferred return types or when types are fully resolved (not under
 * skipLibCheck). It does NOT fire for the alias-instantiation case (those
 * types stay "unresolved" under this extractor's program configuration).
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
  if (!type.isUnion()) return undefined
  const members = type.types
  if (members.length !== 2) return undefined

  let okMember: ts.Type | undefined
  let errMember: ts.Type | undefined

  for (const member of members) {
    const kindProp = member.getProperty("kind")
    if (!kindProp) return undefined
    const kindType = checker.getTypeOfSymbolAtLocation(kindProp, loc)
    if (!kindType.isStringLiteral()) return undefined
    if (kindType.value === "ok") okMember = member
    else if (kindType.value === "err") errMember = member
    else return undefined
  }

  if (!okMember || !errMember) return undefined

  // kind:"ok" branch must have `value` (T)
  const valueProp = okMember.getProperty("value")
  if (!valueProp) return undefined

  // kind:"err" branch must have `error` (E) — guards against accidental matches
  const errorProp = errMember.getProperty("error")
  if (!errorProp) return undefined

  return checker.getTypeOfSymbolAtLocation(valueProp, loc)
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
 * Unwrapping uses two paths (see ARCHITECTURE NOTE above):
 *
 *   SYNTAX PATH (primary): reads the explicit return type annotation node.
 *     Handles `Result<T,E>` directly, barrel re-exports (no rename), and
 *     further-generic local aliases like `type ApiResult<T> = Result<T, E>`.
 *
 *   STRUCTURAL PATH (fallback): matches the exact DU shape when the return
 *     type IS a proper union — covers inferred-return cases or fully-resolved
 *     contexts outside of skipLibCheck.
 */
export function typeRefFromReturnType(
  fn: ts.Node,
  checker: ts.TypeChecker,
  registry?: SharingRegistry,
): TypeRef {
  const fnType = checker.getTypeAtLocation(fn)
  const [sig] = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call)
  if (!sig) return puntRef("no call signature on op fn")

  // ── SYNTAX PATH: explicit return type annotation on the function node ────
  //
  // When the function has an explicit `: ReturnType` annotation, we read that
  // type node from the AST directly. This gives us the full structure (including
  // type argument positions) without relying on the checker's alias resolution,
  // which is blocked by skipLibCheck.
  //
  // We detect `Promise<Result<T,E>>` by stripping the outer Promise TypeRef and
  // recursing; we detect `Result<T,E>` by name + 2 type args; we detect local
  // aliases like `ApiResult<T>` by checking their declaration's body.
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const retTypeNode = fn.type
    if (retTypeNode && ts.isTypeReferenceNode(retTypeNode)) {
      const tNode = resultTypeArgNodeFrom(retTypeNode, checker)
      if (tNode !== undefined) {
        const tType = checker.getTypeAtLocation(tNode)
        return typeRefFromType(tType, checker, fn, undefined, registry)
      }
    }
  }

  // ── TYPE-LEVEL PATH: inferred returns or non-annotated functions ─────────
  //
  // Fall through to the resolved return type from the call signature.
  let returnType = checker.getReturnTypeOfSignature(sig)

  // Strip Promise<T> at the type level (concrete Promise objects resolve fine).
  if (returnType.symbol?.name === "Promise") {
    const args = checker.getTypeArguments(returnType as ts.TypeReference)
    const inner = args[0]
    if (inner === undefined) return puntRef("Promise with no type argument")
    returnType = inner
  }

  // STRUCTURAL path: match the exact DU shape from core/src/index.ts.
  // Fires when the type is a proper union (not an unresolved alias instantiation).
  const structuralValue = structuralResultValueType(returnType, checker, fn)
  if (structuralValue !== undefined) {
    returnType = structuralValue
  }

  return typeRefFromType(returnType, checker, fn, undefined, registry)
}

/**
 * Derive the output schema from a function-typed node by inspecting its return
 * type. Unwraps `Result<T, E>` and `Promise<Result<T, E>>` to yield T's schema.
 */
export function schemaFromReturnType(
  fn: ts.Node,
  checker: ts.TypeChecker,
): JsonSchema {
  return toJsonSchema(typeRefFromReturnType(fn, checker)) as JsonSchema
}

// ============================================================================
// JSDoc → description
// ============================================================================

/** Read the flattened JSDoc comment text off a single node, if present. */
function jsDocTextOf(node: ts.Node): string | undefined {
  for (const j of ts.getJSDocCommentsAndTags(node)) {
    if (ts.isJSDoc(j)) {
      const text = ts.getTextOfJSDocComment(j.comment)
      if (text && text.trim().length > 0) return text.trim()
    }
  }
  return undefined
}

/**
 * Extract the leading JSDoc description of a node, flattened to a single
 * trimmed string. JSDoc attaches to the owning declaration statement, so this
 * climbs to the nearest statement if the node itself carries none. Returns
 * undefined when absent.
 */
export function extractJsDoc(node: ts.Node): string | undefined {
  const own = jsDocTextOf(node)
  if (own) return own
  let cur: ts.Node | undefined = node.parent
  while (cur && !ts.isSourceFile(cur)) {
    const text = jsDocTextOf(cur)
    if (text) return text
    if (ts.isStatement(cur)) break
    cur = cur.parent
  }
  return undefined
}

// ============================================================================
// Op-value extraction
// ============================================================================
//
// `createExtractorProgram` moved to `@rhi-zone/fractal-type-ir/from-typescript`
// (general-purpose `ts.Program` factory) and is re-exported above.

/**
 * Given an op VALUE expression from source, return the function node it wraps.
 * Supports `op(fn, meta)` calls and bare arrow/function expressions. `op` need
 * not resolve — the arrow's own parameter annotation is what we read.
 */
export function opFunctionNode(expr: ts.Expression): ts.Node | undefined {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return expr
  if (ts.isCallExpression(expr)) {
    const [first] = expr.arguments
    if (first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))) {
      return first
    }
  }
  return undefined
}
