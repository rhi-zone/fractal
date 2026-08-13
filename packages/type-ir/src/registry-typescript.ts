// The `typescript`-backed importers, as a pluggable registry extension.
//
// These entries cannot work from a string: resolving `type User = { … }` means
// running the real type checker, which needs a `ts.Program` built over the
// file and its imports, plus the name of the symbol to extract.
//
// They live in their own module because `typescript` is an OPTIONAL peer
// dependency — a consumer who never imports this file never pulls the compiler
// in, at runtime or at typecheck time. But they are built with the same
// `defineRegistry` as the base entries and are the same kind of value, so a
// caller who wants both merges the two registries and afterwards uses one
// lookup and one id space:
//
//     const importers = mergeRegistries<AnyImporter>(
//       importerRegistry,
//       typescriptImporterRegistry,
//     )
//     ingestFrom(importers, "typescript", { file, symbol })
//
// The `input` tag makes that union a discriminated union, so narrowing on it
// recovers the right `run` signature — the differing input shape is expressed
// in the type system rather than by making callers remember which module a
// given id came from.
import ts from "typescript";

import type { TypeRef, TypeRefDocument } from "./index.ts";
import { typeRefDocument } from "./index.ts";
import type { Registry, RegistryEntry } from "./registry-core.ts";
import { defineRegistry, lookup } from "./registry-core.ts";
import type { Importer } from "./registry.ts";
import { createExtractorProgram, typeRefFromType } from "./from-typescript.ts";
import { fromStandardSchemaType } from "./from-standard-schema-type.ts";

/** Everything a checker-backed importer needs. `program` is optional only as
 * a convenience — omitting it builds a single-entry program over `file`,
 * which is right for one-off extraction and wrong for batch work, where the
 * caller should build one program and reuse it across many symbols. */
export interface TypeScriptInput {
  /** Absolute path to the file declaring the symbol. */
  readonly file: string;
  /** Name of the exported type alias, interface, class, or const to extract. */
  readonly symbol: string;
  /** Pre-built program. Built via `createExtractorProgram(file)` if omitted. */
  readonly program?: ts.Program;
}

export interface TypeScriptImporter extends RegistryEntry {
  readonly subpath: string;
  readonly extensions: readonly string[];
  readonly input: "typescript";
  run(input: TypeScriptInput): TypeRefDocument;
}

/** An importer from either half of the registry. Narrow on `input` to call it:
 * `"typescript"` takes a `TypeScriptInput`, everything else takes source
 * text. */
export type AnyImporter = Importer | TypeScriptImporter;

interface Resolved {
  readonly checker: ts.TypeChecker;
  readonly symbol: ts.Symbol;
  readonly declaration: ts.Declaration;
}

/** Locate `symbol` among `file`'s module exports. Exports are used rather
 * than a syntactic walk so that re-exports resolve and non-exported internals
 * stay invisible — extracting a type the module does not expose would produce
 * a schema no consumer could ever reference. */
function resolveSymbol({ file, symbol, program }: TypeScriptInput): Resolved {
  const prog = program ?? createExtractorProgram(file);
  const checker = prog.getTypeChecker();
  const sourceFile = prog.getSourceFile(file);
  if (sourceFile === undefined) throw new Error(`file not found in program: ${file}`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) throw new Error(`${file} is not a module (no exports)`);
  const found = checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === symbol);
  if (found === undefined) throw new Error(`${file} does not export ${symbol}`);
  const declaration = found.declarations?.[0];
  if (declaration === undefined) throw new Error(`${symbol} has no declaration`);
  return { checker, symbol: found, declaration };
}

/** The declared type of a type alias / interface / class, or the value type
 * of a const. `getDeclaredTypeOfSymbol` returns the intrinsic `any`-like
 * placeholder for value symbols, so the symbol's flags pick the accessor. */
function typeOfSymbol({ checker, symbol, declaration }: Resolved): ts.Type {
  const isTypeSymbol =
    (symbol.flags &
      (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) !==
    0;
  return isTypeSymbol
    ? checker.getDeclaredTypeOfSymbol(symbol)
    : checker.getTypeOfSymbolAtLocation(symbol, declaration);
}

/** Extract a `TypeRef` for one exported TypeScript symbol. */
export function importTypeScript(input: TypeScriptInput): TypeRef {
  const resolved = resolveSymbol(input);
  return typeRefFromType(typeOfSymbol(resolved), resolved.checker, resolved.declaration);
}

/** Extract a `TypeRef` from an exported Standard Schema value by reading its
 * `~standard.types.output` at compile time. Unlike the runtime
 * `fromStandardSchema` tiers this needs no sample values and no validator
 * execution — the checker resolves the declared output type directly, so
 * optionality and literal unions survive intact. */
export function importStandardSchemaType(input: TypeScriptInput): TypeRef {
  const resolved = resolveSymbol(input);
  return fromStandardSchemaType(typeOfSymbol(resolved), resolved.checker, resolved.declaration);
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
];

/** Mergeable into `importerRegistry` from `./registry`. */
export const typescriptImporterRegistry: Registry<TypeScriptImporter> =
  defineRegistry(typescriptImporterList);

/** Every checker-backed importer id, in registration order. */
export const typescriptImporterIds: readonly string[] = typescriptImporterRegistry.ids;

export function getTypeScriptImporter(id: string): TypeScriptImporter {
  return lookup(typescriptImporterRegistry, "TypeScript input format", id);
}

/** Run any importer from a (possibly merged) registry through one call.
 *
 * This is the unified convention the merge exists for: the caller supplies
 * whatever the entry needs and does not have to know which module registered
 * it. `input` stays a union rather than collapsing to one type because the
 * underlying shapes genuinely differ — no amount of indirection makes a
 * `.proto` file and a `ts.Program` the same thing — but a mismatch is caught
 * here, named, instead of surfacing as a failure deep inside an importer. */
export function ingestFrom(
  registry: Registry<AnyImporter>,
  id: string,
  input: string | TypeScriptInput,
): TypeRefDocument {
  const importer = lookup(registry, "input format", id);
  if (importer.input === "typescript") {
    if (typeof input === "string") {
      throw new Error(`input format ${id} needs a file and symbol, not source text`);
    }
    return importer.run(input);
  }
  if (typeof input !== "string") {
    throw new Error(`input format ${id} needs source text, not a file and symbol`);
  }
  return importer.run(input);
}
