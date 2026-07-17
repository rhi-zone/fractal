// packages/api-tree/src/tree.ts — @rhi-zone/fractal-api-tree
//
// Walk an authored Node tree AT THE TYPE LEVEL and produce a tool-name →
// { inputSchema, description } map — the artifact the MCP projection consumes.
//
// Why type-level, not AST pattern-matching: `api(children, opts?)` and
// `op(fn, meta?)` are BOTH generic — `api()`'s `C` type parameter preserves
// each child's exact `Node<H>` (handler included), so
// `api({ list: op(listBooks, http.get) })`'s resolved type already carries
// `children.list.handler: typeof listBooks`. The checker resolves this
// without walking the AST at all: `checker.getTypeAtLocation(exportNode)`
// gives the full tree shape, and `getPropertyOfType`/`getTypeOfSymbolAtLocation`
// walk it structurally — `children` → each key's node type → `handler` present
// (required, not just declared-optional) means leaf; `children` present
// (required) means branch. `op()`'s own return type marks `handler` required
// (`Omit<Node, "handler"> & { readonly handler: H }`), while `api()`'s return
// type leaves `handler` at Node's declared-optional — that required/optional
// split is the structural leaf/branch discriminator this walker uses.
//
// This walker still touches a SMALL amount of AST, for two things the type
// system provably cannot give back:
//   1. A leaf's underlying function NODE (needed by extract.ts's
//      `typeRefFromFunctionNode`/`typeRefFromReturnType`, which read parameter/
//      return type annotations and JSDoc off an actual node) — recovered via
//      the handler's call signature's own `.declaration`, which TypeScript
//      preserves back to the original arrow/function-expression node
//      regardless of how many identifiers it was threaded through.
//   2. A `fallback.name` STRING LITERAL — `api()`'s `F` type parameter is
//      inferred against the declared constraint `{ readonly name: string;
//      readonly subtree: Node<any> }`; because `name`'s constraint position is
//      the plain (non-generic) `string`, TypeScript widens the literal during
//      inference, so `checker.getTypeOfSymbolAtLocation` on the resolved
//      `fallback.name` property yields `string`, not `"userId"` (verified:
//      `subtree` DOES stay fully structural — only the sibling `name` widens).
//      The literal is recovered by reading the property symbol's own
//      declaration — a real `PropertyAssignment` in source when the branch is
//      inline, or (for a named-constant branch) by following one level of
//      identifier reference to that constant's own initializer — and lifting
//      the string-literal AST node's own type (`checker.getTypeAtLocation` on
//      the literal expression itself, not the property, stays un-widened).
//
// Everything else — which children exist, which are leaves vs. branches,
// each leaf's real input/output types, whether a branch has a fallback at
// all — comes from the checker, not from matching `op(...)`/`api(...)` call
// shapes or following identifier chains through the AST.
//
// meta.mcp.name / meta.mcp.segment overrides are NOT yet mirrored here.
//   TODO(api-tree): honor meta.mcp.name / meta.mcp.segment when reconstructing
//   tool names, matching packages/mcp-api-projector/src/project.ts.

import ts from "typescript"
import type { TypeRef } from "@rhi-zone/fractal-type-ir"
import {
  createExtractorProgram,
  extractJsDoc,
  schemaFromFunctionNode,
  schemaFromReturnType,
  typeRefFromFunctionNode,
  typeRefFromReturnType,
  type JsonSchema,
} from "./extract.ts"

/** Per-tool derived facts: real input schema + JSDoc-derived description. */
export type ToolSchema = {
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  description?: string
}

/** Map of MCP tool name → derived schema/description. */
export type SchemaMap = Record<string, ToolSchema>

/** Per-tool derived facts as TypeRefs (pre-projection). */
export type ToolTypeInfo = {
  input: TypeRef
  output?: TypeRef
  description?: string
}

/** Map of MCP tool name → derived TypeRefs/description. */
export type TypeRefMap = Record<string, ToolTypeInfo>

const join = (prefix: string, seg: string): string =>
  prefix.length > 0 ? `${prefix}_${seg}` : seg

/** Cap on identifier-chain resolution depth — guards against reference cycles. */
const MAX_RESOLVE_DEPTH = 10

/** True when a property symbol resolved off a type is REQUIRED (not optional). */
function isRequiredProperty(prop: ts.Symbol): boolean {
  return (prop.flags & ts.SymbolFlags.Optional) === 0
}

/**
 * The function node behind a leaf's `handler` property: the call signature's
 * own `.declaration`, which TypeScript keeps pointing at the original
 * arrow/function-expression node no matter how many named constants or
 * generic instantiations sit between it and this leaf's position in the tree.
 */
function functionNodeOfHandler(
  handlerType: ts.Type,
  checker: ts.TypeChecker,
): ts.Node | undefined {
  const [sig] = checker.getSignaturesOfType(handlerType, ts.SignatureKind.Call)
  return sig?.declaration
}

/**
 * Resolve an expression to the object-literal expression it denotes,
 * following `Identifier` references to their declaration's initializer
 * transitively (capped at `MAX_RESOLVE_DEPTH`). Used ONLY to recover the
 * `fallback.name` string literal that TypeScript's generic inference widens
 * away at the type level (see the module doc comment) — not for tree
 * structure, which comes entirely from the checker.
 */
function resolveObjectLiteral(
  node: ts.Expression,
  checker: ts.TypeChecker,
  depth = 0,
): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(node)) return node
  if (depth >= MAX_RESOLVE_DEPTH || !ts.isIdentifier(node)) return undefined
  const symbol = checker.getSymbolAtLocation(node)
  const decl = symbol?.declarations?.[0]
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined
  return resolveObjectLiteral(decl.initializer, checker, depth + 1)
}

const objectLiteralProp = (
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined =>
  obj.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
  )

/** The initializer expression of a property-assignment or variable declaration node. */
function initializerOf(decl: ts.Node): ts.Expression | undefined {
  if (ts.isPropertyAssignment(decl)) return decl.initializer
  if (ts.isVariableDeclaration(decl)) return decl.initializer
  return undefined
}

/**
 * Read a fallback branch's `name` string literal off source. `branchDecl` is
 * the branch node's own declaration — a property-assignment (`key: api(...)`
 * or `key: someNamedBranch`) for a nested branch, or a variable declaration
 * for a root export; its initializer is either the `api(children, opts)`
 * call directly, or (for a named-constant branch) an identifier that
 * resolves to one. Returns `undefined` if no literal `fallback.name` is
 * found — the caller then has no name to key the fallback subtree under and
 * skips it.
 */
function fallbackNameLiteral(
  branchDecl: ts.Node,
  checker: ts.TypeChecker,
): string | undefined {
  const initial = initializerOf(branchDecl)
  if (!initial) return undefined
  let init: ts.Expression = initial
  if (ts.isIdentifier(init)) {
    const symbol = checker.getSymbolAtLocation(init)
    const decl = symbol?.declarations?.[0]
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined
    init = decl.initializer
  }
  if (!ts.isCallExpression(init)) return undefined
  const optsArg = init.arguments[1]
  if (!optsArg || !ts.isObjectLiteralExpression(optsArg)) return undefined
  const fallbackProp = objectLiteralProp(optsArg, "fallback")
  if (!fallbackProp) return undefined
  const fallbackLiteral = resolveObjectLiteral(fallbackProp.initializer, checker)
  if (!fallbackLiteral) return undefined
  const nameProp = objectLiteralProp(fallbackLiteral, "name")
  if (!nameProp || !ts.isStringLiteral(nameProp.initializer)) return undefined
  return nameProp.initializer.text
}

/**
 * `onLeaf` receives both the underscore-joined MCP tool name (`name`, mirrors
 * `toTools`) and the raw path-segment array (`path`) it was built from — a
 * fallback segment appears in `path` as `:name` (e.g. `":bookId"`), matching
 * the convention `route.ts`'s `pathKey`/`injectValidators` use at runtime over
 * the `HttpRoute` tree.
 */
type OnLeaf = (
  name: string,
  path: readonly string[],
  fn: ts.Node,
  descriptionSource: ts.Node,
  checker: ts.TypeChecker,
) => void

/**
 * Walk one node's resolved TYPE, invoking `onLeaf` for each leaf (a child
 * whose `handler` property is REQUIRED, i.e. produced by `op()`) and
 * recursing into each branch (a child whose `children` property is REQUIRED,
 * i.e. produced by `api()`) and — when present — its `fallback.subtree`.
 *
 * `nodeType` is the resolved type of a Node value (root export or any
 * descendant); `nodeDecl`, when available, is that value's own
 * property-assignment declaration in source, used only to recover the
 * `fallback.name` literal (see module doc comment) — never to re-derive tree
 * structure, which comes entirely from `nodeType`.
 */
function walkNodeType(
  nodeType: ts.Type,
  nodeDecl: ts.Node | undefined,
  prefix: string,
  path: readonly string[],
  loc: ts.Node,
  checker: ts.TypeChecker,
  onLeaf: OnLeaf,
): void {
  const childrenProp = checker.getPropertyOfType(nodeType, "children")
  if (childrenProp && isRequiredProperty(childrenProp)) {
    const childrenType = checker.getTypeOfSymbolAtLocation(childrenProp, loc)
    for (const childProp of checker.getPropertiesOfType(childrenType)) {
      const childKey = childProp.name
      const childType = checker.getTypeOfSymbolAtLocation(childProp, loc)
      const childDecl = childProp.declarations?.[0]

      const handlerProp = checker.getPropertyOfType(childType, "handler")
      if (handlerProp && isRequiredProperty(handlerProp)) {
        // Leaf: op(fn, meta?) — handler is required on op()'s return type.
        const handlerType = checker.getTypeOfSymbolAtLocation(handlerProp, loc)
        const fn = functionNodeOfHandler(handlerType, checker)
        if (!fn) continue
        const descriptionSource = childDecl ?? fn
        onLeaf(join(prefix, childKey), [...path, childKey], fn, descriptionSource, checker)
        continue
      }

      // Branch: api(...) — children is required on api()'s return type.
      walkNodeType(
        childType,
        childDecl,
        join(prefix, childKey),
        [...path, childKey],
        loc,
        checker,
        onLeaf,
      )
    }
  }

  const fallbackProp = checker.getPropertyOfType(nodeType, "fallback")
  if (fallbackProp && nodeDecl) {
    const fallbackName = fallbackNameLiteral(nodeDecl, checker)
    if (fallbackName !== undefined) {
      const fallbackType = checker.getTypeOfSymbolAtLocation(fallbackProp, loc)
      const subtreeProp = checker.getPropertyOfType(fallbackType, "subtree")
      if (subtreeProp) {
        const subtreeType = checker.getTypeOfSymbolAtLocation(subtreeProp, loc)
        walkNodeType(
          subtreeType,
          subtreeProp.declarations?.[0],
          join(prefix, fallbackName),
          [...path, `:${fallbackName}`],
          loc,
          checker,
          onLeaf,
        )
      }
    }
  }
}

/**
 * Walk every exported `api(children, opts?)` tree in a source file, mirroring
 * toTools' name construction, and invoke `onLeaf` for each `op(fn, meta?)`
 * leaf found. Finds exports via a minimal AST scan (there is no type-level
 * way to enumerate a file's exports); the tree SHAPE itself — leaves,
 * branches, fallbacks — comes entirely from `checker.getTypeAtLocation` on
 * each export, not from matching call expressions.
 */
function walkTree(entryFile: string, onLeaf: OnLeaf): void {
  const program = createExtractorProgram(entryFile)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(entryFile)
  if (!source) throw new Error(`walkTree: source not found: ${entryFile}`)

  for (const stmt of source.statements) {
    if (
      !ts.isVariableStatement(stmt) ||
      !stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      continue
    }
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      const nodeType = checker.getTypeAtLocation(decl.name)
      // A Node value always carries `meta`; skip exports that aren't trees
      // (plain re-exported types, unrelated constants, …).
      if (!checker.getPropertyOfType(nodeType, "meta")) continue
      walkNodeType(nodeType, decl, "", [], decl.name, checker, onLeaf)
    }
  }
}

/**
 * Extract the tool-name → schema map for every exported `api(children, opts?)`
 * tree in a source file. Mirrors toTools' name construction.
 */
export function extractToolSchemas(entryFile: string): SchemaMap {
  const out: SchemaMap = {}
  walkTree(entryFile, (name, _path, fn, descriptionSource, checker) => {
    const description = extractJsDoc(descriptionSource) ?? extractJsDoc(fn)
    out[name] = {
      inputSchema: schemaFromFunctionNode(fn, checker),
      outputSchema: schemaFromReturnType(fn, checker),
      ...(description !== undefined ? { description } : {}),
    }
  })
  return out
}

/**
 * Extract the tool-name → TypeRef map for every exported `api(children, opts?)`
 * tree in a source file. Mirrors toTools' name construction. Same tree walk as
 * `extractToolSchemas`, but yields TypeRefs (pre-projection) instead of
 * JSON Schema.
 */
export function extractToolTypeRefs(entryFile: string): TypeRefMap {
  const out: TypeRefMap = {}
  walkTree(entryFile, (name, _path, fn, descriptionSource, checker) => {
    const description = extractJsDoc(descriptionSource) ?? extractJsDoc(fn)
    out[name] = {
      input: typeRefFromFunctionNode(fn, checker),
      output: typeRefFromReturnType(fn, checker),
      ...(description !== undefined ? { description } : {}),
    }
  })
  return out
}

/**
 * Extract the ROUTE-PATH → TypeRef map for every exported `api(children,
 * opts?)` tree in a source file — same walk as `extractToolTypeRefs`, but
 * keyed by the `"/"`-joined path-segment string `route.ts`'s
 * `pathKey`/`injectValidators` use (fallback segments rendered as `:name`)
 * instead of the underscore-joined MCP tool name. This is the key shape
 * `createApplyValidation`'s `ValidatorMap` inner map expects.
 */
export function extractRouteTypeRefs(entryFile: string): TypeRefMap {
  const out: TypeRefMap = {}
  walkTree(entryFile, (_name, path, fn, descriptionSource, checker) => {
    const description = extractJsDoc(descriptionSource) ?? extractJsDoc(fn)
    const key = path.join("/")
    out[key] = {
      input: typeRefFromFunctionNode(fn, checker),
      output: typeRefFromReturnType(fn, checker),
      ...(description !== undefined ? { description } : {}),
    }
  })
  return out
}
