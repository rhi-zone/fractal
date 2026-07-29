// Registry entries whose input is a TypeScript *program*, not text.
//
// Split out from `./registry` on purpose. These importers cannot work from a
// string: resolving `type User = { … }` means running the real type checker,
// which needs a `ts.Program` built over the file and its imports, plus the
// name of the symbol to extract. Forcing that into the text-in interface
// would mean either lying about the input shape or bundling the TypeScript
// compiler — a *peer* dependency here — into every consumer, including the
// browser playground. So the input shape is different and lives behind its
// own subpath; the text-in registry is unaffected by importing this one.
import ts from "typescript"

import type { TypeRef, TypeRefDocument } from "./index.ts"
import { typeRefDocument } from "./index.ts"
import { createExtractorProgram, typeRefFromType } from "./from-typescript.ts"
import { fromStandardSchemaType } from "./from-standard-schema-type.ts"

/** Everything a checker-backed importer needs. `program` is optional only as
 * a convenience — omitting it builds a single-entry program over `file`,
 * which is right for one-off extraction and wrong for batch work, where the
 * caller should build one program and reuse it across many symbols. */
export interface TypeScriptInput {
  /** Absolute path to the file declaring the symbol. */
  readonly file: string
  /** Name of the exported type alias, interface, class, or const to extract. */
  readonly symbol: string
  /** Pre-built program. Built via `createExtractorProgram(file)` if omitted. */
  readonly program?: ts.Program
}

export interface TypeScriptImporter {
  readonly id: string
  readonly subpath: string
  readonly extensions: readonly string[]
  readonly input: "typescript"
  run(input: TypeScriptInput): TypeRefDocument
}

interface Resolved {
  readonly checker: ts.TypeChecker
  readonly symbol: ts.Symbol
  readonly declaration: ts.Declaration
}

/** Locate `symbol` among `file`'s module exports. Exports are used rather
 * than a syntactic walk so that re-exports resolve and non-exported internals
 * stay invisible — extracting a type the module does not expose would produce
 * a schema no consumer could ever reference. */
function resolveSymbol({ file, symbol, program }: TypeScriptInput): Resolved {
  const prog = program ?? createExtractorProgram(file)
  const checker = prog.getTypeChecker()
  const sourceFile = prog.getSourceFile(file)
  if (sourceFile === undefined) throw new Error(`file not found in program: ${file}`)
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  if (moduleSymbol === undefined) throw new Error(`${file} is not a module (no exports)`)
  const found = checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === symbol)
  if (found === undefined) throw new Error(`${file} does not export ${symbol}`)
  const declaration = found.declarations?.[0]
  if (declaration === undefined) throw new Error(`${symbol} has no declaration`)
  return { checker, symbol: found, declaration }
}

/** The declared type of a type alias / interface / class, or the value type
 * of a const. `getDeclaredTypeOfSymbol` returns the intrinsic `any`-like
 * placeholder for value symbols, so the symbol's flags pick the accessor. */
function typeOfSymbol({ checker, symbol, declaration }: Resolved): ts.Type {
  const isTypeSymbol = (symbol.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) !== 0
  return isTypeSymbol ? checker.getDeclaredTypeOfSymbol(symbol) : checker.getTypeOfSymbolAtLocation(symbol, declaration)
}

/** Extract a `TypeRef` for one exported TypeScript symbol. */
export function importTypeScript(input: TypeScriptInput): TypeRef {
  const resolved = resolveSymbol(input)
  return typeRefFromType(typeOfSymbol(resolved), resolved.checker, resolved.declaration)
}

/** Extract a `TypeRef` from an exported Standard Schema value by reading its
 * `~standard.types.output` at compile time. Unlike the runtime
 * `fromStandardSchema` tiers this needs no sample values and no validator
 * execution — the checker resolves the declared output type directly, so
 * optionality and literal unions survive intact. */
export function importStandardSchemaType(input: TypeScriptInput): TypeRef {
  const resolved = resolveSymbol(input)
  return fromStandardSchemaType(typeOfSymbol(resolved), resolved.checker, resolved.declaration)
}

const typescriptImporterList: readonly TypeScriptImporter[] = [
  {
    id: "typescript",
    subpath: "./from-typescript",
    extensions: [".ts", ".tsx", ".d.ts"],
    input: "typescript",
    run: (input) => typeRefDocument(importTypeScript(input)),
  },
  {
    id: "standard-schema-type",
    subpath: "./from-standard-schema-type",
    extensions: [".ts", ".tsx"],
    input: "typescript",
    run: (input) => typeRefDocument(importStandardSchemaType(input)),
  },
]

export const typescriptImporters: ReadonlyMap<string, TypeScriptImporter> = new Map(
  typescriptImporterList.map((i) => [i.id, i]),
)

/** Every checker-backed importer id, in registration order. */
export const typescriptImporterIds: readonly string[] = typescriptImporterList.map((i) => i.id)

export function getTypeScriptImporter(id: string): TypeScriptImporter {
  const importer = typescriptImporters.get(id)
  if (importer === undefined) throw new Error(`unknown TypeScript input format: ${id}`)
  return importer
}

/** Run a checker-backed importer. Distinct from `./registry`'s `ingest`
 * because the input is a program + symbol, not a string. */
export function ingestTypeScript(id: string, input: TypeScriptInput): TypeRefDocument {
  return getTypeScriptImporter(id).run(input)
}
