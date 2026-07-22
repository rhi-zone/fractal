// packages/api-tree/src/build.ts — @rhi-zone/fractal-api-tree
//
// BUILD ORCHESTRATOR: wires the extractor (extract.ts/tree.ts) to the AOT
// validator compiler (@rhi-zone/fractal-type-ir's compile.ts), producing the
// standalone, zero-runtime-dependency validator MODULE SOURCE that
// `wrapValidators` (below) consumes.
//
//   entryFile --extractRouteTypeRefs--> path -> TypeRef
//            --compileValidatorModule--> module source (exports `validators`,
//              `Record<path, { check, errors, parse }>` — see compile.ts)
//
// `buildValidatorModuleSource` is the one-shot "codegen has run" path;
// `stubValidatorModuleSource` is the pre-codegen dev-time placeholder — an
// empty `validators` map, so `wrapValidators(tree, {})` is a no-op
// passthrough for every leaf until real codegen runs (see `wrapValidators`'s
// own doc comment below).

import * as path from "node:path"
import { compileValidatorModule } from "@rhi-zone/fractal-type-ir"
import { extractRouteTypeRefs } from "./tree.ts"
import type { ShouldShare } from "./extract.ts"
import type { Handler, Node } from "./node.ts"
import { err } from "./index.ts"

/** One generated entry's public shape — see compile.ts's `compileValidatorModule`. */
export type GeneratedEntry = {
  parse: (value: unknown) => { kind: "ok"; value: unknown } | { kind: "err"; errors: unknown[] }
}

// ============================================================================
// wrapValidators — wires generated validators directly onto a `Node` tree's
// leaf handlers. The single mechanism shared by HTTP (createFetch's
// `validators` option), MCP (`createMcpServer`'s `validators` option), and
// CLI (`runCli`'s `validators` option) — each dispatches off (or, for HTTP,
// projects from) the `Node` tree, so wiring validation onto the `handler`
// itself, before any protocol-specific projection runs, covers all three
// with one generated module. Wraps each leaf's handler so it calls the
// generated `parse()` first (coercion + validation + narrowing in one pass)
// and only invokes the original handler on success.
// ============================================================================

/**
 * Runtime brand for a handler produced by `wrapValidators`'s wrapping — lets
 * a projector (CLI, MCP) tell whether a resolved leaf's validation is
 * already handled by a generated validator, so its own fallback
 * coercion/validation step (`coerceInput`/`validateRequired` in CLI,
 * `validateAgainstSchema` in MCP) can be skipped for that leaf specifically,
 * while still running for leaves `wrapValidators` didn't touch — no matching
 * validator at that path, or `validators` not supplied at all. Same pattern
 * as `route.ts`'s `routeBrand`/`isHttpRoute`.
 */
const wrappedHandlerBrand = new WeakSet<Handler>()

/** True when `handler` was produced by `wrapValidators`'s wrapping — see the brand doc above. */
export function isValidatorWrapped(handler: Handler): boolean {
  return wrappedHandlerBrand.has(handler)
}

/**
 * Wrap one leaf handler: `entry.parse(input)` first — `ok` calls `handler`
 * with the parsed (coerced, validated, narrowed) value; `err` returns a
 * `Result` `{kind:"err", error: ValidationError[]}` (this package's own
 * `Result<T,E>` — see index.ts's `ok`/`err`/`isResultShape`) instead of ever
 * reaching `handler`.
 *
 * Deliberately a returned Result, not a thrown error class: an error class
 * can't be exhaustively matched (no discriminated union over `instanceof`)
 * and `instanceof` itself breaks across realms/bundles — a dispatcher
 * (`runRoute` for HTTP, `runCli` for CLI, the MCP tool-call handler) checks
 * the return value's `kind` instead of wrapping the call in a catch block.
 * The wrapped handler's static return type stays the erased `Handler`
 * (default `any`/`any`), so returning a `Result` here doesn't require
 * threading a new generic through `Node`/`op`/`api`.
 */
function wrapHandler(handler: Handler, entry: GeneratedEntry): Handler {
  const wrapped: Handler = async (input: unknown) => {
    const result = entry.parse(input)
    if (result.kind === "err") return err(result.errors)
    return handler(result.value)
  }
  wrappedHandlerBrand.add(wrapped)
  return wrapped
}

/**
 * Walk `node`, wiring each leaf's handler through its generated validator's
 * `parse()` before the original handler runs — see the module doc above for
 * why this lives at the `Node` level rather than on any one protocol's own
 * route/dispatch tree.
 *
 * Keyed the same way `extractRouteTypeRefs` (tree.ts) keys its map: `"/"`-
 * joined path segments, with a `fallback` segment rendered as `:name` (e.g.
 * `"books/:bookId"`) — so a validator module built by
 * `buildValidatorModuleSource` plugs into `wrapValidators` with no re-keying.
 *
 * A leaf with no matching entry in `validators` passes through with its
 * original handler, untouched — this is what makes `wrapValidators` safe to
 * call with a partial (or empty/stub) validator map: uncovered leaves are a
 * no-op. Never mutates `node`; always returns a fresh tree.
 */
export function wrapValidators(
  node: Node,
  validators: Readonly<Record<string, GeneratedEntry>>,
  path: readonly string[] = [],
): Node {
  const entry = validators[path.join("/")]
  const handler = node.handler !== undefined
    ? (entry !== undefined ? wrapHandler(node.handler, entry) : node.handler)
    : undefined
  const children = node.children !== undefined
    ? Object.fromEntries(
        Object.entries(node.children).map(([key, child]) => [
          key,
          wrapValidators(child, validators, [...path, key]),
        ]),
      )
    : undefined
  const fallback = node.fallback !== undefined
    ? {
        name: node.fallback.name,
        subtree: wrapValidators(node.fallback.subtree, validators, [...path, `:${node.fallback.name}`]),
      }
    : undefined
  return {
    ...(handler !== undefined ? { handler } : {}),
    ...(children !== undefined ? { children } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
    meta: node.meta,
  }
}

/**
 * Turn an extracted type's absolute `declarationFile` into the `import type`
 * module specifier the generated module at `outFile` should use to reach it
 * — a relative path from `outFile`'s directory, POSIX-separated (module
 * specifiers use `/` regardless of host OS), keeping the `.ts` extension
 * (the project's own convention — see this repo's `tsconfig.json`
 * `allowImportingTsExtensions`, and e.g. `tree.ts`'s own `from
 * "./generated/validators.ts"` import).
 */
function relativeImportSpecifier(outFile: string, declarationFile: string): string {
  const rel = path.relative(path.dirname(outFile), declarationFile).split(path.sep).join("/")
  return rel.startsWith(".") ? rel : `./${rel}`
}

/**
 * Extract every leaf op's input type from `entryFile` and compile it into a
 * standalone validator module source string — `export const validators:
 * Record<routePath, { check, errors, parse }>`. Pass the imported
 * `validators` map straight to `wrapValidators` (this file) — no adaptation
 * needed, the generated `{ check, errors, parse }` shape already matches
 * `GeneratedEntry`.
 *
 * `outFile`, when given, anchors `import type` specifiers for handler
 * parameter types that are NAMED (alias/interface) rather than inline —
 * see `compileValidatorModule`'s `resolveImport` option and
 * `extract.ts`'s `typeRefFromFunctionNode` (the source of
 * `meta.typeName`/`meta.declarationFile`). Without it, every parameter type
 * inlines its structural TypeScript rendering instead — still typed, just
 * without an import.
 *
 * `shouldShare`, when given, opts into structural sharing across every
 * route's input type (see `extractRouteTypeRefs`'s `options.shouldShare` and
 * type-ir's `SharingRegistry`/`ShouldShare`) — a type reused across routes
 * (or self-recursive) compiles to ONE generated validator function, called
 * from every `ref` site, instead of being re-inlined (and, for a truly
 * recursive type, infinitely re-descended) at each one. Omitted, this is
 * exactly the prior behavior: every route's input inlines its full structure
 * independently, no `defs`.
 */
export function buildValidatorModuleSource(entryFile: string, outFile?: string, shouldShare?: ShouldShare): string {
  const resolveImportOpt =
    outFile === undefined
      ? {}
      : { resolveImport: (declarationFile: string) => relativeImportSpecifier(outFile, declarationFile) }
  if (shouldShare === undefined) {
    const typeRefs = extractRouteTypeRefs(entryFile)
    const entries = Object.entries(typeRefs).map(([name, info]) => ({ name, ref: info.input }))
    return compileValidatorModule(entries, resolveImportOpt)
  }
  const { types, defs } = extractRouteTypeRefs(entryFile, { shouldShare })
  const entries = Object.entries(types).map(([name, info]) => ({ name, ref: info.input }))
  return compileValidatorModule(entries, { ...resolveImportOpt, defs })
}

/** An empty validator module — the pre-codegen dev-time stub. */
export function stubValidatorModuleSource(): string {
  return compileValidatorModule([])
}

/**
 * Build the validator module for `entryFile` and write it to `outFile`.
 */
export async function writeValidatorModule(entryFile: string, outFile: string): Promise<void> {
  await Bun.write(outFile, buildValidatorModuleSource(entryFile, outFile))
}

/** Write the empty pre-codegen stub module to `outFile`. */
export async function writeStubValidatorModule(outFile: string): Promise<void> {
  await Bun.write(outFile, stubValidatorModuleSource())
}
