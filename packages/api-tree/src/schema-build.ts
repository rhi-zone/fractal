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
 * SchemaMap`. `program`, when given, reuses a pre-built `ts.Program`: a
 * caller building both the validator module and the schema artifact for the
 * same batch of entry files shares one Program across both passes, rather
 * than building it twice (once per artifact kind) or twice per entry.
 */
export function buildSchemaModuleSource(entryFile: string, program?: ts.Program): string {
  const programOpt = program === undefined ? {} : { program };
  const schemas = extractToolSchemas(entryFile, programOpt);
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

/**
 * Build the schema module for `entryFile` and write it to `outFile`.
 */
export async function writeSchemaModule(entryFile: string, outFile: string): Promise<void> {
  await Bun.write(outFile, buildSchemaModuleSource(entryFile));
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
 */
export function buildSchemaModuleSourceIncremental(
  entryFile: string,
  program: ts.Program | undefined,
  prior: SchemaCarryForwardState | undefined,
): SchemaIncrementalResult {
  const programOpt = program === undefined ? {} : { program };
  const types = extractToolTypeRefs(entryFile, programOpt);

  const leafFingerprints: Record<string, string> = {};
  const leafArtifacts: Record<string, ToolSchema> = {};
  const changedLeaves: string[] = [];

  for (const [name, info] of Object.entries(types)) {
    const fingerprint = computeLeafFingerprint(entryFile, {
      input: info.input,
      output: info.output,
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
 * build, applied here to the schema artifact instead.
 */
export function buildSchemaModuleCached(
  entryFile: string,
  outFile: string,
  options?: {
    readonly program?: ts.Program;
    readonly force?: boolean;
    readonly reachable?: ReadonlySet<string>;
  } & CacheLocationOptions,
): CachedBuildOutcome<string> {
  if (!options?.force) {
    const check = checkCache(entryFile, outFile, options);
    if (check.hit) return { status: "hit" };
  }
  const program = options?.program ?? createExtractorProgram(entryFile);
  const prior = readCarryForwardState(entryFile, outFile, options);
  const built = buildSchemaModuleSourceIncremental(entryFile, program, prior);
  writeCacheMetadata(entryFile, outFile, program, built.source, options, options?.reachable, {
    leafFingerprints: built.leafFingerprints,
    leafArtifacts: built.leafArtifacts,
  });
  return { status: "built", result: built.source, program };
}

/**
 * `writeSchemaModule`, cached: only writes `outFile` (and updates cache
 * metadata) when `buildSchemaModuleCached` actually built something.
 */
export async function writeSchemaModuleCached(
  entryFile: string,
  outFile: string,
  options?: {
    readonly program?: ts.Program;
    readonly force?: boolean;
  } & CacheLocationOptions,
): Promise<CachedBuildOutcome<string>> {
  const outcome = buildSchemaModuleCached(entryFile, outFile, options);
  if (outcome.status === "built") await Bun.write(outFile, outcome.result);
  return outcome;
}
