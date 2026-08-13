import { resolve, type TypeRef } from "@rhi-zone/fractal-type-ir";
import type { FfiRef, FfiShape, OwnershipDiscipline } from "./index.ts";

// Bun (`bun:ffi`) consumer projector — the JS-side counterpart to
// `rust-c-abi.ts`: where `rust-c-abi.ts` emits the Rust *producer* of a plain C ABI
// (`extern "C"`, `#[repr(C)]`), this file emits the TypeScript *consumer*
// loader code that calls INTO that same shared library from a Bun process,
// via `bun:ffi`'s `dlopen`. Both files target the identical wire boundary —
// a plain, non-WIT, non-wasm-bindgen C ABI — so the ownership-discipline
// scope decisions below are made relative to `rust-c-abi.ts`'s own decisions
// (documented there), not re-derived from scratch.
//
// `bun:ffi` API surface, verified two ways (not carried over from memory):
//   1. `dlopen(path, symbols)` signature and the symbol-descriptor shape
//      (`{ [name]: { args: FFIType[], returns: FFIType } }`) — via WebFetch
//      against https://bun.com/docs/runtime/ffi, 2026-08-03.
//   2. The exact, complete `FFIType` token vocabulary — via direct runtime
//      introspection of the Bun 1.3.9 binary actually installed in this
//      project's environment (`bun -e 'console.log(require("bun:ffi").FFIType)'`,
//      2026-08-03), which is authoritative over the docs page for this
//      question and resolved one real ambiguity the docs page left open (see
//      below). The full enum, by value: `char`(0) `i8`(1) `u8`(2) `i16`(3)
//      `u16`(4) `i32`/`int`/`c_int`(5) `u32`/`uint`/`c_uint`(6)
//      `i64`/`isize`(7) `u64`/`usize`(8) `f64`/`double`(9) `f32`/`float`(10)
//      `bool`(11) `ptr`/`pointer`/`void*`(12) `void`(13) `cstring`(14)
//      `i64_fast`(15) `u64_fast`(16) `function`/`fn`/`callback`(17)
//      `napi_env`(18) `napi_value`(19) `buffer`(20).
//   - Ambiguity resolved by the runtime check: the docs page's own prose
//     table never lists a `void` token (only ever discussing `void` in
//     passing, e.g. "you may declare a non-`void` returns" for
//     `JSCallback`), leaving genuinely unclear whether a void-returning
//     function's `returns` field should be omitted, `undefined`, or some
//     other convention. The runtime enum confirms `"void"` (13) IS a real,
//     distinct `FFIType` token (separate from `ptr`/12) — so void returns
//     are emitted as `returns: "void"` below, not omitted.
//   - No struct type exists anywhere in this enum (confirmed by the complete
//     list above, cross-checked against the docs page, which states plainly
//     that struct-by-value has no direct mapping and must be passed via
//     manual pointers). `bun:ffi` remains, in this respect, exactly as
//     experimental/limited as this session's earlier research flagged —
//     nothing has changed. `toBunFfiType` below throws explicitly for any
//     shape that would require struct-by-value (or any other
//     non-token-representable encoding) rather than guessing a lossy one.
//
// Ownership-discipline scope for this target (mirrors `rust-c-abi.ts`'s own
// "discipline-per-target: decided" reasoning, applied to the SAME C ABI
// `rust-c-abi.ts` targets, viewed from the calling side rather than the producer
// side):
//   - `undefined` (no `meta.ownership`) or `"copy"` — plain by-value,
//     `toBunFfiType` maps the underlying primitive kind directly.
//   - `"opaque-handle"` — `"ptr"`, regardless of the referenced TypeRef's own
//     structural kind (mirrors `toRustCAbiType`'s `*mut <T>` — at the raw ABI,
//     the pointee's Rust-side layout is invisible to a JS caller either way).
//   - `"refcount"` — ALSO `"ptr"`, and deliberately NOT gated the way
//     `rust-c-abi.ts` gates it. `rust-c-abi.ts` throws on `refcount` because that file
//     has to *generate the free-function/bookkeeping implementation itself*,
//     and plain C has no native refcount mechanism to generate correct code
//     for. This file generates no implementation at all — only a `dlopen`
//     symbol-type declaration — and at that level a refcounted handle
//     crosses the C ABI exactly the same way an opaque handle does: a raw
//     pointer (e.g. `Arc::into_raw`/`Box::into_raw` are both `*const/*mut T`
//     at the ABI). The loader code is genuinely identical regardless of
//     which of these two disciplines a given handle uses; forcing a
//     `rust-c-abi.ts`-style throw here would be gating on a distinction that
//     doesn't exist at this layer, not preserving a real one. (This is the
//     same "same reasoning, different conclusion per file" latitude
//     `gleam.ts`/`rescript.ts` already took relative to `wasm-bindgen.ts`/
//     `melange.ts` for the identical four-discipline question, documented in
//     their own file headers.)
//   - `"resource"` (WIT's own/borrow) — THROWS. This is WIT's Canonical ABI
//     mechanism specifically: a resource crosses as an `i32` handle-table
//     index into a per-instance table with lend-count tracking, NOT a raw
//     memory pointer — a fundamentally different wire representation than
//     anything a plain `dlopen`'d C shared library (which never speaks the
//     Canonical ABI) can produce or consume. This matches `rust-c-abi.ts`'s own
//     scope decision for the identical discipline, for the identical reason
//     (no such mechanism exists on this wire boundary) — not a new gate
//     invented for this file.

// Duplicated across every projector file in this package (see `rust-c-abi.ts`'s
// identical copy) — `toSnakeCase` here MUST match `rust-c-abi.ts`'s symbol-naming
// convention exactly, since this file's whole job is binding against symbols
// that convention actually produced in the compiled library.
function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

const JS_RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "await",
  "async",
]);

function escapeJsIdent(name: string): string {
  return JS_RESERVED.has(name) ? `${name}_` : name;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * The `bun:ffi` `FFIType` string token for one boundary position (a
 * parameter's or return's `TypeRef`), applying the same C-ABI ownership rule
 * `toRustCAbiType` (`rust-c-abi.ts`) applies, from the consumer side — see the
 * file-level doc comment for the full reasoning on each discipline.
 */
export function toBunFfiType(ref: TypeRef): string {
  const discipline = ref.meta.ownership as OwnershipDiscipline | undefined;
  if (discipline?.kind === "opaque-handle" || discipline?.kind === "refcount") return "ptr";
  if (discipline?.kind === "resource") {
    throw new Error(
      `toBunFfiType: unsupported ownership discipline "resource" (own/borrow) for the bun:ffi target — ` +
        "that is WIT's Canonical ABI handle-table mechanism (an i32 index with lend-count tracking), not a raw " +
        "C-ABI pointer; a plain dlopen'd shared library (what bun:ffi loads) never speaks that ABI, matching " +
        "rust-c-abi.ts's identical scope decision for the same discipline on the same wire boundary",
    );
  }
  // discipline is undefined or "copy" beyond this point — plain by-value.
  return resolve(ref.shape.kind, primitiveHandlers) ?? unsupportedKind(ref.shape.kind);
}

function unsupportedKind(kind: string): never {
  throw new Error(
    `toBunFfiType: unhandled kind "${kind}" — bun:ffi's FFIType vocabulary has no token for this shape ` +
      "(no struct-by-value, tuple, map, union, or nested-container type exists in its documented/introspected " +
      "type table; a value needing one of those crosses only as a manual pointer + hand-written marshalling code, " +
      "which this minimal generator does not attempt rather than guess a lossy encoding)",
  );
}

// Minimal primitive-kind -> FFIType mapping. Deliberately NOT a full
// TypeShape Converter table the way wasm-bindgen.ts's `handlers` is — bun:ffi
// has no compound-type tokens at all (see file header), so there is no
// struct/enum-hoisting path to build; every non-primitive kind is simply
// unsupported.
const primitiveHandlers: Record<string, string> = {
  boolean: "bool",
  number: "f64",
  integer: "i64",
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
  string: "cstring",
  uuid: "cstring",
  uri: "cstring",
  email: "cstring",
  datetime: "cstring",
  date: "cstring",
  time: "cstring",
  duration: "cstring",
  bytes: "buffer",
  null: "void",
  void: "void",
};

function docComment(indent: string, meta: Readonly<Record<string, unknown>>): string[] {
  return typeof meta.description === "string" ? [`${indent}// ${meta.description}`] : [];
}

type FfiFunctionLike = {
  readonly params: readonly { readonly name: string; readonly type: TypeRef }[];
  readonly returnType: TypeRef;
};

/** One symbol-table entry (`name: { args: [...], returns: ... }`, the value
 * half of `dlopen`'s second argument) for a `function`/`method` shape.
 * `selfParam`, when true, prepends the synthesized `"ptr"` receiver
 * parameter — mirrors `rust-c-abi.ts`'s `buildFunction`'s identical `selfParam`
 * handling for a resource method's implicit handle. */
function buildSymbolEntry(symbolName: string, shape: FfiFunctionLike, selfParam: boolean): string {
  const args: string[] = [];
  if (selfParam) args.push(quote("ptr"));
  for (const p of shape.params) args.push(quote(toBunFfiType(p.type)));
  const returns = quote(toBunFfiType(shape.returnType));
  // The key MUST be the literal native symbol name `dlopen` looks up via
  // `dlsym` (verified against bun.com/docs/runtime/ffi, 2026-08-03: "the
  // KEY in the symbols object ... must exactly match the native exported
  // symbol name" — no separate lookup-name field exists, unlike
  // `linkSymbols`'s explicit aliasing). Always string-quoted (`quote`, not
  // `escapeJsIdent`) rather than emitted as a bare identifier — escaping a
  // reserved-word-shaped symbol name would silently change the string
  // dlsym looks up (e.g. turning a real exported symbol literally named
  // `new` into a lookup for `new_`, which doesn't exist in the library).
  // A quoted string key sidesteps both that risk and the separate
  // "starts with a digit"/non-identifier-shaped-name case, at no cost —
  // JS object literals accept any string as a quoted key.
  return `  ${quote(symbolName)}: { args: [${args.join(", ")}], returns: ${returns} },`;
}

/** The thin exported wrapper function calling through `symbols.<symbolName>`
 * — `wrapperName` is the ffi-ir map key (already an idiomatic JS
 * identifier), `symbolName` is the raw C-ABI export name `rust-c-abi.ts` actually
 * produced (may differ, e.g. snake_case vs camelCase). */
function buildWrapper(
  wrapperName: string,
  symbolName: string,
  ref: FfiRef,
  shape: FfiFunctionLike,
  selfParam?: string,
): string {
  const params: string[] = [];
  if (selfParam !== undefined) params.push(`handle: number /* ${selfParam} */`);
  for (const p of shape.params) params.push(`${escapeJsIdent(p.name)}: unknown`);

  const args = [
    ...(selfParam !== undefined ? ["handle"] : []),
    ...shape.params.map((p) => escapeJsIdent(p.name)),
  ];

  const lines: string[] = [...docComment("", ref.meta)];
  lines.push(`export function ${escapeJsIdent(wrapperName)}(${params.join(", ")}) {`);
  // Bracket + quoted access, same reason the symbol-entry key above is
  // quoted rather than emitted as a bare/escaped identifier — `symbolName`
  // must reach `dlsym` unmodified.
  lines.push(`  return symbols[${quote(symbolName)}](${args.join(", ")})`);
  lines.push("}");
  return lines.join("\n");
}

/** Collected `{ entries, wrappers }` for one `function`/`method`/`resource`
 * shape, gathering everything that needs to land in ONE shared `dlopen`
 * symbol map — the aggregation step `toBunModule` needs for its single
 * `dlopen` call, and that a standalone `toBun` call for a bare function/
 * resource also reuses (so both paths share one code path rather than
 * diverging). */
function collect(ref: FfiRef, name: string): { entries: string[]; wrappers: string[] } {
  const kind = ref.shape.kind;

  if (kind === "function") {
    const shape = ref.shape as FfiShape & { kind: "function" };
    const symbolName = toSnakeCase(name);
    return {
      entries: [buildSymbolEntry(symbolName, shape, false)],
      wrappers: [buildWrapper(name, symbolName, ref, shape)],
    };
  }

  if (kind === "resource") {
    const shape = ref.shape as FfiShape & {
      kind: "resource";
      name: string;
      methods: Readonly<Record<string, FfiRef>>;
    };
    const resourceSnake = toSnakeCase(shape.name);
    const entries: string[] = [];
    const wrappers: string[] = [];

    for (const [methodName, methodRef] of Object.entries(shape.methods)) {
      const methodShape = methodRef.shape as FfiShape & { kind: "method" };
      const symbolName = `${resourceSnake}_${toSnakeCase(methodName)}`;
      entries.push(buildSymbolEntry(symbolName, methodShape, true));
      wrappers.push(
        buildWrapper(`${shape.name}_${methodName}`, symbolName, methodRef, methodShape, shape.name),
      );
    }

    // The paired free function `rust-c-abi.ts`'s `buildResource` always emits
    // (`buildFreeFunction`, `<resource>_free`) — a real exported symbol in
    // the compiled library this file's whole job is to bind against, so
    // omitting it would leave callers with no way to ever release a handle.
    const freeSymbol = `${resourceSnake}_free`;
    entries.push(`  ${quote(freeSymbol)}: { args: [${quote("ptr")}], returns: ${quote("void")} },`);
    wrappers.push(
      [
        `export function ${escapeJsIdent(shape.name)}_free(handle: number) {`,
        `  return symbols[${quote(freeSymbol)}](handle)`,
        "}",
      ].join("\n"),
    );

    return { entries, wrappers };
  }

  throw new Error(
    `toBun: unhandled ffi-ir kind "${kind}" for collect() — only "function" and "resource" contribute dlopen symbols`,
  );
}

/**
 * Lower one ffi-ir `FfiRef` to `bun:ffi` TypeScript loader source — a single
 * `dlopen(libPath, { ... })` call plus one thin exported wrapper per
 * function/method, plus (for a `resource`) its paired `_free` wrapper.
 * `libPath` is required unconditionally: `dlopen`'s first argument is the
 * actual shared-library path, which nothing in `FfiRef` carries (ffi-ir
 * models the boundary shape, not deployment paths) — this is a real,
 * load-bearing parameter of the API being wrapped, not an invented one.
 *
 *   - `function` -> one symbol entry + one wrapper.
 *   - `method` -> `toBun` requires it be reached via its enclosing
 *     `resource` (a bare `method` names a `receiver` by string but carries
 *     no way to know that resource's *other* methods or its free function,
 *     so — mirroring `rust-c-abi.ts`'s `method`-requires-`name` precedent — a
 *     bare `method` here throws, directing the caller to project the whole
 *     `resource` instead).
 *   - `resource` -> opaque-handle pointer passthrough for every method's
 *     receiver (`ptr`), plus the paired `_free` wrapper.
 *   - `module` -> one `dlopen` call grouping every contained function's and
 *     every contained resource's methods' symbols — this is bun:ffi's own
 *     hard constraint driving the design (`dlopen` loads the whole shared
 *     library in one call; one entry per exported symbol needed from it),
 *     not an arbitrary choice.
 */
export function toBun(ref: FfiRef, libPath: string, name?: string): string {
  const kind = ref.shape.kind;

  if (kind === "method") {
    throw new Error(
      'toBun: a bare "method" cannot be projected on its own — project its enclosing "resource" instead, ' +
        "so its receiver's other methods and paired free function land in the same dlopen call",
    );
  }

  if (kind === "function") {
    if (name === undefined) {
      throw new Error(
        'toBun: "function" requires a name — a dlopen symbol is a named export, not an anonymous inline type',
      );
    }
    const { entries, wrappers } = collect(ref, name);
    return renderModule(libPath, entries, wrappers);
  }

  if (kind === "resource") {
    const shape = ref.shape as FfiShape & { kind: "resource"; name: string };
    const { entries, wrappers } = collect(ref, shape.name);
    return renderModule(libPath, entries, wrappers);
  }

  if (kind === "module") {
    const shape = ref.shape as FfiShape & {
      kind: "module";
      name: string;
      functions: Readonly<Record<string, FfiRef>>;
      resources: Readonly<Record<string, FfiRef>>;
    };
    const entries: string[] = [];
    const wrappers: string[] = [];
    for (const [fnName, fnRef] of Object.entries(shape.functions)) {
      const r = collect(fnRef, fnName);
      entries.push(...r.entries);
      wrappers.push(...r.wrappers);
    }
    for (const [, resRef] of Object.entries(shape.resources)) {
      const resShape = resRef.shape as FfiShape & { kind: "resource"; name: string };
      const r = collect(resRef, resShape.name);
      entries.push(...r.entries);
      wrappers.push(...r.wrappers);
    }
    return renderModule(libPath, entries, wrappers);
  }

  throw new Error(
    `toBun: unhandled ffi-ir kind "${kind}" — no bun:ffi mapping implemented for this backend`,
  );
}

function renderModule(libPath: string, entries: string[], wrappers: string[]): string {
  const lines: string[] = [
    'import { dlopen } from "bun:ffi"',
    "",
    `const { symbols } = dlopen(${quote(libPath)}, {`,
    ...entries,
    "})",
    "",
    ...wrappers.flatMap((w, i) => (i === 0 ? [w] : ["", w])),
  ];
  return lines.join("\n");
}
