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
import { walkNodeType } from "./tree.ts"
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

/** One `applyValidation(key, treeExpr)` call site, resolved. */
export type ApplyValidationCallSite = {
  /** The literal first argument. */
  readonly key: string
  /** The resolved TYPE of the `Node` tree the second argument traces back to. */
  readonly nodeType: ts.Type
  /** A node in the entry file to resolve types against (checker calls need a
   * location); the traced tree expression itself. */
  readonly loc: ts.Node
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
      const [keyArg, treeArg] = node.arguments
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
      keyLocations.set(key, where)
      sites.push({ key, nodeType: traceNodeType(treeArg, checker, JSON.stringify(key)), loc: treeArg })
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
