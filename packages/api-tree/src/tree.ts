// packages/api-tree/src/tree.ts — @rhi-zone/fractal-api-tree
//
// Walk an authored Node tree AT THE SOURCE LEVEL and produce a tool-name →
// { inputSchema, description } map — the artifact the MCP projection consumes.
//
// Why source-level: a `Node` value's TYPE erases per-leaf handler input types
// (`children: Record<string, Node>`), so the concrete
// `op((input: {...}) => …)` shapes only survive in the AST. This walker mirrors
// toTools' underscore-joined name construction so the emitted keys line up with
// the runtime tool names.
//
// In the new node model:
//   - Leaf nodes are authored as `op(fn, meta?)` calls stored in `children`.
//   - Branch nodes are authored as `api(children, opts?)` calls, where
//     `children` is an object literal passed positionally (first argument)
//     and `opts` (second argument, optional) may carry `fallback`/`meta`.
//   - The `ops` key no longer exists in the authoring API.
//
// Supported structure: `api(children, opts?)` where:
//   - `children` (the first argument, an object literal) values are:
//     `op(fn, meta?)` or bare arrow → leaf (callable); `api(...)` → static
//     branch child.
//   - `opts.fallback: { name: "...", subtree: api(...) }` → wildcard-capture
//     subtree, namespaced by `name` (replaces the former `param(name, subtree)`).
// meta.mcp.name / meta.mcp.segment overrides are NOT yet mirrored here.
//   TODO(api-tree): honor meta.mcp.name / meta.mcp.segment when reconstructing
//   tool names, matching packages/mcp-api-projector/src/project.ts.

import ts from "typescript"
import type { TypeRef } from "@rhi-zone/fractal-type-ir"
import {
  createExtractorProgram,
  extractJsDoc,
  opFunctionNode,
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

const propName = (p: ts.ObjectLiteralElementLike): string | undefined => {
  if (!ts.isPropertyAssignment(p)) return undefined
  const n = p.name
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text
  return undefined
}

const calleeName = (call: ts.CallExpression): string | undefined =>
  ts.isIdentifier(call.expression) ? call.expression.text : undefined

const join = (prefix: string, seg: string): string =>
  prefix.length > 0 ? `${prefix}_${seg}` : seg

/** Cap on identifier-chain resolution depth — guards against reference cycles. */
const MAX_RESOLVE_DEPTH = 10

/**
 * Resolve an expression to the `op(...)`/`api(...)` call expression it
 * denotes, following `Identifier` references to their declaration's
 * initializer transitively (capped at `MAX_RESOLVE_DEPTH`). This lets the
 * walker follow named-constant ops/subtrees —
 * `const listOp = op(fn, meta); api({ list: listOp })` — not just inline
 * `op(...)` calls.
 */
function resolveCallExpression(
  node: ts.Expression,
  checker: ts.TypeChecker,
  depth = 0,
): ts.CallExpression | undefined {
  if (ts.isCallExpression(node)) return node
  if (depth >= MAX_RESOLVE_DEPTH) return undefined
  if (!ts.isIdentifier(node)) return undefined
  const symbol = checker.getSymbolAtLocation(node)
  const decl = symbol?.declarations?.[0]
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined
  return resolveCallExpression(decl.initializer, checker, depth + 1)
}

/**
 * Resolve the LOCAL identifier a source file binds `api` to when importing
 * it from "@rhi-zone/fractal-api-tree/node" — `import { api } from "..."` binds
 * "api", but `import { api as api_ } from "..."` (used when the file also
 * declares its own `const api = ...` tree) binds "api_". Falls back to
 * "api" when no such import is found, so entry-point detection still works
 * on the common unaliased case.
 */
function resolveApiLocalName(source: ts.SourceFile): string {
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text !== "@rhi-zone/fractal-api-tree/node") continue
    const namedBindings = stmt.importClause?.namedBindings
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue
    for (const el of namedBindings.elements) {
      const importedName = (el.propertyName ?? el.name).text
      if (importedName === "api") return el.name.text
    }
  }
  return "api"
}

/**
 * Walk every exported `api(children, opts?)` tree in a source file, mirroring
 * toTools' name construction, and invoke `onLeaf` for each `op(fn, meta?)`
 * leaf found.
 *
 * In the new node model, children that are `op(...)` calls are leaf nodes;
 * children that are `api(...)` calls are static branch nodes; a sibling
 * `opts.fallback: { name, subtree }` property is the wildcard-capture subtree.
 */
/**
 * `onLeaf` receives both the underscore-joined MCP tool name (`name`, mirrors
 * `toTools`) and the raw path-segment array (`path`) it was built from — a
 * fallback segment appears in `path` as `:name` (e.g. `":bookId"`), matching
 * the convention `route.ts`'s `pathKey`/`injectValidators` use at runtime over
 * the `HttpRoute` tree.
 */
function walkTree(
  entryFile: string,
  onLeaf: (
    name: string,
    path: readonly string[],
    fn: ts.Node,
    childProp: ts.ObjectLiteralElementLike,
    checker: ts.TypeChecker,
  ) => void,
): void {
  const program = createExtractorProgram(entryFile)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(entryFile)
  if (!source) throw new Error(`walkTree: source not found: ${entryFile}`)
  const apiLocalName = resolveApiLocalName(source)

  const walkNodeCall = (call: ts.CallExpression, prefix: string, path: readonly string[]): void => {
    const childrenArg = call.arguments[0]
    if (!childrenArg || !ts.isObjectLiteralExpression(childrenArg)) return

    for (const childProp of childrenArg.properties) {
      const childKey = propName(childProp)
      if (!ts.isPropertyAssignment(childProp) || childKey === undefined) continue
      const init = resolveCallExpression(childProp.initializer, checker)
      if (!init) continue
      const callee = calleeName(init)

      if (callee === "op") {
        // Leaf node: op(fn, meta?) — extract input schema from fn's first arg
        const firstArg = init.arguments[0]
        if (firstArg === undefined) continue
        const fn = opFunctionNode(firstArg)
        if (!fn) continue
        onLeaf(join(prefix, childKey), [...path, childKey], fn, childProp, checker)
      } else {
        // static branch child: api(...) or other constructor
        walkNodeCall(init, join(prefix, childKey), [...path, childKey])
      }
    }

    const optsArg = call.arguments[1]
    if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
      for (const prop of optsArg.properties) {
        const key = propName(prop)
        if (!ts.isPropertyAssignment(prop) || key === undefined) continue
        if (key === "fallback" && ts.isObjectLiteralExpression(prop.initializer)) {
          // fallback: { name: "...", subtree: api(...) }
          let fallbackName: string | undefined
          let subtreeCall: ts.CallExpression | undefined
          for (const fbProp of prop.initializer.properties) {
            const fbKey = propName(fbProp)
            if (!ts.isPropertyAssignment(fbProp) || fbKey === undefined) continue
            if (fbKey === "name" && ts.isStringLiteral(fbProp.initializer)) {
              fallbackName = fbProp.initializer.text
            } else if (fbKey === "subtree") {
              subtreeCall = resolveCallExpression(fbProp.initializer, checker)
            }
          }
          if (fallbackName !== undefined && subtreeCall !== undefined) {
            walkNodeCall(subtreeCall, join(prefix, fallbackName), [...path, `:${fallbackName}`])
          }
        }
      }
    }
  }

  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableStatement(n) &&
      n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of n.declarationList.declarations) {
        const init = decl.initializer
        if (init && ts.isCallExpression(init) && calleeName(init) === apiLocalName) {
          walkNodeCall(init, "", [])
        }
      }
    }
    ts.forEachChild(n, visit)
  }

  visit(source)
}

/**
 * Extract the tool-name → schema map for every exported `api(children, opts?)`
 * tree in a source file. Mirrors toTools' name construction.
 */
export function extractToolSchemas(entryFile: string): SchemaMap {
  const out: SchemaMap = {}
  walkTree(entryFile, (name, _path, fn, childProp, checker) => {
    // JSDoc on the property assignment itself (inline `key: op(...)`) wins;
    // for a named-constant leaf (`key: someOp`), the property carries no
    // comment, so fall back to the JSDoc on `fn`'s own declaration chain
    // (climbs to the `const someOp = op(...)` statement).
    const description = extractJsDoc(childProp) ?? extractJsDoc(fn) ?? extractJsDoc(fn)
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
  walkTree(entryFile, (name, _path, fn, childProp, checker) => {
    const description = extractJsDoc(childProp) ?? extractJsDoc(fn)
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
  walkTree(entryFile, (_name, path, fn, childProp, checker) => {
    const description = extractJsDoc(childProp) ?? extractJsDoc(fn)
    const key = path.join("/")
    out[key] = {
      input: typeRefFromFunctionNode(fn, checker),
      output: typeRefFromReturnType(fn, checker),
      ...(description !== undefined ? { description } : {}),
    }
  })
  return out
}
