// packages/cli/src/cli.ts — @rhi-zone/fractal-cli
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
//   packages/codegen/src/tree.ts — extractToolSchemas, SchemaMap
//   docs/artifacts/fc-op-kinds/projection-cli.md — CLI concept inventory

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import { resolveTags } from "@rhi-zone/fractal-api-tree/tags"
import type { Tags } from "@rhi-zone/fractal-api-tree/tags"
import type { Handler, Meta, Node } from "@rhi-zone/fractal-api-tree/node"
import type { SchemaMap } from "@rhi-zone/fractal-codegen"

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

export type CliOpts = {
  /**
   * Pre-computed schema map (from extractToolSchemas). When provided, input
   * fields are derived from the JSON Schema. When absent, flags degrade to
   * parsing --key value pairs from argv.
   */
  readonly schemas?: SchemaMap
}

// ============================================================================
// CLI meta extraction
// ============================================================================

type CliMeta = {
  readonly name?: string
  readonly alias?: string
  readonly hidden?: boolean
  readonly [key: string]: unknown
}

function getCliMeta(meta: Meta): CliMeta {
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
}

/**
 * Walk the node tree along argv segments, resolving:
 *
 *   Static child (no handler) → consume segment, recurse
 *   No static match + `fallback` present → consume current segment as the
 *     slug value directly, bind it as `fallback.name`, recurse into subtree
 *   Leaf child (has handler) at tail → terminal; return resolved
 *
 * Returns null if no matching path is found.
 */
function resolveLeaf(
  n: Node,
  segments: string[],
  slugs: Record<string, string>,
): Resolved | null {
  if (segments.length === 0) return null
  const [head, ...tail] = segments
  if (head === undefined) return null

  const children = n.children ?? {}

  // Terminal: head should name a leaf child
  if (tail.length === 0) {
    const child = children[head]
    if (child !== undefined && isLeaf(child)) {
      return {
        handler: child.handler!,
        slugs,
        leafName: head,
        leafMeta: child.meta,
      }
    }
    return null
  }

  // Non-terminal: try a static child first (static children always win)
  const staticChild = children[head]
  if (staticChild !== undefined) {
    if (!isLeaf(staticChild)) {
      return resolveLeaf(staticChild, tail, slugs)
    }
    // A leaf child at non-tail is a dead-end (a leaf has no children to recurse into)
    return null
  }

  // No static match — fall back to the wildcard-capture subtree, if any.
  // `head` IS the slug value directly (no separate key segment).
  if (n.fallback !== undefined) {
    return resolveLeaf(n.fallback.subtree, tail, { ...slugs, [n.fallback.name]: head })
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
      lines.push(`  ${leafName}${leafDesc !== undefined ? `  — ${leafDesc}` : ""}`)
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
  lines.push("  --json        Output result as JSON (default)")
  lines.push("  --yes, --force  Skip confirmation prompts for destructive ops")

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
  if (tags.destructive === true) lines.push("  This operation is destructive and irreversible. Requires --yes/--force to skip confirmation.", "")
  if (tags.readOnly === true) lines.push("  This operation is read-only.", "")
  if (tags.streaming === true) lines.push("  This operation streams results (one JSON object per line).", "")

  // Derive flags from schema
  const schemaName = path.join("_").replace(/-/g, "_")
  const toolSchema = schemas[schemaName]

  lines.push("Options:")
  lines.push("  --help        Show this help text")
  lines.push("  --yes, --force  Skip confirm for destructive ops")
  lines.push("  --json        Output as JSON (default)")

  if (toolSchema?.inputSchema !== undefined) {
    const schema = toolSchema.inputSchema as Record<string, unknown>
    const props = schema["properties"] as Record<string, unknown> | undefined
    const required = (schema["required"] as string[] | undefined) ?? []
    if (props !== undefined) {
      for (const [field, fieldSchema] of Object.entries(props)) {
        const isRequired = required.includes(field)
        const fs = fieldSchema as Record<string, unknown>
        const fsDesc = typeof fs["description"] === "string" ? fs["description"] : undefined
        const req = isRequired ? " (required)" : " (optional)"
        lines.push(`  --${field}${fsDesc !== undefined ? `  ${fsDesc}` : ""}${req}`)
      }
    }
  }

  return lines.join("\n") + "\n"
}

// ============================================================================
// Argv parsing
// ============================================================================

type ParsedArgv = {
  flags: Record<string, string | string[] | true>
  help: boolean
  yes: boolean
  json: boolean
  jsonl: boolean
}

/**
 * Parse named --flags from argv into a flat object.
 * Boolean flags (no following value, or next arg starts with --) → true.
 * Repeated flags → array.
 * Extracts: --help, --yes/--force, --json, --jsonl.
 */
function parseFlags(argv: string[]): ParsedArgv {
  const flags: Record<string, string | string[] | true> = {}
  let help = false
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

  return { flags, help, yes, json: json || !jsonl, jsonl }
}

// ============================================================================
// Build handler input from parsed flags + slugs
// ============================================================================

/**
 * Merge parsed flag values with accumulated slug values into a single input
 * object. Slugs overlay flags (provenance-blind — the handler sees one flat
 * input object and cannot tell where any field came from).
 */
function buildInput(
  flags: Record<string, string | string[] | true>,
  slugs: Record<string, string>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(flags)) {
    input[k] = v === true ? true : v
  }
  // Slugs overlay flags (provenance-blind: handler sees one flat object)
  for (const [k, v] of Object.entries(slugs)) {
    input[k] = v
  }
  return input
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
 * @param n    - The root Node to dispatch into.
 * @param argv - Arguments after program name.
 * @param io   - Injectable IO (stdout, stderr, confirm). Defaults to process streams.
 * @param opts - Options: schemas map from codegen.
 */
export async function runCli(
  n: Node,
  argv: string[],
  io: Partial<CliIO> = {},
  opts: CliOpts = {},
): Promise<void> {
  const ioResolved: CliIO = { ...defaultIO, ...io }
  const schemas: SchemaMap = opts.schemas ?? {}

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

  const { flags, help, yes, json: _json, jsonl } = parseFlags(flagArgv)

  // No subcommand args — show root help
  if (pathSegments.length === 0) {
    if (help) {
      ioResolved.stdout.write(buildHelp(n, [], "cli"))
      return
    }
    ioResolved.stderr.write("Usage: cli <subcommand> [options]\nRun with --help for usage.\n")
    throw new CliError("No subcommand provided", 1)
  }

  // --help requested — show help for the subcommand path
  if (help) {
    // Try to resolve to a leaf first
    const target = resolveLeaf(n, pathSegments, {})
    if (target !== null) {
      ioResolved.stdout.write(buildLeafHelp(target, pathSegments, "cli", schemas))
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
    ioResolved.stdout.write(buildHelp(cursor, pathSegments.slice(0, depth), "cli"))
    return
  }

  // Resolve the leaf handler
  const target = resolveLeaf(n, pathSegments, {})
  if (target === null) {
    ioResolved.stderr.write(`Unknown command: ${pathSegments.join(" ")}\nRun with --help for usage.\n`)
    throw new CliError(`Unknown command: ${pathSegments.join(" ")}`, 1)
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

  // Build input: flags + slugs (provenance-blind merge)
  const input = buildInput(flags, target.slugs)

  // Call handler
  let result: unknown
  try {
    result = await Promise.resolve(target.handler(input))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    ioResolved.stderr.write(`Error: ${msg}\n`)
    throw new CliError(msg, 1)
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

// Re-export types for consumers
export type { SchemaMap }
export type { Node, Handler, Meta }
