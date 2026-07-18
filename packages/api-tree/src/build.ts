// packages/api-tree/src/build.ts — @rhi-zone/fractal-api-tree
//
// BUILD ORCHESTRATOR: wires the extractor (extract.ts/tree.ts) to the AOT
// validator compiler (@rhi-zone/fractal-type-ir's compile.ts), producing the
// standalone, zero-runtime-dependency validator MODULE SOURCE that
// `createApplyValidation()` (packages/http-api-projector/src/route.ts) consumes.
//
//   entryFile --extractRouteTypeRefs--> path -> TypeRef
//            --compileValidatorModule--> module source (exports `validators`,
//              `Record<path, { check, errors, parse }>` — see compile.ts)
//
// `buildValidatorModuleSource` is the one-shot "codegen has run" path;
// `stubValidatorModuleSource` is the pre-codegen dev-time placeholder — an
// empty `validators` map, so `toValidatorRecord({})` is a no-op passthrough
// for every route until real codegen runs (see route.ts's
// `createApplyValidation` doc comment).
//
// The generated module's `{ check, errors, parse }` triple is a type-ir
// concern only (it says nothing about `Result`/`Validator` — those are
// http-api-projector's types). `toValidatorRecord` below adapts a generated
// `validators` map into the single-function-per-route shape
// `createApplyValidation`'s `ValidatorMap` expects, by wrapping each entry's
// `parse`: `parse`'s `{kind:"err",errors}` becomes `{kind:"err",error:errors}`
// (route.ts's `Result<T,E>` uses `error`, singular — the structured
// `ValidationError[]` becomes the `E`). Written structurally (no import of
// http-api-projector's `Validator`/`Result` types) so api-tree doesn't need a
// runtime dependency on http-api-projector just for this adapter.

import * as path from "node:path"
import { compileValidatorModule } from "@rhi-zone/fractal-type-ir"
import { extractRouteTypeRefs } from "./tree.ts"

/** One generated entry's public shape — see compile.ts's `compileValidatorModule`. */
type GeneratedEntry = {
  parse: (value: unknown) => { kind: "ok"; value: unknown } | { kind: "err"; errors: unknown[] }
}

/** Structurally matches http-api-projector's `Validator` — `(bag) =>
 * Result<unknown, unknown>` — without importing that package's types. */
type Adapted = (bag: Record<string, unknown>) => { kind: "ok"; value: unknown } | { kind: "err"; error: unknown }

/** Adapt one generated entry's `parse` into a single-function `Validator`. */
export function toValidator(entry: GeneratedEntry): Adapted {
  return (bag) => {
    const result = entry.parse(bag)
    return result.kind === "ok" ? result : { kind: "err", error: result.errors }
  }
}

/** Adapt a whole generated `validators` map into `Record<path, Validator>` —
 * the inner map `createApplyValidation`'s `ValidatorMap` expects. */
export function toValidatorRecord(validators: Record<string, GeneratedEntry>): Record<string, Adapted> {
  return Object.fromEntries(Object.entries(validators).map(([name, entry]) => [name, toValidator(entry)]))
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
 * `validators` through `toValidatorRecord` (this file) before nesting it
 * under whatever outer key `createApplyValidation`'s `applyValidation(key,
 * route)` expects.
 *
 * `outFile`, when given, anchors `import type` specifiers for handler
 * parameter types that are NAMED (alias/interface) rather than inline —
 * see `compileValidatorModule`'s `resolveImport` option and
 * `extract.ts`'s `typeRefFromFunctionNode` (the source of
 * `meta.typeName`/`meta.declarationFile`). Without it, every parameter type
 * inlines its structural TypeScript rendering instead — still typed, just
 * without an import.
 */
export function buildValidatorModuleSource(entryFile: string, outFile?: string): string {
  const typeRefs = extractRouteTypeRefs(entryFile)
  const entries = Object.entries(typeRefs).map(([name, info]) => ({ name, ref: info.input }))
  return compileValidatorModule(
    entries,
    outFile === undefined
      ? undefined
      : { resolveImport: (declarationFile: string) => relativeImportSpecifier(outFile, declarationFile) },
  )
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
