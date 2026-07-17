// packages/http-api-projector/src/codegen.ts — @rhi-zone/fractal-http-api-projector
//
// Client codegen — generates a STANDALONE typed TypeScript client from an
// OpenAPI 3.1 document (see openapi.ts). "Standalone" is load-bearing: the
// emitted source has zero imports from any fractal package (or anywhere
// else) — it only depends on the global WHATWG `fetch`/`Request`/`URL`
// surface, so a consumer can drop the generated file into any TypeScript
// project without pulling in fractal as a dependency. This is the typed
// replacement for `client.ts`'s `AnyClient = Record<string, any>` runtime
// proxy — see client.ts's module doc, "TODO(client): typed client via
// codegen from source".
//
// Two passes over the spec:
//   1. `collectOperations` flattens `spec.paths` into one entry per
//      operation (operationId, path, verb, path-param names, request/
//      response schemas).
//   2. `buildClientTree` regroups those entries by operationId's dotted
//      segments into a nested tree — `"books.bookId.read"` becomes
//      `books -> bookId(param) -> read(op)`. A segment is a *param* node
//      (rendered as a function taking that value) exactly when its name
//      appears in that operation's own path parameters; this mirrors how
//      `openapi.ts`'s `nameLeaves`/`walkRoute` construct operationIds in the
//      first place — a fallback segment's codegen-name IS its param name.
//
// From the tree, two independent renderers walk the SAME structure:
//   - `nodeTypeLiteral`   — the `Client` type (nested object type, param
//                           positions as `(name: string) => {...}`).
//   - `nodeRuntimeLiteral` — the `createClient` factory's returned object
//                           literal, calling the shared `__request` helper.
//
// Per-operation `<Base>Input`/`<Base>Output` type aliases are emitted from
// `requestBody`/`responses["200"]` schemas via `schemaToType` — a small
// JSON-Schema-subset -> TS-type-string converter (see its own doc comment).
//
// See:
//   packages/http-api-projector/src/openapi.ts — OpenApiDoc/OpenApiSchema, the input to this module
//   packages/http-api-projector/src/client.ts  — the untyped runtime client this codegen supersedes

import type { OpenApiDoc, OpenApiSchema } from "./openapi.ts"

// ============================================================================
// Public API
// ============================================================================

export type CodegenOptions = {
  /** Name of the emitted `Client` type and factory return type. Defaults to "Client". */
  readonly clientName?: string
}

/**
 * Generate standalone TypeScript client source from an OpenAPI 3.1 document.
 * The returned string is a complete `.ts` file: type aliases, the `Client`
 * type, a `ClientError` class, and a `createClient(baseUrl, options)`
 * factory — no imports, ready to write to disk or `eval`.
 */
export function generateClient(spec: OpenApiDoc, options: CodegenOptions = {}): string {
  const clientName = options.clientName ?? "Client"
  const entries = collectOperations(spec)
  const root = newNode()
  for (const entry of entries) insertOperation(root, entry)

  const typeDecls: string[] = []
  for (const entry of entries) {
    const base = typeBaseName(entry.operationId)
    if (entry.requestSchema !== undefined) {
      typeDecls.push(`export type ${base}Input = ${schemaToType(entry.requestSchema, "")}`)
    }
    typeDecls.push(`export type ${base}Output = ${schemaToType(entry.responseSchema, "")}`)
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
// Internal: flatten the OpenAPI doc into one entry per operation
// ============================================================================

type OperationEntry = {
  readonly operationId: string
  readonly path: string
  readonly verb: string // uppercase HTTP method
  readonly pathParams: ReadonlySet<string>
  readonly requestSchema?: OpenApiSchema
  readonly responseSchema?: OpenApiSchema
}

function collectOperations(spec: OpenApiDoc): OperationEntry[] {
  const out: OperationEntry[] = []
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [verb, op] of Object.entries(methods)) {
      const pathParams = new Set((op.parameters ?? []).map((p) => p.name))
      const requestSchema = op.requestBody?.content["application/json"]?.schema
      const responseSchema = op.responses["200"]?.content["application/json"]?.schema
      out.push({
        operationId: op.operationId,
        path,
        verb: verb.toUpperCase(),
        pathParams,
        ...(requestSchema !== undefined ? { requestSchema } : {}),
        ...(responseSchema !== undefined ? { responseSchema } : {}),
      })
    }
  }
  return out
}

// ============================================================================
// Internal: regroup flat operations into a nested client tree
// ============================================================================

type ClientTreeNode = {
  readonly children: Map<string, ClientTreeNode>
  param?: { readonly name: string; readonly subtree: ClientTreeNode }
  readonly operations: Map<string, OperationEntry>
}

function newNode(): ClientTreeNode {
  return { children: new Map(), operations: new Map() }
}

/**
 * Thread one operation into the tree along its operationId's dotted
 * segments. All but the last segment are branch points; a segment is a
 * *param* branch (function-call node) exactly when its name is one of this
 * operation's own path parameters — the same convention that produced the
 * segment name in the first place (see openapi.ts's `nameLeaves`, which
 * names a fallback segment after `fallback.name`, the param name itself).
 */
function insertOperation(root: ClientTreeNode, entry: OperationEntry): void {
  const parts = entry.operationId.split(".")
  let node = root
  for (let i = 0; i < parts.length - 1; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const part = parts[i]!
    if (entry.pathParams.has(part)) {
      if (node.param === undefined) {
        node.param = { name: part, subtree: newNode() }
      } else if (node.param.name !== part) {
        throw new Error(
          `generateClient: conflicting param name at "${parts.slice(0, i + 1).join(".")}" — ` +
            `"${node.param.name}" vs "${part}"`,
        )
      }
      node = node.param.subtree
    } else {
      let child = node.children.get(part)
      if (child === undefined) {
        child = newNode()
        node.children.set(part, child)
      }
      node = child
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const opName = parts[parts.length - 1]!
  node.operations.set(opName, entry)
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

/** `"books.bookId.read"` -> `"BooksBookIdRead"` — base name for that op's `<Base>Input`/`<Base>Output`. */
function typeBaseName(operationId: string): string {
  return operationId.split(".").map(pascalCase).join("")
}

/** `/books/{bookId}` -> the content of a JS template literal: `/books/${encodeURIComponent(bookId)}`. */
function pathTemplateLiteral(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => `\${encodeURIComponent(${name})}`)
}

// ============================================================================
// Internal: JSON Schema (OpenApiSchema) -> TypeScript type string
//
// Deliberately a subset converter, matching the schema shapes extractToolSchemas
// (packages/api-tree/src/tree.ts) actually emits: primitives, object/array,
// const/enum, anyOf/oneOf/union, allOf/intersection, and `type` as an array
// (nullable shorthand). Anything else (unrecognized/absent `type`, no
// properties) degrades to `unknown`/`Record<string, unknown>` rather than
// guessing a shape.
// ============================================================================

function schemaToType(schema: OpenApiSchema | undefined, indent: string): string {
  if (schema === undefined) return "unknown"

  if ("const" in schema) return JSON.stringify(schema["const"])

  const enumValues = schema["enum"]
  if (Array.isArray(enumValues)) {
    if (enumValues.length === 0) return "never"
    return enumValues.map((v) => JSON.stringify(v)).join(" | ")
  }

  const anyOf = (schema["anyOf"] ?? schema["oneOf"]) as OpenApiSchema[] | undefined
  if (Array.isArray(anyOf)) {
    if (anyOf.length === 0) return "unknown"
    return anyOf.map((s) => schemaToType(s, indent)).join(" | ")
  }

  const allOf = schema["allOf"] as OpenApiSchema[] | undefined
  if (Array.isArray(allOf)) {
    if (allOf.length === 0) return "unknown"
    return allOf.map((s) => `(${schemaToType(s, indent)})`).join(" & ")
  }

  const type = schema["type"]
  if (Array.isArray(type)) {
    if (type.length === 0) return "unknown"
    return type.map((t) => schemaToType({ ...schema, type: t }, indent)).join(" | ")
  }

  const properties = schema["properties"] as Record<string, OpenApiSchema> | undefined
  if (type === "object" || properties !== undefined) {
    if (properties === undefined || Object.keys(properties).length === 0) {
      return "Record<string, unknown>"
    }
    const required = new Set((schema["required"] as string[] | undefined) ?? [])
    const nextIndent = indent + "  "
    const lines = Object.entries(properties).map(([key, propSchema]) => {
      const optional = required.has(key) ? "" : "?"
      return `${nextIndent}readonly ${safeKey(key)}${optional}: ${schemaToType(propSchema, nextIndent)}`
    })
    return `{\n${lines.join("\n")}\n${indent}}`
  }

  const items = schema["items"] as OpenApiSchema | undefined
  if (type === "array" || items !== undefined) {
    return `Array<${schemaToType(items, indent)}>`
  }

  switch (type) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
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

  for (const [opName, entry] of node.operations) {
    const base = typeBaseName(entry.operationId)
    const outputType = `${base}Output`
    const sig = entry.requestSchema !== undefined ? `(input: ${base}Input)` : `()`
    lines.push(`${nextIndent}readonly ${safeKey(opName)}: ${sig} => Promise<${outputType}>`)
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

  for (const [opName, entry] of node.operations) {
    const base = typeBaseName(entry.operationId)
    const hasInput = entry.requestSchema !== undefined
    const params = hasInput ? `input: ${base}Input` : ""
    const inputArg = hasInput ? "input" : "undefined"
    const pathLit = pathTemplateLiteral(entry.path)
    lines.push(
      `${nextIndent}${safeKey(opName)}: (${params}): Promise<${base}Output> => ` +
        `__request(baseUrl, fetchImpl, headers, "${entry.verb}", \`${pathLit}\`, ${inputArg}) as Promise<${base}Output>,`,
    )
  }

  return lines.length === 0 ? "{}" : `{\n${lines.join("\n")}\n${indent}}`
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
