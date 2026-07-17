// packages/http-api-projector/src/codegen.ts — @rhi-zone/fractal-http-api-projector
//
// Client codegen — generates a STANDALONE typed TypeScript client directly
// from an `HttpRoute` tree + `SchemaMap`. "Standalone" is load-bearing: the
// emitted source has zero imports from any fractal package (or anywhere
// else) — it only depends on the global WHATWG `fetch`/`Request`/`URL`
// surface, so a consumer can drop the generated file into any TypeScript
// project without pulling in fractal as a dependency. This is the typed
// replacement for `client.ts`'s `AnyClient = Record<string, any>` runtime
// proxy — see client.ts's module doc, "TODO(client): typed client via
// codegen from source".
//
// Previously this module took an `OpenApiDoc` (openapi.ts) and re-derived
// path/verb/schema facts from it — a pointless round-trip, since `HttpRoute`
// already carries paths (children keys), methods (the `methods` record), and
// param captures (`fallback`), and `SchemaMap` already carries input/output
// schemas per operation. This module now walks `HttpRoute` directly, mirroring
// `client.ts`'s `buildClientNode` recursion (children → nested client object,
// `fallback` → `(param) => subClient`, `methods` entries → leaf operations).
//
// Two entry points, same split as openapi.ts/client.ts:
//   - `generateClient(route, schemas?, options?)` — the core: walks an
//     already-projected `HttpRoute` tree. No `Node` needed for path/verb
//     correctness; only co-located method names (multiple HTTP verbs placed
//     at the same route position via `applyMoveTo`) and schema-map lookups
//     for those same co-located entries degrade — see `nameFromPath` below,
//     same degradation `toOpenApiFromRoute`/`createClientFromRoute` document.
//   - `generateClientFromNode(node, schemas?, options?)` — convenience:
//     projects `node` via `httpProjection` and also walks the raw `Node` tree
//     once to build two name maps (mirroring openapi.ts's `buildNameMap` and
//     client.ts's `buildHandlerNames`), so co-located members keep their
//     authored names and codegen-name schema lookups match `extractToolSchemas`
//     exactly, unaffected by `applyMoveTo`.
//
// Per-operation `<Base>Input`/`<Base>Output` type aliases are emitted from
// the looked-up `ToolSchema`'s `inputSchema`/`outputSchema` via `schemaToType`
// — a small JSON-Schema-subset -> TS-type-string converter (see its own doc
// comment). A route position's own path-param names (accumulated while
// walking `fallback`) are stripped from `inputSchema` before conversion —
// those fields are already supplied via the nested `(param: string) =>` call
// chain (e.g. `client.books.bookId(id).read()`), so re-listing them on the
// operation's own `input` argument would be redundant and, for GET/HEAD,
// would double-count them as query params. GET/HEAD operations now DO get an
// `Input` type + parameter when the (stripped) schema has real fields — the
// previous version unconditionally suppressed request input for every GET,
// which lost real query-param types (e.g. `catalog.search({ q })`).
//
// See:
//   packages/http-api-projector/src/route.ts    — HttpRoute, naiveTransform, rewriters, httpProjection's pipeline
//   packages/http-api-projector/src/openapi.ts  — buildNameMap-style full-path handler naming (sibling convention)
//   packages/http-api-projector/src/client.ts   — the untyped runtime client this codegen supersedes; buildHandlerNames-style own-key naming
//   packages/api-tree/src/tree.ts               — SchemaMap, ToolSchema, extractToolSchemas
//   packages/api-tree/src/extract.ts            — JsonSchema

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import type { Handler, Node } from "@rhi-zone/fractal-api-tree/node"
import type { JsonSchema } from "@rhi-zone/fractal-api-tree/extract"
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree"
import { httpProjection } from "./dx.ts"
import type { HttpRoute } from "./route.ts"

// ============================================================================
// Public API
// ============================================================================

export type CodegenOptions = {
  /** Name of the emitted `Client` type and factory return type. Defaults to "Client". */
  readonly clientName?: string
}

/**
 * Generate standalone TypeScript client source directly from an already-
 * projected `HttpRoute` tree (and an optional `SchemaMap` for typed
 * input/output). The returned string is a complete `.ts` file: type
 * aliases, the `Client` type, a `ClientError` class, and a
 * `createClient(baseUrl, options)` factory — no imports, ready to write to
 * disk or `eval`.
 *
 * Without `schemas`, every operation degrades to `unknown` input/output —
 * still a complete, working client, just untyped.
 *
 * Co-located method entries (multiple HTTP verbs placed at the same route
 * position via `applyMoveTo`) surface as members named by their lowercased
 * HTTP verb, and their schema-map lookup uses a path-derived codegen name —
 * since a bare `HttpRoute` has no memory of the authored `Node` child key a
 * moved handler started at (same degradation as `createClientFromRoute` in
 * client.ts). Use `generateClientFromNode` when the original `Node` tree is
 * available to recover authored names and exact `extractToolSchemas` keys.
 */
export function generateClient(
  route: HttpRoute,
  schemas?: SchemaMap,
  options: CodegenOptions = {},
): string {
  return render(buildTree(route, "", new Set(), schemas, undefined, undefined), options)
}

/**
 * Convenience wrapper: projects `node` via `httpProjection` (the standard
 * `naiveTransform` + `applyMethods`/`applyMoveTo`/`applyResponse` pipeline —
 * the same one `createFetch`/`httpRoutes` use) and also walks the raw `Node`
 * tree once to build the two name maps `generateClient` alone can't recover:
 *   - a handler → full underscore-joined codegen-name map (mirrors
 *     openapi.ts's `buildNameMap`), used for `SchemaMap` lookups — matches
 *     `extractToolSchemas`'s own naming exactly.
 *   - a handler → own authored child-key map (mirrors client.ts's
 *     `buildHandlerNames`), used for co-located client member names
 *     (`.read()`/`.replace()`/`.remove()` instead of `.get()`/`.put()`/`.delete()`).
 */
export function generateClientFromNode(
  node: Node,
  schemas?: SchemaMap,
  options: CodegenOptions = {},
): string {
  const route = httpProjection(node)
  const codegenNames = buildCodegenNameMap(node)
  const memberNames = buildMemberNameMap(node)
  return render(buildTree(route, "", new Set(), schemas, codegenNames, memberNames), options)
}

// ============================================================================
// Internal: handler → name maps, built from the raw Node tree
//
// Two independent conventions, same split as openapi.ts (`buildNameMap`,
// full accumulated path) and client.ts (`buildHandlerNames`, own key only) —
// duplicated here rather than imported, matching this package's existing
// convention of each projector deriving these facts via its own
// self-contained walk (see openapi.ts's module doc: "Two projectors, two
// encodings of the same fact").
// ============================================================================

/** Full underscore-joined path name (e.g. "books_bookId_read") — for SchemaMap lookups. */
function buildCodegenNameMap(n: Node): Map<Handler, string> {
  const out = new Map<Handler, string>()
  const visit = (node: Node, prefix: string): void => {
    for (const [key, child] of Object.entries(node.children ?? {})) {
      const seg = prefix.length > 0 ? `${prefix}_${key}` : key
      if (isLeaf(child)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        out.set(child.handler!, seg)
      } else {
        visit(child, seg)
      }
    }
    if (node.fallback !== undefined) {
      const seg = prefix.length > 0 ? `${prefix}_${node.fallback.name}` : node.fallback.name
      visit(node.fallback.subtree, seg)
    }
  }
  visit(n, "")
  return out
}

/** Own authored child key (e.g. "read") — for client member names. */
function buildMemberNameMap(n: Node): Map<Handler, string> {
  const out = new Map<Handler, string>()
  const visit = (node: Node): void => {
    for (const [key, child] of Object.entries(node.children ?? {})) {
      if (isLeaf(child)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        out.set(child.handler!, key)
      } else {
        visit(child)
      }
    }
    if (node.fallback !== undefined) visit(node.fallback.subtree)
  }
  visit(n)
  return out
}

/** Fallback name derived purely from path + verb, for handlers absent from a name map. */
function nameFromPath(path: string, verb: string): string {
  const base = path === "/"
    ? "root"
    : path
        .split("/")
        .filter((s) => s.length > 0)
        .map((s) => (s.startsWith("{") && s.endsWith("}") ? s.slice(1, -1) : s))
        .join("_")
  return `${base}_${verb.toLowerCase()}`
}

// ============================================================================
// Internal: HttpRoute walk -> client tree, decorated with schema/type info
// ============================================================================

type OperationEntry = {
  readonly memberName: string
  readonly codegenName: string
  readonly path: string // e.g. "/books/{bookId}"
  readonly verb: string // uppercase HTTP method
  readonly requestSchema?: JsonSchema
  readonly responseSchema?: JsonSchema
}

type ClientTreeNode = {
  readonly children: Map<string, ClientTreeNode>
  param?: { readonly name: string; readonly subtree: ClientTreeNode }
  readonly operations: Map<string, OperationEntry>
}

/** True when `schema` has at least one property left after path-param stripping. */
function hasContent(schema: JsonSchema | undefined): schema is JsonSchema {
  return schema?.properties !== undefined && Object.keys(schema.properties).length > 0
}

/**
 * Remove `exclude`d field names from a schema's `properties`/`required` —
 * those fields are already supplied via the route's own path-param capture
 * chain (the nested `(param: string) => ...` calls), so they don't belong on
 * an operation's own `input` argument. Schemas without `properties` (no
 * fields at all, or an "unsupported" punt schema) pass through unchanged.
 */
function stripPathParams(schema: JsonSchema | undefined, exclude: ReadonlySet<string>): JsonSchema | undefined {
  if (schema?.properties === undefined || exclude.size === 0) return schema
  const kept = Object.entries(schema.properties).filter(([k]) => !exclude.has(k))
  if (kept.length === Object.keys(schema.properties).length) return schema
  return {
    ...schema,
    properties: Object.fromEntries(kept),
    ...(schema.required !== undefined
      ? { required: schema.required.filter((r) => !exclude.has(r)) }
      : {}),
  }
}

/**
 * A route position that is exactly one operation and nothing else — no
 * children, no fallback. Mirrors client.ts's `isSingleLeafMethod`: this is
 * what every `naiveTransform`-produced leaf looks like before any
 * co-location (`applyMoveTo`) merges siblings onto it.
 */
function isSingleLeafMethod(route: HttpRoute): boolean {
  return (
    Object.keys(route.methods ?? {}).length === 1 &&
    Object.keys(route.children ?? {}).length === 0 &&
    route.fallback === undefined
  )
}

/**
 * Attach one operation to `node.operations`, looking up its schema and
 * stripping any path-param fields already supplied by the enclosing
 * `fallback` call chain.
 */
function attachOperation(
  node: ClientTreeNode,
  memberName: string,
  verb: string,
  entry: { readonly handler: Handler },
  path: string,
  pathParamNames: ReadonlySet<string>,
  schemas: SchemaMap | undefined,
  codegenNames: ReadonlyMap<Handler, string> | undefined,
): void {
  const codegenName = codegenNames?.get(entry.handler) ?? nameFromPath(path, verb)
  const toolSchema = schemas?.[codegenName]
  const requestSchema = stripPathParams(toolSchema?.inputSchema, pathParamNames)

  node.operations.set(memberName, {
    memberName,
    codegenName,
    path,
    verb: verb.toUpperCase(),
    ...(hasContent(requestSchema) ? { requestSchema } : {}),
    ...(toolSchema?.outputSchema !== undefined ? { responseSchema: toolSchema.outputSchema } : {}),
  })
}

/**
 * Walk an `HttpRoute` tree into a `ClientTreeNode`. Two cases produce a
 * NAMED operation attached directly to the current node (not a further-
 * nested branch):
 *   - a `route.children[seg]` position that is a single leaf method (the
 *     common case: an authored op with no sub-tree of its own) — the
 *     operation's member name is `seg`, its own tree key, exactly mirroring
 *     the old dotted-`operationId`-flattening convention (`"books.list"` ->
 *     `books: { list: ... }`), just derived structurally instead of by
 *     splitting a string.
 *   - `route.methods` present directly on the CURRENT position (the
 *     co-located case: multiple HTTP verbs merged onto one position by
 *     `applyMoveTo`, e.g. GET/PUT/DELETE all at `/books/{bookId}`) — no
 *     tree key distinguishes these from each other, so the member name
 *     comes from `memberNames` (handler identity -> authored key) when
 *     available, else degrades to the lowercased verb.
 */
function buildTree(
  route: HttpRoute,
  path: string,
  pathParamNames: ReadonlySet<string>,
  schemas: SchemaMap | undefined,
  codegenNames: ReadonlyMap<Handler, string> | undefined,
  memberNames: ReadonlyMap<Handler, string> | undefined,
): ClientTreeNode {
  const node: ClientTreeNode = { children: new Map(), operations: new Map() }
  const displayPath = path === "" ? "/" : path

  for (const [verb, entry] of Object.entries(route.methods ?? {})) {
    const memberName = memberNames?.get(entry.handler) ?? verb.toLowerCase()
    attachOperation(node, memberName, verb, entry, displayPath, pathParamNames, schemas, codegenNames)
  }

  for (const [seg, child] of Object.entries(route.children ?? {})) {
    const childPath = `${path}/${seg}`
    if (isSingleLeafMethod(child)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const [verb] = Object.keys(child.methods!)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const entry = child.methods![verb!]!
      attachOperation(node, seg, verb!, entry, childPath, pathParamNames, schemas, codegenNames)
    } else {
      node.children.set(seg, buildTree(child, childPath, pathParamNames, schemas, codegenNames, memberNames))
    }
  }

  if (route.fallback !== undefined) {
    const { name, subtree } = route.fallback
    node.param = {
      name,
      subtree: buildTree(
        subtree,
        `${path}/{${name}}`,
        new Set([...pathParamNames, name]),
        schemas,
        codegenNames,
        memberNames,
      ),
    }
  }

  return node
}

// ============================================================================
// Internal: naming helpers
// ============================================================================

/** A valid bare JS identifier, or a quoted string literal key otherwise. */
function safeKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
}

function pascalCase(part: string): string {
  return part
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("")
}

/** `"books_bookId_read"` -> `"BooksBookIdRead"` — base name for that op's `<Base>Input`/`<Base>Output`. */
function typeBaseName(codegenName: string): string {
  return codegenName.split("_").map(pascalCase).join("")
}

/** `/books/{bookId}` -> the content of a JS template literal: `/books/${encodeURIComponent(bookId)}`. */
function pathTemplateLiteral(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => `\${encodeURIComponent(${name})}`)
}

// ============================================================================
// Internal: JSON Schema -> TypeScript type string
//
// Deliberately a subset converter, matching the schema shapes `JsonSchema`
// (packages/api-tree/src/extract.ts) actually has: primitives, object/array,
// const/enum, anyOf/oneOf/union, allOf/intersection. Anything else
// (unrecognized/absent `type`, no properties) degrades to
// `unknown`/`Record<string, unknown>` rather than guessing a shape.
// ============================================================================

function schemaToType(schema: JsonSchema | undefined, indent: string): string {
  if (schema === undefined) return "unknown"

  if ("const" in schema) return JSON.stringify(schema.const)

  const enumValues = schema.enum
  if (Array.isArray(enumValues)) {
    if (enumValues.length === 0) return "never"
    return enumValues.map((v) => JSON.stringify(v)).join(" | ")
  }

  const anyOf = schema.anyOf ?? schema.oneOf
  if (Array.isArray(anyOf)) {
    if (anyOf.length === 0) return "unknown"
    return anyOf.map((s) => schemaToType(s, indent)).join(" | ")
  }

  const allOf = (schema as { allOf?: JsonSchema[] }).allOf
  if (Array.isArray(allOf)) {
    if (allOf.length === 0) return "unknown"
    return allOf.map((s) => `(${schemaToType(s, indent)})`).join(" & ")
  }

  const type = schema.type

  const properties = schema.properties
  if (type === "object" || properties !== undefined) {
    if (properties === undefined || Object.keys(properties).length === 0) {
      return "Record<string, unknown>"
    }
    const required = new Set(schema.required ?? [])
    const nextIndent = indent + "  "
    const lines = Object.entries(properties).map(([key, propSchema]) => {
      const optional = required.has(key) ? "" : "?"
      return `${nextIndent}readonly ${safeKey(key)}${optional}: ${schemaToType(propSchema, nextIndent)}`
    })
    return `{\n${lines.join("\n")}\n${indent}}`
  }

  const items = schema.items
  if (type === "array" || items !== undefined) {
    return `Array<${schemaToType(items === false ? undefined : items, indent)}>`
  }

  switch (type) {
    case "string":
      return "string"
    case "number":
      return "number"
    case "boolean":
      return "boolean"
    default:
      return "unknown"
  }
}

// ============================================================================
// Internal: Client type renderer
// ============================================================================

function nodeTypeLiteral(node: ClientTreeNode, indent: string): string {
  const nextIndent = indent + "  "
  const lines: string[] = []

  for (const [key, child] of node.children) {
    lines.push(`${nextIndent}readonly ${safeKey(key)}: ${nodeTypeLiteral(child, nextIndent)}`)
  }

  if (node.param !== undefined) {
    const { name, subtree } = node.param
    lines.push(`${nextIndent}readonly ${safeKey(name)}: (${name}: string) => ${nodeTypeLiteral(subtree, nextIndent)}`)
  }

  for (const [memberName, entry] of node.operations) {
    const base = typeBaseName(entry.codegenName)
    const outputType = entry.responseSchema !== undefined ? `${base}Output` : "unknown"
    const sig = entry.requestSchema !== undefined ? `(input: ${base}Input)` : `()`
    lines.push(`${nextIndent}readonly ${safeKey(memberName)}: ${sig} => Promise<${outputType}>`)
  }

  return lines.length === 0 ? "{}" : `{\n${lines.join("\n")}\n${indent}}`
}

// ============================================================================
// Internal: createClient runtime factory renderer — walks the SAME tree as
// nodeTypeLiteral, producing the matching object literal.
// ============================================================================

function nodeRuntimeLiteral(node: ClientTreeNode, indent: string): string {
  const nextIndent = indent + "  "
  const lines: string[] = []

  for (const [key, child] of node.children) {
    lines.push(`${nextIndent}${safeKey(key)}: ${nodeRuntimeLiteral(child, nextIndent)},`)
  }

  if (node.param !== undefined) {
    const { name, subtree } = node.param
    lines.push(`${nextIndent}${safeKey(name)}: (${name}: string) => (${nodeRuntimeLiteral(subtree, nextIndent)}),`)
  }

  for (const [memberName, entry] of node.operations) {
    const base = typeBaseName(entry.codegenName)
    const hasInput = entry.requestSchema !== undefined
    const outputType = entry.responseSchema !== undefined ? `${base}Output` : "unknown"
    const params = hasInput ? `input: ${base}Input` : ""
    const inputArg = hasInput ? "input" : "undefined"
    const pathLit = pathTemplateLiteral(entry.path)
    lines.push(
      `${nextIndent}${safeKey(memberName)}: (${params}): Promise<${outputType}> => ` +
        `__request(baseUrl, fetchImpl, headers, "${entry.verb}", \`${pathLit}\`, ${inputArg}) as Promise<${outputType}>,`,
    )
  }

  return lines.length === 0 ? "{}" : `{\n${lines.join("\n")}\n${indent}}`
}

// ============================================================================
// Internal: collect every operation in the tree (for type-alias emission)
// ============================================================================

function collectOperations(node: ClientTreeNode, out: OperationEntry[] = []): OperationEntry[] {
  for (const entry of node.operations.values()) out.push(entry)
  for (const child of node.children.values()) collectOperations(child, out)
  if (node.param !== undefined) collectOperations(node.param.subtree, out)
  return out
}

// ============================================================================
// Internal: top-level render
// ============================================================================

function render(root: ClientTreeNode, options: CodegenOptions): string {
  const clientName = options.clientName ?? "Client"
  const entries = collectOperations(root)

  const typeDecls: string[] = []
  const seenBases = new Set<string>()
  for (const entry of entries) {
    const base = typeBaseName(entry.codegenName)
    // Two different route positions could in principle share a codegen name
    // (only possible in the no-Node degraded-naming case, where two distinct
    // co-located verbs at two distinct paths both fall back to the same
    // `nameFromPath`-derived name); guard against emitting duplicate aliases.
    if (seenBases.has(base)) continue
    seenBases.add(base)
    if (entry.requestSchema !== undefined) {
      typeDecls.push(`export type ${base}Input = ${schemaToType(entry.requestSchema, "")}`)
    }
    if (entry.responseSchema !== undefined) {
      typeDecls.push(`export type ${base}Output = ${schemaToType(entry.responseSchema, "")}`)
    }
  }

  const clientTypeDecl = `export type ${clientName} = ${nodeTypeLiteral(root, "")}`
  const factoryBody = nodeRuntimeLiteral(root, "  ")

  return [
    HEADER,
    typeDecls.join("\n\n"),
    clientTypeDecl,
    RUNTIME_HELPERS,
    [
      `export function createClient(baseUrl: string, options: CreateClientOptions = {}): ${clientName} {`,
      `  const fetchImpl = options.fetch ?? fetch`,
      `  const headers = options.headers`,
      `  return ${factoryBody}`,
      `}`,
    ].join("\n"),
  ].join("\n\n") + "\n"
}

// ============================================================================
// Static template chunks — header, shared runtime helper, error class
// ============================================================================

const HEADER =
  "// @generated by @rhi-zone/fractal-http-api-projector's client codegen — do not edit\n" +
  "// Standalone: no imports, depends only on the global `fetch`/`Request`/`URL` surface."

const RUNTIME_HELPERS = `
export type CreateClientOptions = {
  readonly fetch?: typeof fetch
  readonly headers?: Record<string, string>
}

/** Thrown by the generated client when the server responds with a non-2xx status. */
export class ClientError extends Error {
  readonly status: number
  readonly statusText: string
  readonly body: unknown

  constructor(status: number, statusText: string, body: unknown) {
    super(\`HTTP \${status} \${statusText}\`)
    this.name = "ClientError"
    this.status = status
    this.statusText = statusText
    this.body = body
  }
}

async function __request(
  baseUrl: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string> | undefined,
  method: string,
  path: string,
  input: unknown,
): Promise<unknown> {
  let url: string
  const init: RequestInit = { method, headers: { ...(headers ?? {}) } }

  if (method === "GET" || method === "HEAD" || method === "DELETE") {
    // Input goes into query params for read-only/deletion ops.
    const isAbsolute = baseUrl.startsWith("http")
    const u = new URL(path, isAbsolute ? baseUrl : "http://localhost")
    if (input !== null && input !== undefined && typeof input === "object") {
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
      }
    }
    url = isAbsolute ? u.toString() : \`\${baseUrl}\${u.pathname}\${u.search}\`
  } else {
    // POST/PUT/PATCH: input as JSON body.
    url = \`\${baseUrl}\${path}\`
    init.headers = { ...(init.headers as Record<string, string>), "Content-Type": "application/json" }
    init.body = JSON.stringify(input ?? {})
  }

  const res = await fetchImpl(url, init)

  let body: unknown
  const ct = res.headers.get("Content-Type") ?? ""
  if (ct.includes("application/json")) {
    body = await res.json()
  } else {
    body = await res.text()
  }

  if (!res.ok) {
    throw new ClientError(res.status, res.statusText, body)
  }

  return body
}`.trim()
