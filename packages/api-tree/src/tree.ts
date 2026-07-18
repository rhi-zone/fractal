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
// This walker still touches a SMALL amount of AST, for one thing the type
// system provably cannot give back: a leaf's underlying function NODE
// (needed by extract.ts's `typeRefFromFunctionNode`/`typeRefFromReturnType`,
// which read parameter/return type annotations and JSDoc off an actual
// node) — recovered via the handler's call signature's own `.declaration`,
// which TypeScript preserves back to the original arrow/function-expression
// node regardless of how many identifiers it was threaded through.
//
// `fallback.name` no longer needs an AST fallback: `api()`'s fallback type
// parameter `F` is a `const` type parameter (TS 5.0+; see node.ts's doc
// comment), which keeps TS from widening the inferred literal, so
// `checker.getTypeOfSymbolAtLocation` on the resolved `fallback.name`
// property yields the literal (e.g. `"bookId"`) directly — read via the
// property symbol's own type, no AST needed.
//
// Everything — which children exist, which are leaves vs. branches, each
// leaf's real input/output types, whether a branch has a fallback at all,
// and now the fallback's own name — comes from the checker, not from
// matching `op(...)`/`api(...)` call shapes or following identifier chains
// through the AST.
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
 * Read a fallback's `name` string literal off its resolved TYPE. Works now
 * that `api()`'s `F` is a `const` type parameter (node.ts), which defeats
 * literal-widening during inference — so the property's own type is the
 * string-literal type itself, not the widened `string`. Returns `undefined`
 * if it isn't a literal (e.g. a caller passed a non-literal `string`
 * expression for `name`, which `F`'s constraint still structurally accepts)
 * — the caller then has no name to key the fallback subtree under and skips
 * it.
 */
function fallbackNameLiteral(
  fallbackType: ts.Type,
  loc: ts.Node,
  checker: ts.TypeChecker,
): string | undefined {
  const nameProp = checker.getPropertyOfType(fallbackType, "name")
  if (!nameProp) return undefined
  const nameType = checker.getTypeOfSymbolAtLocation(nameProp, loc)
  return nameType.isStringLiteral() ? nameType.value : undefined
}

/**
 * `onLeaf` receives both the underscore-joined MCP tool name (`name`, mirrors
 * `toTools`) and the raw path-segment array (`path`) it was built from — a
 * fallback segment appears in `path` as `:name` (e.g. `":bookId"`), matching
 * the convention `build.ts`'s `wrapValidators` uses at runtime over the
 * `Node` tree.
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
 * descendant) — tree structure, including the fallback's own name, comes
 * entirely from it; no source declaration is needed.
 */
function walkNodeType(
  nodeType: ts.Type,
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
        join(prefix, childKey),
        [...path, childKey],
        loc,
        checker,
        onLeaf,
      )
    }
  }

  const fallbackProp = checker.getPropertyOfType(nodeType, "fallback")
  if (fallbackProp) {
    const fallbackType = checker.getTypeOfSymbolAtLocation(fallbackProp, loc)
    const fallbackName = fallbackNameLiteral(fallbackType, loc, checker)
    if (fallbackName !== undefined) {
      const subtreeProp = checker.getPropertyOfType(fallbackType, "subtree")
      if (subtreeProp) {
        const subtreeType = checker.getTypeOfSymbolAtLocation(subtreeProp, loc)
        walkNodeType(
          subtreeType,
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
      walkNodeType(nodeType, "", [], decl.name, checker, onLeaf)
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
 * keyed by the `"/"`-joined path-segment string `build.ts`'s
 * `wrapValidators` uses (fallback segments rendered as `:name`) instead of
 * the underscore-joined MCP tool name. This is the key shape
 * `wrapValidators`'s generated-entry map expects.
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
