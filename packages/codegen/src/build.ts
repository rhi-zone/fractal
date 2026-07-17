// packages/codegen/src/build.ts — @rhi-zone/fractal-codegen
//
// BUILD ORCHESTRATOR: wires the extractor (extract.ts/tree.ts) to the AOT
// validator compiler (compile.ts), producing the standalone,
// zero-runtime-dependency validator MODULE SOURCE that
// `createApplyValidation()` (packages/http-api-projector/src/route.ts) consumes.
//
//   entryFile --extractRouteTypeRefs--> path -> TypeRef
//            --compileValidatorModule--> module source (exports `validators`)
//
// `buildValidatorModuleSource` is the one-shot "codegen has run" path;
// `stubValidatorModuleSource` is the pre-codegen dev-time placeholder — an
// empty `validators` map, so `createApplyValidation(stub.validators)` is a
// no-op passthrough for every route until real codegen runs (see route.ts's
// `createApplyValidation` doc comment).

import { compileValidatorModule } from "./compile.ts"
import { extractRouteTypeRefs } from "./tree.ts"

/**
 * Extract every leaf op's input type from `entryFile` and compile it into a
 * standalone validator module source string — `export const validators:
 * Record<routePath, Validator>`. The caller nests this under whatever outer
 * key it passes to `createApplyValidation`'s `applyValidation(key, route)`.
 */
export function buildValidatorModuleSource(entryFile: string): string {
  const typeRefs = extractRouteTypeRefs(entryFile)
  const entries = Object.entries(typeRefs).map(([name, info]) => ({ name, ref: info.input }))
  return compileValidatorModule(entries)
}

/** An empty validator module — the pre-codegen dev-time stub. */
export function stubValidatorModuleSource(): string {
  return compileValidatorModule([])
}

/**
 * Build the validator module for `entryFile` and write it to `outFile`.
 */
export async function writeValidatorModule(entryFile: string, outFile: string): Promise<void> {
  await Bun.write(outFile, buildValidatorModuleSource(entryFile))
}

/** Write the empty pre-codegen stub module to `outFile`. */
export async function writeStubValidatorModule(outFile: string): Promise<void> {
  await Bun.write(outFile, stubValidatorModuleSource())
}
