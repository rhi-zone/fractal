// packages/api-tree/src/apply-validation-build.ts — @rhi-zone/fractal-api-tree
//
// CALL-SITE-ANCHORED BUILD ORCHESTRATOR for the `applyValidation(key, tree)`
// mechanism (apply-validation.ts) — the sibling of `build.ts`, which anchors
// on EXPORTED `api()` trees instead:
//
//   build.ts:                entryFile --extractRouteTypeRefs (scans exports)-->
//                            `${treeId}/${path}` -> TypeRef --compile--> module
//
//   this file:               entryFile --scan applyValidation() CALL SITES-->
//                            per key: `${path}` -> TypeRef --compile--> module
//                            (+ the nested `Record<key, Record<path, entry>>`
//                             and the `createApplyValidation` composition)
//
// The extraction machinery is shared, not reimplemented: each traced tree is
// descended with `walkNodeType` (tree.ts) and each leaf's TypeRefs come from
// `typeRefFromFunctionNode`/`typeRefFromReturnType` (extract.ts), exactly as
// `extractRouteTypeRefs` does. Only the ANCHOR differs (call sites, not
// exports) and therefore the KEYING: paths here are tree-relative, because
// `applyValidation`'s own `key` argument already scopes one tree — where
// `extractRouteTypeRefs` has to prefix every path with a `treeId` to keep two
// trees in one file from colliding in a single flat map.
//
// Codegen is where the LOUD checks live for this mechanism, since the runtime
// stub is deliberately permissive (apply-validation.ts):
//   - a non-literal `key` argument, a `key` used at two call sites in one
//     entry file, or a tree expression that can't be traced to a `Node`, all
//     throw here rather than silently producing a wrong/last-wins map;
//   - a tree expression whose declaration lives in ANOTHER file throws too:
//     same-file resolution is this phase's deliberate first cut, and giving
//     up silently would emit a module missing that call site's whole key.
//
// PHASE 1: nothing in production code consumes the generated module yet — see
// apply-validation.ts's module doc.

import * as path from "node:path"
import ts from "typescript"
import {
  assembleValidatorModule,
  compileDefsBlock,
  compileEntryFragment,
  compileValidatorModule,
  type CompiledEntryFragment,
  type TypeRef,
} from "@rhi-zone/fractal-type-ir"
import {
  createExtractorProgram,
  createSharingRegistry,
  extractJsDoc,
  finalizeSharedDefs,
  typeRefFromFunctionNode,
  typeRefFromReturnType,
  type ShouldShare,
} from "./extract.ts"
import { readMetaEncodingMapProfileNames, readMetaSourceMap, readMetaStringLiteral, walkNodeType } from "./tree.ts"
import type { TypeRefMap } from "./tree.ts"
import { APPLY_VALIDATION_BRAND } from "./apply-validation.ts"
import {
  checkCache,
  computeDefNamesFingerprint,
  computeLeafFingerprint,
  readCarryForwardState,
  writeCacheMetadata,
  type CacheLocationOptions,
  type CachedBuildOutcome,
} from "./cache.ts"
import { deriveFieldProfiles, type FieldProfileDerivation, type ProtocolName } from "./wire-derive.ts"
import {
  argvProfile,
  compileConstraintsFn,
  compileWireEntryFragment,
  compileWireEntryFragmentComposite,
  identityProfile,
  INFER_TYPE_REF_SOURCE,
  jsonProfile,
  queryProfile,
  wireValidatorKey,
  type CompiledConstraintsFn,
  type CompiledWireEntryFragment,
  type WireProfile,
} from "@rhi-zone/fractal-type-ir"

/** The five wire protocol names an `applyValidation` call site's optional
 * third argument may name. */
const PROTOCOL_NAMES: ReadonlySet<string> = new Set(["http", "cli", "mcp", "graphql", "jsonrpc", "identity"])

function isProtocolName(value: string): value is ProtocolName {
  return PROTOCOL_NAMES.has(value)
}

/** The module specifier the generated module imports `createApplyValidation`
 * from. Overridable (`options.runtimeImport`) only so this package's own
 * tests can point a generated module at the local source file; a real
 * consumer always gets the published subpath. */
export const DEFAULT_RUNTIME_IMPORT = "@rhi-zone/fractal-api-tree/apply-validation"

/** Separator joining a call site's `key` and a leaf's tree-relative path into
 * the FLAT entry name handed to the type-ir compiler (which emits one flat
 * `validators` record). `\u0000` cannot occur in either half of a real key —
 * a path segment is a JS identifier-ish object key and a `key` is an authored
 * string literal — and `JSON.stringify` (how compile.ts emits entry names)
 * escapes it, so the generated source stays plain ASCII. The generated module
 * never asks a consumer to know about this: it re-groups the flat record into
 * the nested `Record<key, Record<path, entry>>` `createApplyValidation` wants
 * (see `composeApplyValidationTail`). */
const FLAT_KEY_SEPARATOR = "\u0000"

const flatName = (key: string, leafPath: string): string => `${key}${FLAT_KEY_SEPARATOR}${leafPath}`

/** One `applyValidation(key, treeExpr, protocol?)` call site, resolved. */
export type ApplyValidationCallSite = {
  /** The literal first argument. */
  readonly key: string
  /** The resolved TYPE of the `Node` tree the second argument traces back to. */
  readonly nodeType: ts.Type
  /** A node in the entry file to resolve types against (checker calls need a
   * location); the traced tree expression itself. */
  readonly loc: ts.Node
  /** The literal third argument, when present — see decision 1,
   * docs/design/wire-profiles-and-staged-validation.md's "Implementation
   * trace (phase B)" section. `undefined` for an ordinary 2-arg call site,
   * which the EXISTING (unchanged) `extractApplyValidationTypeRefs`/
   * `buildApplyValidationModuleSource*` path keeps handling exactly as
   * before. */
  readonly protocol?: ProtocolName
}

/** True when the CALLEE of `call` is a `createApplyValidation` result.
 *
 * Resolution is by TYPE IDENTITY, via the checker — never by the callee's
 * name. `ApplyValidation` (apply-validation.ts) declares a phantom optional
 * property, `APPLY_VALIDATION_BRAND`, that exists only in the type; asking
 * `checker.getTypeAtLocation(callee)` for that property answers "is this the
 * function `createApplyValidation` returned" regardless of what the binding
 * was renamed to, how many re-export hops (`./generated` -> the runtime
 * package) sit in between, or whether the consumer aliased the import. An
 * unrelated local function literally named `applyValidation` has no such
 * property and is never matched.
 *
 * The alias chain is ALSO resolved (below) — not to decide the match, but so
 * a diagnostic can name the declaration a matched callee came from. */
function isApplyValidationCallee(callee: ts.Expression, checker: ts.TypeChecker): boolean {
  const calleeType = checker.getTypeAtLocation(callee)
  return checker.getPropertyOfType(calleeType, APPLY_VALIDATION_BRAND) !== undefined
}

/** The declaration a callee's (possibly aliased/imported) symbol resolves to
 * — for diagnostics only. */
function calleeDeclaration(callee: ts.Expression, checker: ts.TypeChecker): ts.Declaration | undefined {
  const symbol = checker.getSymbolAtLocation(callee)
  if (!symbol) return undefined
  const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
  return resolved.declarations?.[0]
}

/** A `Node` tree's type, structurally: carries `meta` (every `Node` does —
 * the same discriminator `forEachTreeCandidate` uses, tree.ts) and carries NO
 * `methods` property (an already-PROJECTED HTTP tree does — that's the one
 * property that tells the two apart at the type level, and this package can't
 * import `HttpRoute` to check nominally). */
function isNodeType(type: ts.Type, checker: ts.TypeChecker): boolean {
  return (
    checker.getPropertyOfType(type, "meta") !== undefined &&
    checker.getPropertyOfType(type, "methods") === undefined
  )
}

/** The declaration an identifier ultimately binds to, with any IMPORT alias
 * resolved through — an imported binding's own symbol declares only the
 * `ImportSpecifier` in the importing file, which would make a cross-file
 * declaration look local. Resolving the alias is what lets the cross-file
 * case below report the file the value actually comes from. */
function declarationOfIdentifier(id: ts.Identifier, checker: ts.TypeChecker): ts.Declaration | undefined {
  const symbol = checker.getSymbolAtLocation(id)
  if (!symbol) return undefined
  const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
  return resolved.declarations?.[0] ?? symbol.declarations?.[0]
}

function describeLocation(node: ts.Node): string {
  const source = node.getSourceFile()
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart())
  return `${source.fileName}:${line + 1}:${character + 1}`
}

/**
 * Trace an `applyValidation` call's SECOND argument back to the underlying
 * `api()`-produced `Node` tree, returning its resolved type.
 *
 * Three forms are traced, in this order:
 *   1. the expression's own type is already `Node`-shaped — `applyValidation
 *      ("books", apiTree)` where `apiTree` is an identifier the checker
 *      resolves on its own, or `applyValidation("books", api({...}))` inline;
 *   2. an identifier bound in THIS file — followed to its declaration's
 *      initializer and retried (this is what makes `const routes =
 *      httpProjection(apiTree)` traceable through `routes`);
 *   3. a wrapping call — `httpProjection(apiTree)`, `composeTransforms(...)
 *      (apiTree)`, any one-level wrapper — unwrapped by scanning its
 *      ARGUMENTS for the first `Node`-typed one.
 *
 * Anything else, including an identifier declared in a DIFFERENT file, throws.
 * Cross-file tracing is deliberately out of this phase's scope, and silence
 * there would mean emitting a module that's missing this key entirely — the
 * exact class of quiet miss this mechanism's loudness exists to kill.
 */
function traceNodeType(expr: ts.Expression, checker: ts.TypeChecker, keyLabel: string): ts.Type {
  const entryFile = expr.getSourceFile().fileName
  const seen = new Set<ts.Node>()

  const trace = (current: ts.Expression): ts.Type => {
    if (seen.has(current)) {
      throw new Error(
        `applyValidation codegen: cyclic tree expression for key ${keyLabel} at ${describeLocation(current)}`,
      )
    }
    seen.add(current)

    const ownType = checker.getTypeAtLocation(current)
    if (isNodeType(ownType, checker)) return ownType

    if (ts.isIdentifier(current)) {
      const decl = declarationOfIdentifier(current, checker)
      if (!decl) {
        throw new Error(
          `applyValidation codegen: cannot resolve tree expression ${JSON.stringify(current.text)} ` +
            `for key ${keyLabel} at ${describeLocation(current)}`,
        )
      }
      if (decl.getSourceFile().fileName !== entryFile) {
        throw new Error(
          `applyValidation codegen: the tree passed for key ${keyLabel} at ${describeLocation(current)} ` +
            `is declared in another file (${decl.getSourceFile().fileName}). Cross-file tracing isn't ` +
            `supported yet — declare the tree (or its projection) in the entry file, or call ` +
            `applyValidation in the file that declares it.`,
        )
      }
      if (ts.isVariableDeclaration(decl) && decl.initializer) return trace(decl.initializer)
      throw new Error(
        `applyValidation codegen: the tree passed for key ${keyLabel} at ${describeLocation(current)} ` +
          `resolves to a declaration this codegen can't trace (${ts.SyntaxKind[decl.kind]}).`,
      )
    }

    if (ts.isCallExpression(current)) {
      for (const arg of current.arguments) {
        if (isNodeType(checker.getTypeAtLocation(arg), checker)) return checker.getTypeAtLocation(arg)
        if (ts.isIdentifier(arg)) {
          // An identifier argument may itself need one hop (a local `const`
          // holding the tree) before its Node-ness is visible.
          const decl = declarationOfIdentifier(arg, checker)
          if (
            decl &&
            decl.getSourceFile().fileName === entryFile &&
            ts.isVariableDeclaration(decl) &&
            decl.initializer &&
            isNodeType(checker.getTypeAtLocation(decl.initializer), checker)
          ) {
            return checker.getTypeAtLocation(decl.initializer)
          }
        }
      }
      throw new Error(
        `applyValidation codegen: the call wrapping the tree for key ${keyLabel} at ` +
          `${describeLocation(current)} has no Node-typed argument to unwrap.`,
      )
    }

    if (ts.isParenthesizedExpression(current)) return trace(current.expression)

    throw new Error(
      `applyValidation codegen: cannot trace the tree expression for key ${keyLabel} at ` +
        `${describeLocation(current)} back to an api() Node tree.`,
    )
  }

  return trace(expr)
}

/**
 * Every `applyValidation(key, treeExpr)` call site in `source`, with each
 * call's tree traced to its `Node` type.
 *
 * Throws on a non-literal `key` (nothing can be generated for a key that
 * isn't known statically), on a missing tree argument, and on a DUPLICATE key
 * across two call sites in the same entry file — last-wins would silently
 * apply one tree's validators to another tree's leaves, and the runtime's own
 * duplicate-key guard would only catch it later, at the second call.
 */
export function findApplyValidationCallSites(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): ApplyValidationCallSite[] {
  const sites: ApplyValidationCallSite[] = []
  const keyLocations = new Map<string, string>()

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isApplyValidationCallee(node.expression, checker)) {
      const [keyArg, treeArg, protocolArg] = node.arguments
      const where = describeLocation(node)
      if (keyArg === undefined || !ts.isStringLiteralLike(keyArg)) {
        const decl = calleeDeclaration(node.expression, checker)
        throw new Error(
          `applyValidation codegen: the key argument at ${where} is not a string literal ` +
            `(callee declared at ${decl ? describeLocation(decl) : "unknown"}). Codegen can only ` +
            `generate validators for statically-known keys.`,
        )
      }
      const key = keyArg.text
      const previous = keyLocations.get(key)
      if (previous !== undefined) {
        throw new Error(
          `applyValidation codegen: duplicate key ${JSON.stringify(key)} — used at ${previous} and ` +
            `again at ${where}. Each call site must claim its own key.`,
        )
      }
      if (treeArg === undefined) {
        throw new Error(`applyValidation codegen: missing tree argument for key ${JSON.stringify(key)} at ${where}`)
      }
      let protocol: ProtocolName | undefined
      if (protocolArg !== undefined) {
        if (!ts.isStringLiteralLike(protocolArg) || !isProtocolName(protocolArg.text)) {
          throw new Error(
            `applyValidation codegen: the protocol argument at ${where} is not a recognized string literal ` +
              `(expected one of ${[...PROTOCOL_NAMES].map((p) => JSON.stringify(p)).join(", ")}). Codegen can ` +
              `only generate per-protocol validators for statically-known protocol names.`,
          )
        }
        protocol = protocolArg.text
      }
      keyLocations.set(key, where)
      sites.push({
        key,
        nodeType: traceNodeType(treeArg, checker, JSON.stringify(key)),
        loc: treeArg,
        ...(protocol !== undefined ? { protocol } : {}),
      })
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return sites
}

/** Per-key leaf TypeRefs, keyed by tree-relative path — plus the shared
 * `defs` a `shouldShare` extraction produced (empty without it). */
export type ApplyValidationTypeRefs = {
  readonly byKey: Readonly<Record<string, TypeRefMap>>
  readonly defs: Record<string, TypeRef>
}

function loadSource(entryFile: string, program: ts.Program): ts.SourceFile {
  const source = program.getSourceFile(entryFile)
  if (!source) throw new Error(`applyValidation codegen: source not found: ${entryFile}`)
  return source
}

/**
 * Extract every `applyValidation` call site's leaf TypeRefs from `entryFile`.
 *
 * Same per-leaf derivation as `extractRouteTypeRefs` (tree.ts) — same
 * `walkNodeType` descent, same `typeRefFromFunctionNode`/
 * `typeRefFromReturnType`/`extractJsDoc` — differing only in the anchor (call
 * sites) and the keying (tree-relative paths, grouped under the call site's
 * `key`, instead of one flat `${treeId}/${path}` map).
 */
export function extractApplyValidationTypeRefs(
  entryFile: string,
  options?: { readonly shouldShare?: ShouldShare; readonly program?: ts.Program },
): ApplyValidationTypeRefs {
  const program = options?.program ?? createExtractorProgram(entryFile)
  const checker = program.getTypeChecker()
  const source = loadSource(entryFile, program)
  const registry = options?.shouldShare ? createSharingRegistry() : undefined

  const byKey: Record<string, TypeRefMap> = {}
  for (const site of findApplyValidationCallSites(source, checker)) {
    // A 3-arg (protocol-naming) call site is handled entirely by the
    // separate wire-profile path below (`extractWireApplyValidationTypeRefs`)
    // — skipped here so this function's output (and therefore every existing
    // caller: `buildApplyValidationModuleSource`/its incremental/cached
    // siblings) is COMPLETELY UNCHANGED by a 3-arg call site's mere presence
    // in the same entry file. See decision 1, the design doc's
    // "Implementation trace (phase B)" section.
    if (site.protocol !== undefined) continue
    const types: TypeRefMap = {}
    walkNodeType(site.nodeType, "", [], site.loc, checker, (_name, leafPath, fn, descriptionSource, leafChecker) => {
      const description = extractJsDoc(descriptionSource) ?? extractJsDoc(fn)
      types[leafPath.join("/")] = {
        input: typeRefFromFunctionNode(fn, leafChecker, registry),
        output: typeRefFromReturnType(fn, leafChecker, registry),
        ...(description !== undefined ? { description } : {}),
      }
    })
    byKey[site.key] = types
  }

  if (!options?.shouldShare || !registry) return { byKey, defs: {} }

  // Same flatten -> finalizeSharedDefs -> reassemble plumbing as tree.ts's
  // `finalizeWithDefs`, over the two-level (key, path) map instead of a flat
  // one: sharing must span EVERY key's leaves (a type reused across two trees
  // in one entry file is exactly the case sharing exists for).
  const flatRoots: Record<string, TypeRef> = {}
  for (const [key, types] of Object.entries(byKey)) {
    for (const [leafPath, info] of Object.entries(types)) {
      flatRoots[`${flatName(key, leafPath)}\u0000input`] = info.input
      if (info.output !== undefined) flatRoots[`${flatName(key, leafPath)}\u0000output`] = info.output
    }
  }
  const { roots, defs } = finalizeSharedDefs(registry, flatRoots, options.shouldShare)
  const shared: Record<string, TypeRefMap> = {}
  for (const [key, types] of Object.entries(byKey)) {
    const rebuilt: TypeRefMap = {}
    for (const [leafPath, info] of Object.entries(types)) {
      rebuilt[leafPath] = {
        input: roots[`${flatName(key, leafPath)}\u0000input`]!,
        ...(info.output !== undefined ? { output: roots[`${flatName(key, leafPath)}\u0000output`]! } : {}),
        ...(info.description !== undefined ? { description: info.description } : {}),
      }
    }
    shared[key] = rebuilt
  }
  return { byKey: shared, defs }
}

/** Flat compiler entries (one per leaf across all keys), in a stable order —
 * the emission order of both the compiled `validators` record and the nested
 * regrouping below. */
function flatEntries(byKey: Readonly<Record<string, TypeRefMap>>): { name: string; ref: TypeRef }[] {
  const entries: { name: string; ref: TypeRef }[] = []
  for (const [key, types] of Object.entries(byKey)) {
    for (const [leafPath, info] of Object.entries(types)) {
      entries.push({ name: flatName(key, leafPath), ref: info.input })
    }
  }
  return entries
}

/**
 * The tail appended to the compiled validator module: regroup the flat
 * `validators` record into the nested `Record<key, Record<path, entry>>`
 * `createApplyValidation` takes, and export the composed `applyValidation`.
 * Emitted as an explicit literal (rather than a runtime regrouping loop) so
 * the generated module stays fully statically typed and the mapping from flat
 * name to (key, path) is readable in the output.
 *
 * The consumer writes exactly one import:
 *   `import { applyValidation } from "./generated"`.
 */
function composeApplyValidationTail(byKey: Readonly<Record<string, TypeRefMap>>): string {
  const lines: string[] = []
  lines.push("")
  lines.push("/** Generated validators, grouped by the key each applyValidation call site claims. */")
  lines.push("export const validatorsByKey = {")
  for (const [key, types] of Object.entries(byKey)) {
    lines.push(`  ${JSON.stringify(key)}: {`)
    for (const leafPath of Object.keys(types)) {
      lines.push(`    ${JSON.stringify(leafPath)}: validators[${JSON.stringify(flatName(key, leafPath))}],`)
    }
    lines.push("  },")
  }
  lines.push("}")
  lines.push("")
  lines.push("/** Pass this to each `applyValidation(key, tree)` call site. */")
  lines.push("export const applyValidation = createApplyValidation(validatorsByKey)")
  lines.push("")
  return lines.join("\n")
}

const runtimeImportLine = (runtimeImport: string): string =>
  `import { createApplyValidation } from ${JSON.stringify(runtimeImport)}\n`

/**
 * The PRE-CODEGEN STUB module: a pass-through `applyValidation` over an empty
 * map, so a freshly scaffolded project compiles and runs before codegen has
 * ever produced validators — the consumer's single
 * `import { applyValidation } from "./generated"` resolves from the first
 * commit onward.
 *
 * Note this differs from `wrapValidators`' pre-codegen convention, which has
 * no stub at all: there, a consumer simply OMITS the optional `validators`
 * option (see build.ts's module doc). That option-omission convention has no
 * analogue here, because the whole point of this mechanism is a call site
 * that names its key unconditionally — hence an actual emitted stub.
 * Permissive by construction and SILENT about it: coverage is enforced by
 * codegen and by `assertValidationCoverage` (apply-validation.ts), never here.
 */
export function applyValidationStubSource(options?: { readonly runtimeImport?: string }): string {
  const runtimeImport = options?.runtimeImport ?? DEFAULT_RUNTIME_IMPORT
  return [
    "// AUTO-GENERATED by @rhi-zone/fractal-api-tree. Do not edit by hand.",
    "//",
    "// PRE-CODEGEN STUB — a pass-through applyValidation over an empty validator",
    "// map. Replaced wholesale by the real generated module once codegen runs.",
    "",
    runtimeImportLine(runtimeImport).trimEnd(),
    "",
    "export const validatorsByKey = {}",
    "",
    "export const applyValidation = createApplyValidation(validatorsByKey)",
    "",
  ].join("\n")
}

/**
 * Turn an extracted type's absolute `declarationFile` into the `import type`
 * specifier the generated module at `outFile` should use — same convention
 * (relative, POSIX separators, `.ts` extension kept) as build.ts's own
 * `relativeImportSpecifier`.
 */
function relativeImportSpecifier(outFile: string, declarationFile: string): string {
  const rel = path.relative(path.dirname(outFile), declarationFile).split(path.sep).join("/")
  return rel.startsWith(".") ? rel : `./${rel}`
}

export type ApplyValidationBuildOptions = {
  readonly outFile?: string
  readonly shouldShare?: ShouldShare
  readonly program?: ts.Program
  readonly runtimeImport?: string
}

/**
 * Build the complete `applyValidation` module source for `entryFile`: every
 * call site's leaves compiled by `compileValidatorModule` (the SAME AOT
 * compiler `build.ts` uses — parse/coerce/narrow plus the structured error
 * DU), followed by the nested regrouping and the `createApplyValidation`
 * composition.
 *
 * An entry file with NO call sites yields the stub module — there is nothing
 * to generate, and a consumer's import must still resolve.
 */
export function buildApplyValidationModuleSource(
  entryFile: string,
  options?: ApplyValidationBuildOptions,
): string {
  const { byKey, defs } = extractApplyValidationTypeRefs(entryFile, {
    ...(options?.shouldShare !== undefined ? { shouldShare: options.shouldShare } : {}),
    ...(options?.program !== undefined ? { program: options.program } : {}),
  })
  const runtimeImport = options?.runtimeImport ?? DEFAULT_RUNTIME_IMPORT
  const entries = flatEntries(byKey)
  if (entries.length === 0) {
    const stubOpt = options?.runtimeImport !== undefined ? { runtimeImport: options.runtimeImport } : {}
    return applyValidationStubSource(stubOpt)
  }
  const outFile = options?.outFile
  const compiled = compileValidatorModule(entries, {
    ...(outFile !== undefined
      ? { resolveImport: (declarationFile: string) => relativeImportSpecifier(outFile, declarationFile) }
      : {}),
    ...(Object.keys(defs).length > 0 ? { defs } : {}),
  })
  return runtimeImportLine(runtimeImport) + compiled + composeApplyValidationTail(byKey)
}

/** Write `buildApplyValidationModuleSource`'s output to `outFile`. */
export async function writeApplyValidationModule(
  entryFile: string,
  outFile: string,
  options?: Omit<ApplyValidationBuildOptions, "outFile">,
): Promise<void> {
  await Bun.write(outFile, buildApplyValidationModuleSource(entryFile, { ...options, outFile }))
}

// ============================================================================
// Cached / incremental variants — the SAME two-tier machinery build.ts uses
// (cache.ts): Tier 1 (`checkCache`) skips the `ts.Program` build and the whole
// extraction when nothing this output depended on changed; Tier 2
// (`readCarryForwardState` + per-leaf fingerprints) recompiles only the leaves
// whose IR fingerprint actually moved, carrying every other leaf's compiled
// fragment forward verbatim.
//
// Both tiers transplant unchanged because neither is coupled to build.ts's
// anchor: Tier 1 keys on (entry file, its extraction's source closure,
// toolchain versions, output path), and Tier 2 keys per LEAF NAME — and a leaf
// name is opaque to `computeLeafFingerprint`, so this file's `key\0path`
// composite works exactly as build.ts's `treeId/path` does. The one piece that
// is NOT cached is this file's own tail (the regrouping + composition): it's
// derived from the same `byKey` map the fragments were, costs nothing to
// re-emit, and caching it separately would only add a way for it to drift.
// ============================================================================

/** Narrow an opaquely-stored cache artifact back to a compiled fragment —
 * same guard, same rationale (cache files are untrusted input) as build.ts's
 * `isCompiledFragment`. */
function isCompiledFragment(value: unknown): value is CompiledEntryFragment {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string"
}

export type ApplyValidationIncrementalResult = {
  readonly source: string
  readonly leafFingerprints: Record<string, string>
  readonly leafArtifacts: Record<string, CompiledEntryFragment>
  readonly defNamesFingerprint: string
  /** Flat leaf names actually RECOMPILED this run — everything else was
   * carried forward. For tests/observability, not correctness. */
  readonly changedLeaves: readonly string[]
}

/** Prior Tier-2 state for one entry — `readCarryForwardState`'s return shape
 * (cache.ts), re-declared here for the same reason build.ts re-declares it. */
export type ApplyValidationCarryForwardState = {
  readonly leafFingerprints: Readonly<Record<string, string>>
  readonly leafArtifacts: Readonly<Record<string, unknown>>
  readonly defNamesFingerprint: string
}

/**
 * `buildApplyValidationModuleSource`'s Tier-2 sibling — identical extraction
 * and identical codegen, except a leaf whose fingerprint matches
 * `prior.leafFingerprints` (and whose def-name-set fingerprint still matches)
 * reuses `prior.leafArtifacts`' fragment verbatim instead of recompiling.
 * Mirrors `buildValidatorModuleSourceIncremental` (build.ts) one-for-one.
 */
export function buildApplyValidationModuleSourceIncremental(
  entryFile: string,
  options: ApplyValidationBuildOptions & { readonly prior?: ApplyValidationCarryForwardState },
): ApplyValidationIncrementalResult {
  const { byKey, defs } = extractApplyValidationTypeRefs(entryFile, {
    ...(options.shouldShare !== undefined ? { shouldShare: options.shouldShare } : {}),
    ...(options.program !== undefined ? { program: options.program } : {}),
  })
  const runtimeImport = options.runtimeImport ?? DEFAULT_RUNTIME_IMPORT
  const outFile = options.outFile
  const resolveImport =
    outFile === undefined ? undefined : (declarationFile: string) => relativeImportSpecifier(outFile, declarationFile)

  const defsBlock = compileDefsBlock(defs)
  const defNamesFingerprint = computeDefNamesFingerprint(defsBlock.defNames)
  const prior = options.prior
  const defNamesUnchanged = prior !== undefined && prior.defNamesFingerprint === defNamesFingerprint

  const entries = flatEntries(byKey)
  const leafFingerprints: Record<string, string> = {}
  const leafArtifacts: Record<string, CompiledEntryFragment> = {}
  const changedLeaves: string[] = []

  for (const { name, ref } of entries) {
    const fingerprint = computeLeafFingerprint(entryFile, { input: ref })
    leafFingerprints[name] = fingerprint
    const priorArtifact = prior?.leafArtifacts[name]
    const reusable =
      defNamesUnchanged && prior !== undefined && prior.leafFingerprints[name] === fingerprint && isCompiledFragment(priorArtifact)
    if (reusable && isCompiledFragment(priorArtifact)) {
      leafArtifacts[name] = priorArtifact
    } else {
      leafArtifacts[name] = compileEntryFragment(ref, resolveImport, defsBlock.defNames)
      changedLeaves.push(name)
    }
  }

  const source =
    entries.length === 0
      ? applyValidationStubSource({ runtimeImport })
      : runtimeImportLine(runtimeImport) +
        assembleValidatorModule(entries, leafArtifacts, defsBlock.lines) +
        composeApplyValidationTail(byKey)

  return { source, leafFingerprints, leafArtifacts, defNamesFingerprint, changedLeaves }
}

/**
 * `buildApplyValidationModuleSource`, cached — Tier 1 hit skips everything
 * (including the `ts.Program` build); a miss falls through to Tier 2 above.
 * Same contract, same options, same `CachedBuildOutcome` as build.ts's
 * `buildValidatorModuleCached`.
 */
export function buildApplyValidationModuleCached(
  entryFile: string,
  outFile: string,
  options?: {
    readonly shouldShare?: ShouldShare
    readonly program?: ts.Program
    readonly runtimeImport?: string
    readonly force?: boolean
    readonly reachable?: ReadonlySet<string>
  } & CacheLocationOptions,
): CachedBuildOutcome<string> {
  if (!options?.force) {
    const check = checkCache(entryFile, outFile, options)
    if (check.hit) return { status: "hit" }
  }
  const program = options?.program ?? createExtractorProgram(entryFile)
  const prior = readCarryForwardState(entryFile, outFile, options)
  const built = buildApplyValidationModuleSourceIncremental(entryFile, {
    outFile,
    program,
    ...(options?.shouldShare !== undefined ? { shouldShare: options.shouldShare } : {}),
    ...(options?.runtimeImport !== undefined ? { runtimeImport: options.runtimeImport } : {}),
    ...(prior !== undefined ? { prior } : {}),
  })
  writeCacheMetadata(entryFile, outFile, program, built.source, options, options?.reachable, {
    leafFingerprints: built.leafFingerprints,
    leafArtifacts: built.leafArtifacts,
    defNamesFingerprint: built.defNamesFingerprint,
  })
  return { status: "built", result: built.source, program }
}

/**
 * `writeApplyValidationModule`, cached: writes `outFile` only when
 * `buildApplyValidationModuleCached` actually built something.
 */
export async function writeApplyValidationModuleCached(
  entryFile: string,
  outFile: string,
  options?: {
    readonly shouldShare?: ShouldShare
    readonly program?: ts.Program
    readonly runtimeImport?: string
    readonly force?: boolean
    readonly reachable?: ReadonlySet<string>
  } & CacheLocationOptions,
): Promise<CachedBuildOutcome<string>> {
  const outcome = buildApplyValidationModuleCached(entryFile, outFile, options)
  if (outcome.status === "built") await Bun.write(outFile, outcome.result)
  return outcome
}

// ============================================================================
// Wire-profile build path — 3-arg `applyValidation(key, tree, protocol)` call
// sites (decision 1). PARALLEL machinery to everything above: the 2-arg path
// (`extractApplyValidationTypeRefs`/`buildApplyValidationModuleSource*`) is
// untouched (see the `site.protocol !== undefined` skip in
// `extractApplyValidationTypeRefs` above) — a 3-arg call site is invisible to
// it, and a 2-arg call site is invisible to everything below.
//
// STATIC-META-READ INVESTIGATION (decision 4/5's "investigate before
// assuming"): `walkNodeType`'s existing `mcpMetaOverride` (tree.ts) already
// reads a scalar STRING-LITERAL meta value off a resolved `Node` TYPE — not
// just a type shape, an actual authored VALUE (`meta.mcp.name`), via
// `checker.getPropertyOfType`/`getTypeOfSymbolAtLocation`/`isStringLiteral()`.
// That IS "a legitimate static-meta-read path" (option (a) from the task):
// `meta.http.method`/`meta.http.verb` (flat scalars) and `meta.<proto>.
// sourceMap` (a map of per-field `{ store, key? }` literals — one level
// deeper, enumerated via `getPropertiesOfType`, the SAME enumeration
// `walkNodeType` already uses for `children`) generalize the identical
// technique — see `readMetaStringLiteral`/`readMetaSourceMap` (tree.ts).
// `option (b)` (`getConstantValue`/partial evaluation) was not needed once
// (a) panned out and wasn't separately investigated.
//
// The gap that remains, and IS real: `encodingMap`'s two authorable shapes
// (see the design doc's decision-5 discussion) are a base-profile-name STRING
// (`"identity" | "json" | "query" | "argv"`) or a custom decoder FUNCTION
// (`(w: FieldValidWire) => TField`). The string form reads exactly like a
// `sourceMap` entry's `store` (`readMetaEncodingMapProfileNames`, tree.ts) —
// wired in below. The FUNCTION form has no analogous path: a function value
// has no literal TYPE for the checker to hand back (unlike a string), so
// there is nothing to read "as a value" — emitting a reference to it in the
// generated module would require either (a) the function being a NAMED
// EXPORT elsewhere that codegen could import (not what the design describes
// — it's authored inline, per field, in the meta object literal) or (b)
// copying its source text into the generated module (fragile: closures,
// scoping, and it isn't what any existing codegen path in this codebase
// does — `guardAnnotation`'s cross-file `typeName`/`declarationFile`
// resolution imports a TYPE reference, never re-emits a value's source).
// Neither is implemented; a function-valued `encodingMap` entry is silently
// OMITTED by `readMetaEncodingMapProfileNames` (see that function's own doc
// comment) rather than causing a wrong/silent-fallback result — this is the
// one part of decision 4/5 left as a documented gap, not "fully wired."
// ============================================================================

/** The base profile a `meta.<proto>.encodingMap` entry's STRING form names —
 * see `readMetaEncodingMapProfileNames` (tree.ts) for what this doesn't cover
 * (a function-valued entry; the documented gap above). */
const BASE_PROFILE_BY_NAME: Readonly<Record<string, WireProfile>> = {
  identity: identityProfile,
  json: jsonProfile,
  query: queryProfile,
  argv: argvProfile,
}

/** One 3-arg call site's leaf: its input `TypeRef` plus the derived wire
 * profile assignment (`wire-derive.ts`). */
export type WireApplyValidationLeaf = {
  readonly ref: TypeRef
  readonly derivation: FieldProfileDerivation
}

/** Per-key wire-profile leaves — one `protocol` per key (a call site names
 * exactly one), each key's leaves keyed by tree-relative path, same
 * convention as `ApplyValidationTypeRefs`. */
export type WireApplyValidationTypeRefs = {
  readonly byKey: Readonly<
    Record<string, { readonly protocol: ProtocolName; readonly leaves: Readonly<Record<string, WireApplyValidationLeaf>> }>
  >
}

/**
 * Extract every 3-arg `applyValidation(key, treeExpr, protocol)` call site's
 * leaves from `entryFile`, deriving each leaf's wire-profile assignment along
 * the way — `identity`/`mcp`/`graphql`/`jsonrpc` need no meta read at all
 * (`deriveFieldProfiles` returns a uniform base profile unconditionally for
 * those); `http`/`cli` read that leaf's own `meta.<proto>.sourceMap` (and, for
 * `http`, `meta.http.method`/`.verb`) via the generalized `mcpMetaOverride`
 * technique (`readMetaSourceMap`/`readMetaStringLiteral`, tree.ts), plus this
 * leaf's own tree-relative path's `:name` fallback segments as its path-param
 * name set (already exactly what `leafPath` carries — no extra read needed).
 *
 * `encodingMap`'s STRING-form entries (base-profile-name overrides) are read
 * and applied on top for `http`/`cli`; a FUNCTION-form entry is a documented
 * gap (see this section's header comment) and is silently omitted.
 *
 * No `shouldShare`/defs support (scope cut, mirrors type-ir phase A's own "no
 * defs/ref recursion support for wire profiles" cut).
 */
export function extractWireApplyValidationTypeRefs(
  entryFile: string,
  options?: { readonly program?: ts.Program },
): WireApplyValidationTypeRefs {
  const program = options?.program ?? createExtractorProgram(entryFile)
  const checker = program.getTypeChecker()
  const source = loadSource(entryFile, program)

  const byKey: Record<string, { protocol: ProtocolName; leaves: Record<string, WireApplyValidationLeaf> }> = {}
  for (const site of findApplyValidationCallSites(source, checker)) {
    if (site.protocol === undefined) continue
    const protocol = site.protocol
    const leaves: Record<string, WireApplyValidationLeaf> = {}
    walkNodeType(
      site.nodeType,
      "",
      [],
      site.loc,
      checker,
      (_name, leafPath, fn, _descriptionSource, leafChecker, nodeType) => {
        const ref = typeRefFromFunctionNode(fn, leafChecker)
        const pathParamNames = leafPath.filter((seg) => seg.startsWith(":")).map((seg) => seg.slice(1))
        let derivation: FieldProfileDerivation
        if (protocol === "http" || protocol === "cli") {
          const sourceMap = readMetaSourceMap(nodeType, protocol, site.loc, leafChecker)
          const method =
            protocol === "http"
              ? readMetaStringLiteral(nodeType, "http", "method", site.loc, leafChecker) ??
                readMetaStringLiteral(nodeType, "http", "verb", site.loc, leafChecker)
              : undefined
          derivation = deriveFieldProfiles(protocol, sourceMap, method, pathParamNames)
          const encodingMap = readMetaEncodingMapProfileNames(nodeType, protocol, site.loc, leafChecker)
          if (encodingMap !== undefined && "fieldProfiles" in derivation) {
            const fieldProfiles = { ...derivation.fieldProfiles }
            for (const [field, baseName] of Object.entries(encodingMap)) {
              const base = BASE_PROFILE_BY_NAME[baseName]
              if (base !== undefined) fieldProfiles[field] = base
            }
            derivation = { fieldProfiles, defaultProfile: derivation.defaultProfile }
          }
        } else {
          derivation = deriveFieldProfiles(protocol, undefined, undefined, [])
        }
        leaves[leafPath.join("/")] = { ref, derivation }
      },
    )
    byKey[site.key] = { protocol, leaves }
  }
  return { byKey }
}

/** Flat compiler entries (one per leaf across all wire-profile call sites),
 * mirroring `flatEntries` above — each entry additionally carries its own
 * `protocol` and derived `FieldProfileDerivation`. */
function flatWireEntries(
  byKey: WireApplyValidationTypeRefs["byKey"],
): { name: string; ref: TypeRef; protocol: ProtocolName; derivation: FieldProfileDerivation }[] {
  const entries: { name: string; ref: TypeRef; protocol: ProtocolName; derivation: FieldProfileDerivation }[] = []
  for (const [key, { protocol, leaves }] of Object.entries(byKey)) {
    for (const [leafPath, leaf] of Object.entries(leaves)) {
      entries.push({ name: flatName(key, leafPath), ref: leaf.ref, protocol, derivation: leaf.derivation })
    }
  }
  return entries
}

/** Compile one leaf's `CompiledWireEntryFragment` — the uniform-profile case
 * (`{ profile }`) goes through `compileWireEntryFragment` directly; the
 * composite case (`{ fieldProfiles, defaultProfile }`) goes through
 * `compileWireEntryFragmentComposite`. Neither is duplicated here — this is
 * just the `FieldProfileDerivation`-shaped dispatch between the two. */
function compileWireLeafFragment(
  ref: TypeRef,
  derivation: FieldProfileDerivation,
  constraintsFnName: string,
  resolveImport?: (declarationFile: string) => string,
): CompiledWireEntryFragment {
  if ("profile" in derivation) return compileWireEntryFragment(ref, derivation.profile, constraintsFnName, resolveImport)
  return compileWireEntryFragmentComposite(
    ref,
    derivation.fieldProfiles,
    derivation.defaultProfile,
    constraintsFnName,
    resolveImport,
  )
}

function indentGenerated(lines: readonly string[], spaces: number): string[] {
  const pad = " ".repeat(spaces)
  return lines.map((line) => (line.length === 0 ? line : pad + line))
}

/**
 * WORKAROUND for a genuine cross-entry naming collision in
 * `compileConstraintsFn` (type-ir compile.ts, Phase A, out of this phase's
 * "do not touch" list's scope but not a function this file owns either) —
 * see the design doc's "Implementation trace (phase B)" section for the full
 * writeup and a minimal repro. `compileConstraintsFn` gives each call its OWN
 * fresh `GenCtx`, whose const-naming counter always starts at 0 — so two
 * DIFFERENT entries' constraints functions each independently hoist consts
 * named `__ref0`, `__ref1`, ... starting from zero. Splicing more than one
 * entry's `fn.lines` into ONE module at shared scope (exactly what
 * `assembleWireModule`, compile.ts, and this function both do) produces a
 * duplicate `const` declaration whenever two entries each need at least one
 * hoisted const — the common case: any plain typed field's `type`-kind error
 * references one (`typeErrorStmt`'s `refLiteral`). No EXISTING test caught
 * this because no existing wire-profile test compiles more than one ENTRY
 * into one module (every multi-profile test uses a single entry across
 * several profiles, whose IIFE-scoped IIFE IS unaffected — this file's own
 * `compileWireEntryFragment`/`compileWireEntryFragmentComposite` fragments
 * are already correctly scoped, only `compileConstraintsFn`'s module-scope
 * consts collide).
 *
 * This mangles ONLY the const names THIS entry's own `fn.lines` actually
 * declares (a per-entry-unique suffix), leaving `compileConstraintsFn`
 * itself, `wireFragments`' own already-correctly-scoped consts, and every
 * other existing caller of that function completely untouched — a pure
 * textual disambiguation at the ASSEMBLY layer, not a fix to the root cause
 * (which lives in `GenCtx`/`compileConstraintsFn`, out of this phase's
 * mandate to modify).
 */
function disambiguateConstraintsConsts(lines: readonly string[], suffix: string): string[] {
  const text = lines.join("\n")
  const declared = new Set<string>()
  for (const m of text.matchAll(/^const (__\w+) = /gm)) declared.add(m[1]!)
  if (declared.size === 0) return [...lines]
  let renamed = text
  for (const name of declared) {
    renamed = renamed.replace(new RegExp(`\\b${name}\\b`, "g"), `${name}${suffix}`)
  }
  return renamed.split("\n")
}

/**
 * `assembleWireModule`'s (type-ir) sibling for THIS file's shape: each entry
 * has exactly ONE protocol (a call site names exactly one), not a uniform
 * profile SET shared across every entry the way `assembleWireModule` assumes
 * — so this reassembles from already-compiled fragments directly rather than
 * reusing that function. `wireFragments` is keyed by
 * `wireValidatorKey(name, protocol)`, same convention.
 */
function assembleWireApplyValidationModule(
  entries: readonly { readonly name: string; readonly protocol: ProtocolName }[],
  constraintsFns: Readonly<Record<string, CompiledConstraintsFn>>,
  wireFragments: Readonly<Record<string, CompiledWireEntryFragment>>,
): string {
  const imports = new Map<string, Set<string>>()
  imports.set("@rhi-zone/fractal-type-ir", new Set(["ValidationError"]))

  const constraintsLines: string[] = []
  entries.forEach(({ name }, index) => {
    const fn = constraintsFns[name]
    if (!fn) throw new Error(`buildWireApplyValidationModuleSource: missing constraints fn for entry ${JSON.stringify(name)}`)
    constraintsLines.push(...disambiguateConstraintsConsts(fn.lines, `_${index}`))
  })

  const entryLines: string[] = []
  for (const { name, protocol } of entries) {
    const key = wireValidatorKey(name, protocol)
    const frag = wireFragments[key]
    if (!frag) throw new Error(`buildWireApplyValidationModuleSource: missing wire fragment for ${JSON.stringify(key)}`)
    if (frag.typeImport) {
      const names = imports.get(frag.typeImport.from) ?? new Set<string>()
      names.add(frag.typeImport.typeName)
      imports.set(frag.typeImport.from, names)
    }
    const codeLines = frag.code.split("\n")
    entryLines.push(
      `  ${JSON.stringify(key)}: ${codeLines[0]}`,
      ...indentGenerated(codeLines.slice(1, -1), 2),
      `  ${codeLines[codeLines.length - 1]},`,
    )
  }

  const lines: string[] = []
  lines.push("// AUTO-GENERATED by @rhi-zone/fractal-api-tree (wire-profile path). Do not edit by hand.")
  lines.push("")
  for (const [from, names] of imports) {
    lines.push(`import type { ${[...names].sort().join(", ")} } from ${JSON.stringify(from)}`)
  }
  if (imports.size > 0) lines.push("")
  lines.push(INFER_TYPE_REF_SOURCE)
  lines.push("")
  lines.push(...constraintsLines)
  if (constraintsLines.length > 0) lines.push("")
  lines.push("export const wireValidators = {")
  lines.push(...entryLines)
  lines.push("}")
  lines.push("")
  return lines.join("\n")
}

/**
 * The tail appended to the compiled wire module: regroup the flat
 * `wireValidators` record into the nested `Record<key, Record<path,
 * Partial<Record<protocol, entry>>>>` `createApplyValidation`'s SECOND
 * argument wants, and export a standalone `applyValidation`.
 *
 * An entry file mixing 2-arg and 3-arg call sites gets TWO separately built
 * modules (this one, and the 2-arg path's) — each exports its own usable
 * `applyValidation`, but a consumer that wants ONE shared function (so
 * `usedKeys` is tracked across both kinds of call in one file) composes
 * manually: `createApplyValidation(validatorsByKey, wireValidatorsByKey)`,
 * importing `validatorsByKey`/`wireValidatorsByKey` from each generated
 * module respectively. Documented here as a scope note, not a contradiction —
 * the same class of explicit scope cut this file already makes elsewhere
 * (e.g. same-file-only tree tracing, `traceNodeType`'s doc comment).
 */
function composeWireApplyValidationTail(byKey: WireApplyValidationTypeRefs["byKey"]): string {
  const lines: string[] = []
  lines.push("")
  lines.push("/** Generated wire validators, grouped by (key, tree-relative path, protocol). */")
  lines.push("export const wireValidatorsByKey = {")
  for (const [key, { protocol, leaves }] of Object.entries(byKey)) {
    lines.push(`  ${JSON.stringify(key)}: {`)
    for (const leafPath of Object.keys(leaves)) {
      const entryRef = wireValidatorKey(flatName(key, leafPath), protocol)
      lines.push(`    ${JSON.stringify(leafPath)}: { ${JSON.stringify(protocol)}: wireValidators[${JSON.stringify(entryRef)}] },`)
    }
    lines.push("  },")
  }
  lines.push("}")
  lines.push("")
  lines.push("/** Pass this as `createApplyValidation`'s SECOND argument. */")
  lines.push("export const applyValidation = createApplyValidation({}, wireValidatorsByKey)")
  lines.push("")
  return lines.join("\n")
}

export type WireApplyValidationBuildOptions = {
  readonly outFile?: string
  readonly program?: ts.Program
  readonly runtimeImport?: string
}

/**
 * Build the complete wire-profile `applyValidation` module source for
 * `entryFile` — every 3-arg call site's leaves compiled via
 * `compileWireLeafFragment`/`compileConstraintsFn`, assembled by
 * `assembleWireApplyValidationModule`, followed by the nested regrouping and
 * `createApplyValidation` composition (`composeWireApplyValidationTail`).
 *
 * An entry file with no 3-arg call sites yields the SAME stub module the
 * 2-arg path yields (`applyValidationStubSource`) — nothing to generate, and
 * a consumer's import must still resolve.
 */
export function buildWireApplyValidationModuleSource(
  entryFile: string,
  options?: WireApplyValidationBuildOptions,
): string {
  const { byKey } = extractWireApplyValidationTypeRefs(entryFile, {
    ...(options?.program !== undefined ? { program: options.program } : {}),
  })
  const runtimeImport = options?.runtimeImport ?? DEFAULT_RUNTIME_IMPORT
  const entries = flatWireEntries(byKey)
  if (entries.length === 0) {
    const stubOpt = options?.runtimeImport !== undefined ? { runtimeImport: options.runtimeImport } : {}
    return applyValidationStubSource(stubOpt)
  }
  const outFile = options?.outFile
  const resolveImport =
    outFile === undefined ? undefined : (declarationFile: string) => relativeImportSpecifier(outFile, declarationFile)

  const constraintsFns: Record<string, CompiledConstraintsFn> = {}
  const wireFragments: Record<string, CompiledWireEntryFragment> = {}
  for (const { name, ref, protocol, derivation } of entries) {
    constraintsFns[name] = compileConstraintsFn(name, ref)
    wireFragments[wireValidatorKey(name, protocol)] = compileWireLeafFragment(
      ref,
      derivation,
      constraintsFns[name].fnName,
      resolveImport,
    )
  }
  return (
    runtimeImportLine(runtimeImport) +
    assembleWireApplyValidationModule(entries, constraintsFns, wireFragments) +
    composeWireApplyValidationTail(byKey)
  )
}

/** JSON-serializable fingerprint input for one leaf's derivation — profile
 * NAMES, not the `WireProfile` objects themselves (whose `leafHandlers`
 * values are functions; `JSON.stringify` silently drops them, which would
 * still distinguish most profiles via their surviving keys but needlessly
 * relies on that side effect) — see `computeLeafFingerprint`'s doc comment
 * (cache.ts) and this design's item 7 ("just pass `{ input: ref, profile:
 * profileName }`"). */
function fingerprintableDerivation(derivation: FieldProfileDerivation): unknown {
  if ("profile" in derivation) return { profile: derivation.profile.name }
  return {
    defaultProfile: derivation.defaultProfile.name,
    fieldProfiles: Object.fromEntries(Object.entries(derivation.fieldProfiles).map(([field, p]) => [field, p.name])),
  }
}

export type WireApplyValidationIncrementalResult = {
  readonly source: string
  readonly leafFingerprints: Record<string, string>
  readonly leafArtifacts: Record<string, CompiledWireEntryFragment>
  /** Flat `(leafName, protocol)` keys (via `wireValidatorKey`) actually
   * RECOMPILED this run — everything else was carried forward. */
  readonly changedLeaves: readonly string[]
}

/** Prior Tier-2 state for one wire-path entry — no `defNamesFingerprint`
 * tracking (this path has no defs/ref-recursion support at all, per this
 * section's header comment's scope cut), unlike `ApplyValidationCarryForwardState`. */
export type WireApplyValidationCarryForwardState = {
  readonly leafFingerprints: Readonly<Record<string, string>>
  readonly leafArtifacts: Readonly<Record<string, unknown>>
}

function isCompiledWireFragment(value: unknown): value is CompiledWireEntryFragment {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { wireType?: unknown }).wireType === "string"
  )
}

/**
 * `buildWireApplyValidationModuleSource`'s Tier-2 sibling — identical
 * extraction/derivation and identical codegen, except a leaf whose
 * `(input ref, protocol, derivation)` fingerprint matches
 * `prior.leafFingerprints` reuses `prior.leafArtifacts`'s fragment verbatim
 * instead of recompiling. Mirrors `buildApplyValidationModuleSourceIncremental`
 * one-for-one, keyed by `wireValidatorKey(name, protocol)` instead of bare
 * `name` (this path's fingerprint/artifact keys fold `protocol` in — see item
 * 7: "the profile identity is already folded into the fingerprint for free").
 */
export function buildWireApplyValidationModuleSourceIncremental(
  entryFile: string,
  options: WireApplyValidationBuildOptions & { readonly prior?: WireApplyValidationCarryForwardState },
): WireApplyValidationIncrementalResult {
  const { byKey } = extractWireApplyValidationTypeRefs(entryFile, {
    ...(options.program !== undefined ? { program: options.program } : {}),
  })
  const runtimeImport = options.runtimeImport ?? DEFAULT_RUNTIME_IMPORT
  const outFile = options.outFile
  const resolveImport =
    outFile === undefined ? undefined : (declarationFile: string) => relativeImportSpecifier(outFile, declarationFile)

  const entries = flatWireEntries(byKey)
  const leafFingerprints: Record<string, string> = {}
  const leafArtifacts: Record<string, CompiledWireEntryFragment> = {}
  const constraintsFns: Record<string, CompiledConstraintsFn> = {}
  const changedLeaves: string[] = []
  const prior = options.prior

  for (const { name, ref, protocol, derivation } of entries) {
    const fingerprintKey = wireValidatorKey(name, protocol)
    const fingerprint = computeLeafFingerprint(entryFile, {
      input: ref,
      protocol,
      derivation: fingerprintableDerivation(derivation),
    })
    leafFingerprints[fingerprintKey] = fingerprint
    constraintsFns[name] = compileConstraintsFn(name, ref)
    const priorArtifact = prior?.leafArtifacts[fingerprintKey]
    const reusable =
      prior !== undefined && prior.leafFingerprints[fingerprintKey] === fingerprint && isCompiledWireFragment(priorArtifact)
    if (reusable && isCompiledWireFragment(priorArtifact)) {
      leafArtifacts[fingerprintKey] = priorArtifact
    } else {
      leafArtifacts[fingerprintKey] = compileWireLeafFragment(ref, derivation, constraintsFns[name].fnName, resolveImport)
      changedLeaves.push(fingerprintKey)
    }
  }

  const source =
    entries.length === 0
      ? applyValidationStubSource({ runtimeImport })
      : runtimeImportLine(runtimeImport) +
        assembleWireApplyValidationModule(entries, constraintsFns, leafArtifacts) +
        composeWireApplyValidationTail(byKey)

  return { source, leafFingerprints, leafArtifacts, changedLeaves }
}

/**
 * `buildWireApplyValidationModuleSource`, cached — same two-tier shape as
 * `buildApplyValidationModuleCached`. No `defNamesFingerprint` tracked (this
 * path has none — see `WireApplyValidationCarryForwardState`'s doc comment);
 * `writeCacheMetadata`'s `defNamesFingerprint` slot gets a stable constant
 * (the empty set's fingerprint) purely so the cache file's shape stays
 * uniform across both build paths, never compared against.
 */
export function buildWireApplyValidationModuleCached(
  entryFile: string,
  outFile: string,
  options?: {
    readonly program?: ts.Program
    readonly runtimeImport?: string
    readonly force?: boolean
    readonly reachable?: ReadonlySet<string>
  } & CacheLocationOptions,
): CachedBuildOutcome<string> {
  if (!options?.force) {
    const check = checkCache(entryFile, outFile, options)
    if (check.hit) return { status: "hit" }
  }
  const program = options?.program ?? createExtractorProgram(entryFile)
  const priorRaw = readCarryForwardState(entryFile, outFile, options)
  const prior: WireApplyValidationCarryForwardState | undefined =
    priorRaw === undefined ? undefined : { leafFingerprints: priorRaw.leafFingerprints, leafArtifacts: priorRaw.leafArtifacts }
  const built = buildWireApplyValidationModuleSourceIncremental(entryFile, {
    outFile,
    program,
    ...(options?.runtimeImport !== undefined ? { runtimeImport: options.runtimeImport } : {}),
    ...(prior !== undefined ? { prior } : {}),
  })
  writeCacheMetadata(entryFile, outFile, program, built.source, options, options?.reachable, {
    leafFingerprints: built.leafFingerprints,
    leafArtifacts: built.leafArtifacts,
    defNamesFingerprint: computeDefNamesFingerprint([]),
  })
  return { status: "built", result: built.source, program }
}

/**
 * `buildWireApplyValidationModuleCached`, writing the result — mirrors
 * `writeApplyValidationModuleCached`.
 */
export async function writeWireApplyValidationModuleCached(
  entryFile: string,
  outFile: string,
  options?: {
    readonly program?: ts.Program
    readonly runtimeImport?: string
    readonly force?: boolean
    readonly reachable?: ReadonlySet<string>
  } & CacheLocationOptions,
): Promise<CachedBuildOutcome<string>> {
  const outcome = buildWireApplyValidationModuleCached(entryFile, outFile, options)
  if (outcome.status === "built") await Bun.write(outFile, outcome.result)
  return outcome
}
