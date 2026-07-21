// packages/graphql-api-projector/src/codegen.ts — @rhi-zone/fractal-graphql-api-projector
//
// Client codegen — generates a STANDALONE typed TypeScript client directly
// from a `Node` tree + a `FieldTypeMap`/`namedTypes` registry. "Standalone"
// is load-bearing, matching http-api-projector's own codegen.ts: the emitted
// source has zero imports from any fractal package (or anywhere else) — a
// consumer can drop the generated file into any TypeScript project without
// pulling fractal in as a dependency. This is the typed replacement for
// `client.ts`'s `AnyGraphQLClient = Record<string, any>` runtime proxy — see
// http-api-projector/src/codegen.ts's own module doc for the sibling
// rationale this mirrors.
//
// Reuses client.ts's exact document-assembly logic (`buildDocument`,
// `selectionSetFor`) and project.ts's exact naming/derivation logic
// (`argsFromInput`, `camelJoin`, `deriveOperationType`, `getGraphQLMeta`,
// `underscoreJoin`) rather than reimplementing them — a leaf's field name,
// operation type, argument list, and GraphQL document text must never drift
// between the runtime proxy client and this codegen path, since both need to
// address the exact same field a `createGraphQLServer` built from the same
// tree actually resolves.
//
// ── What differs from the runtime proxy client ──────────────────────────────
// `createGraphQLClient` (client.ts) computes a leaf's document/args ONCE at
// proxy-build time and merges captured (fallback) values with caller-supplied
// `input` through a runtime `slugValues` bag. Codegen has strictly more
// information at generation time: which arg names are captured (bound by an
// ancestor fallback) vs. declared (supplied by the caller) is statically
// known, so the generated code reads a captured arg directly off its
// enclosing closure parameter (the same `(id: string) => ({ ... })` nesting
// HTTP/MCP codegen already use for path/URI captures) instead of threading a
// runtime value bag — no `slugValues` merge needed in the emitted output.
//
// ── Types ────────────────────────────────────────────────────────────────
// Per-operation `<Base>Input`/`<Base>Output` type aliases are emitted
// directly from the looked-up `FieldTypeInfo`'s `input`/`output` TypeRefs via
// type-ir's `toTypeScript` (`@rhi-zone/fractal-type-ir/typescript`) — no
// JSON-Schema round-trip (unlike HTTP's `schemaToType`), since GraphQL's own
// `FieldTypeMap` already carries real TypeRefs. `Input` is emitted (and the
// operation's function gains an `input` parameter) only when the leaf has at
// least one DECLARED argument (`argsFromInput(typeInfo?.input).length > 0`);
// a leaf whose only arguments are fallback-captured has no `input` parameter
// at all — those values come from the closure chain, exactly mirroring HTTP
// codegen's path-param stripping.
//
// See:
//   packages/graphql-api-projector/src/client.ts    — the untyped runtime client this codegen supersedes; buildDocument/selectionSetFor source of truth
//   packages/graphql-api-projector/src/project.ts    — projectGraphQL (field-name/operation-type/arg source of truth)
//   packages/http-api-projector/src/codegen.ts       — sibling codegen (structural mirror, JSON-Schema flavored)
//   packages/api-tree/src/tree.ts                    — extractToolTypeRefs (produces the FieldTypeMap this module consumes)

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import type { Node } from "@rhi-zone/fractal-api-tree/node"
import type { TypeRef } from "@rhi-zone/fractal-type-ir"
import { toTypeScript } from "@rhi-zone/fractal-type-ir/typescript"
import { buildDocument, selectionSetFor } from "./client.ts"
import { argsFromInput, camelJoin, deriveOperationType, getGraphQLMeta, underscoreJoin } from "./project.ts"
import type { Arg, FieldTypeMap, OperationType } from "./project.ts"

// ============================================================================
// Public API
// ============================================================================

export type GraphQLCodegenOptions = {
  /** Underscore-joined tree-path → derived input/output TypeRefs — the same `FieldTypeMap` `projectGraphQL`/`createGraphQLServer`/`createGraphQLClient` accept. Drives argument/return types. */
  readonly types?: FieldTypeMap
  /** Named type declarations a `ref`-kind output TypeRef may target — needed to expand a `ref` field into a real selection set instead of degrading to `__typename`. Same registry `createGraphQLClient`'s `opts.namedTypes` accepts. */
  readonly namedTypes?: Readonly<Record<string, TypeRef>>
  /** Name of the emitted `Client` type and factory return type. Defaults to "Client". */
  readonly clientName?: string
}

/**
 * Generate standalone TypeScript client source from a `Node` tree. The
 * returned string is a complete `.ts` file: type aliases, per-operation
 * document constants, the `Client` type, a `GraphQLClientError` class, and a
 * `createClient(transport)` factory — no imports, ready to write to disk or
 * `eval`.
 *
 * Without `types`/`namedTypes`, every operation still produces a complete,
 * working (untyped — `unknown` input/output, `{ __typename }` or no
 * selection set) client and a syntactically valid document, mirroring
 * `createGraphQLClient`'s own degrade-gracefully behavior when `opts` is
 * omitted.
 */
export function generateGraphQLClient(tree: Node, opts: GraphQLCodegenOptions = {}): string {
  const types = opts.types ?? {}
  const namedTypes = opts.namedTypes ?? {}
  const root = buildTree(tree, [], [], types, namedTypes)
  return render(root, opts.clientName ?? "Client")
}

// ============================================================================
// Internal: Node walk -> client tree, decorated with type/document info
// ============================================================================

type OperationEntry = {
  readonly memberName: string
  readonly baseName: string
  readonly operationType: OperationType
  readonly fieldName: string
  /** Query-nesting path (ancestor tree path, incl. fallback-name segments) — `[]` for flat Mutation/Subscription. */
  readonly path: readonly string[]
  /** Full ordered arg list (captured-fallback first, then declared) — same order `project.ts`'s `buildField`/`buildDispatch` and `client.ts`'s `buildLeaf` use. */
  readonly args: readonly Arg[]
  /** Subset of `args` names sourced from an ancestor fallback's closure parameter, not the leaf's own `input`. */
  readonly capturedNames: ReadonlySet<string>
  readonly hasInput: boolean
  readonly inputTypeRef?: TypeRef
  readonly outputTypeRef?: TypeRef
  readonly document: string
}

type ClientTreeNode = {
  readonly children: Map<string, ClientTreeNode>
  param?: { readonly name: string; readonly subtree: ClientTreeNode }
  readonly operations: Map<string, OperationEntry>
}

/**
 * Walk a `Node` tree into a `ClientTreeNode`, computing each leaf's
 * field-name/operation-type/args/document via the exact same functions
 * `project.ts`/`client.ts` use — see module doc.
 */
function buildTree(
  node: Node,
  path: readonly string[],
  capturedArgs: readonly Arg[],
  types: FieldTypeMap,
  namedTypes: Readonly<Record<string, TypeRef>>,
): ClientTreeNode {
  const out: ClientTreeNode = { children: new Map(), operations: new Map() }

  for (const [key, child] of Object.entries(node.children ?? {})) {
    if (isLeaf(child)) {
      out.operations.set(key, buildLeafEntry(child, path, key, capturedArgs, types, namedTypes))
    } else {
      out.children.set(key, buildTree(child, [...path, key], capturedArgs, types, namedTypes))
    }
  }

  if (node.fallback !== undefined) {
    const { name, subtree } = node.fallback
    out.param = {
      name,
      subtree: buildTree(
        subtree,
        [...path, name],
        [...capturedArgs, { name, typeSDL: "ID!" }],
        types,
        namedTypes,
      ),
    }
  }

  return out
}

function buildLeafEntry(
  child: Node,
  path: readonly string[],
  key: string,
  capturedArgs: readonly Arg[],
  types: FieldTypeMap,
  namedTypes: Readonly<Record<string, TypeRef>>,
): OperationEntry {
  const operationType = deriveOperationType(child.meta)
  const gql = getGraphQLMeta(child.meta)
  const lookupKey = [...path, key].reduce(underscoreJoin, "")
  const typeInfo = types[lookupKey]

  const declaredArgs = argsFromInput(typeInfo?.input)
  const declaredNames = new Set(declaredArgs.map((a) => a.name))
  // Same merge order/precedence as project.ts's buildField/buildDispatch and
  // client.ts's buildLeaf: captured (fallback) args first, a declared arg
  // with a colliding name wins.
  const captured = capturedArgs.filter((a) => !declaredNames.has(a.name))
  const args = [...captured, ...declaredArgs]
  const capturedNames = new Set(captured.map((a) => a.name))

  const fieldName =
    typeof gql.name === "string" ? gql.name : operationType === "query" ? key : [...path, key].reduce(camelJoin, "")
  const fieldPath = operationType === "query" ? path : []

  const selection = selectionSetFor(typeInfo?.output, namedTypes)
  const document = buildDocument(operationType, fieldPath, fieldName, args, selection)

  return {
    memberName: key,
    baseName: typeBaseName(lookupKey),
    operationType,
    fieldName,
    path: fieldPath,
    args,
    capturedNames,
    hasInput: declaredArgs.length > 0,
    ...(declaredArgs.length > 0 && typeInfo?.input !== undefined ? { inputTypeRef: typeInfo.input } : {}),
    ...(typeInfo?.output !== undefined ? { outputTypeRef: typeInfo.output } : {}),
    document,
  }
}

// ============================================================================
// Internal: naming helpers
// ============================================================================

/** A valid bare JS identifier, or a quoted string literal key otherwise. */
function safeKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
}

/** A bare property-access expression, or bracket notation when `key` isn't a valid identifier. */
function propAccess(obj: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${obj}.${key}` : `${obj}[${JSON.stringify(key)}]`
}

function pascalCase(part: string): string {
  return part
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("")
}

/** `"books_add"` -> `"BooksAdd"` — base name for that op's `<Base>Input`/`<Base>Output` and `<Base>Document`. */
function typeBaseName(lookupKey: string): string {
  return lookupKey.split("_").map(pascalCase).join("") || "Root"
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
    const outputType = entry.outputTypeRef !== undefined ? `${entry.baseName}Output` : "unknown"
    const sig = entry.hasInput ? `(input: ${entry.baseName}Input)` : `()`
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
    const outputType = entry.outputTypeRef !== undefined ? `${entry.baseName}Output` : "unknown"
    const params = entry.hasInput ? `input: ${entry.baseName}Input` : ``
    const variablesLit =
      entry.args.length === 0
        ? "{}"
        : `{ ${entry.args
            .map((a) =>
              entry.capturedNames.has(a.name)
                ? `${safeKey(a.name)}: ${a.name}`
                : `${safeKey(a.name)}: ${propAccess("input", a.name)}`,
            )
            .join(", ")} }`
    const pathLit = JSON.stringify(entry.path)
    lines.push(
      `${nextIndent}${safeKey(memberName)}: (${params}): Promise<${outputType}> => ` +
        `__call(transport, ${entry.baseName}Document, ${variablesLit}, ${pathLit}, ` +
        `${JSON.stringify(entry.fieldName)}, ${JSON.stringify(entry.operationType)}) as Promise<${outputType}>,`,
    )
  }

  return lines.length === 0 ? "{}" : `{\n${lines.join("\n")}\n${indent}}`
}

// ============================================================================
// Internal: collect every operation in the tree (for type-alias/document emission)
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

function render(root: ClientTreeNode, clientName: string): string {
  const entries = collectOperations(root)

  const typeDecls: string[] = []
  const documentDecls: string[] = []
  const seenBases = new Set<string>()
  for (const entry of entries) {
    // Two distinct leaves could in principle share a base name only if
    // `meta.graphql.name` overrides collide across positions — guard against
    // emitting duplicate declarations (same convention as HTTP codegen).
    if (seenBases.has(entry.baseName)) continue
    seenBases.add(entry.baseName)
    if (entry.hasInput && entry.inputTypeRef !== undefined) {
      typeDecls.push(`export type ${entry.baseName}Input = ${toTypeScript(entry.inputTypeRef)}`)
    }
    if (entry.outputTypeRef !== undefined) {
      typeDecls.push(`export type ${entry.baseName}Output = ${toTypeScript(entry.outputTypeRef)}`)
    }
    documentDecls.push(`const ${entry.baseName}Document = ${JSON.stringify(entry.document)}`)
  }

  const clientTypeDecl = `export type ${clientName} = ${nodeTypeLiteral(root, "")}`
  const factoryBody = nodeRuntimeLiteral(root, "  ")

  return (
    [
      HEADER,
      typeDecls.join("\n\n"),
      documentDecls.join("\n"),
      clientTypeDecl,
      RUNTIME_HELPERS,
      [
        `export function createClient(transport: GraphQLTransport): ${clientName} {`,
        `  return ${factoryBody}`,
        `}`,
      ].join("\n"),
    ].join("\n\n") + "\n"
  )
}

// ============================================================================
// Static template chunks — header, shared runtime helpers, error class
// ============================================================================

const HEADER =
  "// @generated by @rhi-zone/fractal-graphql-api-projector's client codegen — do not edit\n" +
  "// Standalone: no imports, depends only on the transport function passed to createClient."

const RUNTIME_HELPERS = `
/** One GraphQL error entry, as \`errors[]\` conventionally carries it. */
export type GraphQLClientErrorEntry = {
  readonly message: string
  readonly extensions?: unknown
}

/** The shape a transport's response must carry — the standard GraphQL execution-result contract. */
export type GraphQLTransportResult = {
  readonly data?: unknown
  readonly errors?: readonly GraphQLClientErrorEntry[]
}

/**
 * Sends one query/mutation/subscription document + variables to a GraphQL
 * endpoint and returns its result. Wire this to \`fetch\` against a GraphQL
 * HTTP endpoint, directly to an in-process \`server.execute\` call, or any
 * other transport speaking the same contract.
 */
export type GraphQLTransport = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<GraphQLTransportResult>

/** Thrown by the generated client when the transport's result carries a non-empty \`errors\` array. */
export class GraphQLClientError extends Error {
  readonly errors: readonly GraphQLClientErrorEntry[]

  constructor(errors: readonly GraphQLClientErrorEntry[]) {
    super(errors[0]?.message ?? "GraphQL request failed")
    this.name = "GraphQLClientError"
    this.errors = errors
  }
}

/** Read the leaf field's own value back out of a transport's \`data\`, following \`path\` (Query only — Mutation/Subscription are flat). */
function __unwrapData(
  data: unknown,
  path: readonly string[],
  fieldName: string,
  operationType: "query" | "mutation" | "subscription",
): unknown {
  if (data === null || data === undefined) return undefined
  let cur: unknown = data
  if (operationType === "query") {
    for (const seg of path) {
      if (cur === null || typeof cur !== "object") return undefined
      cur = (cur as Record<string, unknown>)[seg]
    }
  }
  if (cur === null || typeof cur !== "object") return undefined
  return (cur as Record<string, unknown>)[fieldName]
}

async function __call(
  transport: GraphQLTransport,
  document: string,
  variables: Record<string, unknown>,
  path: readonly string[],
  fieldName: string,
  operationType: "query" | "mutation" | "subscription",
): Promise<unknown> {
  const result = await transport(document, variables)
  if (result.errors !== undefined && result.errors.length > 0) {
    throw new GraphQLClientError(result.errors)
  }
  return __unwrapData(result.data, path, fieldName, operationType)
}`.trim()
