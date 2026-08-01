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
// meta.mcp.name (leaf) is now mirrored here (see `mcpMetaOverride` below) — a
// leaf's `meta.mcp.name` replaces the underscore-joined default entirely,
// matching packages/mcp-api-projector/src/project.ts's `projectTools` walk.
// Read off the resolved TYPE the same way `fallbackNameLiteral` reads a
// fallback's `name`: `op()`'s meta contributions are a `const`-inferred tuple
// (node.ts's `FoldMeta<C>`), so the literal survives into `op()`'s own return
// type — no AST needed. `meta.mcp` itself is only PRESENT on the type when
// something in the entry file's import graph has declaration-merged it onto
// `Meta` (mcp-api-projector's `project.ts` does this); absent that,
// `mcpMetaOverride` returns `undefined` and this walker falls back to its
// prior tree-position-derived naming, same as it always has.
//
// meta.mcp.segment (branch) is now mirrored too: `api()`'s `opts.meta`
// parameter (node.ts) is a `const` type parameter (`M`), matching how
// `children`/`fallback` already preserve literal types — so the literal
// `"products"` in `api(children, { meta: { mcp: { segment: "products" } }
// })` survives into the resolved TYPE, and `mcpMetaOverride` below reads it
// the same way it already reads a leaf's `meta.mcp.name`. See
// extract.test.ts's "meta.mcp overrides reflected in the reconstructed name"
// describe block for the executable record.

import ts from "typescript"
import type { TypeRef } from "@rhi-zone/fractal-type-ir"
import {
  createExtractorProgram,
  createSharingRegistry,
  extractJsDoc,
  finalizeSharedDefs,
  schemaFromFunctionNode,
  schemaFromReturnType,
  typeRefFromFunctionNode,
  typeRefFromReturnType,
  type JsonSchema,
  type ShouldShare,
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
 * Read a string-literal override at `meta.mcp.<key>` off a resolved node
 * TYPE — the type-level mirror of mcp-api-projector's own runtime read
 * (`getMcpMeta(child.meta).name` / `.segment`, project.ts), used here because
 * this walker only ever has a TYPE for a node, never a value. Returns
 * `undefined` when `meta.mcp` isn't present on the type at all (nothing in
 * the entry file's import graph has declaration-merged it onto `Meta`), the
 * requested key isn't set, or it resolves to a non-literal `string` (e.g. a
 * caller built the override from a runtime expression) — the caller then
 * falls back to tree-position-derived naming, mirroring mcp-api-projector's
 * own `typeof mcp.name === "string" ? mcp.name : ...` ternary.
 */
function mcpMetaOverride(
  nodeType: ts.Type,
  key: "name" | "segment",
  loc: ts.Node,
  checker: ts.TypeChecker,
): string | undefined {
  const metaProp = checker.getPropertyOfType(nodeType, "meta")
  if (!metaProp) return undefined
  const metaType = checker.getTypeOfSymbolAtLocation(metaProp, loc)
  const mcpProp = checker.getPropertyOfType(metaType, "mcp")
  if (!mcpProp) return undefined
  const mcpType = checker.getTypeOfSymbolAtLocation(mcpProp, loc)
  const keyProp = checker.getPropertyOfType(mcpType, key)
  if (!keyProp) return undefined
  const keyType = checker.getTypeOfSymbolAtLocation(keyProp, loc)
  return keyType.isStringLiteral() ? keyType.value : undefined
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
        // meta.mcp.name wins outright (no prefix applied) — else the usual
        // underscore-joined default, matching project.ts's own leaf-name ternary.
        const nameOverride = mcpMetaOverride(childType, "name", loc, checker)
        const name = nameOverride ?? join(prefix, childKey)
        onLeaf(name, [...path, childKey], fn, descriptionSource, checker)
        continue
      }

      // Branch: api(...) — children is required on api()'s return type.
      // meta.mcp.segment overrides this child's own contribution to the
      // prefix (the route `path` array is unaffected either way — mcp.segment
      // is an MCP-tool-naming concern only, matching project.ts's `rawSeg`).
      const segmentOverride = mcpMetaOverride(childType, "segment", loc, checker)
      walkNodeType(
        childType,
        join(prefix, segmentOverride ?? childKey),
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
        const subtreePath = [...path, `:${fallbackName}`]

        // The Node model explicitly allows `fallback.subtree` to be a bare
        // leaf (`op()`), not just a branch (`api({...})`) — build.ts's
        // runtime walks (`collectUnvalidatedLeaves`/`wrapValidatorsUnchecked`)
        // check `node.handler !== undefined` on the subtree itself before
        // ever looking at `children`, so a bare-leaf fallback subtree is
        // keyed at `subtreePath` directly (no extra segment beyond the
        // fallback's own name). Mirror that here: check whether the subtree
        // TYPE is itself a leaf (handler required) before recursing into it
        // as a branch, so extraction visits — and keys — a bare-leaf
        // fallback subtree exactly the way `wrapValidators` will at runtime.
        const subtreeHandlerProp = checker.getPropertyOfType(subtreeType, "handler")
        if (subtreeHandlerProp && isRequiredProperty(subtreeHandlerProp)) {
          const handlerType = checker.getTypeOfSymbolAtLocation(subtreeHandlerProp, loc)
          const fn = functionNodeOfHandler(handlerType, checker)
          if (fn) {
            const descriptionSource = subtreeProp.declarations?.[0] ?? fn
            const nameOverride = mcpMetaOverride(subtreeType, "name", loc, checker)
            const name = nameOverride ?? join(prefix, fallbackName)
            onLeaf(name, subtreePath, fn, descriptionSource, checker)
          }
        } else {
          walkNodeType(
            subtreeType,
            join(prefix, fallbackName),
            subtreePath,
            loc,
            checker,
            onLeaf,
          )
        }
      }
    }
  }
}

/**
 * The returned expression of a top-level function-declaration "tree
 * factory" body: the LAST top-level statement, if (and only if) it is an
 * unconditional `return <expr>`. Everything before it — destructuring, local
 * `op(...)`/`api(...)` consts, unrelated computation — is walked over
 * untouched and never inspected; only the TYPE of the final returned
 * expression matters, and the checker resolves an identifier's type through
 * its local binding on its own, so both `return api({...})` directly and
 * `const tree = api({...}); return tree` fall out of the same check with no
 * extra tracing needed. This is also busiless's actual pattern:
 * `buildDomainAuthTree(composed)` destructures `composed`, builds three
 * `op(...)` locals, then `return api({}, { fallback: {...} })`.
 *
 * A body ending in anything else — a conditional/branch, a loop, an
 * expression statement, multiple top-level returns spread across branches —
 * doesn't match and the factory is skipped, same as any other export that
 * isn't a tree. Deliberately no control-flow analysis: this only ever looks
 * at the LAST statement.
 */
function returnExpressionOfFactoryBody(body: ts.Block): ts.Expression | undefined {
  const stmts = body.statements
  const last = stmts[stmts.length - 1]
  return last && ts.isReturnStatement(last) && last.expression ? last.expression : undefined
}

/**
 * Find every exported `api(children, opts?)` TREE candidate in `source` and
 * invoke `visit(nodeType, loc)` for each — the shared export-scanning walk
 * behind both `walkTree` (below, which additionally descends into each
 * candidate via `walkNodeType`) and `hasTreeExport` (which only needs to
 * know whether at least one candidate exists, not walk into it).
 *
 * Finds exports via a minimal AST scan (there is no type-level way to
 * enumerate a file's exports); the tree SHAPE itself — leaves, branches,
 * fallbacks — comes entirely from `checker.getTypeAtLocation` on each
 * export, not from matching call expressions.
 *
 * Two export shapes are recognized: a top-level `export const x = api(...)`
 * (tree built eagerly), and a top-level `export function f(...) { ... }`
 * whose body returns a tree per `returnExpressionOfFactoryBody` above (tree
 * built inside a factory closing over a composition-time value, e.g.
 * `export function buildDomainAuthTree(composed) { return api({...}) }`) —
 * the factory's own parameters are never inspected, only the type of the
 * expression it returns.
 *
 * A candidate only reaches `visit` once it's confirmed Node-shaped (carries
 * a `meta` property) — plain re-exported types, unrelated constants, and a
 * factory whose body doesn't return a tree are filtered out here, not left
 * for `visit` to re-check.
 */
function forEachTreeCandidate(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  visit: (nodeType: ts.Type, loc: ts.Node) => void,
): void {
  // A Node value always carries `meta`; skip candidates that aren't trees
  // (plain re-exported types, unrelated constants, a factory that doesn't
  // return a tree, …).
  const visitIfTree = (nodeType: ts.Type, loc: ts.Node): void => {
    if (!checker.getPropertyOfType(nodeType, "meta")) return
    visit(nodeType, loc)
  }

  for (const stmt of source.statements) {
    const isExported =
      ts.canHaveModifiers(stmt) &&
      (ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
    if (!isExported) continue

    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
        visitIfTree(checker.getTypeAtLocation(decl.name), decl.name)
      }
      continue
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      const returnExpr = returnExpressionOfFactoryBody(stmt.body)
      if (returnExpr) visitIfTree(checker.getTypeAtLocation(returnExpr), returnExpr)
    }
  }
}

/**
 * Walk every exported `api(children, opts?)` tree in a source file, mirroring
 * toTools' name construction, and invoke `onLeaf` for each `op(fn, meta?)`
 * leaf found. See `forEachTreeCandidate` above for how exports are found and
 * filtered to genuine tree candidates; this just additionally descends into
 * each one via `walkNodeType`.
 */
function walkTree(entryFile: string, onLeaf: OnLeaf, sharedProgram?: ts.Program): void {
  const program = sharedProgram ?? createExtractorProgram(entryFile)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(entryFile)
  if (!source) throw new Error(`walkTree: source not found: ${entryFile}`)

  forEachTreeCandidate(source, checker, (nodeType, loc) =>
    walkNodeType(nodeType, "", [], loc, checker, onLeaf),
  )
}

/**
 * True when `entryFile` exports at least one `api(children, opts?)` tree at
 * its top level — per the same two export shapes `walkTree` recognizes (a
 * `const` bound directly to `api(...)`, or a factory function whose body's
 * final statement returns one) — WITHOUT requiring any leaf to be present
 * (an `api({})` with zero children still counts). This answers "is this a
 * Node-tree entry file", not "does it have anything to validate" — the
 * question `discover.ts`'s `findEntryFiles` needs answered to autodetect
 * entry files by directory scan instead of a hand-maintained list.
 *
 * `sharedProgram`, when given, reuses a pre-built `ts.Program` instead of
 * building a fresh single-root one over `entryFile` — same rationale as
 * `walkTree`'s own `sharedProgram` parameter and `buildValidatorModuleSource`'s
 * `program` option (build.ts).
 */
export function hasTreeExport(entryFile: string, sharedProgram?: ts.Program): boolean {
  const program = sharedProgram ?? createExtractorProgram(entryFile)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(entryFile)
  if (!source) throw new Error(`hasTreeExport: source not found: ${entryFile}`)
  let found = false
  forEachTreeCandidate(source, checker, () => {
    found = true
  })
  return found
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

/** Every leaf's derived input/output TypeRef, PLUS the shared `defs` map a
 * `shouldShare`-driven extraction produced — see `finalizeSharedDefs`
 * (extract.ts) and `SharingRegistry`'s doc comment. Sharing spans the WHOLE
 * tree (every leaf's input and output alike), since that's the entire point:
 * a type reused ACROSS tools, not just within one, is exactly the case
 * structural sharing exists for. */
export type TypeRefMapWithDefs = { readonly types: TypeRefMap; readonly defs: Record<string, TypeRef> }

/**
 * Extract the tool-name → TypeRef map for every exported `api(children, opts?)`
 * tree in a source file. Mirrors toTools' name construction. Same tree walk as
 * `extractToolSchemas`, but yields TypeRefs (pre-projection) instead of
 * JSON Schema.
 *
 * Passing `options.shouldShare` (default omitted — plain `TypeRefMap`, exact
 * prior behavior, no sharing) opts into structural sharing across every
 * leaf's input/output TypeRefs: the return shape becomes
 * `{ types, defs }`, `types` value TypeRefs may contain `{ kind: "ref" }`
 * nodes resolving into `defs` (see type-ir's `TypeRefDocument`).
 *
 * Passing `options.program` reuses a pre-built `ts.Program` (e.g. from
 * `createExtractorProgram`'s multi-root form) instead of building a fresh
 * single-root one over `entryFile` — see that function's doc comment for why
 * this matters for batch extraction across many entry files in one process.
 */
export function extractToolTypeRefs(entryFile: string, options?: { program?: ts.Program }): TypeRefMap
export function extractToolTypeRefs(
  entryFile: string,
  options: { shouldShare: ShouldShare; program?: ts.Program },
): TypeRefMapWithDefs
export function extractToolTypeRefs(
  entryFile: string,
  options?: { shouldShare?: ShouldShare; program?: ts.Program },
): TypeRefMap | TypeRefMapWithDefs {
  const registry = options?.shouldShare ? createSharingRegistry() : undefined
  const out: TypeRefMap = {}
  walkTree(
    entryFile,
    (name, _path, fn, descriptionSource, checker) => {
      const description = extractJsDoc(descriptionSource) ?? extractJsDoc(fn)
      out[name] = {
        input: typeRefFromFunctionNode(fn, checker, registry),
        output: typeRefFromReturnType(fn, checker, registry),
        ...(description !== undefined ? { description } : {}),
      }
    },
    options?.program,
  )
  if (!options?.shouldShare || !registry) return out
  return finalizeWithDefs(out, registry, options.shouldShare)
}

/**
 * Extract the ROUTE-PATH → TypeRef map for every exported `api(children,
 * opts?)` tree in a source file — same walk as `extractToolTypeRefs`, but
 * keyed by the `"/"`-joined path-segment string `build.ts`'s
 * `wrapValidators` uses (fallback segments rendered as `:name`) instead of
 * the underscore-joined MCP tool name. This is the key shape
 * `wrapValidators`'s generated-entry map expects.
 *
 * Same `options.shouldShare`/`options.program` opt-ins as `extractToolTypeRefs`
 * — see its doc comment.
 */
export function extractRouteTypeRefs(entryFile: string, options?: { program?: ts.Program }): TypeRefMap
export function extractRouteTypeRefs(
  entryFile: string,
  options: { shouldShare: ShouldShare; program?: ts.Program },
): TypeRefMapWithDefs
export function extractRouteTypeRefs(
  entryFile: string,
  options?: { shouldShare?: ShouldShare; program?: ts.Program },
): TypeRefMap | TypeRefMapWithDefs {
  const registry = options?.shouldShare ? createSharingRegistry() : undefined
  const out: TypeRefMap = {}
  walkTree(
    entryFile,
    (_name, path, fn, descriptionSource, checker) => {
      const description = extractJsDoc(descriptionSource) ?? extractJsDoc(fn)
      const key = path.join("/")
      out[key] = {
        input: typeRefFromFunctionNode(fn, checker, registry),
        output: typeRefFromReturnType(fn, checker, registry),
        ...(description !== undefined ? { description } : {}),
      }
    },
    options?.program,
  )
  if (!options?.shouldShare || !registry) return out
  return finalizeWithDefs(out, registry, options.shouldShare)
}

/** Shared plumbing for both `extractToolTypeRefs`/`extractRouteTypeRefs`'s
 * sharing opt-in: flattens every leaf's input/output into the
 * `Record<string, TypeRef>` `finalizeSharedDefs` expects (keyed
 * `${leafKey}\0input`/`${leafKey}\0output` so the two never collide), then
 * reassembles the per-leaf `TypeRefMap` shape from the rewritten roots. */
function finalizeWithDefs(
  map: TypeRefMap,
  registry: ReturnType<typeof createSharingRegistry>,
  shouldShare: ShouldShare,
): TypeRefMapWithDefs {
  const flatRoots: Record<string, TypeRef> = {}
  for (const [key, info] of Object.entries(map)) {
    flatRoots[`${key}\0input`] = info.input
    if (info.output !== undefined) flatRoots[`${key}\0output`] = info.output
  }
  const { roots, defs } = finalizeSharedDefs(registry, flatRoots, shouldShare)
  const types: TypeRefMap = {}
  for (const [key, info] of Object.entries(map)) {
    types[key] = {
      input: roots[`${key}\0input`]!,
      ...(info.output !== undefined ? { output: roots[`${key}\0output`]! } : {}),
      ...(info.description !== undefined ? { description: info.description } : {}),
    }
  }
  return { types, defs }
}
