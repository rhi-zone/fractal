// packages/codegen/src/tree.ts — @rhi-zone/fractal-codegen
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
//   - Branch nodes are authored as `node({ children?, fallback?, meta? })` calls.
//   - The `ops` key no longer exists in the authoring API.
//
// Supported structure: `node({ children, fallback })` where:
//   - `children` values are: `op(fn, meta?)` or bare arrow → leaf (callable);
//     `node({…})` → static branch child.
//   - `fallback: { name: "...", subtree: node({…}) }` → wildcard-capture
//     subtree, namespaced by `name` (replaces the former `param(name, subtree)`).
// meta.mcp.name / meta.mcp.segment overrides are NOT yet mirrored here.
//   TODO(codegen): honor meta.mcp.name / meta.mcp.segment when reconstructing
//   tool names, matching packages/mcp/src/project.ts.

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

const objectArgOf = (
  call: ts.CallExpression,
): ts.ObjectLiteralExpression | undefined => {
  const [arg] = call.arguments
  return arg && ts.isObjectLiteralExpression(arg) ? arg : undefined
}

const calleeName = (call: ts.CallExpression): string | undefined =>
  ts.isIdentifier(call.expression) ? call.expression.text : undefined

const join = (prefix: string, seg: string): string =>
  prefix.length > 0 ? `${prefix}_${seg}` : seg

/**
 * Walk every exported `node({…})` tree in a source file, mirroring toTools'
 * name construction, and invoke `onLeaf` for each `op(fn, meta?)` leaf found.
 *
 * In the new node model, children that are `op(...)` calls are leaf nodes;
 * children that are `node(...)` calls are static branch nodes; a sibling
 * `fallback: { name, subtree }` property is the wildcard-capture subtree.
 */
function walkTree(
  entryFile: string,
  onLeaf: (
    name: string,
    fn: ts.Node,
    childProp: ts.ObjectLiteralElementLike,
    checker: ts.TypeChecker,
  ) => void,
): void {
  const program = createExtractorProgram(entryFile)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(entryFile)
  if (!source) throw new Error(`walkTree: source not found: ${entryFile}`)

  const walkNodeCall = (call: ts.CallExpression, prefix: string): void => {
    const obj = objectArgOf(call)
    if (!obj) return

    for (const prop of obj.properties) {
      const key = propName(prop)
      if (!ts.isPropertyAssignment(prop) || key === undefined) continue

      if (key === "children" && ts.isObjectLiteralExpression(prop.initializer)) {
        for (const childProp of prop.initializer.properties) {
          const childKey = propName(childProp)
          if (!ts.isPropertyAssignment(childProp) || childKey === undefined) continue
          const init = childProp.initializer
          if (!ts.isCallExpression(init)) continue
          const callee = calleeName(init)

          if (callee === "op") {
            // Leaf node: op(fn, meta?) — extract input schema from fn's first arg
            const firstArg = init.arguments[0]
            if (firstArg === undefined) continue
            const fn = opFunctionNode(firstArg)
            if (!fn) continue
            onLeaf(join(prefix, childKey), fn, childProp, checker)
          } else {
            // static branch child: node({…}) or other constructor
            walkNodeCall(init, join(prefix, childKey))
          }
        }
      } else if (key === "fallback" && ts.isObjectLiteralExpression(prop.initializer)) {
        // fallback: { name: "...", subtree: node({…}) }
        let fallbackName: string | undefined
        let subtreeCall: ts.CallExpression | undefined
        for (const fbProp of prop.initializer.properties) {
          const fbKey = propName(fbProp)
          if (!ts.isPropertyAssignment(fbProp) || fbKey === undefined) continue
          if (fbKey === "name" && ts.isStringLiteral(fbProp.initializer)) {
            fallbackName = fbProp.initializer.text
          } else if (fbKey === "subtree" && ts.isCallExpression(fbProp.initializer)) {
            subtreeCall = fbProp.initializer
          }
        }
        if (fallbackName !== undefined && subtreeCall !== undefined) {
          walkNodeCall(subtreeCall, join(prefix, fallbackName))
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
        if (init && ts.isCallExpression(init) && calleeName(init) === "node") {
          walkNodeCall(init, "")
        }
      }
    }
    ts.forEachChild(n, visit)
  }

  visit(source)
}

/**
 * Extract the tool-name → schema map for every exported `node({…})` tree in a
 * source file. Mirrors toTools' name construction.
 */
export function extractToolSchemas(entryFile: string): SchemaMap {
  const out: SchemaMap = {}
  walkTree(entryFile, (name, fn, childProp, checker) => {
    const description = extractJsDoc(childProp)
    out[name] = {
      inputSchema: schemaFromFunctionNode(fn, checker),
      outputSchema: schemaFromReturnType(fn, checker),
      ...(description !== undefined ? { description } : {}),
    }
  })
  return out
}

/**
 * Extract the tool-name → TypeRef map for every exported `node({…})` tree in
 * a source file. Mirrors toTools' name construction. Same tree walk as
 * `extractToolSchemas`, but yields TypeRefs (pre-projection) instead of
 * JSON Schema.
 */
export function extractToolTypeRefs(entryFile: string): TypeRefMap {
  const out: TypeRefMap = {}
  walkTree(entryFile, (name, fn, childProp, checker) => {
    const description = extractJsDoc(childProp)
    out[name] = {
      input: typeRefFromFunctionNode(fn, checker),
      output: typeRefFromReturnType(fn, checker),
      ...(description !== undefined ? { description } : {}),
    }
  })
  return out
}
