// packages/cli-api-projector/src/cli.ts — @rhi-zone/fractal-cli-api-projector
//
// CLI projection for the function-core tree.
//
// Walks a Node tree along an argv subcommand path, resolving:
//   - Branch children → subcommand prefix segments
//   - `fallback` (wildcard-capture) → the current argv token IS the slug
//     value directly (no separate key segment — same as HTTP: the value
//     itself discriminates, not a tree-authored name)
//   - Leaf children (nodes with handler) → terminal subcommand names
//
// Tag-driven behavior (read directly from the leaf's OWN meta.tags — there is
// no ancestor inheritance; see docs/design/router-model.md — "Tags"):
//   - destructive:true  → io.confirm() before running (skippable via --yes/--force)
//   - readOnly:true     → no confirm
//   - streaming:true    → output each item as a JSONL line
//   - deprecated:true   → "[DEPRECATED]" marker in command listings + leaf help
//
// Input field → flag derivation:
//   Named --flags parsed from argv; fallback slug values merged on top
//   (provenance-blind — handler sees one flat input object).
//
// Help: --help at any level prints usage text.
// Output: JSON pretty-printed to io.stdout. Error: thrown CliError (exit code 1).
//
// Design note: runCli throws CliError instead of calling process.exit() directly.
// The caller decides how to handle exit (which lets tests inject without mocking
// process.exit, keeping the test runner alive).
//
// See:
//   packages/api-tree/src/node.ts   — Node, Handler, fallback
//   packages/api-tree/src/tags.ts   — resolveTags
//   packages/api-tree/src/tree.ts — extractToolSchemas, SchemaMap
//   docs/artifacts/fc-op-kinds/projection-cli.md — CLI concept inventory

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import { resolveTags } from "@rhi-zone/fractal-api-tree/tags"
import type { Tags } from "@rhi-zone/fractal-api-tree/tags"
import type { Handler, Meta, Node } from "@rhi-zone/fractal-api-tree/node"
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree"
import type { JsonSchema } from "@rhi-zone/fractal-api-tree/extract"
import { assemble, createStore, isResultShape } from "@rhi-zone/fractal-api-tree"
import type { SourceMap, Stores } from "@rhi-zone/fractal-api-tree"

// Augment the shared StoreRegistry with CLI's store names — see
// http-api-projector/src/decode.ts for the matching augmentation and its doc.
declare module "@rhi-zone/fractal-api-tree" {
  interface StoreRegistry {
    flag: true
    path: true
    env: true
  }
}

import { isValidatorWrapped, wrapValidators } from "@rhi-zone/fractal-api-tree/build"
import type { GeneratedEntry } from "@rhi-zone/fractal-api-tree/build"
import type { AlsConfig } from "@rhi-zone/fractal-api-tree/context"
import { generateCompletions, isShellName } from "./completions.ts"

// ============================================================================
// CliError — thrown instead of process.exit()
// ============================================================================

/**
 * Thrown by runCli on error or abort. `exitCode` is the intended process exit
 * code (1 for errors). The caller (a real main() or test harness) handles it.
 */
export class CliError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = "CliError"
    this.exitCode = exitCode
  }
}

// ============================================================================
// Injectable IO interface
// ============================================================================

/**
 * Injectable IO interface for testability.
 *
 * All writes go through stdout/stderr; confirm() handles destructive prompts.
 * Defaults: process.stdout, process.stderr, readline-based confirm.
 */
export type CliIO = {
  stdout: { write(s: string): void }
  stderr: { write(s: string): void }
  confirm(prompt: string): Promise<boolean>
}

// ============================================================================
// Options
// ============================================================================

export type CliOpts<T = unknown> = {
  /**
   * Pre-computed schema map (from extractToolSchemas). When provided, input
   * fields are derived from the JSON Schema — both for help text and for
   * coercing flag values to the schema's declared type before the handler
   * is called (see `coerceInput`). When absent, flags degrade to parsing
   * --key value pairs from argv as bare strings (no coercion).
   */
  readonly schemas?: SchemaMap
  /**
   * Program name used in usage/help text and generated completion scripts.
   * Defaults to "cli".
   */
  readonly programName?: string
  /**
   * Program version string, printed (and returned from) on `--version`/`-V`.
   * When absent, `--version` falls through to a CliError — there's nothing
   * to print.
   */
  readonly version?: string
  /**
   * Generated validators (from `buildValidatorModuleSource` /
   * `compileValidatorModule`, keyed by `"/"`-joined route path — see
   * `wrapValidators` in `@rhi-zone/fractal-api-tree/build`). When provided,
   * `n` is wrapped via `wrapValidators` before dispatch: any leaf with a
   * matching entry has its handler run through the generated `parse()`
   * (coercion + validation in one pass), and `coerceInput`/`applyDefaults`/
   * `validateRequired` are skipped for that leaf — the generated validator
   * takes over. Leaves with no matching entry (or when this option is
   * omitted entirely) keep using `coerceInput`/`validateRequired` against
   * `opts.schemas` as before.
   */
  readonly validators?: Readonly<Record<string, GeneratedEntry>>
  /**
   * Wrap the handler call so it runs inside its own `AsyncLocalStorage`
   * context. `init` computes the per-invocation context value from
   * CLI-specific dispatch context (see `CliAlsContext`). Mirrors HTTP's
   * `PresetOptions.als` (`packages/http-api-projector/src/preset.ts`). ALS is
   * the INNERMOST wrapper — closer to the handler than `opts.middleware` —
   * so the store is active only while `target.handler` (and anything it
   * calls, transitively) runs; a `CliMiddleware`'s own code, before or after
   * calling `next`, is NOT itself inside the ALS context — Node's
   * `AsyncLocalStorage` doesn't propagate back out through an `await`'d call
   * once it settles. A middleware that needs cross-cutting context should
   * read it from `stores` (the second parameter every `CliMiddleware`
   * receives), or read the ALS store from code it invokes synchronously
   * inside `next`. Absent by default (no ALS wrapping).
   */
  readonly als?: AlsConfig<CliAlsContext, T>
  /**
   * Around-hooks wrapping the handler call — `F => F` where
   * `F = (input, stores) => result` (see
   * docs/design/middleware-and-caller-context.md). Composes like an onion:
   * the first entry in the array is the OUTERMOST wrapper (it sees the call
   * first and last), matching HTTP's layer composition
   * (`packages/http-api-projector/src/layers.ts`). `stores` is the raw
   * pre-assembly stores built for input assembly (see `buildInput`) — the
   * vehicle for cross-cutting concerns (caller identity, audit, ...); the
   * handler itself never sees `stores`.
   *
   * When omitted (or empty), the handler is called directly — zero overhead.
   */
  readonly middleware?: readonly CliMiddleware[]
}

// ============================================================================
// Middleware — around-hooks wrapping the handler call
//
// Middleware is F => F, where F = (input, stores) => result — see
// docs/design/middleware-and-caller-context.md. `input` is the assembled,
// validated domain arguments (same shape the handler receives); `stores` is
// the raw pre-assembly stores built by `buildInput`. The handler itself is
// `(input) => result` — it never receives `stores`; that's structural (see
// the `(input, _stores) => handler(input)` base in `runCli`), not a
// convention to remember.
// ============================================================================

/**
 * A CLI middleware wraps the handler-invoking function `next` (itself
 * `F => F`, see module doc above). Middleware compose like HTTP layers:
 * `runCli` applies `opts.middleware` outermost-first (see `CliOpts`).
 */
export type CliMiddleware = (
  next: (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown>,
) => (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown>

/**
 * Compose `middleware` around `base`, first entry outermost — `middleware[0]`
 * wraps `middleware[1]` wraps ... wraps `base`. An empty array returns `base`
 * unchanged (identity — no wrapping overhead).
 */
function composeMiddleware(
  middleware: readonly CliMiddleware[],
  base: (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown>,
): (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown> {
  let wrapped = base
  for (let i = middleware.length - 1; i >= 0; i--) {
    wrapped = middleware[i]!(wrapped)
  }
  return wrapped
}

// ============================================================================
// ALS dispatch context — separate from CliMiddleware's (input, stores). ALS
// is a side channel (see docs/design/middleware-and-caller-context.md); this
// is dispatch metadata for `CliOpts.als`'s `init`, not a context bag threaded
// through middleware.
// ============================================================================

/** Dispatch context `CliOpts.als`'s `init` receives. */
export type CliAlsContext = {
  readonly meta: Meta
  readonly io: CliIO
  readonly slugs: Record<string, string>
  readonly leafName: string
}

// ============================================================================
// CLI meta extraction
// ============================================================================

/**
 * `meta.cli` open bag — per-projection overrides for CLI subcommand
 * generation. Standard keys are typed; any other key passes through
 * untouched (open bag, not a fixed schema).
 */
export type CliMeta = {
  readonly name?: string
  readonly alias?: string
  readonly hidden?: boolean
  /**
   * Per-param source overrides for this leaf's input assembly (see
   * `packages/api-tree/src/input.ts`). Lets a tree author pull a field from
   * a store other than the CLI's default ("flag") — e.g.
   * `{ apiKey: { store: "env", key: "API_KEY" } }` to require an environment
   * variable instead of a `--api-key` flag. Params not listed here still
   * resolve via the normal flag/slug convention.
   */
  readonly sourceMap?: SourceMap
  readonly [key: string]: unknown
}

export function getCliMeta(meta: Meta): CliMeta {
  const c = meta.cli
  if (typeof c !== "object" || c === null) return {}
  return c as CliMeta
}

// ============================================================================
// Resolution: walk the Node tree along argv segments
// ============================================================================

/**
 * Resolved dispatch target: the leaf handler to call and the accumulated
 * slug values from `fallback` traversal.
 */
type Resolved = {
  readonly handler: Handler
  readonly slugs: Record<string, string>
  readonly leafName: string
  readonly leafMeta: Meta
  /**
   * The path used to look up this leaf's schema in a `SchemaMap`, i.e. the
   * same underscore-joined segments `extractToolSchemas` (packages/api-tree/
   * src/tree.ts) produces: fallback segments are named by `fallback.name`
   * (e.g. "bookId"), NOT by the runtime slug value the user typed on argv.
   * Distinct from the raw argv path segments, which contain the literal
   * slug value at that position.
   */
  readonly schemaPath: string[]
}

/**
 * Find a leaf child of `children` whose `meta.cli.alias` equals `head`.
 * Returns the child's canonical key (NOT the alias) alongside the node —
 * schema lookups and help text key off the canonical name, so an alias is
 * purely an alternate invocation spelling, never a rename.
 */
function findLeafByAlias(
  children: Record<string, Node>,
  head: string,
): [string, Node] | undefined {
  for (const [key, child] of Object.entries(children)) {
    if (isLeaf(child) && getCliMeta(child.meta).alias === head) return [key, child]
  }
  return undefined
}

/**
 * Walk the node tree along argv segments, resolving:
 *
 *   Static child (no handler) → consume segment, recurse
 *   No static match + `fallback` present → consume current segment as the
 *     slug value directly, bind it as `fallback.name`, recurse into subtree
 *   Leaf child (has handler) at tail → terminal; return resolved
 *
 * A leaf child's `meta.cli.alias` (see `CliMeta`) is also accepted at the
 * terminal position — `head` may name either the leaf's own key or its
 * alias. The resolved `leafName`/`schemaPath` always use the canonical key.
 *
 * Returns null if no matching path is found.
 */
function resolveLeaf(
  n: Node,
  segments: string[],
  slugs: Record<string, string>,
  schemaPath: string[] = [],
): Resolved | null {
  if (segments.length === 0) return null
  const [head, ...tail] = segments
  if (head === undefined) return null

  const children = n.children ?? {}

  // Terminal: head should name a leaf child, by its own key or its alias
  if (tail.length === 0) {
    const direct = children[head]
    const [key, child] = direct !== undefined
      ? [head, direct]
      : (findLeafByAlias(children, head) ?? [head, undefined])
    if (child !== undefined && isLeaf(child)) {
      return {
        handler: child.handler!,
        slugs,
        leafName: key,
        leafMeta: child.meta,
        schemaPath: [...schemaPath, key],
      }
    }
    return null
  }

  // Non-terminal: try a static child first (static children always win)
  const staticChild = children[head]
  if (staticChild !== undefined) {
    if (!isLeaf(staticChild)) {
      return resolveLeaf(staticChild, tail, slugs, [...schemaPath, head])
    }
    // A leaf child at non-tail is a dead-end (a leaf has no children to recurse into)
    return null
  }

  // No static match — fall back to the wildcard-capture subtree, if any.
  // `head` IS the slug value directly (no separate key segment); the
  // schema path instead records `fallback.name`, matching how
  // extractToolSchemas names the fallback subtree's tools.
  if (n.fallback !== undefined) {
    return resolveLeaf(
      n.fallback.subtree,
      tail,
      { ...slugs, [n.fallback.name]: head },
      [...schemaPath, n.fallback.name],
    )
  }

  return null
}

// ============================================================================
// Help text generation
// ============================================================================

function descriptionFrom(meta: Meta): string | undefined {
  if (typeof meta.description === "string") return meta.description
  const cliMeta = getCliMeta(meta)
  if (typeof cliMeta.description === "string") return cliMeta.description
  return undefined
}

function buildHelp(
  n: Node,
  path: string[],
  programName: string,
): string {
  const lines: string[] = []
  const cmd = [programName, ...path].join(" ")

  const desc = descriptionFrom(n.meta)
  if (desc !== undefined) lines.push(desc, "")

  lines.push(`Usage: ${cmd} <subcommand> [options]`, "")

  const children = n.children ?? {}

  // List leaf children (callables)
  const leafEntries = Object.entries(children).filter(([, child]) => isLeaf(child))
  if (leafEntries.length > 0) {
    lines.push("Commands:")
    for (const [key, child] of leafEntries) {
      const cliMeta = getCliMeta(child.meta)
      if (cliMeta.hidden === true) continue
      const leafDesc = descriptionFrom(child.meta)
      const leafName = typeof cliMeta.name === "string" ? cliMeta.name : key
      const aliasSuffix = typeof cliMeta.alias === "string" ? ` (alias: ${cliMeta.alias})` : ""
      const deprecatedPrefix = resolveTags((child.meta.tags ?? {}) as Tags).deprecated === true ? "[DEPRECATED] " : ""
      lines.push(`  ${deprecatedPrefix}${leafName}${aliasSuffix}${leafDesc !== undefined ? `  — ${leafDesc}` : ""}`)
    }
  }

  // List branch children
  const nonLeafEntries = Object.entries(children).filter(([, child]) => !isLeaf(child))
  if (nonLeafEntries.length > 0 || n.fallback !== undefined) {
    if (leafEntries.length > 0) lines.push("")
    lines.push("Subcommand groups:")
    for (const [key, child] of nonLeafEntries) {
      const cliMeta = getCliMeta(child.meta)
      if (cliMeta.hidden === true) continue
      const childDesc = descriptionFrom(child.meta)
      lines.push(`  ${key}${childDesc !== undefined ? `  — ${childDesc}` : ""}`)
    }
    if (n.fallback !== undefined) {
      const cliMeta = getCliMeta(n.fallback.subtree.meta)
      if (cliMeta.hidden !== true) {
        lines.push(`  <${n.fallback.name}>  — parameterized group`)
      }
    }
  }

  lines.push("")
  lines.push("Global flags:")
  lines.push("  --help        Show this help text")
  lines.push("  --version, -V  Print the program version")
  lines.push("  --json        Output result as JSON (default)")
  lines.push("  --yes, --force  Skip confirmation prompts for destructive ops")
  lines.push("")
  lines.push(`Run '${cmd} completions <bash|zsh|fish>' to print a shell completion script.`)

  return lines.join("\n") + "\n"
}

function buildLeafHelp(
  resolved: Resolved,
  path: string[],
  programName: string,
  schemas: SchemaMap,
): string {
  const lines: string[] = []
  const cmd = [programName, ...path].join(" ")
  const desc = descriptionFrom(resolved.leafMeta)
  if (desc !== undefined) lines.push(desc, "")
  lines.push(`Usage: ${cmd} [options]`, "")

  const tags = resolveTags((resolved.leafMeta.tags ?? {}) as Tags)
  if (tags.deprecated === true) lines.push("  [DEPRECATED] This operation is deprecated and may be removed.", "")
  if (tags.destructive === true) lines.push("  This operation is destructive and irreversible. Requires --yes/--force to skip confirmation.", "")
  if (tags.readOnly === true) lines.push("  This operation is read-only.", "")
  if (tags.streaming === true) lines.push("  This operation streams results (one JSON object per line).", "")

  // Derive flags from schema — schemaPath uses fallback.name (e.g. "bookId"),
  // not the runtime slug value, matching extractToolSchemas' key convention.
  const schemaName = resolved.schemaPath.join("_").replace(/-/g, "_")
  const toolSchema = schemas[schemaName]

  lines.push("Options:")
  lines.push("  --help        Show this help text")
  lines.push("  --yes, --force  Skip confirm for destructive ops")
  lines.push("  --json        Output as JSON (default)")

  if (toolSchema?.inputSchema.properties !== undefined) {
    const props = toolSchema.inputSchema.properties
    const required = toolSchema.inputSchema.required ?? []
    for (const [field, fieldSchema] of Object.entries(props)) {
      const isRequired = required.includes(field)
      // `extractToolSchemas` (packages/api-tree/src/extract.ts) populates
      // per-field `description` from each property's leading JSDoc comment.
      const fsDesc = fieldSchema.description
      const req = isRequired ? " (required)" : " (optional)"
      const typeHint = describeFieldType(fieldSchema)
      lines.push(`  --${field}${typeHint !== undefined ? `  <${typeHint}>` : ""}${fsDesc !== undefined ? `  ${fsDesc}` : ""}${req}`)
    }
  }

  return lines.join("\n") + "\n"
}

/** Short human-readable type hint for a field's help line, e.g. "number" or "enum: a|b|c". */
function describeFieldType(fieldSchema: JsonSchema): string | undefined {
  if (fieldSchema.enum !== undefined) return `enum: ${fieldSchema.enum.join("|")}`
  if (fieldSchema.type === "array") {
    const items = fieldSchema.items
    if (items !== undefined && items !== false) {
      const itemType = describeFieldType(items)
      if (itemType !== undefined) return `${itemType}[]`
    }
    return "array"
  }
  return fieldSchema.type
}

// ============================================================================
// Argv parsing
// ============================================================================

type ParsedArgv = {
  flags: Record<string, string | string[] | true>
  help: boolean
  version: boolean
  yes: boolean
  json: boolean
  jsonl: boolean
}

/**
 * Parse named --flags from argv into a flat object.
 * Boolean flags (no following value, or next arg starts with --) → true.
 * Repeated flags → array.
 * Extracts: --help, --version/-V, --yes/--force, --json, --jsonl.
 */
function parseFlags(argv: string[]): ParsedArgv {
  const flags: Record<string, string | string[] | true> = {}
  let help = false
  let version = false
  let yes = false
  let json = false
  let jsonl = false

  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === undefined) { i++; continue }

    if (arg === "--help" || arg === "-h") {
      help = true; i++; continue
    }
    if (arg === "--version" || arg === "-V") {
      version = true; i++; continue
    }
    if (arg === "--yes" || arg === "--force" || arg === "-y") {
      yes = true; i++; continue
    }
    if (arg === "--json") {
      json = true; i++; continue
    }
    if (arg === "--jsonl") {
      jsonl = true; i++; continue
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) {
        // Boolean flag
        flags[key] = true
        i++
      } else {
        // Key-value flag; handle repeated
        const existing = flags[key]
        if (existing === undefined) {
          flags[key] = next
        } else if (Array.isArray(existing)) {
          existing.push(next)
        } else if (typeof existing === "string") {
          flags[key] = [existing, next]
        }
        i += 2
      }
      continue
    }

    // Ignore non-flag args in the rest (path segments are already separated)
    i++
  }

  return { flags, help, version, yes, json: json || !jsonl, jsonl }
}

// ============================================================================
// Build handler input from parsed flags + slugs
// ============================================================================

/**
 * Assemble the handler's input bag from the CLI's named stores, via the
 * shared resolution pipeline (`packages/api-tree/src/input.ts`).
 *
 * Stores:
 *   - "flag": parsed --flags (parseFlags result)
 *   - "path": accumulated `fallback`-captured slug values — named "path" (not
 *     "slug") because `assemble`'s `pathParamNames` resolution is hardcoded to
 *     read from a store literally named "path" (see input.ts)
 *   - "env":  process.env — new capability, reachable only via `sourceMap`
 *     (no implicit convention pulls a field from the environment)
 *
 * Primary store is "flag" (unmarked params default to a CLI flag). Slug
 * keys are passed as `pathParamNames` so they always win over a same-named
 * flag — matching the prior hardcoded merge order (slugs overlay flags).
 *
 * `paramNames` is the union of every key any store could produce: flag
 * keys, slug keys, and any name declared in `sourceMap` (so a field pulled
 * purely from an override — e.g. `apiKey` from "env" with no `--api-key`
 * flag — is still assembled even though it never appears in `flags`). This
 * keeps schema-less trees (no fixed field list) working exactly as before:
 * with an empty `sourceMap`, this reduces to the old flags+slugs merge.
 *
 * Returns the `stores` alongside the assembled `input` bag — `stores` is
 * threaded into `CliMiddleware` (see above), which sees both the assembled
 * input AND the raw pre-assembly stores; the handler itself only ever sees
 * `input`.
 */
function buildInput(
  flags: Record<string, string | string[] | true>,
  slugs: Record<string, string>,
  sourceMap: SourceMap,
): { readonly input: Record<string, unknown>; readonly stores: Stores } {
  const stores: Stores = {
    flag: createStore(flags),
    path: createStore(slugs),
    env: createStore(process.env as Record<string, unknown>),
  }

  const paramNames = [
    ...new Set([
      ...Object.keys(flags),
      ...Object.keys(slugs),
      ...Object.keys(sourceMap),
    ]),
  ]

  return { input: assemble(stores, paramNames, sourceMap, "flag", Object.keys(slugs)), stores }
}

// ============================================================================
// Type coercion from JSON Schema
// ============================================================================
//
// Flag values arrive from argv as `string | string[] | true` (see
// parseFlags). Before the handler is called, coerceInput walks the leaf's
// input schema (from `opts.schemas`, keyed by `resolved.schemaPath`) and
// coerces each field present in BOTH the input and the schema's
// `properties` to the schema's declared type:
//   number/integer → Number(value), reject NaN (and non-integers for "integer")
//   boolean        → "true"/"1"/"yes" → true, "false"/"0"/"no" → false
//   array          → coerce each element against `items`
//   enum           → validate membership, suggest the closest match on miss
//   string/other   → left untouched (today's behavior)
// Fields with no matching schema property pass through unchanged — this is
// what keeps coercion backward-compatible with schema-less trees (opts.schemas
// omitted) and with fields a schema doesn't know about.

/** Levenshtein edit distance — used to suggest the closest enum value on a mismatch. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const dp: number[][] = []
  for (let i = 0; i < rows; i++) {
    const row = new Array<number>(cols).fill(0)
    row[0] = i
    dp.push(row)
  }
  for (let j = 0; j < cols; j++) dp[0]![j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      )
    }
  }
  return dp[rows - 1]![cols - 1]!
}

/** The enum member closest (by edit distance) to `value`, or undefined for an empty enum. */
function closestEnumMatch(value: string, options: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDist = Infinity
  for (const opt of options) {
    const d = levenshteinDistance(value, opt)
    if (d < bestDist) {
      bestDist = d
      best = opt
    }
  }
  return best
}

/** Coerce a single scalar value against a (non-array) field schema. */
function coerceScalar(field: string, value: unknown, schema: JsonSchema): unknown {
  if (schema.enum !== undefined) {
    const str = typeof value === "string" ? value : String(value)
    if (!schema.enum.includes(str)) {
      const suggestion = closestEnumMatch(str, schema.enum)
      const hint = suggestion !== undefined ? ` Did you mean "${suggestion}"?` : ""
      throw new CliError(
        `--${field}: invalid value "${str}" — expected one of: ${schema.enum.join(", ")}.${hint}`,
        1,
      )
    }
    return str
  }

  // `schema.type` is typed as a 5-member literal union, but the extractor's
  // underlying type-ir->JSON-Schema projection (packages/type-ir/src/json-schema.ts)
  // legitimately emits "integer" too (cast at the api-tree boundary) — compare
  // as a plain string so both "number" and "integer" are covered.
  const rawType = schema.type as string | undefined
  switch (rawType) {
    case "number":
    case "integer": {
      if (typeof value === "boolean") {
        throw new CliError(`--${field}: expected a number, got a boolean flag`, 1)
      }
      const n = Number(value)
      if (Number.isNaN(n)) {
        throw new CliError(`--${field}: expected a number, got "${String(value)}"`, 1)
      }
      if (rawType === "integer" && !Number.isInteger(n)) {
        throw new CliError(`--${field}: expected an integer, got "${String(value)}"`, 1)
      }
      return n
    }
    case "boolean": {
      if (typeof value === "boolean") return value
      const str = String(value)
      const s = str.toLowerCase()
      if (s === "true" || s === "1" || s === "yes") return true
      if (s === "false" || s === "0" || s === "no") return false
      throw new CliError(`--${field}: expected a boolean, got "${str}"`, 1)
    }
    default:
      // "string", "object", or schema-less — left untouched.
      return value
  }
}

/** Coerce one input field against its schema, handling the `array` wrapper around coerceScalar. */
function coerceField(field: string, value: unknown, schema: JsonSchema): unknown {
  if (schema.type === "array") {
    const items = schema.items
    const arr = Array.isArray(value) ? value : [value]
    if (items === undefined || items === false) return arr
    return arr.map((el) => coerceScalar(field, el, items))
  }
  return coerceScalar(field, value, schema)
}

/**
 * Coerce a raw handler input object against a leaf's input schema, field by
 * field. Fields absent from `schema.properties` (including all fields, when
 * `schema` itself is undefined — no schema was supplied for this leaf) pass
 * through unchanged, so this stays backward-compatible with schema-less
 * trees. Throws CliError on a coercion failure (NaN number, invalid enum
 * member, unparseable boolean).
 */
export function coerceInput(
  input: Record<string, unknown>,
  schema: JsonSchema | undefined,
): Record<string, unknown> {
  const props = schema?.properties
  if (props === undefined) return input

  const out: Record<string, unknown> = { ...input }
  for (const [field, value] of Object.entries(input)) {
    const fieldSchema = props[field]
    if (fieldSchema === undefined) continue
    out[field] = coerceField(field, value, fieldSchema)
  }
  return out
}

// ============================================================================
// Defaults + required-field validation
// ============================================================================

/**
 * Fill in `schema.properties[field].default` for any field absent from
 * `input`. Defaults come from the schema pre-typed (e.g. `default: 0` for a
 * number field) — no coercion is applied to them, unlike argv-sourced string
 * values. A field already present in `input` (including explicit `false`/
 * `0`/`""`) is left alone; "absent" means `undefined`, not falsy.
 */
export function applyDefaults(
  input: Record<string, unknown>,
  schema: JsonSchema | undefined,
): Record<string, unknown> {
  const props = schema?.properties
  if (props === undefined) return input

  const out: Record<string, unknown> = { ...input }
  for (const [field, fieldSchema] of Object.entries(props)) {
    if (out[field] === undefined && fieldSchema.default !== undefined) {
      out[field] = fieldSchema.default
    }
  }
  return out
}

/**
 * Validate that every field in `schema.required` is present in `input`
 * (post-defaults). Throws CliError listing all missing fields at once
 * (rather than failing on the first) so a user fixing a multi-field miss
 * doesn't have to re-run once per field.
 */
export function validateRequired(
  input: Record<string, unknown>,
  schema: JsonSchema | undefined,
): void {
  const required = schema?.required
  if (required === undefined || required.length === 0) return

  const missing = required.filter((field) => input[field] === undefined)
  if (missing.length > 0) {
    const flags = missing.map((field) => `--${field}`).join(", ")
    throw new CliError(
      `Missing required field${missing.length > 1 ? "s" : ""}: ${flags}`,
      1,
    )
  }
}

// ============================================================================
// Default IO (process-backed)
// ============================================================================

const defaultIO: CliIO = {
  stdout: { write: (s: string) => process.stdout.write(s) },
  stderr: { write: (s: string) => process.stderr.write(s) },
  confirm: async (_prompt: string): Promise<boolean> => false,
}

// ============================================================================
// runCli — public API
// ============================================================================

/**
 * Dispatch a Node tree from argv.
 *
 * argv should be the arguments AFTER the program name (i.e. process.argv.slice(2)).
 * Leading non-flag tokens are consumed as the subcommand path; remaining
 * --flags are parsed as handler input fields.
 *
 * Throws CliError (with exitCode) instead of calling process.exit() directly —
 * the caller (a real main() entry point) is responsible for actually exiting.
 * This keeps bun test alive when errors occur.
 *
 * @param rootNode - The root Node to dispatch into. Wrapped via `wrapValidators`
 *   first when `opts.validators` is provided (see `CliOpts.validators`).
 * @param argv - Arguments after program name.
 * @param io   - Injectable IO (stdout, stderr, confirm). Defaults to process streams.
 * @param opts - Options: schemas map from codegen.
 */
export async function runCli<T = unknown>(
  rootNode: Node,
  argv: string[],
  io: Partial<CliIO> = {},
  opts: CliOpts<T> = {},
): Promise<void> {
  const ioResolved: CliIO = { ...defaultIO, ...io }
  const schemas: SchemaMap = opts.schemas ?? {}
  const programName = opts.programName ?? "cli"
  // Wire generated validators onto the tree BEFORE any dispatch — see
  // `CliOpts.validators`. Leaves with no matching entry keep their original
  // handler untouched (wrapValidators is a no-op there).
  const n = opts.validators !== undefined ? wrapValidators(rootNode, opts.validators) : rootNode

  // Split argv into subcommand-path segments vs flag tokens.
  // Strategy: consume leading non-flag tokens as path segments; everything
  // after the first --flag is treated as flag argv.
  const pathSegments: string[] = []
  const flagArgv: string[] = []
  let seenFlag = false
  for (const arg of argv) {
    if (seenFlag || arg.startsWith("-")) {
      seenFlag = true
      flagArgv.push(arg)
    } else {
      pathSegments.push(arg)
    }
  }

  // `completions <shell>` — a reserved top-level command (not part of the
  // authored tree) that prints a static shell completion script derived from
  // the tree structure + schemas. See ./completions.ts.
  if (pathSegments[0] === "completions") {
    const shellArg = pathSegments[1]
    if (!isShellName(shellArg)) {
      ioResolved.stderr.write(
        `Usage: ${programName} completions <bash|zsh|fish>\n`,
      )
      throw new CliError("Unknown or missing shell for completions", 1)
    }
    ioResolved.stdout.write(generateCompletions(shellArg, n, schemas, programName))
    return
  }

  const { flags, help, version, yes, json: _json, jsonl } = parseFlags(flagArgv)

  // --version — print the configured program version and return. Takes
  // priority over subcommand resolution (mirrors --help), since it's a
  // program-level query, not a subcommand-scoped one.
  if (version) {
    if (opts.version === undefined) {
      ioResolved.stderr.write("No version configured for this program.\n")
      throw new CliError("No version configured", 1)
    }
    ioResolved.stdout.write(opts.version + "\n")
    return
  }

  // No subcommand args — show root help
  if (pathSegments.length === 0) {
    if (help) {
      ioResolved.stdout.write(buildHelp(n, [], programName))
      return
    }
    ioResolved.stderr.write(`Usage: ${programName} <subcommand> [options]\nRun with --help for usage.\n`)
    throw new CliError("No subcommand provided", 1)
  }

  // --help requested — show help for the subcommand path
  if (help) {
    // Try to resolve to a leaf first
    const target = resolveLeaf(n, pathSegments, {})
    if (target !== null) {
      ioResolved.stdout.write(buildLeafHelp(target, pathSegments, programName, schemas))
      return
    }
    // Otherwise walk to a branch child for group help
    let cursor: Node = n
    let depth = 0
    for (const seg of pathSegments) {
      const child = (cursor.children ?? {})[seg]
      if (child !== undefined && !isLeaf(child)) {
        cursor = child
        depth++
      } else {
        break
      }
    }
    ioResolved.stdout.write(buildHelp(cursor, pathSegments.slice(0, depth), programName))
    return
  }

  // Resolve the leaf handler
  const target = resolveLeaf(n, pathSegments, {})
  if (target === null) {
    const typed = pathSegments.join(" ")
    const suggestion = suggestCommand(n, pathSegments)
    const hint = suggestion !== undefined ? ` Did you mean "${suggestion}"?` : ""
    ioResolved.stderr.write(`Unknown command: "${typed}".${hint}\nRun with --help for usage.\n`)
    throw new CliError(`Unknown command: "${typed}".${hint}`, 1)
  }

  // Tags are read directly from the leaf's own meta — no ancestor inheritance.
  const tags = resolveTags((target.leafMeta.tags ?? {}) as Tags)

  // Confirm for destructive ops (unless --yes/--force)
  if (tags.destructive === true && !yes) {
    const ok = await ioResolved.confirm(
      "This operation is destructive and irreversible. Proceed?"
    )
    if (!ok) {
      ioResolved.stderr.write("Aborted.\n")
      throw new CliError("Aborted by user", 1)
    }
  }

  // Build input: flags + slugs (provenance-blind merge), then coerce against
  // the leaf's input schema (number/boolean/array/enum → typed values; a
  // schema-less field, or no schema at all, passes through unchanged), then
  // fill in schema defaults for absent fields, then validate that every
  // `required` field is present — all BEFORE the handler is ever called.
  const schemaName = target.schemaPath.join("_").replace(/-/g, "_")
  const inputSchema = schemas[schemaName]?.inputSchema
  const sourceMap = getCliMeta(target.leafMeta).sourceMap ?? {}
  const { input: rawInput, stores } = buildInput(flags, target.slugs, sourceMap)
  // A generated validator (see CliOpts.validators) already wraps
  // target.handler to run parse() — coercion + validation + defaults in one
  // pass — so the schema-derived fallback path below is skipped for this
  // leaf specifically. Uncovered leaves (no matching generated validator, or
  // opts.validators omitted entirely) keep using it exactly as before.
  const generatedValidatorHandlesThis = isValidatorWrapped(target.handler)
  let input: Record<string, unknown> = rawInput
  if (!generatedValidatorHandlesThis) {
    try {
      input = coerceInput(rawInput, inputSchema)
      input = applyDefaults(input, inputSchema)
      validateRequired(input, inputSchema)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      ioResolved.stderr.write(`Error: ${msg}\n`)
      throw err instanceof CliError ? err : new CliError(msg, 1)
    }
  }

  // Call handler — wrapped (innermost-first) by ALS (see CliOpts.als), then
  // by any configured middleware (outermost-first; see CliOpts.middleware).
  // With neither configured, `callHandler` is just `target.handler` itself
  // (zero overhead).
  const alsContext: CliAlsContext = {
    meta: target.leafMeta,
    io: ioResolved,
    slugs: target.slugs,
    leafName: target.leafName,
  }
  const alsHandler = opts.als !== undefined
    ? (input: Record<string, unknown>) =>
        opts.als!.storage.run(opts.als!.init(alsContext), () => target.handler(input))
    : target.handler
  // Bridge the plain handler `(input) => result` into `F => F`'s base case
  // `(input, stores) => handler(input)` — the handler never sees `stores`,
  // structurally (see CliMiddleware's module doc above).
  const base = (input: Record<string, unknown>, _stores: Stores) => alsHandler(input)
  const middleware = opts.middleware ?? []
  const callHandler = middleware.length === 0
    ? base
    : composeMiddleware(middleware, base)

  let result: unknown
  try {
    result = await Promise.resolve(callHandler(input, stores))
  } catch {
    // Thrown errors are never surfaced verbatim to the end user — matching
    // HTTP's `runRoute` (route.ts), which already collapses a thrown error
    // to a generic "internal server error" 500 rather than leaking
    // `err.message`. A handler's thrown message can carry internals (stack
    // frames, file paths, driver-specific SQL text, ...) that weren't meant
    // for a CLI consumer; a handler that WANTS to communicate a specific,
    // user-facing failure should return an `err(...)` Result instead (see
    // the Result-unwrapping check below), which IS surfaced verbatim — that
    // is the intentional, opt-in error-reporting channel.
    ioResolved.stderr.write("Error: internal error\n")
    throw new CliError("internal error", 1)
  }

  // Result unwrapping: applied UNCONDITIONALLY (matching HTTP's `runRoute`,
  // route.ts) — any handler returning `{kind:"err", error}` gets proper CLI
  // error handling, not just leaves wrapped by a generated validator
  // (`generatedValidatorHandlesThis`, computed above, still only gates the
  // fallback coerceInput/validateRequired step, a separate concern). A
  // `kind:"ok"` Result is unwrapped to its `.value` before being printed, so
  // an ordinary handler that happens to return this package's own
  // `Result<T,E>` shape (see @rhi-zone/fractal-api-tree's `ok`/`err`) is
  // treated the same way regardless of validator wiring.
  if (isResultShape(result)) {
    if (result.kind === "err") {
      const msg = `Error: ${JSON.stringify(result.error)}`
      ioResolved.stderr.write(`${msg}\n`)
      throw new CliError(msg, 1)
    }
    result = result.value
  }

  // Output
  if (tags.streaming === true || jsonl) {
    // Streaming: one JSON line per item
    if (Array.isArray(result) || isAsyncIterable(result)) {
      const items = isAsyncIterable(result)
        ? await collectAsync(result)
        : (result as unknown[])
      for (const item of items) {
        ioResolved.stdout.write(JSON.stringify(item) + "\n")
      }
    } else {
      ioResolved.stdout.write(JSON.stringify(result) + "\n")
    }
  } else {
    // Default: pretty JSON
    if (result === undefined || result === null) {
      ioResolved.stdout.write("null\n")
    } else {
      ioResolved.stdout.write(JSON.stringify(result, null, 2) + "\n")
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return typeof v === "object" && v !== null && Symbol.asyncIterator in v
}

async function collectAsync(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = []
  for await (const item of it) {
    result.push(item)
  }
  return result
}

// ============================================================================
// Tree walk for listing all leaf nodes (for help / introspection)
// ============================================================================

export type CliCommandEntry = {
  readonly path: string[]
  readonly leafName: string
  readonly handler: Handler
  readonly slugs: string[]
}

/**
 * Walk the Node tree and enumerate all reachable leaf nodes with their CLI paths.
 * Useful for generating full help text or testing coverage.
 */
export function walkCliCommands(
  n: Node,
  prefix: string[] = [],
  slugAcc: string[] = [],
): CliCommandEntry[] {
  const out: CliCommandEntry[] = []

  for (const [key, child] of Object.entries(n.children ?? {})) {
    if (isLeaf(child)) {
      out.push({
        path: prefix,
        leafName: key,
        handler: child.handler!,
        slugs: slugAcc,
      })
    } else {
      out.push(...walkCliCommands(child, [...prefix, key], slugAcc))
    }
  }

  if (n.fallback !== undefined) {
    out.push(...walkCliCommands(n.fallback.subtree, prefix, [...slugAcc, n.fallback.name]))
  }

  return out
}

/**
 * Suggest the closest reachable full command path to what the user typed,
 * by edit distance over the space-joined path strings — same
 * `levenshteinDistance` used for enum near-misses (coerceScalar). Returns
 * undefined when the tree has no leaf commands at all.
 */
function suggestCommand(root: Node, pathSegments: string[]): string | undefined {
  const typed = pathSegments.join(" ")
  const candidates = walkCliCommands(root).map((c) => [...c.path, c.leafName].join(" "))
  let best: string | undefined
  let bestDist = Infinity
  for (const candidate of candidates) {
    const d = levenshteinDistance(typed, candidate)
    if (d < bestDist) {
      bestDist = d
      best = candidate
    }
  }
  return best
}

// Re-export types for consumers
export type { SchemaMap }
export type { Node, Handler, Meta }
