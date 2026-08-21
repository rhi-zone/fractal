import type { TypeRef } from "@rhi-zone/fractal-type-ir";
import { toSnakeCaseStripSeparators as toSnakeCase } from "@rhi-zone/fractal-type-ir/codegen-helpers";
import type { FfiRef, FfiShape, OwnershipDiscipline } from "./index.ts";

// Python ctypes projector — Python source (a `ctypes.CDLL` load, per-function
// `.argtypes`/`.restype` declarations, and thin wrapper functions/classes)
// for the consumer side of a plain-C FFI boundary. This is the mirror image
// of `rust-c-abi.ts` (which emits the Rust/cbindgen producer side of the same
// boundary): where `rust-c-abi.ts` emits the shared library, this file emits the
// Python code that dlopen()s it and calls in.
//
// Every API fact below is sourced from Python's own official docs
// (docs.python.org/3/library/ctypes.html), specifically:
//   - Loading: `ctypes.CDLL(path)` (also `ctypes.cdll.LoadLibrary(path)`,
//     equivalent) — "instantiate CDLL ... to load shared libraries into the
//     Python process."
//   - Per-function signatures: "the required argument types of functions
//     exported from DLLs" are set via the function object's own `argtypes`
//     attribute (a list); "other return types can be specified by setting
//     the restype attribute of the function object" (default is C `int`).
//     Both are documented as being set directly on `lib.funcname`, e.g.
//     `printf.argtypes = [c_char_p, ...]; printf.restype = c_int`.
//   - Primitive vocabulary confirmed from the docs' ctypes-type table:
//     `c_bool`, `c_char`, `c_wchar`, `c_byte`/`c_ubyte`, `c_short`/`c_ushort`,
//     `c_int`, `c_int8`/`c_int16`/`c_int32`/`c_int64` (and unsigned
//     counterparts), `c_long`/`c_ulong`, `c_longlong`/`c_ulonglong`,
//     `c_size_t`/`c_ssize_t`, `c_float`, `c_double`, `c_longdouble`,
//     `c_char_p` (`char*`, NUL-terminated, Python `bytes`/`None`),
//     `c_wchar_p` (`wchar_t*`, Python `str`/`None`), `c_void_p` (`void*`,
//     Python `int`/`None`).
//   - Structs: "Structures ... must derive from the Structure ... base
//     class[.] Each subclass must define a `_fields_` attribute[, which]
//     must be a list of 2-tuples, containing a field name and a field type."
//   - Opaque/incomplete types: the docs' own "Incomplete Types" section
//     forward-declares a struct as `class cell(Structure): pass` (no
//     `_fields_` at all) precisely because the class name must exist before
//     `_fields_` can reference it recursively; the same `class Name(Structure):
//     pass` form — left permanently without `_fields_` — is the documented
//     shape for a type that is only ever handled behind a pointer, never
//     dereferenced by name, which is exactly cbindgen/C's own opaque-pointer
//     convention `rust-c-abi.ts` already emits on the producer side (its
//     `#[repr(C)] pub struct Name { _private: [u8; 0] }`). This projector
//     mirrors that with `class Name(Structure): pass` + `POINTER(Name)` for
//     the handle type, rather than a bare untyped `c_void_p`, so that two
//     different resources' handles remain distinct Python/ctypes types (the
//     same distinctness cbindgen's per-resource opaque struct gives on the
//     Rust side) rather than all collapsing to interchangeable raw `void*`.
//   - Ownership: ctypes itself has no ownership or reference-counting model
//     — it is confirmed to be "low-level access to native libraries ...
//     bypassing Python's safety mechanisms," and its own docs' one lifetime
//     warning (on `CFUNCTYPE` callback objects) is about the *caller* being
//     responsible for keeping Python-side references alive, not about any
//     ctypes-managed ownership discipline for values crossing the boundary.
//     Consequently — see `toCtypesType` below — every `OwnershipDiscipline`
//     other than `"copy"` (`"opaque-handle"`, `"refcount"`, `"resource"`)
//     produces the same ctypes declaration: a pointer. ctypes has no
//     type-level way to express "this pointer is refcounted" or "this
//     pointer is owned vs. borrowed" — that bookkeeping is either done by
//     the C library itself (refcount) or simply isn't checked at all
//     (resource own/borrow, absent a host runtime — same point `rust-c-abi.ts`'s
//     own file header makes about plain C generally). All three disciplines
//     collapse to this one declaration.
//
// This is the only projector in this package targeting Python rather than
// Rust, so `rust-c-abi.ts`/`wasm-bindgen.ts`'s Rust-specific helpers (identifier
// escaping, snake_case conversion) don't apply here. Python identifier rules
// and keyword list are re-derived below, self-contained (each projector file
// owns its own copy of these small helpers).

// Python 3 reserved keywords (https://docs.python.org/3/reference/lexical_analysis.html#keywords)
// — cannot appear as a plain identifier.
const PY_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

/** Escapes a Python identifier that collides with a reserved keyword using a
 * trailing underscore (`class_`, `type_`) — PEP 8's own documented
 * convention for this exact situation ("single trailing underscore ... used
 * by convention to avoid conflicts with Python keyword"), the Python
 * analogue of `rust-c-abi.ts`'s raw-identifier (`r#type`) escape. */
function escapePyIdent(name: string): string {
  return PY_KEYWORDS.has(name) ? `${name}_` : name;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function docComment(indent: string, meta: Readonly<Record<string, unknown>>): string[] {
  return typeof meta.description === "string" ? [`${indent}# ${meta.description}`] : [];
}

/**
 * The ctypes-level ctype expression for one boundary position (a
 * parameter's or return's `TypeRef`), applying the same ownership rule
 * `rust-c-abi.ts`'s `toRustCAbiType` applies for the producer side, but collapsed to
 * ctypes' own vocabulary (see file header for why every non-`"copy"`
 * discipline collapses to the same pointer form):
 *   - no `meta.ownership` at all, or `{ kind: "copy" }` — the plain by-value
 *     ctypes primitive/struct expression from `toCtypesShape` below.
 *   - `{ kind: "opaque-handle" }` / `{ kind: "refcount" }` /
 *     `{ kind: "resource", mode }` — `POINTER(<T>)`, where `<T>` is the same
 *     base expression, matching `rust-c-abi.ts`'s `*mut <T>` on the producer
 *     side. ctypes has no construct distinguishing these three at the
 *     type-declaration level (see file header); all three produce this one
 *     form, explicitly, rather than three near-duplicate cases.
 *
 * Never throws for a data-shape kind ctypes truly can't represent (arrays
 * without a length convention, tagged unions without a discriminant,
 * intersections, etc.) here — that's `toCtypesShape`'s job, which throws.
 */
export function toCtypesType(ref: TypeRef): string {
  const discipline = ref.meta.ownership as OwnershipDiscipline | undefined;
  const base = toCtypesShape(ref);
  if (discipline === undefined || discipline.kind === "copy") return base;
  if (
    discipline.kind === "opaque-handle" ||
    discipline.kind === "refcount" ||
    discipline.kind === "resource"
  ) {
    return `POINTER(${base})`;
  }
  // Exhaustiveness guard — OwnershipDiscipline is a closed union in index.ts;
  // this branch is unreachable for any value constructible via `ownership.*`.
  throw new Error(
    `toCtypesType: unhandled ownership discipline "${(discipline as { kind: string }).kind}"`,
  );
}

/**
 * The by-value ctypes expression for a type-ir `TypeShape`, ignoring
 * ownership (see `toCtypesType`, which applies the pointer wrap on top of
 * this). Covers the primitive/struct/ref subset ctypes can marshal;
 * throws for shapes with no native C-ABI representation ctypes itself defines
 * (`array`/`tuple`/`map`/`union`/`intersection`/`enum`/`stream`/`page`/
 * `instance`/`unknown`/`never`), matching `rust-c-abi.ts`'s own throw-not-degrade
 * convention for shapes outside its target's representable subset.
 */
export function toCtypesShape(ref: TypeRef): string {
  const shape = ref.shape;
  switch (shape.kind) {
    case "boolean":
      return "c_bool";
    case "integer":
      return "c_int64";
    case "number":
      return "c_double";
    case "string":
      // char* — the C-ABI string convention (NUL-terminated bytes), matching
      // this package's convention of treating a boundary `TypeRef` as
      // crossing at the raw-C level, not a Python-native `str`. `c_char_p`
      // marshals as Python `bytes`/`None` per the docs (see file header).
      return "c_char_p";
    case "null":
    case "void":
      return "None";
    case "object": {
      const typeName = ref.meta.typeName;
      if (typeof typeName !== "string") {
        throw new Error(
          'toCtypesShape: an "object" TypeRef requires meta.typeName naming the Structure class declared for it — ctypes.Structure fields need a class name, and this shape carries no name of its own at this position',
        );
      }
      return typeName;
    }
    case "ref":
      // Bare pass-through of the referenced name, trusting a Structure (or
      // primitive alias) of that name is declared elsewhere — same
      // convention `rust-serde.ts`'s `ref` handler documents ("trusting a
      // struct of that name is declared/imported elsewhere").
      return (shape as { kind: "ref"; target: string }).target;
    default:
      throw new Error(
        `toCtypesShape: type-ir kind "${shape.kind}" has no ctypes representation this backend implements — ctypes marshals fixed C-ABI scalar/pointer/struct values only, with no native array-length, tagged-union, or map convention of its own`,
      );
  }
}

type FfiFunctionLike = {
  readonly params: readonly { readonly name: string; readonly type: TypeRef }[];
  readonly returnType: TypeRef;
};

/** One function's ctypes wiring: the `.argtypes`/`.restype` assignment on
 * the raw `lib.<fnName>` symbol, plus a thin Pythonic wrapper function with
 * the same name (escaped/snake_cased) that calls it — matching the way
 * hand-rolled ctypes wrapper modules (and generators such as ctypesgen)
 * structure bindings: the raw `CDLL` symbol stays reachable via `lib.*`, and
 * calling code is meant to use the wrapper. `selfParam`, when given, is the
 * synthesized `handle` parameter for a resource method (mirroring
 * `rust-c-abi.ts`'s `buildFunction`'s identical `selfParam` synthesis — ffi-ir's
 * `method` kind names its receiver by resource name only, carrying no
 * parameter of its own). The wrapper's body calls through to the loaded
 * library — ffi-ir carries only the signature, so there is no library-side
 * implementation to stub, unlike the producer-side `rust-c-abi.ts`/`wasm-bindgen.ts`
 * `todo!()` bodies. */
function buildFunction(
  fnName: string,
  ref: FfiRef,
  shape: FfiFunctionLike,
  selfParam?: string,
): string {
  const paramNames: string[] = [];
  const argtypes: string[] = [];
  if (selfParam !== undefined) {
    paramNames.push("handle");
    argtypes.push(`POINTER(${selfParam})`);
  }
  for (const p of shape.params) {
    const ident = escapePyIdent(toSnakeCase(p.name));
    paramNames.push(ident);
    argtypes.push(toCtypesType(p.type));
  }

  const isVoidReturn =
    shape.returnType.shape.kind === "void" || shape.returnType.shape.kind === "null";
  const restype = isVoidReturn ? "None" : toCtypesType(shape.returnType);

  // `getattr(lib, "<fnName>")`, not a bare `lib.<fnName>` dot-access — unlike
  // JS (where a reserved word is a legal property name after a dot, see
  // typescript-deno.ts's `symbolKey` comment for that case), Python's own
  // grammar rejects a keyword in attribute-access position too (`lib.class`
  // is a `SyntaxError`, not just an identifier-declaration error) — so the
  // native-symbol access needs the same "never render the raw name as a bare
  // identifier" treatment `typescript-bun.ts`'s quoted symbol-table keys use,
  // for a Python-specific reason. `fnName` itself is left unescaped here
  // (unlike `escapePyIdent(fnName)` below, used for the `def` line) so the
  // real native symbol `getattr` looks up is never altered by escaping.
  const symbolAccess = `getattr(lib, ${quote(fnName)})`;
  const defName = escapePyIdent(fnName);

  const lines: string[] = [...docComment("", ref.meta)];
  lines.push(`${symbolAccess}.argtypes = [${argtypes.join(", ")}]`);
  lines.push(`${symbolAccess}.restype = ${restype}`);
  lines.push("");
  lines.push(`def ${defName}(${paramNames.join(", ")}):`);
  lines.push(`    return ${symbolAccess}(${paramNames.join(", ")})`);
  return lines.join("\n");
}

/** The opaque-handle Structure declaration for a resource — see the file
 * header's "Incomplete Types" citation. Permanently incomplete (no
 * `_fields_` ever assigned): calling code only ever holds `POINTER(Name)`,
 * never dereferences the pointee, matching cbindgen's own opaque-pointer
 * convention that `rust-c-abi.ts`'s `buildOpaqueStruct` implements on the
 * producer side. */
function buildOpaqueStruct(name: string, ref: FfiRef): string {
  return [...docComment("", ref.meta), `class ${name}(Structure):`, "    pass"].join("\n");
}

/** A resource's method surface projected as a Python class: `__init__`
 * stores the raw `POINTER(Name)` handle, each method is a bound method
 * delegating to `lib.<resource>_<method>(self._handle, ...)`, and
 * `__del__` calls the paired free function — the free-function-per-resource
 * convention `rust-c-abi.ts`'s `buildFreeFunction` establishes on the producer
 * side (`<resource>_free`), assumed here by the same fixed-name convention
 * since ffi-ir's `resource` shape carries no `freeFn` of its own (only a
 * *reference's* `OwnershipDiscipline.freeFn` does, and no reference is in
 * scope at a resource declaration itself). This is the idiomatic
 * hand-rolled-ctypes-wrapper shape for an opaque handle (own the pointer,
 * expose methods, free on GC) — the mirror of a `cffi`/`ctypesgen` wrapper
 * class, not a bare function-taking-a-raw-handle style, so calling code
 * gets normal Python object semantics over the raw handle. */
function buildResourceClass(
  name: string,
  shape: FfiShape & { kind: "resource"; methods: Readonly<Record<string, FfiRef>> },
): string {
  const resourceSnake = toSnakeCase(name);
  const lines: string[] = [
    `class ${name}:`,
    "    def __init__(self, handle):",
    "        self._handle = handle",
    "",
  ];

  for (const [methodName, methodRef] of Object.entries(shape.methods)) {
    const methodShape = methodRef.shape as FfiShape & { kind: "method" };
    const pyMethodName = escapePyIdent(toSnakeCase(methodName));
    const paramNames = methodShape.params.map((p) => escapePyIdent(toSnakeCase(p.name)));
    const callArgs = ["self._handle", ...paramNames].join(", ");
    lines.push(
      `    def ${pyMethodName}(self${paramNames.length > 0 ? ", " + paramNames.join(", ") : ""}):`,
    );
    lines.push(`        return ${resourceSnake}_${toSnakeCase(methodName)}(${callArgs})`);
    lines.push("");
  }

  lines.push("    def __del__(self):");
  lines.push(`        ${resourceSnake}_free(self._handle)`);
  return lines.join("\n");
}

function buildResource(
  name: string,
  ref: FfiRef,
  shape: FfiShape & { kind: "resource"; methods: Readonly<Record<string, FfiRef>> },
): string {
  const resourceSnake = toSnakeCase(name);
  const decls: string[] = [buildOpaqueStruct(name, ref)];

  for (const [methodName, methodRef] of Object.entries(shape.methods)) {
    const methodShape = methodRef.shape as FfiShape & { kind: "method" };
    const fnName = `${resourceSnake}_${toSnakeCase(methodName)}`;
    decls.push(buildFunction(fnName, methodRef, methodShape, name));
  }

  // The paired free function's own argtypes/restype — no ffi-ir shape backs
  // it directly (same as `rust-c-abi.ts`'s `buildFreeFunction`, which likewise
  // synthesizes it rather than reading one from the IR), so its wiring is
  // emitted inline rather than routed through `buildFunction`.
  decls.push(
    [
      `lib.${resourceSnake}_free.argtypes = [POINTER(${name})]`,
      `lib.${resourceSnake}_free.restype = None`,
      "",
      `def ${resourceSnake}_free(handle):`,
      `    return lib.${resourceSnake}_free(handle)`,
    ].join("\n"),
  );

  decls.push(buildResourceClass(name, shape));
  return decls.join("\n\n");
}

/**
 * Lower one ffi-ir `FfiRef` to Python `ctypes` consumer source.
 *   - `function` -> `.argtypes`/`.restype` wiring + a thin wrapper function
 *     (requires `name`, mirroring `rust-c-abi.ts`'s identical requirement).
 *   - `method` -> the same, plus a synthesized `handle` first parameter
 *     (requires `name`, the method's own key in its resource's methods map).
 *   - `resource` -> the opaque `Structure` declaration, each method's
 *     wiring, the paired free-function wiring, and a Python class wrapping
 *     the handle (`name` argument, if given, is ignored — the shape carries
 *     its own `name`, matching `rust-c-abi.ts`'s identical convention).
 *   - `module` -> one `from ctypes import *` + `CDLL(...)` load block,
 *     followed by all contained resources then all contained functions.
 *     `libraryPath` names the shared-library path passed to `CDLL`;
 *     defaults to a `./lib<module-name>.so`-shaped placeholder (Linux
 *     shared-object naming convention) when omitted — callers generating
 *     real bindings should pass the actual build output path.
 *
 * Throws for any type-ir kind `toCtypesShape` doesn't implement, anywhere in
 * a crossed `TypeRef` — same explicit-throw-on-unsupported pattern
 * `rust-c-abi.ts` uses for ownership disciplines/kinds it can't realize on its
 * own target.
 */
export function toCtypes(ref: FfiRef, name?: string, libraryPath?: string): string {
  const kind = ref.shape.kind;

  if (kind === "function") {
    if (name === undefined) {
      throw new Error(
        'toCtypes: "function" requires a name — a C export is a named symbol, not an anonymous inline type',
      );
    }
    const shape = ref.shape as FfiShape & { kind: "function" };
    return buildFunction(toSnakeCase(name), ref, shape);
  }

  if (kind === "method") {
    if (name === undefined) {
      throw new Error(
        "toCtypes: \"method\" requires a name — the method's own key in its resource's methods map",
      );
    }
    const shape = ref.shape as FfiShape & { kind: "method" };
    const fnName = `${toSnakeCase(shape.receiver)}_${toSnakeCase(name)}`;
    return buildFunction(fnName, ref, shape, shape.receiver);
  }

  if (kind === "resource") {
    const shape = ref.shape as FfiShape & {
      kind: "resource";
      name: string;
      methods: Readonly<Record<string, FfiRef>>;
    };
    return buildResource(shape.name, ref, shape);
  }

  if (kind === "module") {
    const shape = ref.shape as FfiShape & {
      kind: "module";
      name: string;
      functions: Readonly<Record<string, FfiRef>>;
      resources: Readonly<Record<string, FfiRef>>;
    };
    const path = libraryPath ?? `./lib${toSnakeCase(shape.name)}.so`;
    const header = ["from ctypes import *", "", `lib = CDLL(${quote(path)})`];
    const decls: string[] = [
      ...Object.entries(shape.resources).map(([resName, resRef]) => toCtypes(resRef, resName)),
      ...Object.entries(shape.functions).map(([fnName, fnRef]) => toCtypes(fnRef, fnName)),
    ];
    return [header.join("\n"), ...decls].join("\n\n");
  }

  throw new Error(
    `toCtypes: unhandled ffi-ir kind "${kind}" — no ctypes mapping implemented for this backend`,
  );
}
