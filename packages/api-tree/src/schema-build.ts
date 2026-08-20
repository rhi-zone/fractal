// The schema-artifact build orchestrator: emits a standalone TS module that
// exports the `SchemaMap` `extractToolSchemas` (tree.ts) produces — one per
// entry file, with the same conventions (generated-file header, `--check`
// drift-detection semantics, cache behavior) as the wire-validator module,
// so the two artifacts never diverge into separately-maintained codegen
// paths.
//
// Why a separate artifact from the validator module, not folded into it: the
// validator-module compilers (type-ir's `compileWireEntryFragment`/
// `compileConstraintsFn`) emit compiled functions (`check`/`errors`/`parse`)
// derived from each leaf's TypeRef — those need zero runtime dependencies,
// which is exactly the point. A `SchemaMap` is plain JSON-Schema data (no
// functions to compile), consumed by `toOpenApi`'s `schemas` option
// (http-api-projector/openapi.ts) to avoid paying `extractToolSchemas`'s own
// `ts.Program` cost at doc-build/request time. Emitting it as its own
// generated module, rather than adding a second export to the validator
// module, keeps each artifact's consumer importing only what it needs (a
// validator-wiring call site never needs JSON-Schema data; an OpenAPI-doc
// build never needs compiled validators), and keeps `--check` drift
// detection scoped: a change that only affects schema shape (e.g. a JSDoc
// description edit) doesn't need to touch the validator module's generated
// bytes, and vice versa.
//
// Emission format: plain `JSON.stringify(schemas, null, 2)`. A `SchemaMap` is
// exactly the kind of value `JSON.stringify` already renders correctly
// (nested objects/arrays/strings/numbers/booleans, `$comment` punts included
// as regular string values), so the validator compilers' template-per-
// shape-kind codegen machinery has no place here — that machinery exists
// because compiled validator functions need custom control flow per shape;
// a schema is just data.

import * as path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type ts from "typescript";
import { toJsonSchema } from "@rhi-zone/fractal-type-ir/json-schema";
import { createExtractorProgram } from "./extract.ts";
import {
  extractToolSchemas,
  extractToolTypeRefs,
  type SchemaMap,
  type ToolSchema,
  type ToolTypeInfo,
} from "./tree.ts";
import type { JsonSchema } from "./extract.ts";
import {
  checkCache,
  computeLeafFingerprint,
  readCarryForwardState,
  writeCacheMetadata,
  type CacheLocationOptions,
  type CachedBuildOutcome,
} from "./cache.ts";

/**
 * Extract every leaf op's derived JSON-Schema from `entryFile` and render it
 * as a standalone TS module source string: `export const schemas:
 * SchemaMap`. `treeId` (required — same rationale as `extractToolSchemas`'s
 * own mandatory `treeId`, tree.ts) names which of `entryFile`'s exported
 * trees to build the artifact for; a single-tree file passes that tree's
 * sole binding name. `program`, when given, reuses a pre-built `ts.Program`:
 * a caller building both the validator module and the schema artifact for
 * the same batch of entry files shares one Program across both passes,
 * rather than building it twice (once per artifact kind) or twice per
 * entry.
 */
export function buildSchemaModuleSource(
  entryFile: string,
  treeId: string,
  program?: ts.Program,
): string {
  const programOpt = program === undefined ? {} : { program };
  const schemas = extractToolSchemas(entryFile, treeId, programOpt);
  return renderSchemaModule(schemas);
}

/** Render a `SchemaMap` value to TS module source — split out from
 * `buildSchemaModuleSource` so `buildSchemaModuleCached`'s cache-hit path
 * never needs to call it, and so a caller with an already-extracted
 * `SchemaMap` (e.g. reusing one it also fed to `toOpenApi`'s `schemas`
 * option in-process) can render it without re-extracting. */
function renderSchemaModule(schemas: SchemaMap): string {
  const lines = [
    'import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree"',
    "",
    `export const schemas: SchemaMap = ${JSON.stringify(schemas, null, 2)}`,
    "",
  ];
  return lines.join("\n");
}

/** `fs.writeFileSync`-equivalent used throughout this file instead of
 * `Bun.write` — this package is otherwise `node:fs`-based (its own CLI,
 * `apply-validation-build.ts`), and `Bun.write` made these two write helpers
 * the one Bun-only surface in it, unusable from a plain Node consumer (audit
 * §6#6). Creates `outFile`'s parent directory first, matching `Bun.write`'s
 * own auto-mkdir behavior. */
async function writeFileEnsuringDir(outFile: string, content: string): Promise<void> {
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, content);
}

/**
 * Build the schema module for `entryFile`'s `treeId` tree and write it to
 * `outFile`.
 */
export async function writeSchemaModule(
  entryFile: string,
  treeId: string,
  outFile: string,
): Promise<void> {
  await writeFileEnsuringDir(outFile, buildSchemaModuleSource(entryFile, treeId));
}

// Tier 2 — leaf-level incremental build (see docs/design/
// ir-keyed-cache-spec.md). The schema artifact has no `defs`/structural-
// sharing concept at all (`extractToolSchemas` never opts into
// `shouldShare` — see this file's header doc), so its Tier 2 is simpler than
// the validator module's: a leaf's fingerprint alone (no def-name-set half)
// decides carry-forward.

export type SchemaCarryForwardState = {
  readonly leafFingerprints: Readonly<Record<string, string>>;
  readonly leafArtifacts: Readonly<Record<string, unknown>>;
};

function isToolSchema(v: unknown): v is ToolSchema {
  return typeof v === "object" && v !== null && "inputSchema" in v;
}

/** One leaf's derived `ToolSchema` — mirrors `extractToolSchemas`'s own
 * per-leaf construction (`schemaFromFunctionNode`/`schemaFromReturnType`)
 * exactly, just from an already-extracted TypeRef pair instead of
 * re-deriving one — see `buildSchemaModuleSourceIncremental`. */
function toolSchemaFrom(info: ToolTypeInfo): ToolSchema {
  return {
    inputSchema: toJsonSchema(info.input) as JsonSchema,
    ...(info.output !== undefined ? { outputSchema: toJsonSchema(info.output) as JsonSchema } : {}),
    ...(info.description !== undefined ? { description: info.description } : {}),
  };
}

export type SchemaIncrementalResult = {
  readonly source: string;
  readonly leafFingerprints: Record<string, string>;
  readonly leafArtifacts: Record<string, ToolSchema>;
  readonly changedLeaves: readonly string[];
};

/**
 * `buildSchemaModuleSource`'s Tier-2 sibling: extracts every leaf's TypeRef
 * via `extractToolTypeRefs` (the same walk `extractToolSchemas` runs
 * internally, exposed here so this function can fingerprint each leaf's IR
 * BEFORE projecting it) and reuses `prior`'s `ToolSchema` for any leaf whose
 * fingerprint is unchanged instead of re-running `toJsonSchema` on it.
 * `treeId` (required) is `buildSchemaModuleSource`'s own — same tree, same
 * scoping rationale.
 */
export function buildSchemaModuleSourceIncremental(
  entryFile: string,
  treeId: string,
  program: ts.Program | undefined,
  prior: SchemaCarryForwardState | undefined,
): SchemaIncrementalResult {
  const programOpt = program === undefined ? {} : { program };
  const types = extractToolTypeRefs(entryFile, treeId, programOpt);

  const leafFingerprints: Record<string, string> = {};
  const leafArtifacts: Record<string, ToolSchema> = {};
  const changedLeaves: string[] = [];

  for (const [name, info] of Object.entries(types)) {
    // `description` is part of the fingerprint, not just `input`/`output` —
    // `toolSchemaFrom` below embeds `info.description` into the carried-
    // forward artifact, so a Tier-1-miss rebuild that reused a prior
    // artifact fingerprinted on `{input, output}` alone would silently keep
    // a stale description on any leaf whose types didn't change but whose
    // description did (audit §1.2).
    const fingerprint = computeLeafFingerprint(entryFile, {
      input: info.input,
      output: info.output,
      description: info.description,
    });
    leafFingerprints[name] = fingerprint;

    const priorArtifact = prior?.leafArtifacts[name];
    const reusable =
      prior !== undefined &&
      prior.leafFingerprints[name] === fingerprint &&
      isToolSchema(priorArtifact);

    leafArtifacts[name] =
      reusable && priorArtifact !== undefined && isToolSchema(priorArtifact)
        ? priorArtifact
        : (() => {
            changedLeaves.push(name);
            return toolSchemaFrom(info);
          })();
  }

  const source = renderSchemaModule(leafArtifacts);
  return { source, leafFingerprints, leafArtifacts, changedLeaves };
}

// Cached variants — Tier 1 (cache.ts's `checkCache`) gates whether a
// `ts.Program` gets built at all; on a Tier-1 miss, Tier 2 (above) recompiles
// only the leaves whose fingerprint actually changed. A schema artifact's
// cache metadata lives under its own `outFile` (a distinct file from the
// validator module's), tracked independently.

/**
 * `buildSchemaModuleSource`, cached: gates on the same Tier-1 (`checkCache`)
 * / Tier-2 (leaf fingerprint) contract as the wire-validator module's cached
 * build, applied here to the schema artifact instead. `treeId` (required) is
 * `buildSchemaModuleSource`'s own — a caller building artifacts for several
 * trees exported from the same `entryFile` calls this once per `treeId`,
 * each with its own `outFile` (cache metadata is keyed by `outFile`, so two
 * trees sharing one `outFile` would clobber each other's cache entry — not
 * this function's problem to prevent, same as any other `outFile` reuse).
 *
 * `options.header`, when given, is prepended to the rendered module source
 * BEFORE `outputHash` is computed and before it's returned as `result` — the
 * same treatment as the wire-validator module's cached wrapper (see
 * `buildWireApplyValidationModuleCached`'s doc comment for the full
 * rationale: this is what makes a header-wanting caller able to use this
 * wrapper directly, per docs/current/repo-audit-2026-08-20.md §6#2/§8.1,
 * instead of hand-rolling its own header-prepend around it). Omitting
 * `header` (or passing `""`) preserves the exact pre-existing behavior.
 */
/** The `buildOptionsKey` `buildSchemaModuleCached` folds `treeId`/`header`
 * into (audit §1.3, and the header half for the same reason as the
 * wire-validator twin's `wireApplyValidationBuildOptionsKey`): a single
 * entryFile can export several trees, each built to its own outFile —
 * without `treeId` here, a cache metadata file keyed only by
 * outFile+entryFile can't tell "tree A's artifact" from "tree B's artifact"
 * apart if a caller reuses cache location options across trees, and a
 * `--tree-id` change with no other input change was a silent Tier-1 hit
 * serving the WRONG tree's artifact. Without `header` folded in too, a
 * caller changing whether (or what) header it passes, with no other input
 * change, would be a silent Tier-1 hit serving a stale/missing header.
 * `treeId` alone (no trailing separator) when `header` is omitted —
 * preserves the exact pre-existing buildOptionsKey value for every caller
 * that doesn't pass a header.
 *
 * Exported for the same reason as `wireApplyValidationBuildOptionsKey`:
 * cli.ts's `runCheck` builds via the Tier-2 incremental function directly,
 * but still needs `checkCache`/`writeCacheMetadata` calls that agree with
 * what a `build`/`watch` run using this cached wrapper would have recorded. */
export function schemaBuildOptionsKey(treeId: string, options?: { readonly header?: string }): string {
  return options?.header === undefined ? treeId : `${treeId} ${options.header}`;
}

export function buildSchemaModuleCached(
  entryFile: string,
  treeId: string,
  outFile: string,
  options?: {
    readonly program?: ts.Program;
    readonly force?: boolean;
    readonly reachable?: ReadonlySet<string>;
    readonly header?: string;
  } & CacheLocationOptions,
): CachedBuildOutcome<string> {
  const cacheOpts = { ...options, buildOptionsKey: schemaBuildOptionsKey(treeId, options) };
  if (!cacheOpts?.force) {
    const check = checkCache(entryFile, outFile, cacheOpts);
    if (check.hit) return { status: "hit" };
  }
  const program = cacheOpts?.program ?? createExtractorProgram(entryFile);
  const prior = readCarryForwardState(entryFile, outFile, cacheOpts);
  const built = buildSchemaModuleSourceIncremental(entryFile, treeId, program, prior);
  const finalSource = (cacheOpts?.header ?? "") + built.source;
  writeCacheMetadata(entryFile, outFile, program, finalSource, cacheOpts, cacheOpts?.reachable, {
    leafFingerprints: built.leafFingerprints,
    leafArtifacts: built.leafArtifacts,
  });
  return { status: "built", result: finalSource, program };
}

/**
 * `writeSchemaModule`, cached: only writes `outFile` (and updates cache
 * metadata) when `buildSchemaModuleCached` actually built something.
 */
export async function writeSchemaModuleCached(
  entryFile: string,
  treeId: string,
  outFile: string,
  options?: {
    readonly program?: ts.Program;
    readonly force?: boolean;
    // Was previously missing here while its validator-artifact twin
    // (`writeWireApplyValidationModuleCached`) kept it — copy drift between
    // the two wrapper's option shapes (audit §6#6). A batch caller sharing
    // one multi-root Program across many schema entries needs this to record
    // each entry's own precise closure, same as the validator twin.
    readonly reachable?: ReadonlySet<string>;
    readonly header?: string;
  } & CacheLocationOptions,
): Promise<CachedBuildOutcome<string>> {
  const outcome = buildSchemaModuleCached(entryFile, treeId, outFile, options);
  if (outcome.status === "built") await writeFileEnsuringDir(outFile, outcome.result);
  return outcome;
}
