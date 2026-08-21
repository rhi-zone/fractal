import type { TypeRef } from "@rhi-zone/fractal-type-ir";
// Side-effect import: registers type-ir's fixed-width int/float kinds and
// "bytes" into the shared `TypeKinds` interface via declaration merging.
// Required here because this file's own `denoFfiType` switches on the
// `"int8"`/`"uint32"`/`"float64"`/`"bytes"`/... shape kinds directly (string
// literal matching, not `resolve()`/ancestor fallback — same as wit.ts's
// `PRIMITIVES` table), and this package's tsc program doesn't otherwise
// reach those kind-registration modules through any import edge —
// wasm-bindgen.ts in this same package establishes the identical convention
// for the identical reason.
import "@rhi-zone/fractal-type-ir/kinds/common";
import {
  toSnakeCaseStripSeparators as toSnakeCase,
  escapeJsIdent,
} from "@rhi-zone/fractal-type-ir/codegen-helpers";
import type { FfiKinds, FfiParam, FfiRef, FfiShape, OwnershipDiscipline } from "./index.ts";

// ffi-ir -> Deno FFI consumer projector — a consumer, not a producer, of the
// C ABI: unlike rust-c-abi.ts, which emits Rust `extern "C"` source
// implementing a C-ABI library, this file emits the Deno-side TypeScript
// loader that calls into whatever library rust-c-abi.ts's Rust output
// compiles to, via `Deno.dlopen`. Consumer and producer are separate
// files/concerns; wasm-bindgen.ts (the Rust producer) has no consumer-side
// counterpart in this package, so this is the first consumer-side backend
// here.
//
// Deno.dlopen API surface (per docs.deno.com/runtime/fundamentals/ffi/):
//
//   - `Deno.dlopen(path, symbols)` returns `{ symbols, close() }`; each
//     `symbols[name]` is `{ parameters: FfiType[], result: FfiType }` and,
//     after the call, `lib.symbols.<name>(...)` invokes it directly
//     (synchronous — the docs describe no async/nonblocking calling
//     convention at the API level; `Deno.dlopen` itself "throws
//     synchronously when the library cannot be loaded").
//   - FFI type vocabulary (Deno type | C type): `i8`/`u8` (`number`),
//     `i16`/`u16` (`number`), `i32`/`u32` (`number`), `i64`/`u64` (`bigint`),
//     `usize`/`isize` (`bigint`), `f32`/`f64` (`number`), `void`
//     (`undefined`), `pointer` (opaque object or `null` — "as of Deno 1.31
//     the JavaScript representation of `pointer` has become an opaque
//     pointer object or `null` for null pointers"; the docs' own prose type
//     table describes it loosely as `{} | null`, but Deno's real ambient
//     `lib.deno.ns.d.ts` names a dedicated `Deno.PointerValue<T>` for it — a
//     branded `PointerObject<T> = { readonly [brand]: T } | null` — so this
//     file's `POINTER_TYPE_ALIAS` aliases straight to `Deno.PointerValue`
//     rather than hand-spelling the prose description, which doesn't
//     structurally match the real branded type), `buffer` (`BufferSource |
//     null` as a parameter — Deno's own `ToNativeType` ambient mapping —
//     `function` (callback pointer).
//   - Structs are natively supported by value: `{ struct: [...] }` describes
//     a C struct's layout as an ordered array of field FFI types, and struct
//     values cross the boundary as a `TypedArray` whose bytes match that C
//     layout (params) / a `Uint8Array` of the right length (returns). This
//     file does not implement that path (see `denoFfiType`'s throw for
//     `"object"` below) — computing the `{ struct: [...] }` field-type array
//     and the C ABI byte layout (natural alignment + padding rules) a caller
//     must pack/unpack against is a separate undertaking (rust-serde's
//     `toRustType` "object" case doesn't target `#[repr(C)]` layout either,
//     and rust-c-abi.ts's own "copy" path for an object TypeRef inherits
//     whatever non-C-ABI shape `toRustType` gives it, so there is no
//     established fractal C-ABI struct-layout convention yet to mirror
//     here) — out of scope for this minimal projector, the same "minimal
//     subset, throw for the rest" scoping wit.ts's own file header documents
//     for its own data-shape coverage.
//   - No dedicated `"bool"` FFI type exists in Deno's vocabulary — `u8` is
//     this file's convention for `boolean`, the 1-byte width matching both
//     Rust `bool` and C99 `_Bool`'s own layout.
//   - `"string"` has no native Deno FFI type, and the docs describe no
//     established C-string convention (no `cstr`/`getCString()`/pointer+
//     length guidance on that page). Crossing a string requires a concrete
//     encoding decision (null-terminated buffer vs. pointer+length pair, and
//     who owns/frees the bytes) that neither ffi-ir's schema (index.ts) nor
//     rust-c-abi.ts's own "copy" path (which inherits rust-serde's
//     `toRustType` `"string" -> "String"` mapping, itself not a
//     `#[repr(C)]`-safe C-ABI string representation) has decided.
//     `denoFfiType` throws explicitly for `"string"` rather than inventing
//     an encoding.
//
// Ownership-discipline scope for this target (mirrors the file-level
// per-target reasoning rust-c-abi.ts/wit.ts/gleam.ts each give, re-derived
// here since Deno FFI's situation matches neither exactly):
//
//   - `"copy"` (or no `meta.ownership` at all) — the primitive/bytes value
//     crosses by its structural Deno FFI type (`denoFfiType`'s primitive
//     table). Struct/object-shaped copies throw (see above).
//   - `"opaque-handle"`, `"refcount"`, and `"resource"` (own/borrow) all
//     collapse to the same Deno-side representation: `"pointer"`. This is
//     Deno FFI's own structural fact: `Deno.dlopen`'s raw calling convention
//     has no ownership model of its own (no inc/dec-refcount hook, no
//     lend-count/trap runtime the way WIT's Canonical ABI has), so each of
//     these three disciplines is, at the raw symbol-table level, an opaque
//     native handle represented as `pointer` — the same conclusion
//     gleam.ts's file header reaches for why ownership metadata doesn't
//     gate/branch its own codegen (JS/Gleam has nothing an ownership
//     qualifier could attach to), extended here to Deno's raw-pointer FFI
//     layer specifically. Ownership metadata still shapes this file's
//     output in one place: `"opaque-handle"`'s `freeFn` field (index.ts's
//     `OwnershipDiscipline`) is what changes generated code shape — when
//     present (or for any resource at all, see `buildResourceGroup` below,
//     mirroring rust-c-abi.ts's own unconditional per-resource
//     free-function emission), an explicit `<resource>Free` wrapper calling
//     the paired free symbol is synthesized. `"refcount"`/`"resource"`
//     carry no equivalent function name in today's schema (index.ts defines
//     `freeFn` only on the `opaque-handle` variant), so no such wrapper is
//     synthesized for them.

function toCamelCase(name: string): string {
  const snake = toSnakeCase(name);
  return snake.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function toPascalCase(name: string): string {
  const camel = toCamelCase(name);
  return camel.length === 0 ? camel : camel[0]!.toUpperCase() + camel.slice(1);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** Deno's documented FFI pointer representation ("as of Deno 1.31 the
 * JavaScript representation of `pointer` has become an opaque pointer
 * object or `null`") — aliased directly to Deno's real ambient
 * `Deno.PointerValue<T>` (declared in `lib.deno.ns.d.ts` as a branded
 * `PointerObject<T> = { readonly [brand]: T } | null`) rather than
 * hand-spelling the docs page's prose description as a literal union: a
 * hand-spelled `{} | null` is missing the `[brand]` property Deno's own
 * `PointerObject` requires, so it fails to structurally match anywhere a
 * real `Deno.dlopen` symbol call expects a pointer argument (see
 * typescript-deno.test.ts's `deno check` compile-check suite). Emitted once
 * per generated file as a local alias. */
const POINTER_TYPE_ALIAS = "type Pointer = Deno.PointerValue";

const PRIMITIVE_DENO_TYPES: Readonly<Record<string, string>> = {
  boolean: "u8",
  integer: "i64",
  number: "f64",
  int8: "i8",
  int16: "i16",
  int32: "i32",
  int64: "i64",
  uint8: "u8",
  uint16: "u16",
  uint32: "u32",
  uint64: "u64",
  float32: "f32",
  float64: "f64",
  bytes: "buffer",
};

/** Deno FFI type -> the TS type a wrapper function's parameter/return
 * position should carry, per the Deno/C/Rust type table (see file
 * header). */
function tsTypeFor(denoType: string): string {
  if (denoType === "i64" || denoType === "u64" || denoType === "usize" || denoType === "isize")
    return "bigint";
  if (denoType === "void") return "void";
  // `BufferSource` (Deno's/the DOM lib's ambient `ArrayBufferView<ArrayBuffer>
  // | ArrayBuffer`), not `Uint8Array | null`: a `Uint8Array` alone doesn't
  // structurally match the real symbol call's `buffer`-typed parameter — its
  // `.buffer` is typed `ArrayBufferLike` (`ArrayBuffer | SharedArrayBuffer`),
  // which isn't assignable to `BufferSource`'s narrower `ArrayBuffer` (see
  // typescript-deno.test.ts's `deno check` compile-check suite).
  if (denoType === "buffer") return "BufferSource | null";
  if (denoType === "pointer") return "Pointer";
  return "number"; // i8/u8/i16/u16/i32/u32/f32/f64
}

function isVoidType(ref: TypeRef): boolean {
  return ref.shape.kind === "void" || ref.shape.kind === "null";
}

/**
 * The Deno FFI type string for one boundary position (a parameter's or
 * return's `TypeRef`), applying this target's ownership rule (see file
 * header):
 *   - `"opaque-handle"` / `"refcount"` / `"resource"` ownership — always
 *     `"pointer"`, regardless of which of the three; Deno's raw FFI layer
 *     draws no distinction between them (see file header).
 *   - `"copy"` or no ownership metadata — the structural primitive mapping.
 *     Throws for `"string"` (no native type, no established encoding
 *     convention — see file header) and for any shape kind outside the
 *     primitive/bytes table (e.g. `"object"`/`"array"` — native struct-by-
 *     value support exists in Deno but this minimal projector does not
 *     implement the C-ABI layout computation it requires; see file header).
 */
export function denoFfiType(ref: TypeRef): string {
  const discipline = ref.meta.ownership as OwnershipDiscipline | undefined;
  if (discipline !== undefined && discipline.kind !== "copy") return "pointer";

  const kind = ref.shape.kind;
  if (isVoidType(ref)) return "void";
  if (kind in PRIMITIVE_DENO_TYPES) return PRIMITIVE_DENO_TYPES[kind]!;

  if (kind === "string") {
    throw new Error(
      'denoFfiType: "string" has no native Deno FFI type and no established fractal C-ABI string convention to encode against ' +
        "(null-terminated pointer vs. pointer+length, and byte ownership, are all undecided — see this file's header) — " +
        "throwing rather than guessing an encoding",
    );
  }

  throw new Error(
    `denoFfiType: shape kind "${kind}" has no mapping in this minimal projector's primitive/bytes/pointer subset — ` +
      "Deno FFI can represent a by-value struct natively via `{ struct: [...] }`, but computing the required C-ABI " +
      "byte layout (field order, alignment, padding) is out of scope here; a full type-ir -> Deno-struct-layout " +
      "projector is separate, not-yet-done work",
  );
}

function libPathOf(meta: Readonly<Record<string, unknown>>, where: string): string {
  const libPath = meta.libPath;
  if (typeof libPath !== "string") {
    throw new Error(
      `toDenoFfi: "${where}" is missing required meta.libPath (the path/URL Deno.dlopen's first argument names, e.g. ` +
        '"./libexample.so") — there is no derivable default, so this must be supplied on the FfiRef\'s own meta bag ' +
        "(the same open-metadata-bag convention gleam.ts's meta.jsModule already established for its own target-specific, " +
        "schema-absent requirement)",
    );
  }
  return libPath;
}

type SymbolEntry = {
  readonly key: string;
  readonly parameters: readonly string[];
  readonly result: string;
};

type Wrapper = {
  readonly exportName: string;
  readonly symbolKey: string;
  readonly params: readonly { readonly name: string; readonly denoType: string }[];
  readonly resultDenoType: string;
  readonly docLines: readonly string[];
};

function docComment(meta: Readonly<Record<string, unknown>>): string[] {
  return typeof meta.description === "string" ? [`/** ${meta.description} */`] : [];
}

type FfiFunctionLike = {
  readonly params: readonly FfiParam[];
  readonly returnType: TypeRef;
};

/** Builds the symbol-table entry and wrapper-function description for one
 * `function`/`method` shape. `selfParam`, when given (a method's receiver
 * resource name), is prepended as a `"pointer"` parameter named `handle` —
 * mirrors rust-c-abi.ts's `buildFunction`'s identical `selfParam` convention
 * exactly, since the native symbol this calls into is the one rust-c-abi.ts
 * emits, which synthesizes that same leading handle parameter for every
 * method. */
function buildCallable(
  symbolKey: string,
  exportName: string,
  ref: FfiRef,
  shape: FfiFunctionLike,
  selfParam?: string,
): { symbol: SymbolEntry; wrapper: Wrapper } {
  const params: { name: string; denoType: string }[] = [];
  if (selfParam !== undefined) params.push({ name: "handle", denoType: "pointer" });
  for (const p of shape.params) {
    // `escapeJsIdent`: a wrapper param name is a real JS declaration-position
    // identifier (unlike `symbolKey` below, which is only ever used as an
    // object key or dot-property access — see `renderSymbolsObject`'s
    // comment for why that position needs no escaping).
    params.push({ name: escapeJsIdent(toCamelCase(p.name)), denoType: denoFfiType(p.type) });
  }
  const resultDenoType = isVoidType(shape.returnType) ? "void" : denoFfiType(shape.returnType);

  return {
    symbol: { key: symbolKey, parameters: params.map((p) => p.denoType), result: resultDenoType },
    wrapper: {
      exportName: escapeJsIdent(exportName),
      symbolKey,
      params,
      resultDenoType,
      docLines: docComment(ref.meta),
    },
  };
}

function renderSymbolsObject(symbols: readonly SymbolEntry[]): string {
  const lines = symbols.map(
    (s) =>
      `    ${quote(s.key)}: { parameters: [${s.parameters.map(quote).join(", ")}], result: ${quote(s.result)} },`,
  );
  return ["{", ...lines, "}"].join("\n");
}

function renderWrapper(libVar: string, w: Wrapper): string {
  const params = w.params.map((p) => `${p.name}: ${tsTypeFor(p.denoType)}`).join(", ");
  const args = w.params.map((p) => p.name).join(", ");
  const returnTs = tsTypeFor(w.resultDenoType);
  const call = `${libVar}.symbols.${w.symbolKey}`; // symbol keys are always snake_case identifiers (from toSnakeCase), valid as plain property access
  const body =
    w.resultDenoType === "void" ? `  ${call}(${args})` : `  return ${call}(${args}) as ${returnTs}`;
  return [
    ...w.docLines,
    `export function ${w.exportName}(${params}): ${returnTs} {`,
    body,
    "}",
  ].join("\n");
}

/** The paired free-function wrapper for a resource — synthesized
 * unconditionally per resource, mirroring rust-c-abi.ts's `buildResource`, which
 * emits `${resourceSnake}_free` unconditionally regardless of which
 * ownership discipline (if any) a given call site attaches to a reference
 * to this resource. `handle`'s Deno type is `"pointer"` unconditionally too
 * — see file header: opaque-handle/refcount/resource all collapse to
 * `"pointer"` at this raw layer, so the free wrapper's own signature does
 * not vary by discipline either. */
function buildFreeWrapper(resourceName: string): { symbol: SymbolEntry; wrapper: Wrapper } {
  const resourceSnake = toSnakeCase(resourceName);
  const symbolKey = `${resourceSnake}_free`;
  return {
    symbol: { key: symbolKey, parameters: ["pointer"], result: "void" },
    wrapper: {
      exportName: escapeJsIdent(`${toCamelCase(resourceName)}Free`),
      symbolKey,
      params: [{ name: "handle", denoType: "pointer" }],
      resultDenoType: "void",
      docLines: [
        `/** Releases a ${resourceName} handle — pairs with rust-c-abi.ts's synthesized \`${symbolKey}\` export. */`,
      ],
    },
  };
}

function buildResourceGroup(
  name: string,
  ref: FfiRef,
  shape: FfiKinds["resource"],
): { symbols: SymbolEntry[]; wrappers: Wrapper[] } {
  const resourceSnake = toSnakeCase(name);
  const symbols: SymbolEntry[] = [];
  const wrappers: Wrapper[] = [];

  for (const [methodName, methodRef] of Object.entries(shape.methods)) {
    if (methodRef.shape.kind !== "method" && methodRef.shape.kind !== "function") {
      throw new Error(
        `toDenoFfi: resource "${name}"'s method "${methodName}" has shape kind "${methodRef.shape.kind}", not "method"/"function"`,
      );
    }
    const methodShape = methodRef.shape as FfiFunctionLike;
    const symbolKey = `${resourceSnake}_${toSnakeCase(methodName)}`;
    const exportName = `${toCamelCase(name)}${toPascalCase(methodName)}`;
    const { symbol, wrapper } = buildCallable(symbolKey, exportName, methodRef, methodShape, name);
    symbols.push(symbol);
    wrappers.push(wrapper);
  }

  const free = buildFreeWrapper(name);
  symbols.push(free.symbol);
  wrappers.push(free.wrapper);

  void ref; // resource-level meta (e.g. description) is not currently surfaced per-group; kept for signature symmetry with sibling builders
  return { symbols, wrappers };
}

function renderModuleOrGroup(
  libVar: string,
  libPath: string,
  symbols: readonly SymbolEntry[],
  wrappers: readonly Wrapper[],
): string {
  const lib = `const ${libVar} = Deno.dlopen(${quote(libPath)}, ${renderSymbolsObject(symbols)})`;
  const wrapperCode = wrappers.map((w) => renderWrapper(libVar, w));
  return [POINTER_TYPE_ALIAS, "", lib, "", ...wrapperCode].join("\n");
}

/**
 * Lower one ffi-ir `FfiRef` to Deno FFI consumer TypeScript source — a
 * `Deno.dlopen` call plus one exported wrapper function per exported
 * function/resource-method (and, per resource, one paired free-function
 * wrapper — see `buildFreeWrapper`).
 *
 *   - `function` -> its own single-symbol `Deno.dlopen` call plus one
 *     wrapper (requires `name`, mirroring rust-c-abi.ts's/wasm-bindgen.ts's
 *     identical requirement — a symbol's name lives as the key in the
 *     enclosing `module.functions` map, not on the shape itself. requires
 *     `meta.libPath`, see `libPathOf`).
 *   - `method` -> the same, plus a synthesized `handle: Pointer` first
 *     parameter matching rust-c-abi.ts's receiver convention (requires `name`
 *     and `meta.libPath`).
 *   - `resource` -> one `Deno.dlopen` call grouping every declared method's
 *     symbol plus the paired free-function symbol, with one wrapper per
 *     method plus the free wrapper (requires `meta.libPath`; `name`, if
 *     given, is ignored — the shape carries its own `name` field).
 *   - `module` -> one `Deno.dlopen` call grouping all of its functions' and
 *     all of its resources' methods'/free-functions' symbols together (a
 *     module is one FFI boundary sharing one native library, so one shared
 *     `lib` handle is the natural mapping — unlike the single-item
 *     `Deno.dlopen` calls the standalone function/method/resource cases
 *     synthesize, which are independently valid per Deno's API but would
 *     reopen the same library once per symbol if used for a whole module).
 *
 * Throws — never silently degrades — for: `"string"`-typed or struct
 * (`"object"`/other non-primitive)-typed values anywhere in a crossed
 * `TypeRef` (see `denoFfiType`), a `function`/`method` shape called without
 * a `name`, and any `FfiRef` missing the required `meta.libPath` convention
 * (see `libPathOf`).
 */
export function toDenoFfi(ref: FfiRef, name?: string): string {
  const kind = ref.shape.kind;

  if (kind === "module") {
    const shape = ref.shape as FfiKinds["module"];
    const libPath = libPathOf(ref.meta, shape.name);
    const symbols: SymbolEntry[] = [];
    const wrappers: Wrapper[] = [];

    for (const [fnName, fnRef] of Object.entries(shape.functions)) {
      if (fnRef.shape.kind !== "function" && fnRef.shape.kind !== "method") {
        throw new Error(
          `toDenoFfi: module "${shape.name}"'s function "${fnName}" has shape kind "${fnRef.shape.kind}", not "function"/"method"`,
        );
      }
      const fnShape = fnRef.shape as FfiFunctionLike;
      const { symbol, wrapper } = buildCallable(
        toSnakeCase(fnName),
        toCamelCase(fnName),
        fnRef,
        fnShape,
      );
      symbols.push(symbol);
      wrappers.push(wrapper);
    }

    for (const [resName, resRef] of Object.entries(shape.resources)) {
      if (resRef.shape.kind !== "resource") {
        throw new Error(
          `toDenoFfi: module "${shape.name}"'s resource "${resName}" has shape kind "${resRef.shape.kind}", not "resource"`,
        );
      }
      const { symbols: resSymbols, wrappers: resWrappers } = buildResourceGroup(
        resName,
        resRef,
        resRef.shape as FfiKinds["resource"],
      );
      symbols.push(...resSymbols);
      wrappers.push(...resWrappers);
    }

    return renderModuleOrGroup("lib", libPath, symbols, wrappers);
  }

  if (kind === "function") {
    if (name === undefined) {
      throw new Error(
        'toDenoFfi: "function" requires a name — a Deno FFI symbol is a named entry, not an anonymous inline type',
      );
    }
    const shape = ref.shape as FfiShape & { kind: "function" };
    const libPath = libPathOf(ref.meta, name);
    const { symbol, wrapper } = buildCallable(toSnakeCase(name), toCamelCase(name), ref, shape);
    return renderModuleOrGroup("lib", libPath, [symbol], [wrapper]);
  }

  if (kind === "method") {
    if (name === undefined) {
      throw new Error(
        "toDenoFfi: \"method\" requires a name — the method's own key in its resource's methods map",
      );
    }
    const shape = ref.shape as FfiShape & { kind: "method" };
    const libPath = libPathOf(ref.meta, name);
    const symbolKey = `${toSnakeCase(shape.receiver)}_${toSnakeCase(name)}`;
    const exportName = `${toCamelCase(shape.receiver)}${toPascalCase(name)}`;
    const { symbol, wrapper } = buildCallable(symbolKey, exportName, ref, shape, shape.receiver);
    return renderModuleOrGroup("lib", libPath, [symbol], [wrapper]);
  }

  if (kind === "resource") {
    const shape = ref.shape as FfiKinds["resource"];
    const libPath = libPathOf(ref.meta, shape.name);
    const { symbols, wrappers } = buildResourceGroup(shape.name, ref, shape);
    return renderModuleOrGroup("lib", libPath, symbols, wrappers);
  }

  throw new Error(
    `toDenoFfi: unhandled ffi-ir kind "${kind}" — no Deno FFI mapping implemented for this backend`,
  );
}
