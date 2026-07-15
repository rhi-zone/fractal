// packages/codegen/src/extract.ts — @rhi-zone/fractal-codegen
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
// objects are lowered structurally. Anything exotic (unions, generics, branded
// / callable types, …) is PUNTED to `t(types.unknown, { $comment })` carrying
// a `$comment` that names the unhandled case — self-documenting rather than
// silently lossy. Extraction goes TS type → TypeRef → JSON Schema; the
// TypeRef is produced here and projected via
// `@rhi-zone/fractal-type-ir/json-schema`'s `toJsonSchema`.
//
// Derived-from-type ONLY: there is no hand-authored schema anywhere. If a shape
// isn't recovered here, it degrades to the MCP spec minimum, never to a second
// source of truth.
//
// See:
//   packages/core/src/node.ts    — the op model (`op(fn, meta)`)
//   packages/mcp/src/project.ts  — the consumer (toTools inputSchema/description)

import ts from "typescript"
import { t, types, type TypeRef } from "@rhi-zone/fractal-type-ir"
import { toJsonSchema } from "@rhi-zone/fractal-type-ir/json-schema"

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
  items?: JsonSchema
  $comment?: string
}

// ============================================================================
// Core: TypeScript type → JSON-Schema
// ============================================================================

/** The TypeRef punt: `unknown` tagged with the unhandled case. */
const puntRef = (reason: string): TypeRef =>
  t(types.unknown, { $comment: `TODO(codegen): unhandled type — ${reason}` })

/**
 * Lower a resolved `ts.Type` to a TypeRef.
 *
 * Handles the obvious cases; punts everything else to `t(types.unknown, …)`
 * carrying a `$comment` naming the case. `loc` anchors symbol-type resolution.
 */
export function typeRefFromType(
  type: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
): TypeRef {
  const flags = type.flags

  // ── Primitives ────────────────────────────────────────────────────────────
  if (flags & ts.TypeFlags.StringLike) return t(types.string)
  if (flags & ts.TypeFlags.NumberLike) return t(types.number)
  if (flags & ts.TypeFlags.BooleanLike) return t(types.boolean)

  // ── Arrays (T[] / Array<T>) ───────────────────────────────────────────────
  if (checker.isArrayType(type)) {
    const [elem] = checker.getTypeArguments(type as ts.TypeReference)
    return t(
      types.array(
        elem
          ? typeRefFromType(elem, checker, loc)
          : puntRef("unknown array element"),
      ),
    )
  }

  // ── Genuine unions punt (optional `| undefined` is stripped upstream) ──────
  if (type.isUnion()) {
    return puntRef(`union (${checker.typeToString(type)})`)
  }

  // ── Object types: primitive/optional/array/nested fields ──────────────────
  if (flags & ts.TypeFlags.Object) {
    // Function-like objects (call/construct signatures) are not domain shapes.
    if (
      checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
      checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0
    ) {
      return puntRef(`callable/constructable (${checker.typeToString(type)})`)
    }

    const fields: Record<string, TypeRef> = {}

    for (const prop of checker.getPropertiesOfType(type)) {
      const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0
      // Strip `| undefined` so `field?: string` lowers as a plain string.
      const propType = checker
        .getTypeOfSymbolAtLocation(prop, loc)
        .getNonNullableType()
      const fieldRef = typeRefFromType(propType, checker, loc)
      fields[prop.name] = optional
        ? t(fieldRef.shape, { ...fieldRef.meta, optional: true })
        : fieldRef
    }

    return t(types.object(fields))
  }

  // ── Everything else (generic param, unknown, any, branded, …) ─────────────
  return puntRef(`unsupported (${checker.typeToString(type)})`)
}

/**
 * Lower a resolved `ts.Type` to a JSON-Schema value.
 *
 * Handles the obvious cases; punts everything else to `{ type: "object" }`
 * with a `$comment` naming the case. `loc` anchors symbol-type resolution.
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
 * Derive the input TypeRef from a function-typed node (arrow or function
 * expression): its first parameter's type is the op input. A niladic op
 * lowers to an empty object TypeRef.
 */
export function typeRefFromFunctionNode(
  fn: ts.Node,
  checker: ts.TypeChecker,
): TypeRef {
  const fnType = checker.getTypeAtLocation(fn)
  const [sig] = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call)
  if (!sig) return puntRef("no call signature on op fn")
  const [param] = sig.getParameters()
  if (!param) return t(types.object({}))
  const paramType = checker.getTypeOfSymbolAtLocation(param, fn)
  return typeRefFromType(paramType, checker, fn)
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
//        `{ ok: true; value: T } | { ok: false; error: E }`
//      This fires when the type was genuinely expanded to a union.
//
//   3. FALSE-POSITIVE GUARD:
//      The name check ("Result") is the primary discriminant. Arbitrary unions
//      without an alias named "Result" never trigger path 1.
//      The structural path (2) matches the exact DU fields (ok/value/error with
//      boolean literal discriminants) — too specific for accidental collisions.

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
  //   Covers: `import { Result } from "@rhi-zone/fractal-core"` (a)
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
 * Exact shape from packages/core/src/index.ts:
 *   `{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }`
 *
 * Match criteria (all must hold to avoid false positives on arbitrary unions):
 *   1. Union of exactly 2 members
 *   2. Each member has property `ok` typed as a BooleanLiteral (true or false)
 *   3. The `ok: true` member has a `value` property → T extracted from it
 *   4. The `ok: false` member has an `error` property (guards against accidental matches)
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

  let okTrueMember: ts.Type | undefined
  let okFalseMember: ts.Type | undefined

  for (const member of members) {
    const okProp = member.getProperty("ok")
    if (!okProp) return undefined
    const okType = checker.getTypeOfSymbolAtLocation(okProp, loc)
    if (!(okType.flags & ts.TypeFlags.BooleanLiteral)) return undefined
    const isTrue =
      (okType as ts.Type & { intrinsicName?: string }).intrinsicName === "true"
    if (isTrue) okTrueMember = member
    else okFalseMember = member
  }

  if (!okTrueMember || !okFalseMember) return undefined

  // ok:true branch must have `value` (T)
  const valueProp = okTrueMember.getProperty("value")
  if (!valueProp) return undefined

  // ok:false branch must have `error` (E) — guards against accidental matches
  const errorProp = okFalseMember.getProperty("error")
  if (!errorProp) return undefined

  return checker.getTypeOfSymbolAtLocation(valueProp, loc)
}

// ============================================================================
// Function/op return type → JSON-Schema
// ============================================================================

/**
 * Derive the output schema from a function-typed node by inspecting its return
 * type. Unwraps `Result<T, E>` and `Promise<Result<T, E>>` to yield T's schema.
 * Exotic/unresolvable return types punt to `{ type: "object" }` with a TODO
 * $comment, consistent with the input-side fallback.
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
        return typeRefFromType(tType, checker, fn)
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

  return typeRefFromType(returnType, checker, fn)
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
// Program helper + op-value extraction
// ============================================================================

/** Create a read-only Program over a single entry file. */
export function createExtractorProgram(entryFile: string): ts.Program {
  return ts.createProgram([entryFile], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
  })
}

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
