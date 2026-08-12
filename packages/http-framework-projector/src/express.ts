// packages/http-framework-projector/src/express.ts — @rhi-zone/fractal-http-framework-projector
//
// Express router codegen — walks an `HttpRoute` tree (the same tree
// `@rhi-zone/fractal-http-api-projector`'s own `codegen.ts` walks to produce
// a standalone client) and emits an idiomatic Express `Router` instead: a
// `create<RouterName>Router(handlers)` factory returning a real `Router()`
// instance with `.get`/`.post`/`.put`/`.patch`/`.delete` registrations at
// real Express path syntax (`:param`, not `{param}`).
//
// EJECT MODEL (see docs/design/framework-router-codegen.md "Regen vs.
// one-time eject" — decided by the project owner): this writes the router
// file ONCE. Nothing here re-runs codegen automatically or asserts the
// output still matches the source tree. The emitted file carries a
// `// @generated ... do not edit` header (mirroring `codegen.ts`'s HEADER)
// as the minimal signal that hand-editing it means it will not be
// transparently overwritten by a future regen invocation — full
// drift-detection (hash-stamped, refuse/force/diff modes) is scoped in the
// design doc but not implemented here.
//
// HANDLER WIRING: the factory takes a `Handlers` argument — a plain nested
// object mirroring the route tree's shape, each leaf typed as fractal's own
// `Handler<I, O> = (input: I) => O | Promise<O>` signature
// (`@rhi-zone/fractal-api-tree/node`). This is deliberate: fractal's `Handler`
// already receives ONE assembled `input` object that includes path-param
// values merged in alongside query/body fields (see `route.ts`'s `assemble`)
// — so the SAME handler functions already wired into a fractal `api()`/`op()`
// tree can be passed straight into the generated factory unchanged, with no
// import-path guessing about where those handlers live. This differs from
// `codegen.ts`'s CLIENT codegen, which curries path params via
// `(id: string) => subClient` — that shape exists there because an HTTP
// CLIENT supplies path params per call; a SERVER-side handler already
// receives them as ordinary input fields, so no currying is needed here.
//
// REQUEST DECODING is a deliberately simplified approximation, not a port of
// `decode.ts`'s full `sources`/`sourceMap` machinery: for GET/HEAD/DELETE,
// `input = { ...req.params, ...req.query }`; for POST/PUT/PATCH,
// `input = { ...req.params, ...req.body }`. No per-param source overrides,
// no coercion (`req.params`/`req.query` values are always strings — a
// `number`-typed path param is NOT parsed to a number here). This is the
// same class of documented degradation `codegen.ts`'s module doc names for
// co-located methods: real, not silently swallowed. `req.body` requires the
// consuming app to already have body-parsing middleware mounted (e.g.
// `app.use(express.json())`) — this router does not add it, since it may be
// mounted inside a larger app that already configures its own.
//
// VALIDATION: none is generated. Per
// docs/design/framework-router-codegen.md's "Validator/schema mapping per
// target" section, Express (unlike Hono's `zValidator` or Elysia's
// `t.Object`) has no single dominant validation convention to target —
// generating a Zod/TypeBox call here would be picking a convention the
// framework itself doesn't have. `<Base>Input`/`<Base>Output` TYPE aliases
// ARE still emitted (from `SchemaMap`, same `schemaToType` JSON-Schema-subset
// conversion `codegen.ts` uses) purely for compile-time DX on the `Handlers`
// type — no runtime check is generated from them.
//
// RESPONSE ENCODING: always `res.json(result ?? null)` at the implicit
// default 200 status — mirrors `route.ts`'s own `defaultEncode`
// (`jsonRouteResponse(output, { status: 200 })`), not an invented
// convention. Custom status codes set via `meta.http.response`
// (`applyResponse`) are NOT reflected — same "eject, then hand-edit" answer
// as everything else this module simplifies.
//
// ERRORS: caught and passed to `next(err)` — Express's own built-in
// error-handling convention (not a fractal invention), letting the
// consumer's existing error-handling middleware decide the response shape.
//
// See:
//   packages/http-api-projector/src/codegen.ts — client codegen, this module's closest precedent
//   packages/http-api-projector/src/route.ts   — HttpRoute, naiveTransform, assemble, defaultEncode
//   packages/api-tree/src/node.ts              — Handler<I, O>
//   packages/api-tree/src/tree.ts              — SchemaMap, ToolSchema, extractToolSchemas
//   docs/design/framework-router-codegen.md    — settled decisions this module implements

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import type { Handler, Node } from "@rhi-zone/fractal-api-tree/node"
import type { JsonSchema } from "@rhi-zone/fractal-api-tree/extract"
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree"
import { httpProjection } from "@rhi-zone/fractal-http-api-projector"
import type { HttpRoute } from "@rhi-zone/fractal-http-api-projector/route"

// ============================================================================
// Public API
// ============================================================================

export type ExpressCodegenOptions = {
  /** Base name for the emitted `<RouterName>Handlers` type and `create<RouterName>Router` factory. Defaults to "Api". */
  readonly routerName?: string
}

/**
 * Generate Express router source directly from an already-projected
 * `HttpRoute` tree (and an optional `SchemaMap` for typed input/output
 * aliases). The returned string is a complete `.ts` file: type aliases, a
 * `<RouterName>Handlers` type, and a `create<RouterName>Router(handlers)`
 * factory returning a real `express.Router()` — ready to write to disk and
 * `import`/mount into an existing Express app (`app.use(createApiRouter(...))`).
 *
 * Without `schemas`, every operation's `Handlers` leaf degrades to
 * `Handler<unknown, unknown>` — still complete and mountable, just untyped.
 *
 * Co-located method entries (multiple HTTP verbs placed at the same route
 * position via `applyMoveTo`) surface as members named by their lowercased
 * HTTP verb, and their schema-map lookup uses a path-derived codegen name —
 * same degradation `generateClient` (codegen.ts) documents. Use
 * `generateExpressRouterFromNode` when the original `Node` tree is available
 * to recover authored names and exact `extractToolSchemas` keys.
 */
export function generateExpressRouter(
  route: HttpRoute,
  schemas?: SchemaMap,
  options: ExpressCodegenOptions = {},
): string {
  return render(buildTree(route, "", schemas, undefined, undefined), options)
}

/**
 * Convenience wrapper: projects `node` via `httpProjection` (the standard
 * `naiveTransform` + `applyMethods`/`applyMoveTo`/`applyResponse` pipeline)
 * and also walks the raw `Node` tree once to build the two name maps
 * `generateExpressRouter` alone can't recover — mirrors
 * `generateClientFromNode` (codegen.ts) exactly, same two maps, same reason.
 */
export function generateExpressRouterFromNode(
  node: Node,
  schemas?: SchemaMap,
  options: ExpressCodegenOptions = {},
): string {
  const route = httpProjection(node)
  const codegenNames = buildCodegenNameMap(node)
  const memberNames = buildMemberNameMap(node)
  return render(buildTree(route, "", schemas, codegenNames, memberNames), options)
}

// ============================================================================
// Internal: handler -> name maps, built from the raw Node tree
//
// Duplicated from codegen.ts rather than imported/shared — matches this
// package family's existing convention of each projector deriving these
// facts via its own self-contained walk (see codegen.ts's own module doc,
// quoting openapi.ts: "Two projectors, two encodings of the same fact").
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
      if (isLeaf(node.fallback.subtree)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        out.set(node.fallback.subtree.handler!, seg)
      } else {
        visit(node.fallback.subtree, seg)
      }
    }
  }
  visit(n, "")
  return out
}

/** Own authored child key (e.g. "read") — for Handlers object member names. */
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
    if (node.fallback !== undefined) {
      if (isLeaf(node.fallback.subtree)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        out.set(node.fallback.subtree.handler!, node.fallback.name)
      } else {
        visit(node.fallback.subtree)
      }
    }
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
        .map((s) => (s.startsWith(":") ? s.slice(1) : s))
        .join("_")
  return `${base}_${verb.toLowerCase()}`
}

// ============================================================================
// Internal: HttpRoute walk -> Express tree, decorated with schema/type info
// ============================================================================

type OperationEntry = {
  readonly memberName: string
  readonly codegenName: string
  readonly expressPath: string // e.g. "/books/:bookId" — real Express route syntax
  readonly verb: string // uppercase HTTP method
  readonly requestSchema?: JsonSchema
  readonly responseSchema?: JsonSchema
}

type ExpressTreeNode = {
  // Unified: both literal path-segment children AND a fallback (dynamic
  // path-param) child live in the same map, keyed by their own name — no
  // currying needed (see module doc: server-side handlers receive path
  // params as ordinary merged input fields, unlike the client's per-call
  // `(id) => ...` shape).
  readonly children: Map<string, ExpressTreeNode>
  readonly operations: Map<string, OperationEntry>
}

/** A route position that is exactly one operation and nothing else. Mirrors codegen.ts's `isSingleLeafMethod`. */
function isSingleLeafMethod(route: HttpRoute): boolean {
  return (
    Object.keys(route.methods ?? {}).length === 1 &&
    Object.keys(route.children ?? {}).length === 0 &&
    route.fallback === undefined
  )
}

function attachOperation(
  node: ExpressTreeNode,
  memberName: string,
  verb: string,
  entry: { readonly handler: Handler },
  expressPath: string,
  schemas: SchemaMap | undefined,
  codegenNames: ReadonlyMap<Handler, string> | undefined,
): void {
  const codegenName = codegenNames?.get(entry.handler) ?? nameFromPath(expressPath, verb)
  const toolSchema = schemas?.[codegenName]

  node.operations.set(memberName, {
    memberName,
    codegenName,
    expressPath,
    verb: verb.toUpperCase(),
    ...(toolSchema?.inputSchema !== undefined ? { requestSchema: toolSchema.inputSchema } : {}),
    ...(toolSchema?.outputSchema !== undefined ? { responseSchema: toolSchema.outputSchema } : {}),
  })
}

/**
 * Walk an `HttpRoute` tree into an `ExpressTreeNode`. Mirrors codegen.ts's
 * `buildTree` structurally, with two differences: path segments use `:name`
 * (real Express syntax) instead of `{name}`, and a `fallback` position is
 * folded directly into `children` (no curry wrapper — see module doc).
 */
function buildTree(
  route: HttpRoute,
  expressPath: string,
  schemas: SchemaMap | undefined,
  codegenNames: ReadonlyMap<Handler, string> | undefined,
  memberNames: ReadonlyMap<Handler, string> | undefined,
): ExpressTreeNode {
  const node: ExpressTreeNode = { children: new Map(), operations: new Map() }
  const displayPath = expressPath === "" ? "/" : expressPath

  for (const [verb, entry] of Object.entries(route.methods ?? {})) {
    const memberName = memberNames?.get(entry.handler) ?? verb.toLowerCase()
    attachOperation(node, memberName, verb, entry, displayPath, schemas, codegenNames)
  }

  for (const [seg, child] of Object.entries(route.children ?? {})) {
    const childPath = `${expressPath}/${seg}`
    if (isSingleLeafMethod(child)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const [verb] = Object.keys(child.methods!)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const entry = child.methods![verb!]!
      attachOperation(node, seg, verb!, entry, childPath, schemas, codegenNames)
    } else {
      node.children.set(seg, buildTree(child, childPath, schemas, codegenNames, memberNames))
    }
  }

  if (route.fallback !== undefined) {
    const { name, subtree } = route.fallback
    const childPath = `${expressPath}/:${name}`
    node.children.set(name, buildTree(subtree, childPath, schemas, codegenNames, memberNames))
  }

  return node
}

// ============================================================================
// Internal: naming helpers — duplicated from codegen.ts (see its own doc)
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

/** `.books.bookId.read` — dotted accessor chain onto the `handlers` argument. */
function handlerAccessExpr(pathKeys: readonly string[], memberName: string): string {
  return ["handlers", ...pathKeys, memberName].map(safeKey).join(".")
}

// ============================================================================
// Internal: JSON Schema -> TypeScript type string — duplicated from
// codegen.ts (see its own doc: deliberately a subset converter matching the
// shapes JsonSchema actually has; unrecognized shapes degrade to
// unknown/Record<string, unknown> rather than guessing).
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
// Internal: Handlers type renderer
// ============================================================================

function nodeTypeLiteral(node: ExpressTreeNode, indent: string): string {
  const nextIndent = indent + "  "
  const lines: string[] = []

  for (const [key, child] of node.children) {
    lines.push(`${nextIndent}readonly ${safeKey(key)}: ${nodeTypeLiteral(child, nextIndent)}`)
  }

  for (const [memberName, entry] of node.operations) {
    const base = typeBaseName(entry.codegenName)
    const inputType = entry.requestSchema !== undefined ? `${base}Input` : "unknown"
    const outputType = entry.responseSchema !== undefined ? `${base}Output` : "unknown"
    lines.push(`${nextIndent}readonly ${safeKey(memberName)}: Handler<${inputType}, ${outputType}>`)
  }

  return lines.length === 0 ? "{}" : `{\n${lines.join("\n")}\n${indent}}`
}

// ============================================================================
// Internal: collect every operation in the tree (for type-alias emission and
// router registration)
// ============================================================================

type CollectedOperation = OperationEntry & { readonly pathKeys: readonly string[] }

function collectOperations(
  node: ExpressTreeNode,
  pathKeys: readonly string[] = [],
  out: CollectedOperation[] = [],
): CollectedOperation[] {
  for (const entry of node.operations.values()) out.push({ ...entry, pathKeys })
  for (const [key, child] of node.children) collectOperations(child, [...pathKeys, key], out)
  return out
}

// ============================================================================
// Internal: top-level render
// ============================================================================

function render(root: ExpressTreeNode, options: ExpressCodegenOptions): string {
  const routerName = options.routerName ?? "Api"
  const handlersTypeName = `${routerName}Handlers`
  const factoryName = `create${routerName}Router`
  const entries = collectOperations(root)

  const typeDecls: string[] = []
  const seenBases = new Set<string>()
  for (const entry of entries) {
    const base = typeBaseName(entry.codegenName)
    if (seenBases.has(base)) continue
    seenBases.add(base)
    if (entry.requestSchema !== undefined) {
      typeDecls.push(`export type ${base}Input = ${schemaToType(entry.requestSchema, "")}`)
    }
    if (entry.responseSchema !== undefined) {
      typeDecls.push(`export type ${base}Output = ${schemaToType(entry.responseSchema, "")}`)
    }
  }

  const handlersTypeDecl = `export type ${handlersTypeName} = ${nodeTypeLiteral(root, "")}`

  const registrations = entries
    .map((entry) => {
      const accessExpr = handlerAccessExpr(entry.pathKeys, entry.memberName)
      const method = entry.verb.toLowerCase()
      const isBodyVerb = entry.verb === "POST" || entry.verb === "PUT" || entry.verb === "PATCH"
      const inputExpr = isBodyVerb
        ? "{ ...req.params, ...(req.body ?? {}) }"
        : "{ ...req.params, ...req.query }"
      return [
        `  router.${method}(${JSON.stringify(entry.expressPath)}, async (req: Request, res: Response, next: NextFunction) => {`,
        `    try {`,
        `      const input = ${inputExpr}`,
        `      const result = await ${accessExpr}(input)`,
        `      res.json(result ?? null)`,
        `    } catch (err) {`,
        `      next(err)`,
        `    }`,
        `  })`,
      ].join("\n")
    })
    .join("\n\n")

  return [
    HEADER,
    IMPORTS,
    typeDecls.join("\n\n"),
    handlersTypeDecl,
    [
      `export function ${factoryName}(handlers: ${handlersTypeName}): ReturnType<typeof Router> {`,
      `  const router = Router()`,
      ``,
      registrations,
      ``,
      `  return router`,
      `}`,
    ].join("\n"),
  ]
    .filter((chunk) => chunk.length > 0)
    .join("\n\n") + "\n"
}

// ============================================================================
// Static template chunks
// ============================================================================

const HEADER =
  "// @generated by @rhi-zone/fractal-http-framework-projector's Express router codegen — do not edit\n" +
  "// Eject model: this file is written once and not automatically regenerated — see\n" +
  "// docs/design/framework-router-codegen.md. Hand-edit freely; rerunning codegen\n" +
  "// overwrites this file wholesale, so re-run only when you intend to discard local edits.\n" +
  "//\n" +
  "// Requires body-parsing middleware (e.g. `app.use(express.json())`) mounted on the\n" +
  "// consuming app for POST/PUT/PATCH operations — this router does not add its own."

const IMPORTS =
  'import { Router } from "express"\n' + 'import type { NextFunction, Request, Response } from "express"\n' +
  'import type { Handler } from "@rhi-zone/fractal-api-tree/node"'
