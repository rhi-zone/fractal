import { resolve, type TypeRef } from "@rhi-zone/fractal-type-ir";
// Side-effect import: registers type-ir's extension kinds (int8..64/uint8..64/
// float32/float64, etc.) into the shared `TypeKinds` interface via declaration
// merging — required here because this file's kind-keyed lookup tables
// reference those kind names as string literals, the same reason
// `wasm-bindgen.ts` (ffi-ir's own sibling) imports this module for its own
// "bytes" reference. This file uses no named export from it.
import "@rhi-zone/fractal-type-ir/kinds/common";
import type { FfiParam, FfiRef, FfiShape, OwnershipDiscipline } from "./index.ts";

// .NET/P-Invoke consumer-side projector — the caller of a C-ABI shared
// library (the counterpart to `rust-c-abi.ts`'s Rust/`#[no_mangle] pub extern "C"`
// producer side). Named by target platform (`dotnet.ts`), matching this
// package's established naming split: `rescript.ts`/`gleam.ts`/`melange.ts`
// name by target language/platform (the file emits a whole language's own
// idiomatic external-declaration syntax), while `wasm-bindgen.ts`/`rust-c-abi.ts`
// name by technique (a specific binding mechanism inside one language, Rust).
// P/Invoke is .NET's only mechanism for calling native code — there is no
// second competing technique inside .NET the way wasm-bindgen is one of
// several ways to bind Rust to JS — so, like ReScript's `external`, "the
// platform" and "the technique" name the same thing here, and the
// target-platform naming (`dotnet.ts`) matches the convention `rescript.ts`
// already set for that case.
//
// ============================================================================
// P/Invoke attribute choice: `LibraryImportAttribute`, verified against
// Microsoft Learn (WebFetch, 2026-08-03):
//   - "P/Invoke source generation" (learn.microsoft.com/en-us/dotnet/standard/
//     native-interop/pinvoke-source-generation): `[LibraryImport]` (.NET 7+)
//     triggers compile-time source generation of marshalling code on a
//     `static partial` method, "removing the need for generation of an IL
//     stub at runtime" that `[DllImport]` requires, and works under Native
//     AOT/trimming where `[DllImport]`'s runtime-generated IL stub does not.
//   - "Native interoperability best practices" (learn.microsoft.com/en-us/
//     dotnet/standard/native-interop/best-practices): "✔️ DO use
//     `[LibraryImport]`, if possible, when targeting .NET 7+" is Microsoft's
//     own stated current guidance for new code; `[DllImport]` is called out
//     as appropriate only in specific cases the SYSLIB1054 analyzer flags
//     (calling-convention/marshalling features `[LibraryImport]` doesn't
//     support — none of which this backend's scope needs: no COM, no
//     `PreserveSig=false` HRESULT-to-exception translation, no non-UTF-8/
//     UTF-16 legacy ANSI/BestFitMapping).
//   This backend targets `[LibraryImport]` exclusively — no `[DllImport]`
//   fallback path is implemented, since nothing in this backend's scope
//   (primitive scalars, UTF-8 strings, opaque handles) needs a feature
//   `[LibraryImport]` lacks.
//
// Requirements this imposes (also verified from the same source-generation
// doc): a `[LibraryImport]`-annotated method must be `static` AND `partial`
// (the source generator supplies the body in a compiler-generated partial
// declaration) — which in turn requires its enclosing type be declared
// `partial` too (an ordinary C# partial-method constraint, not something the
// doc states explicitly but a direct consequence of C#'s partial-method
// feature: a partial method cannot exist inside a non-partial type). Hence
// every wrapping class this backend emits (`module` -> class, `resource` ->
// nested class) is declared `static partial class`, not plain `static class`.
//
// String marshaling, verified from the same "P/Invoke source generation" doc:
// `[LibraryImport]` replaces `[DllImport]`'s Windows-centric `CharSet` with
// `StringMarshalling` (`LibraryImportAttribute.StringMarshalling`), and
// "ANSI has been removed and UTF-8 is now available as a first-class
// option" — `StringMarshalling.Utf8`. This is the correct match for the
// paired `rust-c-abi.ts` producer: its `string` mapping is Rust's `String`/`&str`,
// which is guaranteed-valid UTF-8, not UTF-16 — so `StringMarshalling.Utf8`
// (not `.Utf16`, `[DllImport]`'s historical default on Windows) is emitted
// on every declaration whose signature contains a string, keeping the two
// backends' string convention aligned. `[MarshalAs(UnmanagedType.LPUTF8Str)]`
// is real (confirmed present in the .NET API surface as one of `MarshalAs`'s
// supported settings for `[DllImport]`) but is the `[DllImport]`-era
// per-parameter mechanism `StringMarshalling` supersedes for `[LibraryImport]`
// — not used here since `StringMarshalling.Utf8` at the declaration level
// covers every string parameter/return in one setting, matching "Native
// interoperability best practices"'s own `StringMarshalling`-first framing.
//
// Bool marshaling, verified from the same "best practices" doc's own
// "Boolean parameters and fields" + "Blittable types" sections: a bare C#
// `bool` is explicitly listed as NOT blittable, and "by default, a .NET
// `bool` is marshalled to a Windows `BOOL`... a 4-byte value. However, the
// `_Bool`... type in C... [is] a *single* byte" — an unmarshaled C# `bool`
// mismatches a C/Rust `bool` (both 1 byte, matching Rust's own `bool` that
// `rust-c-abi.ts`/`rust-serde.ts` emit). The doc's own Windows-data-types table gives the fix: `BOOLEAN`
// (an 8-bit Windows bool, the same width as Rust/C's `bool`) maps to
// `[MarshalAs(UnmanagedType.U1)] bool`. Confirmed the source generator
// respects `[MarshalAs]` (same doc, "The source generator also respects the
// MarshalAsAttribute" section) — so `[MarshalAs(UnmanagedType.U1)]` is
// emitted on every bool-typed parameter/return (as `[return: MarshalAs(...)]`
// for a return position), matching this exact documented idiom.
//
// ============================================================================
// Ownership-discipline scope for this target. `rust-c-abi.ts` (the producer this
// backend consumes) implements exactly two of the four `OwnershipDiscipline`
// kinds — `"copy"` (by-value) and `"opaque-handle"` (`*mut T` + a
// separately-emitted `<resource>_free` function) — and throws explicitly for
// `"refcount"`/`"resource"` (own/borrow), since plain C has no native
// mechanism for either (see `rust-c-abi.ts`'s own file header). Every P/Invoke
// declaration this file emits is meant to pair 1:1 with what `rust-c-abi.ts` can
// actually produce, so in practice only `"copy"` and `"opaque-handle"` cross
// this specific boundary today.
//
// Unlike `rust-c-abi.ts`, this file does not throw for `"refcount"`/`"resource"`
// (own/borrow) ownership. Ownership discipline governs who is responsible
// for freeing a handle and when (call an explicit free-fn once / decrement a
// refcount / respect a lend-count-and-trap contract) — a caller-side
// bookkeeping question that does not change how the handle crosses the ABI
// wire: in every one of the four disciplines, a resource reference is still,
// physically, one pointer-sized value — `IntPtr` on the .NET side, `*mut T`
// on the C-ABI side. `toDotNetType` below therefore renders `IntPtr`
// uniformly for any non-`"copy"` ownership discipline attached to a
// resource reference, regardless of which of the three it is. A caller
// pairing this against a producer that doesn't yet emit a matching
// refcount/resource-discipline C ABI (i.e. `rust-c-abi.ts` today) gets a
// `P/Invoke`-correct `IntPtr` declaration for a symbol that doesn't yet
// exist to link against — that mismatch is a producer-side coverage gap,
// not something this consumer-side backend detects.
//
// The one case this file throws for, a genuine P/Invoke-side limitation
// rather than a caller-side bookkeeping distinction: a `"copy"`
// (or unset) ownership TypeRef whose structural `type-ir` kind is anything
// beyond the flat scalar set below (`object`/`array`/`map`/`tuple`/`union`/
// `enum`/`intersection`/`interface`/a bare `ref` with no ownership metadata/
// etc.). By-value struct marshaling for those would require this backend to
// also emit `[StructLayout(LayoutKind.Sequential)]` C# struct declarations
// mirroring the producer's own layout — no such struct-shape projector exists
// for either side of this pairing yet (`rust-c-abi.ts` itself has no `object`
// handling of its own; `rust-serde.ts`'s `object` case only degrades to a
// bare type-name reference, not a real repr(C) layout), so emitting a
// same-layout C# struct here would be inventing a struct definition with
// nothing on the producer side to verify it against. Throws explicitly,
// matching the throw-not-degrade convention `wasm-bindgen.ts`/`rust-c-abi.ts`
// already use for kinds/disciplines they can't realize on their own targets.

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toPascalCase(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function indent(block: string, prefix = "    "): string {
  return block
    .split("\n")
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join("\n");
}

// C# reserved keywords (ECMA-334 §7.4.4 / the C# language reference's
// keyword list) that cannot appear as a plain identifier and require `@`
// verbatim-identifier escaping.
const CSHARP_KEYWORDS = new Set([
  "abstract",
  "as",
  "base",
  "bool",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "checked",
  "class",
  "const",
  "continue",
  "decimal",
  "default",
  "delegate",
  "do",
  "double",
  "else",
  "enum",
  "event",
  "explicit",
  "extern",
  "false",
  "finally",
  "fixed",
  "float",
  "for",
  "foreach",
  "goto",
  "if",
  "implicit",
  "in",
  "int",
  "interface",
  "internal",
  "is",
  "lock",
  "long",
  "namespace",
  "new",
  "null",
  "object",
  "operator",
  "out",
  "override",
  "params",
  "private",
  "protected",
  "public",
  "readonly",
  "ref",
  "return",
  "sbyte",
  "sealed",
  "short",
  "sizeof",
  "stackalloc",
  "static",
  "string",
  "struct",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "uint",
  "ulong",
  "unchecked",
  "unsafe",
  "ushort",
  "using",
  "virtual",
  "void",
  "volatile",
  "while",
]);

function escapeCSharpIdent(name: string): string {
  return CSHARP_KEYWORDS.has(name) ? `@${name}` : name;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

// Structural (non-ownership) type-ir kind -> C# type mapping — the "copy"/
// unset-ownership scalar leaves this backend implements. Deliberately flat
// (no recursion into array/object/etc.): see the file-header "genuine P/Invoke
// limitation" note above for why non-scalar kinds throw instead.
const SCALAR_TYPES: Record<string, string> = {
  boolean: "bool",
  number: "double",
  integer: "long",
  int8: "sbyte",
  int16: "short",
  int32: "int",
  int64: "long",
  uint8: "byte",
  uint16: "ushort",
  uint32: "uint",
  uint64: "ulong",
  float32: "float",
  float64: "double",
  string: "string",
  void: "void",
  null: "void",
};

/**
 * `true` for `"boolean"` kind (or a registered descendant of it) under
 * `"copy"`/unset ownership — the gate for whether `[MarshalAs(UnmanagedType.U1)]`
 * is required (see file header's "Bool marshaling, verified" note). A
 * resource reference (any non-"copy" ownership discipline) is never a bool,
 * so this returns false for those without inspecting the structural kind.
 */
function isBoolType(ref: TypeRef): boolean {
  const discipline = ref.meta.ownership as OwnershipDiscipline | undefined;
  if (discipline !== undefined && discipline.kind !== "copy") return false;
  return resolve(ref.shape.kind, { boolean: true }) === true;
}

/**
 * `true` for `"string"` kind (or descendant) under `"copy"`/unset ownership —
 * the gate for whether `StringMarshalling = StringMarshalling.Utf8` is added
 * to a declaration's `[LibraryImport(...)]` attribute (see file header's
 * "String marshaling, verified" note).
 */
function isStringType(ref: TypeRef): boolean {
  const discipline = ref.meta.ownership as OwnershipDiscipline | undefined;
  if (discipline !== undefined && discipline.kind !== "copy") return false;
  return resolve(ref.shape.kind, { string: true }) === true;
}

/**
 * The C# type for one boundary position (a parameter's or return's
 * `TypeRef`), applying this target's ownership rule (see file header's
 * "Ownership-discipline scope" section):
 *   - no `meta.ownership` at all, or `{ kind: "copy" }` — the flat scalar
 *     mapping in `SCALAR_TYPES` (with `ancestors()` fallback for a
 *     kind not directly listed, e.g. a further subtype an extension module
 *     registers under one of these). Any structural kind outside that table
 *     throws — see the file header's "one case this file DOES throw for."
 *   - `{ kind: "opaque-handle" }` / `{ kind: "refcount" }` /
 *     `{ kind: "resource", mode }` — `IntPtr`, uniformly, regardless of which
 *     of the three (see file header for why this is not a marshaling-level
 *     distinction).
 */
export function toDotNetType(ref: TypeRef): string {
  const discipline = ref.meta.ownership as OwnershipDiscipline | undefined;
  if (discipline !== undefined && discipline.kind !== "copy") return "IntPtr";

  const kind = ref.shape.kind;
  const direct = SCALAR_TYPES[kind];
  if (direct !== undefined) return direct;
  const viaAncestor = resolve(kind, SCALAR_TYPES);
  if (viaAncestor !== undefined) return viaAncestor;

  throw new Error(
    `toDotNet: unsupported type-ir kind "${kind}" for the .NET/P-Invoke target — this backend implements only the flat scalar kinds ` +
      "(boolean/number/integer/int8..64/uint8..64/float32/float64/string/void/null) under copy/unset ownership, plus resource references " +
      'carrying non-"copy" ownership metadata (rendered as IntPtr regardless of discipline — see this file\'s header). Structural kinds ' +
      "(object/array/map/tuple/union/enum/intersection/interface, or a bare ref with no ownership metadata) would require a matching " +
      "repr(C)-equivalent C# struct declaration this backend does not generate (no producer-side struct-layout projector exists yet to " +
      "verify such a struct against).",
  );
}

function docComment(meta: Readonly<Record<string, unknown>>): string[] {
  return typeof meta.description === "string" ? [`/// <summary>${meta.description}</summary>`] : [];
}

type FfiFunctionLike = {
  readonly params: readonly FfiParam[];
  readonly returnType: TypeRef;
};

/**
 * One `[LibraryImport]`-annotated `internal static partial` method for a
 * `function`/`method` shape. `selfParam`, when given, prepends a synthesized
 * `IntPtr handle` receiver parameter (mirroring `rust-c-abi.ts`'s own
 * `selfParam`-driven receiver synthesis for the exact same reason: ffi-ir's
 * `method` kind names its receiver by resource name only, carrying no
 * parameter of its own).
 *
 * Method/parameter naming: kept as the exact native symbol/parameter name
 * (not PascalCased) per "Native interoperability best practices"'s own
 * guidance ("DO use the same naming and capitalization for your methods and
 * parameters as the native method you want to call") — `fnName` here is
 * already the snake_case symbol `rust-c-abi.ts` emits for the paired producer
 * side (see `toSnakeCase` calls at each call site below), so this function
 * does not reformat it. `EntryPoint` is set explicitly on every declaration,
 * even though it equals the method's own escaped name in every case emitted
 * here.
 */
function buildFunction(
  fnName: string,
  ref: FfiRef,
  shape: FfiFunctionLike,
  libraryName: string,
  selfParam?: string,
): string {
  const paramDecls: string[] = [];
  if (selfParam !== undefined) paramDecls.push("IntPtr handle");
  for (const p of shape.params) {
    const ident = escapeCSharpIdent(p.name);
    const marshalAs = isBoolType(p.type) ? "[MarshalAs(UnmanagedType.U1)] " : "";
    paramDecls.push(`${marshalAs}${toDotNetType(p.type)} ${ident}`);
  }

  const isVoidReturn =
    shape.returnType.shape.kind === "void" || shape.returnType.shape.kind === "null";
  const returnType = isVoidReturn ? "void" : toDotNetType(shape.returnType);
  const hasString =
    shape.params.some((p) => isStringType(p.type)) ||
    (!isVoidReturn && isStringType(shape.returnType));
  const returnIsBool = !isVoidReturn && isBoolType(shape.returnType);

  const attrArgs = [quote(libraryName), `EntryPoint = ${quote(fnName)}`];
  if (hasString) attrArgs.push("StringMarshalling = StringMarshalling.Utf8");

  const lines: string[] = [...docComment(ref.meta), `[LibraryImport(${attrArgs.join(", ")})]`];
  if (returnIsBool) lines.push("[return: MarshalAs(UnmanagedType.U1)]");
  lines.push(
    `internal static partial ${returnType} ${escapeCSharpIdent(fnName)}(${paramDecls.join(", ")});`,
  );
  return lines.join("\n");
}

/** The paired free-function declaration for a resource — `rust-c-abi.ts`'s
 * `buildResource` always emits a `<resource>_free(handle: *mut T)` Rust
 * function for every resource (regardless of whether `OwnershipDiscipline`'s
 * `opaque-handle.freeFn` names one explicitly), so this backend always emits
 * the matching P/Invoke declaration too, to stay paired 1:1 with what the
 * producer guarantees to export. */
function buildFreeFunction(freeFnName: string, libraryName: string): string {
  return [
    `[LibraryImport(${quote(libraryName)}, EntryPoint = ${quote(freeFnName)})]`,
    `internal static partial void ${escapeCSharpIdent(freeFnName)}(IntPtr handle);`,
  ].join("\n");
}

function buildResource(
  name: string,
  ref: FfiRef,
  shape: FfiShape & { kind: "resource"; methods: Readonly<Record<string, FfiRef>> },
  libraryName: string,
): string {
  const resourceSnake = toSnakeCase(name);
  const decls: string[] = [];

  for (const [methodName, methodRef] of Object.entries(shape.methods)) {
    const methodShape = methodRef.shape as FfiShape & { kind: "method" };
    const fnName = `${resourceSnake}_${toSnakeCase(methodName)}`;
    decls.push(buildFunction(fnName, methodRef, methodShape, libraryName, name));
  }

  decls.push(buildFreeFunction(`${resourceSnake}_free`, libraryName));

  const body = decls.join("\n\n");
  return [
    ...docComment(ref.meta),
    "// Handle representation: IntPtr, uniformly, for every ownership discipline",
    "// a reference to this resource might carry (opaque-handle/refcount/",
    "// resource own-or-borrow) — see this file's header for why that's a",
    "// caller-side bookkeeping distinction, not a marshaling one. Call the",
    `// paired ${quote(`${resourceSnake}_free`)} export exactly once per handle`,
    "// when using the opaque-handle discipline's manual-free convention.",
    `internal static partial class ${name}`,
    "{",
    indent(body),
    "}",
  ].join("\n");
}

function buildModule(
  name: string,
  shape: FfiShape & { kind: "module" },
  libraryName: string,
): string {
  const functionDecls = Object.entries(shape.functions).map(([fnName, fnRef]) => {
    const fnShape = fnRef.shape as FfiShape & { kind: "function" };
    return buildFunction(toSnakeCase(fnName), fnRef, fnShape, libraryName);
  });
  const resourceDecls = Object.entries(shape.resources).map(([, resRef]) => {
    const resShape = resRef.shape as FfiShape & {
      kind: "resource";
      name: string;
      methods: Readonly<Record<string, FfiRef>>;
    };
    return buildResource(resShape.name, resRef, resShape, libraryName);
  });
  const body = [...resourceDecls, ...functionDecls].join("\n\n");
  return [
    "using System;",
    "using System.Runtime.InteropServices;",
    "",
    `internal static partial class ${toPascalCase(name)}`,
    "{",
    indent(body),
    "}",
  ].join("\n");
}

/**
 * Lower one ffi-ir `FfiRef` to `[LibraryImport]`-annotated C#/.NET P/Invoke
 * source — the consumer side that calls INTO the shared library `rust-c-abi.ts`'s
 * Rust output produces (see file header for the full attribute/marshaling
 * rationale).
 *
 *   - `function` -> a top-level `[LibraryImport]` declaration (requires
 *     `name` and `libraryName` — see below).
 *   - `method` -> the same, plus a synthesized `IntPtr handle` first
 *     parameter and a `<receiver>_<method>` entry point, matching
 *     `rust-c-abi.ts`'s own naming (requires `name`, the method's own key, and
 *     `libraryName`).
 *   - `resource` -> a nested `static partial class` grouping the resource's
 *     method declarations plus its always-paired `<resource>_free`
 *     declaration (requires `libraryName`; `name` argument, if given, is
 *     ignored in favor of the shape's own `name` field, matching `rust-c-abi.ts`'s
 *     identical "resource carries its own name" convention).
 *   - `module` -> a `static partial class` (PascalCased from the module
 *     name) grouping all contained functions/resources, with the
 *     `System`/`System.Runtime.InteropServices` `using` directives a
 *     standalone C# file emitting this needs. `libraryName` defaults to the
 *     module's own `name` when not given explicitly (the natural "one module
 *     -> one native library" default; override when the native library's
 *     filename differs from the ffi-ir module's logical name).
 *
 * `libraryName` (the native shared library `[LibraryImport]`'s first
 * argument names, e.g. `"my_native_lib"` for `libmy_native_lib.so`) has no
 * ffi-ir-schema equivalent — it's a consumer-side loading detail the
 * producer side doesn't carry — so it's a required parameter for
 * `function`/`method`/`resource` (there is no enclosing module to default it
 * from) and an optional override for `module`.
 */
export function toDotNet(ref: FfiRef, name?: string, libraryName?: string): string {
  const kind = ref.shape.kind;

  if (kind === "function") {
    if (name === undefined) {
      throw new Error(
        'toDotNet: "function" requires a name — a P/Invoke declaration is a named symbol, not an anonymous inline type',
      );
    }
    if (libraryName === undefined) {
      throw new Error(
        'toDotNet: "function" requires a libraryName (the native shared library to load) when projected standalone — pass it explicitly, or project the enclosing "module" instead, which defaults it from the module\'s own name',
      );
    }
    const shape = ref.shape as FfiShape & { kind: "function" };
    return buildFunction(toSnakeCase(name), ref, shape, libraryName);
  }

  if (kind === "method") {
    if (name === undefined) {
      throw new Error(
        "toDotNet: \"method\" requires a name — the method's own key in its resource's methods map",
      );
    }
    if (libraryName === undefined) {
      throw new Error(
        'toDotNet: "method" requires a libraryName (the native shared library to load) when projected standalone — pass it explicitly, or project the enclosing "module" instead',
      );
    }
    const shape = ref.shape as FfiShape & { kind: "method" };
    const fnName = `${toSnakeCase(shape.receiver)}_${toSnakeCase(name)}`;
    return buildFunction(fnName, ref, shape, libraryName, shape.receiver);
  }

  if (kind === "resource") {
    if (libraryName === undefined) {
      throw new Error(
        'toDotNet: "resource" requires a libraryName (the native shared library to load) when projected standalone — pass it explicitly, or project the enclosing "module" instead',
      );
    }
    const shape = ref.shape as FfiShape & {
      kind: "resource";
      name: string;
      methods: Readonly<Record<string, FfiRef>>;
    };
    return buildResource(shape.name, ref, shape, libraryName);
  }

  if (kind === "module") {
    const shape = ref.shape as FfiShape & {
      kind: "module";
      name: string;
      functions: Readonly<Record<string, FfiRef>>;
      resources: Readonly<Record<string, FfiRef>>;
    };
    return buildModule(shape.name, shape, libraryName ?? shape.name);
  }

  throw new Error(
    `toDotNet: unhandled ffi-ir kind "${kind}" — no .NET P/Invoke mapping implemented for this backend`,
  );
}
