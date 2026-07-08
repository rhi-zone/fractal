// packages/cli/src/cli.ts — @rhi-zone/fractal-cli
//
// CLI projection for the function-core tree.
//
// Walks a Node tree along an argv subcommand path, resolving:
//   - Static children → subcommand prefix segments
//   - ParamNode children → positional slug values merged into op input
//   - Op keys → terminal subcommand names
//
// Tag-driven behavior (via effectiveTags + resolveTags):
//   - destructive:true  → io.confirm() before running (skippable via --yes/--force)
//   - readOnly:true     → no confirm
//   - streaming:true    → output each item as a JSONL line
//
// Input field → flag derivation:
//   Named --flags parsed from argv; slugs from ParamNode traversal merged on
//   top (provenance-blind — handler sees one flat input object).
//
// Help: --help at any level prints usage text.
// Output: JSON pretty-printed to io.stdout. Error: thrown CliError (exit code 1).
//
// Design note: runCli throws CliError instead of calling process.exit() directly.
// The caller decides how to handle exit (which lets tests inject without mocking
// process.exit, keeping the test runner alive).
//
// See:
//   packages/core/src/node.ts   — Node, Op, ParamNode, dispatch
//   packages/core/src/tags.ts   — effectiveTags, resolveTags
//   packages/codegen/src/tree.ts — extractToolSchemas, SchemaMap
//   docs/artifacts/fc-op-kinds/projection-cli.md — CLI concept inventory

import { isParamNode } from "@rhi-zone/fractal-core/node"
import { effectiveTags, resolveTags } from "@rhi-zone/fractal-core/tags"
import type { Tags } from "@rhi-zone/fractal-core/tags"
import type { Meta, Node, ParamNode, Op } from "@rhi-zone/fractal-core/node"
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
 * Resolved dispatch target: the op to call, accumulated slug values from
 * ParamNode traversal, and the tag path (root-to-op) for effectiveTags.
 */
type Resolved = {
  readonly op: Op
  readonly slugs: Record<string, string>
  readonly tagPath: Array<{ meta?: { tags?: Tags } }>
  readonly opName: string
}

/**
 * Walk the node tree along argv segments, resolving:
 *
 *   Static child (not ParamNode) → consume segment, recurse into child
 *   Static child (IS ParamNode)  → consume segment (tree key), enter subtree,
 *                                   consume NEXT segment as slug value
 *   No static match + ParamNode  → consume current segment as slug value, recurse
 *   Op key at tail               → terminal; return resolved
 *
 * CLI navigates ParamNode children by their tree key (e.g. "byId"), then the
 * following segment is the slug value (e.g. "book-1"). This differs from HTTP
 * dispatch where the URL segment IS the slug value (no key prefix).
 *
 * Returns null if no matching path is found.
 */
function resolveOp(
  n: Node,
  segments: string[],
  slugs: Record<string, string>,
  tagPath: Array<{ meta?: { tags?: Tags } }>,
): Resolved | null {
  if (segments.length === 0) return null
  const [head, ...tail] = segments
  if (head === undefined) return null

  const nodePath: Array<{ meta?: { tags?: Tags } }> = [...tagPath, n]

  // Terminal: head should be an op name
  if (tail.length === 0) {
    const o = n.ops[head]
    if (o !== undefined) {
      return { op: o, slugs, tagPath: [...nodePath, o], opName: head }
    }
    return null
  }

  // Non-terminal: try static child first
  const staticChild = n.children[head]
  if (staticChild !== undefined) {
    if (isParamNode(staticChild)) {
      // head matched the ParamNode slot key (e.g. "byId").
      // The NEXT segment (tail[0]) is the actual slug value.
      // Consume it and recurse into the subtree.
      const [slugValue, ...afterSlug] = tail
      if (slugValue === undefined) return null
      return resolveOp(
        staticChild.subtree,
        afterSlug,
        { ...slugs, [staticChild.name]: slugValue },
        nodePath,
      )
    }
    // Static non-param child: recurse with no slug
    return resolveOp(staticChild, tail, slugs, nodePath)
  }

  // No static match — scan for a bare ParamNode child.
  // In this case, head IS the slug value (no key prefix in the path).
  for (const child of Object.values(n.children)) {
    if (isParamNode(child)) {
      return resolveOp(child.subtree, tail, { ...slugs, [child.name]: head }, nodePath)
    }
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

  // List ops
  const ops = Object.entries(n.ops)
  if (ops.length > 0) {
    lines.push("Commands:")
    for (const [key, o] of ops) {
      const cliMeta = getCliMeta(o.meta)
      if (cliMeta.hidden === true) continue
      const opDesc = descriptionFrom(o.meta)
      const opName = typeof cliMeta.name === "string" ? cliMeta.name : key
      lines.push(`  ${opName}${opDesc !== undefined ? `  — ${opDesc}` : ""}`)
    }
  }

  // List child nodes
  const children = Object.entries(n.children)
  if (children.length > 0) {
    if (ops.length > 0) lines.push("")
    lines.push("Subcommand groups:")
    for (const [key, child] of children) {
      if (isParamNode(child)) {
        const cliMeta = getCliMeta(child.subtree.meta)
        if (cliMeta.hidden === true) continue
        lines.push(`  ${key} <${child.name}>  — parameterized group`)
      } else {
        const cliMeta = getCliMeta(child.meta)
        if (cliMeta.hidden === true) continue
        const childDesc = descriptionFrom(child.meta)
        lines.push(`  ${key}${childDesc !== undefined ? `  — ${childDesc}` : ""}`)
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

function buildOpHelp(
  resolved: Resolved,
  path: string[],
  programName: string,
  schemas: SchemaMap,
): string {
  const lines: string[] = []
  const cmd = [programName, ...path].join(" ")
  const desc = descriptionFrom(resolved.op.meta)
  if (desc !== undefined) lines.push(desc, "")
  lines.push(`Usage: ${cmd} [options]`, "")

  const tags = resolveTags(effectiveTags(resolved.tagPath))
  if (tags.destructive === true) lines.push("  This operation is destructive. Requires --yes/--force to skip confirmation.", "")
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
// Build op input from parsed flags + slugs
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
 * --flags are parsed as op input fields.
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
    // Try to resolve to an op first
    const target = resolveOp(n, pathSegments, {}, [])
    if (target !== null) {
      ioResolved.stdout.write(buildOpHelp(target, pathSegments, "cli", schemas))
      return
    }
    // Otherwise walk to a child node for group help
    let cursor: Node = n
    let depth = 0
    for (const seg of pathSegments) {
      const child = cursor.children[seg]
      if (child !== undefined && !isParamNode(child)) {
        cursor = child
        depth++
      } else {
        break
      }
    }
    ioResolved.stdout.write(buildHelp(cursor, pathSegments.slice(0, depth), "cli"))
    return
  }

  // Resolve the op
  const target = resolveOp(n, pathSegments, {}, [])
  if (target === null) {
    ioResolved.stderr.write(`Unknown command: ${pathSegments.join(" ")}\nRun with --help for usage.\n`)
    throw new CliError(`Unknown command: ${pathSegments.join(" ")}`, 1)
  }

  // Derive effective tags
  const effective = effectiveTags(target.tagPath)
  const tags = resolveTags(effective)

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

  // Call op
  let result: unknown
  try {
    result = await Promise.resolve(target.op.fn(input))
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
// Tree walk for listing all ops (for help / introspection)
// ============================================================================

export type CliCommandEntry = {
  readonly path: string[]
  readonly opName: string
  readonly op: Op
  readonly slugs: string[]
  readonly tagPath: Array<{ meta?: { tags?: Tags } }>
}

/**
 * Walk the Node tree and enumerate all reachable ops with their CLI paths.
 * Useful for generating full help text or testing coverage.
 */
export function walkCliCommands(
  n: Node,
  prefix: string[] = [],
  tagPath: Array<{ meta?: { tags?: Tags } }> = [],
  slugAcc: string[] = [],
): CliCommandEntry[] {
  const out: CliCommandEntry[] = []
  const nodePath = [...tagPath, n]

  for (const [key, o] of Object.entries(n.ops)) {
    out.push({
      path: prefix,
      opName: key,
      op: o,
      slugs: slugAcc,
      tagPath: [...nodePath, o],
    })
  }

  for (const [key, child] of Object.entries(n.children)) {
    if (isParamNode(child)) {
      out.push(
        ...walkCliCommands(
          child.subtree,
          [...prefix, key],
          nodePath,
          [...slugAcc, child.name],
        ),
      )
    } else {
      out.push(...walkCliCommands(child, [...prefix, key], nodePath, slugAcc))
    }
  }

  return out
}

// Re-export types for consumers
export type { SchemaMap }
export type { Node, Op, ParamNode, Meta }
