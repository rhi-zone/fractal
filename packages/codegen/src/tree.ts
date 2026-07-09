// packages/codegen/src/tree.ts — @rhi-zone/fractal-codegen
//
// Walk an authored Node tree AT THE SOURCE LEVEL and produce a tool-name →
// { inputSchema, description } map — the artifact the MCP projection consumes.
//
// Why source-level: a `Node` value's TYPE erases per-leaf handler input types
// (`children: Record<string, ChildEntry>`), so the concrete
// `op((input: {...}) => …)` shapes only survive in the AST. This walker mirrors
// toTools' underscore-joined name construction so the emitted keys line up with
// the runtime tool names.
//
// In the new node model:
//   - Leaf nodes are authored as `op(fn, meta?)` calls stored in `children`.
//   - Branch nodes are authored as `node({ children?, meta? })` calls.
//   - The `ops` key no longer exists in the authoring API.
//
// Supported structure: `node({ children })` with child values:
//   - `op(fn, meta?)` or bare arrow → leaf (callable)
//   - `node({…})` → static branch child
//   - `param("name", node({…}))` → parameterized branch child
// meta.mcp.name / meta.mcp.segment overrides are NOT yet mirrored here.
//   TODO(codegen): honor meta.mcp.name / meta.mcp.segment when reconstructing
//   tool names, matching packages/mcp/src/project.ts.

import ts from "typescript"
import {
  createExtractorProgram,
  extractJsDoc,
  opFunctionNode,
  schemaFromFunctionNode,
  schemaFromReturnType,
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
 * Extract the tool-name → schema map for every exported `node({…})` tree in a
 * source file. Mirrors toTools' name construction.
 *
 * In the new node model, children that are `op(...)` calls are leaf nodes;
 * children that are `node(...)` or `param(...)` calls are branch or param nodes.
 */
export function extractToolSchemas(entryFile: string): SchemaMap {
  const program = createExtractorProgram(entryFile)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(entryFile)
  if (!source) throw new Error(`extractToolSchemas: source not found: ${entryFile}`)

  const out: SchemaMap = {}

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
            const name = join(prefix, childKey)
            const description = extractJsDoc(childProp)
            const outputSchema = schemaFromReturnType(fn, checker)
            out[name] = {
              inputSchema: schemaFromFunctionNode(fn, checker),
              outputSchema,
              ...(description !== undefined ? { description } : {}),
            }
          } else if (callee === "param") {
            // param("name", node({…}))
            const [nameArg, subtree] = init.arguments
            const paramName =
              nameArg && ts.isStringLiteral(nameArg) ? nameArg.text : childKey
            if (subtree && ts.isCallExpression(subtree)) {
              walkNodeCall(subtree, join(prefix, paramName))
            }
          } else {
            // static branch child: node({…}) or other constructor
            walkNodeCall(init, join(prefix, childKey))
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
        if (init && ts.isCallExpression(init) && calleeName(init) === "node") {
          walkNodeCall(init, "")
        }
      }
    }
    ts.forEachChild(n, visit)
  }

  visit(source)
  return out
}
