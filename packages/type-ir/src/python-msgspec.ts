import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// ============================================================================
// msgspec projector — TypeRef -> `msgspec.Struct` class definitions.
//
// Sibling of python-attrs.ts (same "accumulate top-level Decls while walking
// the tree" structure, same nested-object/enum promotion convention: a
// nested field's context name gets capitalized and turned into its own
// class, referenced by name from the parent). Diverges from attrs where
// msgspec's own vocabulary diverges:
//
//   - msgspec.Struct is a plain base class (`class Foo(msgspec.Struct):`),
//     not a decorator-driven one — there's no `attrs.define()`-equivalent
//     call to configure, just base-class keyword args
//     (`msgspec.Struct, frozen=True`) for the handful of struct-level knobs
//     msgspec exposes (https://jcristharif.com/msgspec/structs.html).
//   - Validation constraints (`minLength`/`maximum`/`pattern`/… — the same
//     `meta` keys json-schema.ts's `passthroughKeys` already reads) become
//     `Annotated[T, msgspec.Meta(...)]` — msgspec's own constraint-carrying
//     construct, enforced during `msgspec.json.decode`/`convert`
//     (https://jcristharif.com/msgspec/constraints.html). Unlike
//     python-attrs.ts, `multipleOf` HAS a direct home here
//     (`msgspec.Meta(multiple_of=...)`) — msgspec ships this constraint even
//     though attrs' validator vocabulary doesn't.
//   - `meta.description` also lands inside the same `msgspec.Meta(...)` call
//     (msgspec.Meta accepts `description`/`title` for schema-generation
//     purposes) rather than a separate kwarg the way attrs uses
//     `attrs.field(metadata={...})`.
//   - `meta.deprecated` has no `msgspec.Meta` slot — msgspec's constraint
//     vocabulary is about validation, not lifecycle — so it's rendered as a
//     trailing `# deprecated` comment on the field, the same honest-degrade
//     convention ruby-sorbet.ts uses for `@deprecated`.
//   - msgspec.Struct has no per-field validator hook and no
//     `__post_init__`-style cross-field-validation hook at all (decoding is
//     pure structural (de)serialization, not a place to run arbitrary
//     Python) — so unlike python-attrs.ts's `_validate_<field>` stub
//     functions and `__attrs_post_init__` stub, any *unrecognized* meta key
//     left over on a field or the object's own TypeRef becomes a `# TODO`
//     comment pointing at validating after `msgspec.json.decode(...)` at the
//     call site, rather than a fabricated hook msgspec doesn't actually
//     have.
//   - `meta.readonly` on the *object's own* TypeRef becomes
//     `msgspec.Struct, frozen=True` (msgspec's real whole-instance
//     immutability knob); on a *field* there is no per-field equivalent
//     (unlike attrs' `on_setattr=attrs.setters.frozen`) — degrades to a
//     `# NOTE` comment naming the whole-struct alternative.
//   - `meta.default` follows the same mutable/immutable split
//     python-attrs.ts documents: immutable defaults (str/number/bool/None)
//     stay a plain `= <literal>`; mutable ones (list/object) use
//     `msgspec.field(default_factory=lambda: ...)`, msgspec's own
//     mutable-default mechanism (https://jcristharif.com/msgspec/structs.html#defaults).
//   - `enum` renders as plain `class X(Enum):` (python-dataclass.ts's/
//     python-attrs.ts's choice) — msgspec decodes any Enum subclass by
//     value, no JSON-encoding opinion to motivate str-backing.
//   - Discriminated unions (`meta.discriminator`): msgspec has REAL native
//     tagged-union support (`msgspec.Struct(tag_field=..., tag=...)`,
//     https://jcristharif.com/msgspec/structs.html#tagged-unions) — the
//     degrade comment names that mechanism directly rather than reaching for
//     an external hook the way python-attrs.ts points at
//     `cattrs.register_structure_hook`.
//
// Field order: like python-attrs.ts/python-pydantic.ts, fields are emitted
// in source order — msgspec.Struct's generated `__init__` takes ordered
// positional-or-keyword params like attrs, but every defaulted field below
// is emitted via `msgspec.field(...)`/`= <literal>`, so source order is kept
// as the more faithful rendering (msgspec itself, like attrs, allows a
// defaulted field to precede a non-defaulted one when both are used via
// keyword).
// ============================================================================

const KNOWN_FIELD_META = new Set([
  "optional",
  "nullable",
  "readonly",
  "description",
  "deprecated",
  "default",
  "examples",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "discriminator",
  // Provenance keys (see index.ts's TypeRef doc comment) — not validation
  // intent, nothing to stub.
  "typeName",
  "declarationFile",
])

type FieldDecl = {
  name: string
  type: string
  hasDefault: boolean
  defaultExpr: string
  isMutableDefault: boolean
  deprecated: boolean
  unmodeledKeys: string[]
  readonlyNote: boolean
  comment?: string
}

type Decl =
  | {
      kind: "class"
      name: string
      docstring?: string
      frozen: boolean
      fields: FieldDecl[]
      unmodeledObjectKeys: string[]
    }
  | { kind: "enum"; name: string; members: readonly string[] }
  | { kind: "protocol"; name: string; methodLines: string[] }

interface Ctx {
  decls: Decl[]
  // Guards against re-emitting the same nested class twice and against
  // infinite recursion on a self-referential object graph — same role as
  // python-attrs.ts's `seen`.
  seen: Set<string>
  typingImports: Set<string>
  needsMsgspec: boolean
  needsEnum: boolean
}

type Converter = (shape: TypeShape, ref: TypeRef, ctxName: string, ctx: Ctx) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

function quote(value: string): string {
  return JSON.stringify(value)
}

// Python `Enum` member names must be valid identifiers — sanitize a member
// value (which may be an arbitrary string, e.g. "in-progress") into one,
// keeping the original string as the member's value.
function enumMemberName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()
  const named = sanitized.length === 0 ? "VALUE" : sanitized
  return /^[0-9]/.test(named) ? `_${named}` : named
}

// Render a `meta.default` value (JSON-ish: string/number/boolean/null/array/
// object) as a Python literal — used either as a plain class-body default or
// (for mutable values) inside a `msgspec.field(default_factory=lambda: ...)`.
function pythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None"
  if (typeof value === "boolean") return value ? "True" : "False"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return quote(value)
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([k, v]) => `${quote(k)}: ${pythonLiteral(v)}`).join(", ")}}`
  }
  return "None"
}

function isMutableLiteral(value: unknown): boolean {
  return Array.isArray(value) || (typeof value === "object" && value !== null)
}

// Build the `msgspec.Meta(...)` kwargs implied by a TypeRef's `meta` — the
// same validation-constraint keys json-schema.ts's `passthroughKeys` reads,
// translated to msgspec's constraint vocabulary
// (https://jcristharif.com/msgspec/constraints.html). Unlike
// python-attrs.ts, `multipleOf` and `description` both have a direct home
// here — see the file-header comment.
function metaKwargs(meta: Readonly<Record<string, unknown>>): string[] {
  const kwargs: string[] = []
  if (typeof meta.minLength === "number") kwargs.push(`min_length=${meta.minLength}`)
  if (typeof meta.maxLength === "number") kwargs.push(`max_length=${meta.maxLength}`)
  if (typeof meta.pattern === "string") kwargs.push(`pattern=${quote(meta.pattern)}`)
  if (typeof meta.minimum === "number") kwargs.push(`ge=${meta.minimum}`)
  if (typeof meta.maximum === "number") kwargs.push(`le=${meta.maximum}`)
  if (typeof meta.exclusiveMinimum === "number") kwargs.push(`gt=${meta.exclusiveMinimum}`)
  if (typeof meta.exclusiveMaximum === "number") kwargs.push(`lt=${meta.exclusiveMaximum}`)
  if (typeof meta.multipleOf === "number") kwargs.push(`multiple_of=${meta.multipleOf}`)
  if (typeof meta.description === "string") kwargs.push(`description=${quote(meta.description)}`)
  return kwargs
}

// Meta keys left over once every convention this projector knows how to
// render (constraints, description, deprecated, readonly, default,
// optional/nullable, discriminator, provenance) has been consumed. A
// non-empty result means the TypeRef's open metadata bag is carrying intent
// this projector has no declarative way to express — surfaced as a `# TODO`
// comment rather than silently dropped.
function unrecognizedMeta(meta: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(meta).filter((key) => !KNOWN_FIELD_META.has(key))
}

const discriminatorComment = (propertyName: string): string =>
  `  # discriminated by ${quote(propertyName)} — msgspec supports this natively via` +
  ` msgspec.Struct(tag_field=${quote(propertyName)}) on each variant's own Struct, not a plain Union`

const handlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("float"),
  integer: leaf("int"),
  string: leaf("str"),
  bytes: leaf("bytes"),
  null: leaf("None"),
  void: leaf("None"),
  unknown: (_shape, _ref, _ctxName, ctx) => {
    ctx.typingImports.add("Any")
    return "Any"
  },
  never: (_shape, _ref, _ctxName, ctx) => {
    ctx.typingImports.add("NoReturn")
    return "NoReturn"
  },
  object: (shape, ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "object" }
    const name = capitalize(ctxName)
    if (ctx.seen.has(name)) return name
    ctx.seen.add(name)
    ctx.needsMsgspec = true

    const fields: FieldDecl[] = []
    for (const [fieldName, fieldRef] of Object.entries(s.fields)) {
      const rawType = toMsgspecType(fieldRef, capitalize(fieldName), ctx)
      const isOptional = fieldRef.meta.optional === true
      const hasExplicitDefault = fieldRef.meta.default !== undefined
      // `nullable` already wrapped `rawType` in `| None` inside toMsgspecType
      // — avoid double-wrapping when the field is *also* omittable.
      const fieldTypeCore =
        isOptional && fieldRef.meta.nullable !== true && !rawType.endsWith("| None") ? `${rawType} | None` : rawType

      const constraintKwargs = metaKwargs(fieldRef.meta)
      if (constraintKwargs.length > 0) ctx.typingImports.add("Annotated")
      const fieldType = constraintKwargs.length > 0 ? `Annotated[${fieldTypeCore}, msgspec.Meta(${constraintKwargs.join(", ")})]` : fieldTypeCore

      const unmodeledKeys = unrecognizedMeta(fieldRef.meta)

      const hasDefault = isOptional || hasExplicitDefault
      const defaultExpr = hasExplicitDefault ? pythonLiteral(fieldRef.meta.default) : "None"
      const isMutableDefault = hasExplicitDefault && isMutableLiteral(fieldRef.meta.default)

      const comment =
        fieldRef.shape.kind === "union" && typeof fieldRef.meta.discriminator === "string"
          ? discriminatorComment(fieldRef.meta.discriminator)
          : undefined

      let field: FieldDecl = {
        name: fieldName,
        type: fieldType,
        hasDefault,
        defaultExpr,
        isMutableDefault,
        deprecated: fieldRef.meta.deprecated === true,
        unmodeledKeys,
        readonlyNote: fieldRef.meta.readonly === true,
      }
      if (comment !== undefined) field = { ...field, comment }
      fields.push(field)
    }

    const unmodeledObjectKeys = unrecognizedMeta(ref.meta)
    const frozen = ref.meta.readonly === true
    const docstring = typeof ref.meta.description === "string" ? ref.meta.description : undefined

    let decl: Decl = { kind: "class", name, frozen, fields, unmodeledObjectKeys }
    if (docstring !== undefined) decl = { ...decl, docstring }
    ctx.decls.push(decl)
    return name
  },
  // A class instance carries only nominal identity (className/source), never
  // structure (see type-ir's TypeKinds.instance doc comment) — the caller
  // assembling this generated source is responsible for importing className,
  // same convention as python-attrs.ts's `instance` handler.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "array" }
    return `list[${toMsgspecType(s.element, ctxName, ctx)}]`
  },
  tuple: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const parts = s.elements.map((element, i) => toMsgspecType(element, `${ctxName}${i + 1}`, ctx))
    return `tuple[${parts.join(", ")}]`
  },
  // No native async-stream construct in the language itself; `AsyncIterator`
  // (typing / collections.abc) is the idiomatic equivalent of an
  // `async function` producing values over time — same as
  // python-attrs.ts's stream handler.
  stream: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "stream" }
    ctx.typingImports.add("AsyncIterator")
    return `AsyncIterator[${toMsgspecType(s.element, ctxName, ctx)}]`
  },
  // No pagination convention in Python's standard vocabulary — degrades
  // honestly to `list[T]` over the page's element type, same as the other
  // Python variants' page handler.
  page: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "page" }
    return `list[${toMsgspecType(s.element, ctxName, ctx)}]`
  },
  map: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = toMsgspecType(s.key, `${ctxName}Key`, ctx)
    const value = toMsgspecType(s.value, `${ctxName}Value`, ctx)
    return `dict[${key}, ${value}]`
  },
  union: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "union" }
    const parts = s.variants.map((variant, i) => toMsgspecType(variant, `${ctxName}Variant${i + 1}`, ctx))
    const unique = [...new Set(parts)]
    if (unique.length === 1) return unique[0]!
    ctx.typingImports.add("Union")
    return `Union[${unique.join(", ")}]`
  },
  literal: (shape, _ref, _ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "None"
    ctx.typingImports.add("Literal")
    if (typeof s.value === "string") return `Literal[${quote(s.value)}]`
    if (typeof s.value === "boolean") return `Literal[${s.value ? "True" : "False"}]`
    return `Literal[${s.value}]`
  },
  // Plain `Enum` (not Pydantic's `(str, Enum)`) — msgspec decodes any Enum
  // subclass by value, no JSON-encoding opinion to motivate string-backing,
  // same as python-attrs.ts's enum handler.
  enum: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "enum" }
    const name = `${capitalize(ctxName)}Enum`
    if (ctx.seen.has(name)) return name
    ctx.seen.add(name)
    ctx.needsEnum = true
    ctx.decls.push({ kind: "enum", name, members: s.members })
    return name
  },
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  // No intersection construct in Python's type vocabulary; when every member
  // is an object, the honest rendering is a single class merging all
  // members' fields (mirrors what an intersection of object shapes actually
  // means structurally) — otherwise this degrades to `Any`, same fallback
  // the other Python variants' intersection handler uses.
  intersection: (shape, ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "intersection" }
    if (s.members.length > 0 && s.members.every((member) => member.shape.kind === "object")) {
      const merged: Record<string, TypeRef> = {}
      for (const member of s.members) {
        Object.assign(merged, (member.shape as TypeShape & { kind: "object" }).fields)
      }
      const mergedShape: TypeShape = { kind: "object", fields: merged }
      return handlers.object!(mergedShape, ref, ctxName, ctx)
    }
    ctx.typingImports.add("Any")
    return "Any"
  },
  function: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "function" }
    ctx.typingImports.add("Callable")
    const params = s.params.map((param, i) => toMsgspecType(param.type, `${ctxName}Param${i + 1}`, ctx))
    const returnType = toMsgspecType(s.returnType, `${ctxName}Return`, ctx)
    return `Callable[[${params.join(", ")}], ${returnType}]`
  },
  // `method` has no explicit entry — falls back to `function`'s Callable[...]
  // rendering via `registerParent("method", "function")` (index.ts), same as
  // the other Python variants' standalone-method fallback.
  interface: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "interface" }
    const name = capitalize(ctxName)
    if (ctx.seen.has(name)) return name
    ctx.seen.add(name)
    ctx.typingImports.add("Protocol")
    const methodLines: string[] = []
    for (const [methodName, methodRef] of Object.entries(s.methods)) {
      const m = methodRef.shape as TypeShape & {
        kind: "method" | "function"
        params: readonly { name: string; type: TypeRef }[]
        returnType: TypeRef
      }
      const params = m.params.map((p) => `${p.name}: ${toMsgspecType(p.type, capitalize(p.name), ctx)}`)
      const returnType = toMsgspecType(m.returnType, `${capitalize(methodName)}Return`, ctx)
      methodLines.push(`    def ${methodName}(self, ${params.join(", ")}) -> ${returnType}: ...`)
    }
    ctx.decls.push({ kind: "protocol", name, methodLines })
    return name
  },
}

/** Convert a `TypeRef` to a msgspec-flavored Python type *expression* (e.g.
 * `list[str]`, `int | None`, or a class name for object/enum shapes) — the
 * building block `toMsgspec` uses for the module-level render. `ctxName`
 * names any nested class/enum this call generates (capitalized per Python
 * convention); side effects (new `Decl`s, imports) land on `ctx`. */
export function toMsgspecType(ref: TypeRef, ctxName: string, ctx: Ctx): string {
  const converter = resolve(ref.shape.kind, handlers)
  let type: string
  if (converter === undefined) {
    ctx.typingImports.add("Any")
    type = "Any"
  } else {
    type = converter(ref.shape, ref, ctxName, ctx)
  }
  if (ref.meta.nullable === true) {
    type = `${type} | None`
  }
  return type
}

function renderDecl(decl: Decl): string[] {
  if (decl.kind === "enum") {
    const lines = [`class ${decl.name}(Enum):`]
    for (const member of decl.members) lines.push(`    ${enumMemberName(member)} = ${quote(member)}`)
    return lines
  }
  if (decl.kind === "protocol") {
    const lines = [`class ${decl.name}(Protocol):`]
    lines.push(...(decl.methodLines.length > 0 ? decl.methodLines : ["    ..."]))
    return lines
  }

  const lines: string[] = []
  if (decl.unmodeledObjectKeys.length > 0) {
    lines.push(
      `# TODO: unmodeled validation metadata on "${decl.name}": ${decl.unmodeledObjectKeys.join(", ")}` +
        ` — msgspec.Struct has no post-init validation hook; validate after msgspec.json.decode(...) at the call site`,
    )
  }
  lines.push(`class ${decl.name}(msgspec.Struct${decl.frozen ? ", frozen=True" : ""}):`)
  if (decl.docstring !== undefined) lines.push(`    ${quote(decl.docstring)}`)
  if (decl.fields.length === 0 && decl.docstring === undefined) {
    lines.push("    pass")
    return lines
  }
  for (const field of decl.fields) {
    if (field.unmodeledKeys.length > 0) {
      lines.push(
        `    # TODO: unmodeled validation metadata on "${field.name}": ${field.unmodeledKeys.join(", ")}` +
          ` — msgspec has no per-field validator hook`,
      )
    }
    if (field.readonlyNote) {
      lines.push(`    # NOTE: msgspec has no per-field immutability — frozen=True on the whole Struct is the closest equivalent`)
    }
    const assignment = field.hasDefault
      ? field.isMutableDefault
        ? ` = msgspec.field(default_factory=lambda: ${field.defaultExpr})`
        : ` = ${field.defaultExpr}`
      : ""
    const deprecatedComment = field.deprecated ? "  # deprecated" : ""
    lines.push(`    ${field.name}: ${field.type}${assignment}${deprecatedComment}${field.comment ?? ""}`)
  }
  return lines
}

/**
 * Render a `TypeRef` as a standalone Python module: every nested
 * object/enum/interface promoted to a top-level `msgspec.Struct` class /
 * `Enum` / `Protocol`, plus (for shapes with no class of their own —
 * unions, primitives, arrays, …) a `Name = <expr>` type alias for `ref`
 * itself. `name` seeds both the alias name and the base for any nested class
 * names derived from it.
 */
export function toMsgspec(ref: TypeRef, name = "Root"): string {
  const ctx: Ctx = { decls: [], seen: new Set(), typingImports: new Set(), needsMsgspec: false, needsEnum: false }
  const expr = toMsgspecType(ref, name, ctx)

  // Object/enum/interface shapes already emit a top-level class named `expr`
  // (via the `seen`-guarded push in their handlers above) — no separate alias
  // needed. Everything else gets `name = <expr>`.
  const hasOwnDeclaration = ctx.decls.some((decl) => decl.name === expr)

  const lines: string[] = ["from __future__ import annotations"]
  if (ctx.needsEnum) lines.push("from enum import Enum")
  const typingNames = [...ctx.typingImports].sort()
  if (typingNames.length > 0) lines.push(`from typing import ${typingNames.join(", ")}`)
  if (ctx.needsMsgspec) lines.push("import msgspec")
  lines.push("")

  const body: string[] = []
  for (const decl of ctx.decls) {
    body.push(...renderDecl(decl), "")
  }
  if (!hasOwnDeclaration) {
    const comment =
      ref.shape.kind === "union" && typeof ref.meta.discriminator === "string" ? discriminatorComment(ref.meta.discriminator) : ""
    body.push(`${name} = ${expr}${comment}`, "")
  }
  lines.push(...body)

  return `${lines.join("\n").trimEnd()}\n`
}
