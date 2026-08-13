// Call-site-anchored build orchestrator for the `applyValidation(key, tree,
// protocol?)` mechanism (apply-validation.ts) — the sibling of `build.ts`,
// which anchors on exported `api()` trees instead:
//
//   build.ts:  entryFile --extractRouteTypeRefs (scans exports)-->
//              `${treeId}/${path}` -> TypeRef --compile--> module
//
//   this file: entryFile --scan applyValidation() call sites-->
//              per key: `${path}` -> TypeRef --compile--> module
//              (+ the nested `Record<key, Record<path, entry>>`
//               and the `createApplyValidation` composition)
//
// This is the sole `applyValidation` codegen pipeline
// (`extractWireApplyValidationTypeRefs`/`buildWireApplyValidationModuleSource*`,
// backed by `compileWireEntryFragment`/`compileConstraintsFn`). Every
// `applyValidation` call site — 2-arg or 3-arg — compiles through it: an
// omitted `protocol` argument is sugar for `"identity"` (see
// `extractWireApplyValidationTypeRefs`'s doc comment).
//
// The extraction machinery is shared, not reimplemented: each traced tree is
// descended with `walkNodeType` (tree.ts) and each leaf's TypeRef comes from
// `typeRefFromFunctionNode` (extract.ts), exactly as `extractRouteTypeRefs`
// does. Only the anchor differs (call sites, not exports) and therefore the
// keying: paths here are tree-relative, because `applyValidation`'s own `key`
// argument already scopes one tree — where `extractRouteTypeRefs` has to
// prefix every path with a `treeId` to keep two trees in one file from
// colliding in a single flat map.
//
// The loud checks for this mechanism live in codegen; the runtime stub
// (apply-validation.ts) is permissive:
//   - a non-literal `key` argument, a `key` used at two call sites in one
//     entry file, or a tree expression that can't be traced to a `Node`,
//     each throw here, naming the location and the reason;
//   - a tree expression whose declaration lives in another file throws too —
//     same-file resolution is this phase's scope.

import * as path from "node:path";
import ts from "typescript";
import { compileDefsBlock, type TypeRef } from "@rhi-zone/fractal-type-ir";
import {
  createExtractorProgram,
  createSharingRegistry,
  finalizeSharedDefs,
  typeRefFromFunctionNode,
  type ShouldShare,
} from "./extract.ts";
import {
  readMetaEncodingMapFunctionFields,
  readMetaEncodingMapProfileNames,
  readMetaSourceMap,
  readMetaStringLiteral,
  walkNodeType,
} from "./tree.ts";
import { APPLY_VALIDATION_BRAND } from "./apply-validation.ts";
import {
  checkCache,
  computeDefNamesFingerprint,
  computeLeafFingerprint,
  readCarryForwardState,
  writeCacheMetadata,
  type CacheLocationOptions,
  type CachedBuildOutcome,
} from "./cache.ts";
import {
  deriveFieldProfiles,
  type FieldProfileDerivation,
  type ProtocolName,
} from "./wire-derive.ts";
import {
  argvProfile,
  compileConstraintsFn,
  compileWireEntryFragment,
  compileWireEntryFragmentComposite,
  createWireDefsRegistry,
  identityProfile,
  INFER_TYPE_REF_SOURCE,
  jsonProfile,
  queryProfile,
  wireValidatorKey,
  type CompiledConstraintsFn,
  type CompiledWireEntryFragment,
  type WireDefsRegistry,
  type WireProfile,
} from "@rhi-zone/fractal-type-ir";

/** The five wire protocol names an `applyValidation` call site's optional
 * third argument may name. */
const PROTOCOL_NAMES: ReadonlySet<string> = new Set([
  "http",
  "cli",
  "mcp",
  "graphql",
  "jsonrpc",
  "identity",
]);

function isProtocolName(value: string): value is ProtocolName {
  return PROTOCOL_NAMES.has(value);
}

/** The module specifier the generated module imports `createApplyValidation`
 * from. Overridable (`options.runtimeImport`) only so this package's own
 * tests can point a generated module at the local source file; a real
 * consumer always gets the published subpath. */
export const DEFAULT_RUNTIME_IMPORT = "@rhi-zone/fractal-api-tree/apply-validation";

/** Separator joining a call site's `key` and a leaf's tree-relative path into
 * the flat entry name handed to the type-ir compiler (which emits one flat
 * `validators` record). `\u0000` cannot occur in either half of a real key —
 * a path segment is a JS identifier-ish object key and a `key` is an authored
 * string literal — and `JSON.stringify` (how compile.ts emits entry names)
 * escapes it, so the generated source stays plain ASCII. A consumer of the
 * generated module never sees this encoding: `composeWireApplyValidationTail`
 * re-groups the flat record into the nested `Record<key, Record<path,
 * entry>>` `createApplyValidation` wants. */
const FLAT_KEY_SEPARATOR = "\u0000";

const flatName = (key: string, leafPath: string): string =>
  `${key}${FLAT_KEY_SEPARATOR}${leafPath}`;

/** One `applyValidation(key, treeExpr, protocol?)` call site, resolved. */
export type ApplyValidationCallSite = {
  /** The literal first argument. */
  readonly key: string;
  /** The resolved type of the `Node` tree the second argument traces back to. */
  readonly nodeType: ts.Type;
  /** A node in the entry file to resolve types against (checker calls need a
   * location); the traced tree expression itself. */
  readonly loc: ts.Node;
  /** The literal third argument, when present — see
   * docs/design/wire-profiles-and-staged-validation.md's "`protocol` as
   * `applyValidation`'s optional third argument" section. `undefined` for an
   * ordinary 2-arg call site —
   * `extractWireApplyValidationTypeRefs` treats an `undefined` protocol as
   * sugar for `"identity"`, so a 2-arg call site is not skipped by
   * extraction; this field still records the literal source text (present
   * vs. absent) for diagnostics/tests that care about it. */
  readonly protocol?: ProtocolName;
};

/** True when the callee of `call` is a `createApplyValidation` result.
 *
 * Resolution is by type identity, via the checker — never by the callee's
 * name. `ApplyValidation` (apply-validation.ts) declares a phantom optional
 * property, `APPLY_VALIDATION_BRAND`, that exists only in the type; asking
 * `checker.getTypeAtLocation(callee)` for that property answers "is this the
 * function `createApplyValidation` returned" regardless of what the binding
 * was renamed to, how many re-export hops (`./generated` -> the runtime
 * package) sit in between, or whether the consumer aliased the import. An
 * unrelated local function literally named `applyValidation` has no such
 * property and is never matched.
 *
 * The alias chain is also resolved (below), separately — not to decide the
 * match, but so a diagnostic can name the declaration a matched callee came
 * from. */
function isApplyValidationCallee(callee: ts.Expression, checker: ts.TypeChecker): boolean {
  const calleeType = checker.getTypeAtLocation(callee);
  return checker.getPropertyOfType(calleeType, APPLY_VALIDATION_BRAND) !== undefined;
}

/** The declaration a callee's (possibly aliased/imported) symbol resolves to
 * — for diagnostics only. */
function calleeDeclaration(
  callee: ts.Expression,
  checker: ts.TypeChecker,
): ts.Declaration | undefined {
  const symbol = checker.getSymbolAtLocation(callee);
  if (!symbol) return undefined;
  const resolved =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  return resolved.declarations?.[0];
}

/** A `Node` tree's type, structurally: carries `meta` (every `Node` does —
 * the same discriminator `forEachTreeCandidate` uses, tree.ts) and carries no
 * `methods` property (an already-projected HTTP tree does — that's the one
 * property that tells the two apart at the type level, and this package can't
 * import `HttpRoute` to check nominally). */
function isNodeType(type: ts.Type, checker: ts.TypeChecker): boolean {
  return (
    checker.getPropertyOfType(type, "meta") !== undefined &&
    checker.getPropertyOfType(type, "methods") === undefined
  );
}

/** The declaration an identifier ultimately binds to, with any import alias
 * resolved through — an imported binding's own symbol declares only the
 * `ImportSpecifier` in the importing file, which would make a cross-file
 * declaration look local. Resolving the alias is what lets the cross-file
 * case below report the file the value actually comes from. */
function declarationOfIdentifier(
  id: ts.Identifier,
  checker: ts.TypeChecker,
): ts.Declaration | undefined {
  const symbol = checker.getSymbolAtLocation(id);
  if (!symbol) return undefined;
  const resolved =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  return resolved.declarations?.[0] ?? symbol.declarations?.[0];
}

function describeLocation(node: ts.Node): string {
  const source = node.getSourceFile();
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart());
  return `${source.fileName}:${line + 1}:${character + 1}`;
}

/**
 * Trace an `applyValidation` call's second argument back to the underlying
 * `api()`-produced `Node` tree, returning its resolved type.
 *
 * Three forms are traced, in this order:
 *   1. the expression's own type is already `Node`-shaped — `applyValidation
 *      ("books", apiTree)` where `apiTree` is an identifier the checker
 *      resolves on its own, or `applyValidation("books", api({...}))` inline;
 *   2. an identifier bound in this file — followed to its declaration's
 *      initializer and retried (this is what makes `const routes =
 *      httpProjection(apiTree)` traceable through `routes`);
 *   3. a wrapping call — `httpProjection(apiTree)`, `composeTransforms(...)
 *      (apiTree)`, any one-level wrapper — unwrapped by scanning its
 *      arguments for the first `Node`-typed one.
 *
 * Anything else, including an identifier declared in a different file, throws,
 * naming the location and the reason. Cross-file tracing is out of this
 * phase's scope.
 */
function traceNodeType(expr: ts.Expression, checker: ts.TypeChecker, keyLabel: string): ts.Type {
  const entryFile = expr.getSourceFile().fileName;
  const seen = new Set<ts.Node>();

  const trace = (current: ts.Expression): ts.Type => {
    if (seen.has(current)) {
      throw new Error(
        `applyValidation codegen: cyclic tree expression for key ${keyLabel} at ${describeLocation(current)}`,
      );
    }
    seen.add(current);

    const ownType = checker.getTypeAtLocation(current);
    if (isNodeType(ownType, checker)) return ownType;

    if (ts.isIdentifier(current)) {
      const decl = declarationOfIdentifier(current, checker);
      if (!decl) {
        throw new Error(
          `applyValidation codegen: cannot resolve tree expression ${JSON.stringify(current.text)} ` +
            `for key ${keyLabel} at ${describeLocation(current)}`,
        );
      }
      if (decl.getSourceFile().fileName !== entryFile) {
        throw new Error(
          `applyValidation codegen: the tree passed for key ${keyLabel} at ${describeLocation(current)} ` +
            `is declared in another file (${decl.getSourceFile().fileName}). Cross-file tracing isn't ` +
            `supported yet — declare the tree (or its projection) in the entry file, or call ` +
            `applyValidation in the file that declares it.`,
        );
      }
      if (ts.isVariableDeclaration(decl) && decl.initializer) return trace(decl.initializer);
      throw new Error(
        `applyValidation codegen: the tree passed for key ${keyLabel} at ${describeLocation(current)} ` +
          `resolves to a declaration this codegen can't trace (${ts.SyntaxKind[decl.kind]}).`,
      );
    }

    if (ts.isCallExpression(current)) {
      for (const arg of current.arguments) {
        if (isNodeType(checker.getTypeAtLocation(arg), checker))
          return checker.getTypeAtLocation(arg);
        if (ts.isIdentifier(arg)) {
          // An identifier argument may itself need one hop (a local `const`
          // holding the tree) before its Node-ness is visible.
          const decl = declarationOfIdentifier(arg, checker);
          if (
            decl &&
            decl.getSourceFile().fileName === entryFile &&
            ts.isVariableDeclaration(decl) &&
            decl.initializer &&
            isNodeType(checker.getTypeAtLocation(decl.initializer), checker)
          ) {
            return checker.getTypeAtLocation(decl.initializer);
          }
        }
      }
      throw new Error(
        `applyValidation codegen: the call wrapping the tree for key ${keyLabel} at ` +
          `${describeLocation(current)} has no Node-typed argument to unwrap.`,
      );
    }

    if (ts.isParenthesizedExpression(current)) return trace(current.expression);

    throw new Error(
      `applyValidation codegen: cannot trace the tree expression for key ${keyLabel} at ` +
        `${describeLocation(current)} back to an api() Node tree.`,
    );
  };

  return trace(expr);
}

/**
 * Every `applyValidation(key, treeExpr)` call site in `source`, with each
 * call's tree traced to its `Node` type.
 *
 * Throws on a non-literal `key` (nothing can be generated for a key that
 * isn't known statically), on a missing tree argument, and on a duplicate key
 * across two call sites in the same entry file — each call site must claim
 * its own key. (The runtime's own duplicate-key guard, apply-validation.ts,
 * catches the same case later, at the second call.)
 */
export function findApplyValidationCallSites(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): ApplyValidationCallSite[] {
  const sites: ApplyValidationCallSite[] = [];
  const keyLocations = new Map<string, string>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isApplyValidationCallee(node.expression, checker)) {
      const [keyArg, treeArg, protocolArg] = node.arguments;
      const where = describeLocation(node);
      if (keyArg === undefined || !ts.isStringLiteralLike(keyArg)) {
        const decl = calleeDeclaration(node.expression, checker);
        throw new Error(
          `applyValidation codegen: the key argument at ${where} is not a string literal ` +
            `(callee declared at ${decl ? describeLocation(decl) : "unknown"}). Codegen can only ` +
            `generate validators for statically-known keys.`,
        );
      }
      const key = keyArg.text;
      const previous = keyLocations.get(key);
      if (previous !== undefined) {
        throw new Error(
          `applyValidation codegen: duplicate key ${JSON.stringify(key)} — used at ${previous} and ` +
            `again at ${where}. Each call site must claim its own key.`,
        );
      }
      if (treeArg === undefined) {
        throw new Error(
          `applyValidation codegen: missing tree argument for key ${JSON.stringify(key)} at ${where}`,
        );
      }
      let protocol: ProtocolName | undefined;
      if (protocolArg !== undefined) {
        if (!ts.isStringLiteralLike(protocolArg) || !isProtocolName(protocolArg.text)) {
          throw new Error(
            `applyValidation codegen: the protocol argument at ${where} is not a recognized string literal ` +
              `(expected one of ${[...PROTOCOL_NAMES].map((p) => JSON.stringify(p)).join(", ")}). Codegen can ` +
              `only generate per-protocol validators for statically-known protocol names.`,
          );
        }
        protocol = protocolArg.text;
      }
      keyLocations.set(key, where);
      sites.push({
        key,
        nodeType: traceNodeType(treeArg, checker, JSON.stringify(key)),
        loc: treeArg,
        ...(protocol !== undefined ? { protocol } : {}),
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return sites;
}

function loadSource(entryFile: string, program: ts.Program): ts.SourceFile {
  const source = program.getSourceFile(entryFile);
  if (!source) throw new Error(`applyValidation codegen: source not found: ${entryFile}`);
  return source;
}

const runtimeImportLine = (runtimeImport: string): string =>
  `import { createApplyValidation } from ${JSON.stringify(runtimeImport)}\n`;

/**
 * The pre-codegen stub module: a pass-through `applyValidation` over an empty
 * map, so a freshly scaffolded project compiles and runs before codegen has
 * ever produced validators — the consumer's single
 * `import { applyValidation } from "./generated"` resolves from the first
 * commit onward.
 *
 * An actual emitted stub, rather than an omittable option: a call site names
 * its key unconditionally, with no option to skip passing validators. The
 * stub is permissive by construction and silent about it; coverage is
 * enforced elsewhere, by codegen and by `assertValidationCoverage`
 * (apply-validation.ts).
 */
export function applyValidationStubSource(options?: { readonly runtimeImport?: string }): string {
  const runtimeImport = options?.runtimeImport ?? DEFAULT_RUNTIME_IMPORT;
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
  ].join("\n");
}

/**
 * Turn an extracted type's absolute `declarationFile` into the `import type`
 * specifier the generated module at `outFile` should use — same convention
 * (relative, POSIX separators, `.ts` extension kept) as build.ts's own
 * `relativeImportSpecifier`.
 */
function relativeImportSpecifier(outFile: string, declarationFile: string): string {
  const rel = path.relative(path.dirname(outFile), declarationFile).split(path.sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

// ============================================================================
// Wire-profile build path — the sole `applyValidation` codegen pipeline:
// every 3-arg call site, plus every 2-arg call site treated as sugar for
// protocol `"identity"` — see `extractWireApplyValidationTypeRefs`'s doc
// comment below.
//
// `meta.<proto>.encodingMap` entries take one of two authored shapes (see
// docs/design/wire-profiles-and-staged-validation.md's "Static-meta-read
// investigation" section): a base-profile-name string (`"identity" | "json" |
// "query" | "argv"`) or a custom decoder function (`(w: FieldValidWire) =>
// TField`).
//
// The string form is read the same way `walkNodeType`'s existing
// `mcpMetaOverride` (tree.ts) already reads other scalar meta literals off a
// resolved `Node` type — not just a type shape, an actual authored value
// (`meta.mcp.name`), via
// `checker.getPropertyOfType`/`getTypeOfSymbolAtLocation`/`isStringLiteral()`.
// `meta.http.method`/`meta.http.verb` (flat scalars) and `meta.<proto>.
// sourceMap` (a map of per-field `{ store, key? }` literals — one level
// deeper, enumerated via `getPropertiesOfType`, the same enumeration
// `walkNodeType` uses for `children`) generalize the identical technique —
// see `readMetaStringLiteral`/`readMetaSourceMap` (tree.ts). The
// `encodingMap` string form reads exactly like a `sourceMap` entry's `store`
// (`readMetaEncodingMapProfileNames`, tree.ts) — wired in below.
//
// The function form has no analogous read path: a function value has no
// literal type for the checker to hand back (unlike a string), so there's
// nothing to read "as a value." It doesn't need one — the function never
// moves through codegen at all (no inlining, no source re-emission, no
// cross-file import); it stays exactly where it was authored, an ordinary
// runtime value on the tree's own `meta`, read at wrap time (not codegen
// time) by `apply-validation.ts`'s `createApplyValidation`. What codegen
// genuinely needs statically is narrower than "the function's value": just
// which field names have one, so the generated fragment can emit a hook
// call-site for that field instead of its fused default decode. That's
// answerable from the type alone — a function value's type still carries a
// call signature, even with no literal payload
// (`readMetaEncodingMapFunctionFields`, tree.ts, via
// `checker.getSignaturesOfType(fieldType, ts.SignatureKind.Call)`). See
// `compileWireLeafFragment`'s call below for how the resulting field-name set
// threads into `compileWireEntryFragmentComposite`'s `hookFields` parameter,
// and docs/design/wire-profiles-and-staged-validation.md's "Implementation
// trace (phase E)" section for the full mechanism writeup (runtime hook
// injection, the `"decode"` error kind, the wrap-time stale-module checks).
// ============================================================================

/** The base profile a `meta.<proto>.encodingMap` entry's string form names —
 * see `readMetaEncodingMapProfileNames` (tree.ts) for what this doesn't cover
 * (a function-valued entry; the documented gap above). */
const BASE_PROFILE_BY_NAME: Readonly<Record<string, WireProfile>> = {
  identity: identityProfile,
  json: jsonProfile,
  query: queryProfile,
  argv: argvProfile,
};

/** One 3-arg call site's leaf: its input `TypeRef`, the derived wire profile
 * assignment (`wire-derive.ts`), and — http/cli only, see this section's
 * header comment — the field names whose `encodingMap` entry is a custom
 * decoder function rather than a base-profile-name string, sorted for
 * deterministic fingerprinting. Empty (never `undefined`) for every
 * uniform-profile protocol (`identity`/`mcp`/`graphql`/`jsonrpc`), matching
 * the same scope cut the string form already makes (see
 * `readMetaEncodingMapProfileNames`'s doc comment). */
export type WireApplyValidationLeaf = {
  readonly ref: TypeRef;
  readonly derivation: FieldProfileDerivation;
  readonly hookFields: readonly string[];
};

/** Per-key wire-profile leaves — one `protocol` per key (a call site names
 * exactly one — an omitted third argument resolves to `"identity"`, see
 * `extractWireApplyValidationTypeRefs`'s doc comment), each key's leaves
 * keyed by tree-relative path. */
export type WireApplyValidationTypeRefs = {
  readonly byKey: Readonly<
    Record<
      string,
      {
        readonly protocol: ProtocolName;
        readonly leaves: Readonly<Record<string, WireApplyValidationLeaf>>;
      }
    >
  >;
  /** Shared/recursive `defs` a `shouldShare` extraction produced (empty
   * without it). */
  readonly defs: Record<string, TypeRef>;
};

/**
 * Extract every `applyValidation(key, treeExpr, protocol?)` call site's
 * leaves from `entryFile`, deriving each leaf's wire-profile assignment along
 * the way — `identity`/`mcp`/`graphql`/`jsonrpc` need no meta read at all
 * (`deriveFieldProfiles` returns a uniform base profile unconditionally for
 * those); `http`/`cli` read that leaf's own `meta.<proto>.sourceMap` (and, for
 * `http`, `meta.http.method`/`.verb`) via the generalized `mcpMetaOverride`
 * technique (`readMetaSourceMap`/`readMetaStringLiteral`, tree.ts), plus this
 * leaf's own tree-relative path's `:name` fallback segments as its path-param
 * name set (already exactly what `leafPath` carries — no extra read needed).
 *
 * A call site whose literal third argument is absent
 * (`site.protocol === undefined`) is treated as `protocol = "identity"` —
 * every `applyValidation` call site is extracted here, whether or not its
 * source spells a protocol. This is what lets `apply-validation.ts`'s
 * `createApplyValidation` resolve a 2-arg call against real generated
 * coverage through the same pipeline a 3-arg call uses — see that runtime's
 * `resolveForKey` doc comment for the matching runtime-side half of this.
 * `identity` needs no meta read (same branch as mcp/graphql/jsonrpc below),
 * so this costs nothing extra for a 2-arg site.
 *
 * `encodingMap`'s string-form entries (base-profile-name overrides) are read
 * and applied on top for `http`/`cli`. Function-form entries are detected
 * (existence only, per `readMetaEncodingMapFunctionFields`'s doc comment —
 * see this section's header comment for the full resolution) and threaded
 * into each leaf's own `hookFields`, consumed by `compileWireLeafFragment`.
 *
 * `options.shouldShare` opts into structural sharing: a `SharingRegistry`,
 * `finalizeSharedDefs` over the flattened `(key, leafPath)` roots, and the
 * resulting `defs` threaded into the returned `WireApplyValidationTypeRefs`.
 * Without it, `defs` is empty and every leaf's `ref` is exactly what this
 * function always produced.
 */
export function extractWireApplyValidationTypeRefs(
  entryFile: string,
  options?: { readonly program?: ts.Program; readonly shouldShare?: ShouldShare },
): WireApplyValidationTypeRefs {
  const program = options?.program ?? createExtractorProgram(entryFile);
  const checker = program.getTypeChecker();
  const source = loadSource(entryFile, program);
  const registry = options?.shouldShare ? createSharingRegistry() : undefined;

  const byKey: Record<
    string,
    { protocol: ProtocolName; leaves: Record<string, WireApplyValidationLeaf> }
  > = {};
  for (const site of findApplyValidationCallSites(source, checker)) {
    const protocol = site.protocol ?? "identity";
    const leaves: Record<string, WireApplyValidationLeaf> = {};
    walkNodeType(
      site.nodeType,
      "",
      [],
      site.loc,
      checker,
      (_name, leafPath, fn, _descriptionSource, leafChecker, nodeType) => {
        const ref = typeRefFromFunctionNode(fn, leafChecker, registry);
        const pathParamNames = leafPath
          .filter((seg) => seg.startsWith(":"))
          .map((seg) => seg.slice(1));
        let derivation: FieldProfileDerivation;
        let hookFields: readonly string[] = [];
        if (protocol === "http" || protocol === "cli") {
          const sourceMap = readMetaSourceMap(nodeType, protocol, site.loc, leafChecker);
          const method =
            protocol === "http"
              ? (readMetaStringLiteral(nodeType, "http", "method", site.loc, leafChecker) ??
                readMetaStringLiteral(nodeType, "http", "verb", site.loc, leafChecker))
              : undefined;
          derivation = deriveFieldProfiles(protocol, sourceMap, method, pathParamNames);
          const encodingMap = readMetaEncodingMapProfileNames(
            nodeType,
            protocol,
            site.loc,
            leafChecker,
          );
          if (encodingMap !== undefined && "fieldProfiles" in derivation) {
            const fieldProfiles = { ...derivation.fieldProfiles };
            for (const [field, baseName] of Object.entries(encodingMap)) {
              const base = BASE_PROFILE_BY_NAME[baseName];
              if (base !== undefined) fieldProfiles[field] = base;
            }
            derivation = { fieldProfiles, defaultProfile: derivation.defaultProfile };
          }
          const functionFields = readMetaEncodingMapFunctionFields(
            nodeType,
            protocol,
            site.loc,
            leafChecker,
          );
          if (functionFields !== undefined && functionFields.size > 0)
            hookFields = [...functionFields].sort();
        } else {
          derivation = deriveFieldProfiles(protocol, undefined, undefined, []);
        }
        leaves[leafPath.join("/")] = { ref, derivation, hookFields };
      },
    );
    byKey[site.key] = { protocol, leaves };
  }

  if (!options?.shouldShare || !registry) return { byKey, defs: {} };

  // Flatten -> finalizeSharedDefs -> reassemble, over this path's single
  // `ref` per leaf (this path never carried a separate output ref or
  // description — see this function's own doc comment for why).
  const flatRoots: Record<string, TypeRef> = {};
  for (const [key, { leaves }] of Object.entries(byKey)) {
    for (const [leafPath, leaf] of Object.entries(leaves)) {
      flatRoots[flatName(key, leafPath)] = leaf.ref;
    }
  }
  const { roots, defs } = finalizeSharedDefs(registry, flatRoots, options.shouldShare);
  const shared: Record<
    string,
    { protocol: ProtocolName; leaves: Record<string, WireApplyValidationLeaf> }
  > = {};
  for (const [key, { protocol, leaves }] of Object.entries(byKey)) {
    const rebuilt: Record<string, WireApplyValidationLeaf> = {};
    for (const [leafPath, leaf] of Object.entries(leaves)) {
      rebuilt[leafPath] = {
        ref: roots[flatName(key, leafPath)]!,
        derivation: leaf.derivation,
        hookFields: leaf.hookFields,
      };
    }
    shared[key] = { protocol, leaves: rebuilt };
  }
  return { byKey: shared, defs };
}

/** Flat compiler entries (one per leaf across all call sites), keyed by
 * `flatName(key, leafPath)` — each entry additionally carries its own
 * `protocol`, derived `FieldProfileDerivation`, and `hookFields` (function-
 * form `encodingMap` field names, empty for every uniform-profile
 * protocol). */
function flatWireEntries(byKey: WireApplyValidationTypeRefs["byKey"]): {
  name: string;
  ref: TypeRef;
  protocol: ProtocolName;
  derivation: FieldProfileDerivation;
  hookFields: readonly string[];
}[] {
  const entries: {
    name: string;
    ref: TypeRef;
    protocol: ProtocolName;
    derivation: FieldProfileDerivation;
    hookFields: readonly string[];
  }[] = [];
  for (const [key, { protocol, leaves }] of Object.entries(byKey)) {
    for (const [leafPath, leaf] of Object.entries(leaves)) {
      entries.push({
        name: flatName(key, leafPath),
        ref: leaf.ref,
        protocol,
        derivation: leaf.derivation,
        hookFields: leaf.hookFields,
      });
    }
  }
  return entries;
}

/** Compile one leaf's `CompiledWireEntryFragment` — the uniform-profile case
 * (`{ profile }`) goes through `compileWireEntryFragment` directly (hooks are
 * out of scope for a uniform protocol — the same scope cut the string form
 * already makes, see this section's header comment); the composite case
 * (`{ fieldProfiles, defaultProfile }`) goes through
 * `compileWireEntryFragmentComposite`, threading `hookFields` through so a
 * function-form `encodingMap` field gets a hook call-site instead of its
 * fused default decode. Neither branch is duplicated here — this is just the
 * `FieldProfileDerivation`-shaped dispatch between the two. */
function compileWireLeafFragment(
  ref: TypeRef,
  derivation: FieldProfileDerivation,
  constraintsFnName: string,
  resolveImport?: (declarationFile: string) => string,
  registry?: WireDefsRegistry,
  hookFields: readonly string[] = [],
): CompiledWireEntryFragment {
  if ("profile" in derivation) {
    return compileWireEntryFragment(
      ref,
      derivation.profile,
      constraintsFnName,
      resolveImport,
      registry,
    );
  }
  return compileWireEntryFragmentComposite(
    ref,
    derivation.fieldProfiles,
    derivation.defaultProfile,
    constraintsFnName,
    resolveImport,
    registry,
    new Set(hookFields),
  );
}

function indentGenerated(lines: readonly string[], spaces: number): string[] {
  const pad = " ".repeat(spaces);
  return lines.map((line) => (line.length === 0 ? line : pad + line));
}

/**
 * `assembleWireModule`'s (type-ir) sibling for this file's shape: each entry
 * has exactly one protocol (a call site names exactly one), not a uniform
 * profile set shared across every entry the way `assembleWireModule` assumes
 * — so this reassembles from already-compiled fragments directly rather than
 * reusing that function. `wireFragments` is keyed by
 * `wireValidatorKey(name, protocol)`, same convention.
 *
 * `defsBlockLines`/`wireDefsLines` (default `[]`) mirror `assembleWireModule`'s
 * own two params — the constraints layer's shared `__def_NAME_*` block
 * (`compileDefsBlock`) and the decode layer's `WireDefsRegistry.moduleLines()`,
 * spliced once at module scope regardless of how many entries/protocols
 * reference them.
 */
function assembleWireApplyValidationModule(
  entries: readonly { readonly name: string; readonly protocol: ProtocolName }[],
  constraintsFns: Readonly<Record<string, CompiledConstraintsFn>>,
  wireFragments: Readonly<Record<string, CompiledWireEntryFragment>>,
  defsBlockLines: readonly string[] = [],
  wireDefsLines: readonly string[] = [],
): string {
  const imports = new Map<string, Set<string>>();
  imports.set("@rhi-zone/fractal-type-ir", new Set(["ValidationError"]));

  const constraintsLines: string[] = [];
  entries.forEach(({ name }) => {
    const fn = constraintsFns[name];
    if (!fn)
      throw new Error(
        `buildWireApplyValidationModuleSource: missing constraints fn for entry ${JSON.stringify(name)}`,
      );
    constraintsLines.push(...fn.lines);
  });

  const entryLines: string[] = [];
  for (const { name, protocol } of entries) {
    const key = wireValidatorKey(name, protocol);
    const frag = wireFragments[key];
    if (!frag)
      throw new Error(
        `buildWireApplyValidationModuleSource: missing wire fragment for ${JSON.stringify(key)}`,
      );
    if (frag.typeImport) {
      const names = imports.get(frag.typeImport.from) ?? new Set<string>();
      names.add(frag.typeImport.typeName);
      imports.set(frag.typeImport.from, names);
    }
    const codeLines = frag.code.split("\n");
    entryLines.push(
      `  ${JSON.stringify(key)}: ${codeLines[0]}`,
      ...indentGenerated(codeLines.slice(1, -1), 2),
      `  ${codeLines[codeLines.length - 1]},`,
    );
  }

  const lines: string[] = [];
  lines.push(
    "// AUTO-GENERATED by @rhi-zone/fractal-api-tree (wire-profile path). Do not edit by hand.",
  );
  lines.push("");
  for (const [from, names] of imports) {
    lines.push(`import type { ${[...names].sort().join(", ")} } from ${JSON.stringify(from)}`);
  }
  if (imports.size > 0) lines.push("");
  lines.push(INFER_TYPE_REF_SOURCE);
  lines.push("");
  lines.push(...defsBlockLines);
  if (defsBlockLines.length > 0) lines.push("");
  lines.push(...wireDefsLines);
  if (wireDefsLines.length > 0) lines.push("");
  lines.push(...constraintsLines);
  if (constraintsLines.length > 0) lines.push("");
  lines.push("export const wireValidators = {");
  lines.push(...entryLines);
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/**
 * The tail appended to the compiled wire module: regroup the flat
 * `wireValidators` record into the nested `Record<key, Record<path,
 * Partial<Record<protocol, entry>>>>` `createApplyValidation`'s second
 * argument wants, and export a standalone `applyValidation`.
 *
 * Every `applyValidation` call site in an entry file — 2-arg or 3-arg —
 * lands in this one module's `wireValidatorsByKey`, so a consumer normally
 * just imports the exported `applyValidation` directly. A consumer that also
 * has a hand-authored `ValidatorMap` (a `createApplyValidation` built from a
 * map without codegen, independent of this file entirely) composes the two
 * manually: `createApplyValidation(handAuthoredValidators, wireValidatorsByKey)`.
 */
function composeWireApplyValidationTail(byKey: WireApplyValidationTypeRefs["byKey"]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("/** Generated wire validators, grouped by (key, tree-relative path, protocol). */");
  lines.push("export const wireValidatorsByKey = {");
  for (const [key, { protocol, leaves }] of Object.entries(byKey)) {
    lines.push(`  ${JSON.stringify(key)}: {`);
    for (const leafPath of Object.keys(leaves)) {
      const entryRef = wireValidatorKey(flatName(key, leafPath), protocol);
      lines.push(
        `    ${JSON.stringify(leafPath)}: { ${JSON.stringify(protocol)}: wireValidators[${JSON.stringify(entryRef)}] },`,
      );
    }
    lines.push("  },");
  }
  lines.push("}");
  lines.push("");
  lines.push("/** Pass this as `createApplyValidation`'s SECOND argument. */");
  lines.push("export const applyValidation = createApplyValidation({}, wireValidatorsByKey)");
  lines.push("");
  return lines.join("\n");
}

export type WireApplyValidationBuildOptions = {
  readonly outFile?: string;
  readonly program?: ts.Program;
  readonly runtimeImport?: string;
  readonly shouldShare?: ShouldShare;
};

/**
 * Build the complete wire-profile `applyValidation` module source for
 * `entryFile` — every 3-arg call site's leaves compiled via
 * `compileWireLeafFragment`/`compileConstraintsFn`, assembled by
 * `assembleWireApplyValidationModule`, followed by the nested regrouping and
 * `createApplyValidation` composition (`composeWireApplyValidationTail`).
 *
 * An entry file with no `applyValidation` call sites at all yields the stub
 * module (`applyValidationStubSource`) — nothing to generate, and a
 * consumer's import must still resolve.
 */
export function buildWireApplyValidationModuleSource(
  entryFile: string,
  options?: WireApplyValidationBuildOptions,
): string {
  const { byKey, defs } = extractWireApplyValidationTypeRefs(entryFile, {
    ...(options?.program !== undefined ? { program: options.program } : {}),
    ...(options?.shouldShare !== undefined ? { shouldShare: options.shouldShare } : {}),
  });
  const runtimeImport = options?.runtimeImport ?? DEFAULT_RUNTIME_IMPORT;
  const entries = flatWireEntries(byKey);
  if (entries.length === 0) {
    const stubOpt =
      options?.runtimeImport !== undefined ? { runtimeImport: options.runtimeImport } : {};
    return applyValidationStubSource(stubOpt);
  }
  const outFile = options?.outFile;
  const resolveImport =
    outFile === undefined
      ? undefined
      : (declarationFile: string) => relativeImportSpecifier(outFile, declarationFile);

  const defsBlock = compileDefsBlock(defs);
  const registry = createWireDefsRegistry(defs);
  const constraintsFns: Record<string, CompiledConstraintsFn> = {};
  const wireFragments: Record<string, CompiledWireEntryFragment> = {};
  for (const { name, ref, protocol, derivation, hookFields } of entries) {
    constraintsFns[name] = compileConstraintsFn(name, ref, defsBlock.defNames);
    wireFragments[wireValidatorKey(name, protocol)] = compileWireLeafFragment(
      ref,
      derivation,
      constraintsFns[name].fnName,
      resolveImport,
      registry,
      hookFields,
    );
  }
  return (
    runtimeImportLine(runtimeImport) +
    assembleWireApplyValidationModule(
      entries,
      constraintsFns,
      wireFragments,
      defsBlock.lines,
      registry.moduleLines(),
    ) +
    composeWireApplyValidationTail(byKey)
  );
}

/** JSON-serializable fingerprint input for one leaf's derivation — profile
 * names, not the `WireProfile` objects themselves. (A `WireProfile`'s
 * `leafHandlers` values are functions, which `JSON.stringify` silently drops;
 * fingerprinting on the profile name is the direct route to a stable
 * fingerprint, per `computeLeafFingerprint`'s doc comment (cache.ts): "just
 * pass `{ input: ref, profile: profileName }`".) `hookFields`
 * folds in separately (see this function's caller) rather than here, since
 * it's orthogonal to which profile a field resolves to — a field can flip
 * between fused and hook-covered without its profile assignment changing at
 * all, and that flip alone must still invalidate the leaf's cached artifact
 * (a fused fragment and a hook fragment for the same field/profile emit
 * different code). */
function fingerprintableDerivation(derivation: FieldProfileDerivation): unknown {
  if ("profile" in derivation) return { profile: derivation.profile.name };
  return {
    defaultProfile: derivation.defaultProfile.name,
    fieldProfiles: Object.fromEntries(
      Object.entries(derivation.fieldProfiles).map(([field, p]) => [field, p.name]),
    ),
  };
}

export type WireApplyValidationIncrementalResult = {
  readonly source: string;
  readonly leafFingerprints: Record<string, string>;
  readonly leafArtifacts: Record<string, CompiledWireEntryFragment>;
  readonly defNamesFingerprint: string;
  /** Flat `(leafName, protocol)` keys (via `wireValidatorKey`) actually
   * recompiled this run — everything else was carried forward. */
  readonly changedLeaves: readonly string[];
};

/** Prior Tier-2 state for one wire-path entry. `defNamesFingerprint` tracks
 * whether the def-name set changed: a leaf's carry-forward reuse must check
 * that fingerprint too, since a `ref`'s generated code (both layers — the
 * constraints fn's `ctx.defNames`-gated call, and the decode fn's
 * `WireDefsRegistry` lookup) depends on which def names are callable, not
 * just the leaf's own IR fingerprint. */
export type WireApplyValidationCarryForwardState = {
  readonly leafFingerprints: Readonly<Record<string, string>>;
  readonly leafArtifacts: Readonly<Record<string, unknown>>;
  readonly defNamesFingerprint: string;
};

function isCompiledWireFragment(value: unknown): value is CompiledWireEntryFragment {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { wireType?: unknown }).wireType === "string"
  );
}

/**
 * `buildWireApplyValidationModuleSource`'s Tier-2 sibling — identical
 * extraction/derivation and identical codegen, except a leaf whose
 * `(input ref, protocol, derivation)` fingerprint matches
 * `prior.leafFingerprints` reuses `prior.leafArtifacts`'s fragment verbatim
 * instead of recompiling. Keyed by `wireValidatorKey(name, protocol)` instead
 * of bare `name`, so the fingerprint/artifact keys fold `protocol` in — the
 * profile identity is already folded into the fingerprint for free.
 */
export function buildWireApplyValidationModuleSourceIncremental(
  entryFile: string,
  options: WireApplyValidationBuildOptions & {
    readonly prior?: WireApplyValidationCarryForwardState;
  },
): WireApplyValidationIncrementalResult {
  const { byKey, defs } = extractWireApplyValidationTypeRefs(entryFile, {
    ...(options.program !== undefined ? { program: options.program } : {}),
    ...(options.shouldShare !== undefined ? { shouldShare: options.shouldShare } : {}),
  });
  const runtimeImport = options.runtimeImport ?? DEFAULT_RUNTIME_IMPORT;
  const outFile = options.outFile;
  const resolveImport =
    outFile === undefined
      ? undefined
      : (declarationFile: string) => relativeImportSpecifier(outFile, declarationFile);

  const defsBlock = compileDefsBlock(defs);
  const registry = createWireDefsRegistry(defs);
  const defNamesFingerprint = computeDefNamesFingerprint(defsBlock.defNames);
  const prior = options.prior;
  const defNamesUnchanged =
    prior !== undefined && prior.defNamesFingerprint === defNamesFingerprint;

  const entries = flatWireEntries(byKey);
  const leafFingerprints: Record<string, string> = {};
  const leafArtifacts: Record<string, CompiledWireEntryFragment> = {};
  const constraintsFns: Record<string, CompiledConstraintsFn> = {};
  const changedLeaves: string[] = [];

  for (const { name, ref, protocol, derivation, hookFields } of entries) {
    const fingerprintKey = wireValidatorKey(name, protocol);
    const fingerprint = computeLeafFingerprint(entryFile, {
      input: ref,
      protocol,
      derivation: fingerprintableDerivation(derivation),
      hookFields,
    });
    leafFingerprints[fingerprintKey] = fingerprint;
    constraintsFns[name] = compileConstraintsFn(name, ref, defsBlock.defNames);
    const priorArtifact = prior?.leafArtifacts[fingerprintKey];
    const reusable =
      defNamesUnchanged &&
      prior !== undefined &&
      prior.leafFingerprints[fingerprintKey] === fingerprint &&
      isCompiledWireFragment(priorArtifact);
    if (reusable && isCompiledWireFragment(priorArtifact)) {
      leafArtifacts[fingerprintKey] = priorArtifact;
    } else {
      leafArtifacts[fingerprintKey] = compileWireLeafFragment(
        ref,
        derivation,
        constraintsFns[name].fnName,
        resolveImport,
        registry,
        hookFields,
      );
      changedLeaves.push(fingerprintKey);
    }
  }

  const source =
    entries.length === 0
      ? applyValidationStubSource({ runtimeImport })
      : runtimeImportLine(runtimeImport) +
        assembleWireApplyValidationModule(
          entries,
          constraintsFns,
          leafArtifacts,
          defsBlock.lines,
          registry.moduleLines(),
        ) +
        composeWireApplyValidationTail(byKey);

  return { source, leafFingerprints, leafArtifacts, defNamesFingerprint, changedLeaves };
}

/**
 * `buildWireApplyValidationModuleSource`, cached — Tier 1 (cache.ts's
 * `checkCache`) gates whether a `ts.Program` gets built at all; on a Tier-1
 * miss, `buildWireApplyValidationModuleSourceIncremental` (Tier 2) recompiles
 * only the leaves whose fingerprint actually changed, including the
 * def-name-set fingerprint (see `WireApplyValidationCarryForwardState`'s doc
 * comment for why a leaf's carry-forward reuse depends on it too).
 */
export function buildWireApplyValidationModuleCached(
  entryFile: string,
  outFile: string,
  options?: {
    readonly program?: ts.Program;
    readonly runtimeImport?: string;
    readonly force?: boolean;
    readonly reachable?: ReadonlySet<string>;
    readonly shouldShare?: ShouldShare;
  } & CacheLocationOptions,
): CachedBuildOutcome<string> {
  if (!options?.force) {
    const check = checkCache(entryFile, outFile, options);
    if (check.hit) return { status: "hit" };
  }
  const program = options?.program ?? createExtractorProgram(entryFile);
  const priorRaw = readCarryForwardState(entryFile, outFile, options);
  const prior: WireApplyValidationCarryForwardState | undefined =
    priorRaw === undefined
      ? undefined
      : {
          leafFingerprints: priorRaw.leafFingerprints,
          leafArtifacts: priorRaw.leafArtifacts,
          defNamesFingerprint: priorRaw.defNamesFingerprint,
        };
  const built = buildWireApplyValidationModuleSourceIncremental(entryFile, {
    outFile,
    program,
    ...(options?.runtimeImport !== undefined ? { runtimeImport: options.runtimeImport } : {}),
    ...(options?.shouldShare !== undefined ? { shouldShare: options.shouldShare } : {}),
    ...(prior !== undefined ? { prior } : {}),
  });
  writeCacheMetadata(entryFile, outFile, program, built.source, options, options?.reachable, {
    leafFingerprints: built.leafFingerprints,
    leafArtifacts: built.leafArtifacts,
    defNamesFingerprint: built.defNamesFingerprint,
  });
  return { status: "built", result: built.source, program };
}

/**
 * `buildWireApplyValidationModuleCached`, writing the result to `outFile`
 * when it actually built something (a cache hit writes nothing).
 */
export async function writeWireApplyValidationModuleCached(
  entryFile: string,
  outFile: string,
  options?: {
    readonly program?: ts.Program;
    readonly runtimeImport?: string;
    readonly force?: boolean;
    readonly reachable?: ReadonlySet<string>;
    readonly shouldShare?: ShouldShare;
  } & CacheLocationOptions,
): Promise<CachedBuildOutcome<string>> {
  const outcome = buildWireApplyValidationModuleCached(entryFile, outFile, options);
  if (outcome.status === "built") await Bun.write(outFile, outcome.result);
  return outcome;
}
