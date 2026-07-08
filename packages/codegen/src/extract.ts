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
// / callable types, …) is PUNTED to `{ type: "object" }` carrying a `$comment`
// that names the unhandled case — a valid JSON-Schema value that is
// self-documenting rather than silently lossy.
//
// Derived-from-type ONLY: there is no hand-authored schema anywhere. If a shape
// isn't recovered here, it degrades to the MCP spec minimum, never to a second
// source of truth.
//
// See:
//   packages/core/src/node.ts    — the op model (`op(fn, meta)`)
//   packages/mcp/src/project.ts  — the consumer (toTools inputSchema/description)

import ts from "typescript"

// ============================================================================
// JSON-Schema value (structural subset we emit)
// ============================================================================

/**
 * The JSON-Schema shapes this extractor produces. `$comment` carries a
 * `TODO(codegen): …` marker on any punted node so the fallback is visible in
 * the emitted value itself.
 */
export type JsonSchema = {
  type: "string" | "number" | "boolean" | "array" | "object"
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  $comment?: string
}

/** The punt: a spec-minimum object schema tagged with the unhandled case. */
const punt = (reason: string): JsonSchema => ({
  type: "object",
  $comment: `TODO(codegen): unhandled type — ${reason}`,
})

// ============================================================================
// Core: TypeScript type → JSON-Schema
// ============================================================================

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
  const flags = type.flags

  // ── Primitives ────────────────────────────────────────────────────────────
  if (flags & ts.TypeFlags.StringLike) return { type: "string" }
  if (flags & ts.TypeFlags.NumberLike) return { type: "number" }
  if (flags & ts.TypeFlags.BooleanLike) return { type: "boolean" }

  // ── Arrays (T[] / Array<T>) ───────────────────────────────────────────────
  if (checker.isArrayType(type)) {
    const [elem] = checker.getTypeArguments(type as ts.TypeReference)
    return {
      type: "array",
      items: elem
        ? schemaFromType(elem, checker, loc)
        : punt("unknown array element"),
    }
  }

  // ── Genuine unions punt (optional `| undefined` is stripped upstream) ──────
  if (type.isUnion()) {
    return punt(`union (${checker.typeToString(type)})`)
  }

  // ── Object types: primitive/optional/array/nested fields ──────────────────
  if (flags & ts.TypeFlags.Object) {
    // Function-like objects (call/construct signatures) are not domain shapes.
    if (
      checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
      checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0
    ) {
      return punt(`callable/constructable (${checker.typeToString(type)})`)
    }

    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []

    for (const prop of checker.getPropertiesOfType(type)) {
      const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0
      // Strip `| undefined` so `field?: string` lowers as a plain string.
      const propType = checker
        .getTypeOfSymbolAtLocation(prop, loc)
        .getNonNullableType()
      properties[prop.name] = schemaFromType(propType, checker, loc)
      if (!optional) required.push(prop.name)
    }

    const schema: JsonSchema = { type: "object", properties }
    if (required.length > 0) schema.required = required
    return schema
  }

  // ── Everything else (generic param, unknown, any, branded, …) ─────────────
  return punt(`unsupported (${checker.typeToString(type)})`)
}

// ============================================================================
// Function/op input → JSON-Schema
// ============================================================================

/**
 * Derive the input schema from a function-typed node (arrow or function
 * expression): its first parameter's type is the op input. A niladic op
 * lowers to an empty object schema.
 */
export function schemaFromFunctionNode(
  fn: ts.Node,
  checker: ts.TypeChecker,
): JsonSchema {
  const fnType = checker.getTypeAtLocation(fn)
  const [sig] = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call)
  if (!sig) return punt("no call signature on op fn")
  const [param] = sig.getParameters()
  if (!param) return { type: "object", properties: {} }
  const paramType = checker.getTypeOfSymbolAtLocation(param, fn)
  return schemaFromType(paramType, checker, fn)
}

// ============================================================================
// Function/op return type → JSON-Schema
// ============================================================================

/**
 * Derive the output schema from a function-typed node by inspecting its return
 * type. Strips `Promise<T>` (takes the first type argument) and `Result<T, E>`
 * (recognized by the type name "Result", takes the first type argument).
 * Exotic/unresolvable return types punt to `{ type: "object" }` with a TODO
 * $comment, consistent with the input-side fallback.
 */
export function schemaFromReturnType(
  fn: ts.Node,
  checker: ts.TypeChecker,
): JsonSchema {
  const fnType = checker.getTypeAtLocation(fn)
  const [sig] = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call)
  if (!sig) return punt("no call signature on op fn")

  let returnType = checker.getReturnTypeOfSignature(sig)

  // Strip Promise<T> — take the first type argument
  if (returnType.symbol?.name === "Promise") {
    const args = checker.getTypeArguments(returnType as ts.TypeReference)
    const inner = args[0]
    if (inner === undefined) return punt("Promise with no type argument")
    returnType = inner
  }

  // Strip Result<T, E> — recognized by type name "Result", take the first arg
  // TODO(codegen): recognize Result by nominal identity (import symbol) once
  // the core package exports it as a branded type rather than a structural alias
  if (returnType.symbol?.name === "Result") {
    const args = checker.getTypeArguments(returnType as ts.TypeReference)
    const inner = args[0]
    if (inner === undefined) return punt("Result with no type argument")
    returnType = inner
  }

  return schemaFromType(returnType, checker, fn)
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
