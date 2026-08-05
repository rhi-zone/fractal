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
 * Read a string-literal value at `meta.<namespace>.<key>` off a resolved
 * `Node` TYPE — the SAME technique `mcpMetaOverride` above already uses for
 * `meta.mcp.name`/`meta.mcp.segment`, generalized to an arbitrary namespace
 * (`http`, `cli`, ...) and key, for `apply-validation-build.ts`'s wire-
 * profile build path (`meta.http.method`/`meta.http.verb`, an
 * `encodingMap` entry's base-profile-name string form). Returns `undefined`
 * when the namespace/key isn't present on the type at all, or resolves to a
 * non-literal `string` (e.g. built from a runtime expression) — the same
 * "falls back to whatever the caller does without an override" contract
 * `mcpMetaOverride` already documents.
 */
export function readMetaStringLiteral(
  nodeType: ts.Type,
  namespace: string,
  key: string,
  loc: ts.Node,
  checker: ts.TypeChecker,
): string | undefined {
  const metaProp = checker.getPropertyOfType(nodeType, "meta")
  if (!metaProp) return undefined
  const metaType = checker.getTypeOfSymbolAtLocation(metaProp, loc)
  const nsProp = checker.getPropertyOfType(metaType, namespace)
  if (!nsProp) return undefined
  const nsType = checker.getTypeOfSymbolAtLocation(nsProp, loc)
  const keyProp = checker.getPropertyOfType(nsType, key)
  if (!keyProp) return undefined
  const keyType = checker.getTypeOfSymbolAtLocation(keyProp, loc)
  return keyType.isStringLiteral() ? keyType.value : undefined
}

/**
 * Read `meta.<namespace>.sourceMap` off a resolved `Node` TYPE — one level
 * deeper than `readMetaStringLiteral`: `sourceMap` is itself a map (field
 * name -> `{ store, key? }`), so this enumerates the map's own literal keys
 * (`getPropertiesOfType`, the SAME enumeration `walkNodeType` already uses
 * for `children`) and reads each entry's `store`/`key` as string literals.
 * A field whose `store` doesn't resolve to a string literal is DROPPED from
 * the result (silently — same posture as `readMetaStringLiteral` returning
 * `undefined` for a non-literal single value) rather than failing the whole
 * read, since `resolveSourceMap`'s "Exact-variant hygiene" contract (see
 * docs/design/wire-profiles-and-staged-validation.md) is what's SUPPOSED to
 * keep every entry literal-keyed in the first place — a caller that widened
 * it themselves already accepted the erased-map behavior for that entry.
 *
 * Returns `undefined` when `meta.<namespace>.sourceMap` isn't present on the
 * type at all (no `sourceMap` contribution for this leaf under this
 * namespace).
 */
export function readMetaSourceMap(
  nodeType: ts.Type,
  namespace: string,
  loc: ts.Node,
  checker: ts.TypeChecker,
): Record<string, { readonly store: string; readonly key?: string }> | undefined {
  const metaProp = checker.getPropertyOfType(nodeType, "meta")
  if (!metaProp) return undefined
  const metaType = checker.getTypeOfSymbolAtLocation(metaProp, loc)
  const nsProp = checker.getPropertyOfType(metaType, namespace)
  if (!nsProp) return undefined
  const nsType = checker.getTypeOfSymbolAtLocation(nsProp, loc)
  const sourceMapProp = checker.getPropertyOfType(nsType, "sourceMap")
  if (!sourceMapProp) return undefined
  const sourceMapType = checker.getTypeOfSymbolAtLocation(sourceMapProp, loc)
  const out: Record<string, { store: string; key?: string }> = {}
  for (const fieldProp of checker.getPropertiesOfType(sourceMapType)) {
    const fieldType = checker.getTypeOfSymbolAtLocation(fieldProp, loc)
    const storeProp = checker.getPropertyOfType(fieldType, "store")
    if (!storeProp) continue
    const storeType = checker.getTypeOfSymbolAtLocation(storeProp, loc)
    if (!storeType.isStringLiteral()) continue
    const keyProp = checker.getPropertyOfType(fieldType, "key")
    const keyType = keyProp ? checker.getTypeOfSymbolAtLocation(keyProp, loc) : undefined
    const key = keyType?.isStringLiteral() ? keyType.value : undefined
    out[fieldProp.name] = key !== undefined ? { store: storeType.value, key } : { store: storeType.value }
  }
  return out
}

/**
 * Read `meta.<namespace>.encodingMap`'s STRING-literal (base-profile-name)
 * entries off a resolved `Node` TYPE — `readMetaSourceMap`'s sibling for
 * `encodingMap` (see docs/design/wire-profiles-and-staged-validation.md's
 * "Implementation trace (phase B)" section for the field name decision and
 * the KNOWN GAP this function deliberately does NOT close: an `encodingMap`
 * entry may ALSO be a custom decoder FUNCTION, `(w: FieldValidWire) =>
 * TField` — a function value has no literal TYPE for the checker to hand
 * back (unlike a string), so there is no analogous way to read one off a
 * TYPE alone; doing so would require re-emitting the function's own source
 * into the generated module, which this phase does not attempt (see the
 * design doc for the full writeup). A function-valued entry is silently
 * OMITTED from this function's result — exactly like `readMetaSourceMap`
 * omitting a non-literal `store` — so a caller sees only the entries it CAN
 * safely act on.
 */
export function readMetaEncodingMapProfileNames(
  nodeType: ts.Type,
  namespace: string,
  loc: ts.Node,
  checker: ts.TypeChecker,
): Record<string, string> | undefined {
  const metaProp = checker.getPropertyOfType(nodeType, "meta")
  if (!metaProp) return undefined
  const metaType = checker.getTypeOfSymbolAtLocation(metaProp, loc)
  const nsProp = checker.getPropertyOfType(metaType, namespace)
  if (!nsProp) return undefined
  const nsType = checker.getTypeOfSymbolAtLocation(nsProp, loc)
  const encodingMapProp = checker.getPropertyOfType(nsType, "encodingMap")
  if (!encodingMapProp) return undefined
  const encodingMapType = checker.getTypeOfSymbolAtLocation(encodingMapProp, loc)
  const out: Record<string, string> = {}
  for (const fieldProp of checker.getPropertiesOfType(encodingMapType)) {
    const fieldType = checker.getTypeOfSymbolAtLocation(fieldProp, loc)
    if (fieldType.isStringLiteral()) out[fieldProp.name] = fieldType.value
  }
  return out
}

/**
 * Read `meta.<namespace>.encodingMap`'s FUNCTION-form entries off a resolved
 * `Node` TYPE — the gap `readMetaEncodingMapProfileNames`'s own doc comment
 * documents as deliberately NOT closed by that function: a custom-decoder
 * function value has no literal TYPE the checker can hand back "as a value"
 * (unlike a string), so there is nothing to READ here — only something to
 * DETECT. This function answers a strictly narrower question than its
 * string-form sibling: not "what does this entry say" but "does a callable
 * live at this entry at all" — existence, via
 * `checker.getSignaturesOfType(fieldType, ts.SignatureKind.Call)` being
 * non-empty, never the function's own parameter/return types or its body.
 *
 * That narrower question is exactly what codegen needs for the function
 * form: the generated fragment doesn't need to know WHAT the decoder does
 * (it never runs at codegen time, never gets inlined, never gets its source
 * re-emitted — see docs/design/wire-profiles-and-staged-validation.md's
 * implementation-trace addendum for this phase, "the function never
 * moves") — only WHICH field names to emit a hook call-site for, so the
 * actual function (read off the tree's real `meta` at WRAP time, an
 * ordinary runtime value) can be substituted in later.
 *
 * A field present in the RESULT here should never also appear in
 * `readMetaEncodingMapProfileNames`'s result for the same `(namespace,
 * field)` — a field is either author-set to a base-profile-name STRING or a
 * decoder FUNCTION, never both (a single `op()` call composes one
 * `encodingMap` value per field; a later contribution's key wins outright
 * over an earlier one, same last-wins convention every other flat meta key
 * follows) — but this function doesn't assume that; it simply reports every
 * entry whose type carries a call signature, independent of what the string
 *-form reader finds.
 *
 * Returns `undefined` when `meta.<namespace>.encodingMap` isn't present on
 * the type at all — same "nothing to report" contract every sibling reader
 * in this file uses.
 */
export function readMetaEncodingMapFunctionFields(
  nodeType: ts.Type,
  namespace: string,
  loc: ts.Node,
  checker: ts.TypeChecker,
): ReadonlySet<string> | undefined {
  const metaProp = checker.getPropertyOfType(nodeType, "meta")
  if (!metaProp) return undefined
  const metaType = checker.getTypeOfSymbolAtLocation(metaProp, loc)
  const nsProp = checker.getPropertyOfType(metaType, namespace)
  if (!nsProp) return undefined
  const nsType = checker.getTypeOfSymbolAtLocation(nsProp, loc)
  const encodingMapProp = checker.getPropertyOfType(nsType, "encodingMap")
  if (!encodingMapProp) return undefined
  const encodingMapType = checker.getTypeOfSymbolAtLocation(encodingMapProp, loc)
  const out = new Set<string>()
  for (const fieldProp of checker.getPropertiesOfType(encodingMapType)) {
    const fieldType = checker.getTypeOfSymbolAtLocation(fieldProp, loc)
    if (checker.getSignaturesOfType(fieldType, ts.SignatureKind.Call).length > 0) out.add(fieldProp.name)
  }
  return out
}

/**
 * `onLeaf` receives both the underscore-joined MCP tool name (`name`, mirrors
 * `toTools`) and the raw path-segment array (`path`) it was built from — a
 * fallback segment appears in `path` as `:name` (e.g. `":bookId"`), matching
 * the convention `build.ts`'s `wrapValidators` uses at runtime over the
 * `Node` tree.
 */
export type OnLeaf = (
  name: string,
  path: readonly string[],
  fn: ts.Node,
  descriptionSource: ts.Node,
  checker: ts.TypeChecker,
  /** The leaf's own resolved `Node` TYPE (the `op()` return type, BEFORE
   * descending into `handler`) — additive, appended after every existing
   * parameter, so every existing `OnLeaf` implementation (none of which
   * declares this parameter) keeps satisfying the type unchanged: a function
   * with fewer declared parameters is assignable wherever more are expected
   * (TypeScript's own function-type compatibility rule; JS itself just
   * ignores extra call arguments). Exists so a caller that needs a leaf's own
   * META VALUE (not just its structural TYPE) — `apply-validation-build.ts`'s
   * wire-profile build path reading `meta.http.sourceMap`/`meta.http.method` —
   * can read it off THIS type the same way `mcpMetaOverride` already reads
   * `meta.mcp.name`/`meta.mcp.segment`, without a second tree walk. */
  nodeType: ts.Type,
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
 *
 * Exported (alongside `OnLeaf`) so a walk anchored on something OTHER than
 * this file's exported-tree scan can reuse it unchanged —
 * `apply-validation-build.ts` anchors on `applyValidation(key, treeExpr)`
 * CALL SITES and seeds `path` with `[]` (its keys are tree-relative; the
 * `key` argument, not a `treeId` path prefix, is what scopes one tree). The
 * export adds no behavior here: `walkTree` below still calls it exactly as
 * before.
 */
export function walkNodeType(
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
        onLeaf(name, [...path, childKey], fn, descriptionSource, checker, childType)
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
            onLeaf(name, subtreePath, fn, descriptionSource, checker, subtreeType)
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
 * extra tracing needed. This is also the sibling codebase's actual pattern:
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
 *
 * `visit` also receives `treeId` — the candidate's own exported binding name
 * (the `const`'s identifier, or the factory function's identifier) — the one
 * piece of per-candidate identity this scan already has on hand while it's
 * iterating exports one at a time. `walkTree` (below) folds it into the leaf
 * `path` it hands `onLeaf`, which is what lets `extractRouteTypeRefs`/
 * `extractRouteSchemas` disambiguate two trees in the same file that happen
 * to share a relative leaf path (see those functions' own doc comments for
 * why bare `path.join("/")` collided). Two shapes have no binding identifier
 * of their own and both fall back to the literal id `"default"`: an
 * anonymous `export default function(...) { ... }` factory, and a bare
 * `export default api(...)` (the tree expression exported directly, no
 * function wrapper, no variable binding — parses as `ts.ExportAssignment`).
 * The fallback is sound for both — a module can only have one default
 * export, so it can collide with another NAMED tree's own id only in the
 * (pathological, untested) case a file also has a `const` literally named
 * `default`, which isn't valid JS anyway. `export =` (`stmt.isExportEquals`
 * true, a TS-only construct distinct from a plain default export) is
 * deliberately NOT handled here — left unrecognized, same as before.
 */
function forEachTreeCandidate(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  visit: (nodeType: ts.Type, loc: ts.Node, treeId: string) => void,
): void {
  // A Node value always carries `meta`; skip candidates that aren't trees
  // (plain re-exported types, unrelated constants, a factory that doesn't
  // return a tree, …).
  const visitIfTree = (nodeType: ts.Type, loc: ts.Node, treeId: string): void => {
    if (!checker.getPropertyOfType(nodeType, "meta")) return
    visit(nodeType, loc, treeId)
  }

  for (const stmt of source.statements) {
    // A bare `export default <expr>` parses as ts.ExportAssignment, which
    // carries its own "export"/"default" tokens directly (not as modifiers
    // ts.getModifiers can see) — checked ahead of the modifier-based
    // isExported guard below, which doesn't apply to this node kind.
    // `stmt.isExportEquals` true means `export =` (a TS-only construct,
    // different export mechanism entirely) — deliberately left unhandled.
    if (ts.isExportAssignment(stmt)) {
      if (!stmt.isExportEquals) {
        visitIfTree(checker.getTypeAtLocation(stmt.expression), stmt.expression, "default")
      }
      continue
    }

    const isExported =
      ts.canHaveModifiers(stmt) &&
      (ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
    if (!isExported) continue

    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
        visitIfTree(checker.getTypeAtLocation(decl.name), decl.name, decl.name.text)
      }
      continue
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      const returnExpr = returnExpressionOfFactoryBody(stmt.body)
      if (returnExpr) visitIfTree(checker.getTypeAtLocation(returnExpr), returnExpr, stmt.name?.text ?? "default")
    }
  }
}

/**
 * Walk every exported `api(children, opts?)` tree in a source file, mirroring
 * toTools' name construction, and invoke `onLeaf` for each `op(fn, meta?)`
 * leaf found. See `forEachTreeCandidate` above for how exports are found and
 * filtered to genuine tree candidates; this just additionally descends into
 * each one via `walkNodeType`.
 *
 * Each candidate's own `treeId` (its exported binding name, from
 * `forEachTreeCandidate`) seeds `path` — NOT `prefix` — so it flows into the
 * raw path-segment array `onLeaf` receives (and therefore into
 * `extractRouteTypeRefs`/`extractRouteSchemas`'s `path.join("/")` keys)
 * without touching the underscore-joined MCP tool `name` (`prefix` still
 * starts at `""`, exactly as before) — a tool name is scoped by convention to
 * ONE standalone tree already (`extractToolSchemas`'s own doc comment), so
 * leaving it unprefixed is deliberate, not an oversight.
 */
function walkTree(entryFile: string, onLeaf: OnLeaf, sharedProgram?: ts.Program): void {
  const program = sharedProgram ?? createExtractorProgram(entryFile)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(entryFile)
  if (!source) throw new Error(`walkTree: source not found: ${entryFile}`)

  forEachTreeCandidate(source, checker, (nodeType, loc, treeId) =>
    walkNodeType(nodeType, "", [treeId], loc, checker, onLeaf),
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
 *
 * Passing `options.program` reuses a pre-built `ts.Program` (e.g. from
 * `createExtractorProgram`'s multi-root form) instead of building a fresh
 * single-root one over `entryFile` — same rationale, and same parameter
 * shape, as `extractToolTypeRefs`/`extractRouteTypeRefs`'s own
 * `options.program` (this file) and `buildValidatorModuleSource`'s `program`
 * argument (build.ts): a batch caller building JSON-Schema artifacts for many
 * entry files alongside their validator modules (see
 * `schema-build.ts`'s `buildSchemaModuleSource`) reuses the SAME shared
 * Program instead of paying a second multi-GB `ts.Program` build just for
 * schemas.
 */
export function extractToolSchemas(entryFile: string, options?: { program?: ts.Program }): SchemaMap {
  const out: SchemaMap = {}
  walkTree(
    entryFile,
    (name, _path, fn, descriptionSource, checker) => {
      const description = extractJsDoc(descriptionSource) ?? extractJsDoc(fn)
      out[name] = {
        inputSchema: schemaFromFunctionNode(fn, checker),
        outputSchema: schemaFromReturnType(fn, checker),
        ...(description !== undefined ? { description } : {}),
      }
    },
    options?.program,
  )
  return out
}

/**
 * Extract the tree-PATH → schema map for every exported `api(children,
 * opts?)` tree in a source file — same walk and same JSON-Schema derivation
 * as `extractToolSchemas`, keyed by `${treeId}/${path.join("/")}` instead of
 * the underscore-joined tool name (`treeId` is the exporting tree's own
 * binding name — the `const`'s identifier, or the factory function's — see
 * `forEachTreeCandidate`'s doc comment). Mirrors `extractRouteTypeRefs`'s own
 * path-keying (this file) — that function already made this exact choice
 * for validator codegen (`build.ts`'s `wrapValidators` looks its
 * `GeneratedEntry` map up by the same `"/"`-joined key at runtime, matching
 * this key format 1:1 — see that function's doc comment for how a caller
 * supplies the matching `treeId` as `wrapValidators`'s initial `path`).
 *
 * The `treeId` prefix (not just the leaf's tree-relative path) is required
 * because a source file may export MULTIPLE trees (`tree-factory.fixture.ts`
 * has two) — without it, two trees sharing a relative leaf path (e.g. both
 * have a top-level `"list"` leaf) would silently collide in the flat `out`
 * map this function builds across ALL of the file's trees, with the second
 * tree's entry overwriting the first's — a wrong-schema-silently-applied bug
 * at `wrapValidators` consumption time, not a missing-entry error
 * `collectUnvalidatedLeaves` could ever catch (see `extract.test.ts`'s "two
 * trees, colliding leaf path" coverage).
 *
 * Exists ALONGSIDE `extractToolSchemas`, not as a replacement — a bare tool
 * NAME is unique only within one standalone tree (fine for a single-tree
 * OpenAPI/MCP/CLI/JSON-RPC projection, which is what `extractToolSchemas`
 * still serves); a tree PATH is unique within a COMPOSED tree too (multiple
 * files' trees nested as branches under one root — the sibling codebase's one-root
 * composition, `docs/decisions/one-root-fractal-tree-2026-08-02.md` in that
 * repo, is the motivating case: a naive merge of 17 files' own
 * `extractToolSchemas` output collided on short generic names like `"list"`
 * across up to 7 unrelated slices). A caller merging several files' schema
 * maps into one for a composed root should call THIS function per file and
 * merge the results — each file's own keys are already path-relative to
 * that file's own tree root (now `treeId`-prefixed too), so no additional
 * per-file prefixing is needed as long as the composed root's `toOpenApi`
 * call correlates schemas via the SAME path-keyed mechanism (see
 * `openapi.ts`'s `buildPathMap`) rather than the underscore-joined
 * `codenName`.
 */
export function extractRouteSchemas(entryFile: string, options?: { program?: ts.Program }): SchemaMap {
  const out: SchemaMap = {}
  walkTree(
    entryFile,
    (_name, path, fn, descriptionSource, checker) => {
      const description = extractJsDoc(descriptionSource) ?? extractJsDoc(fn)
      out[path.join("/")] = {
        inputSchema: schemaFromFunctionNode(fn, checker),
        outputSchema: schemaFromReturnType(fn, checker),
        ...(description !== undefined ? { description } : {}),
      }
    },
    options?.program,
  )
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
 * keyed by `${treeId}/${path.join("/")}` (`treeId` = the exporting tree's own
 * binding name; fallback segments rendered as `:name`) instead of the
 * underscore-joined MCP tool name. This is the key shape `build.ts`'s
 * `wrapValidators` expects its generated-entry map to use — see that
 * function's doc comment for how a caller supplies the matching `treeId` via
 * `wrapValidators`'s initial `path` argument, and `extractRouteSchemas`'s doc
 * comment (above) for why the `treeId` prefix is load-bearing: without it,
 * two trees exported from the same file with a colliding relative leaf path
 * silently overwrite each other in this function's flat output map.
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
