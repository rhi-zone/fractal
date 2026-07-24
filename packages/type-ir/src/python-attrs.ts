import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// ============================================================================
// attrs projector — TypeRef -> `attrs.define`-decorated class definitions.
//
// Sibling of python-dataclass.ts and python-pydantic.ts (same "accumulate
// top-level Decls while walking the tree" structure, same nested-object/enum
// promotion convention: a nested field's context name gets capitalized and
// turned into its own class, referenced by name from the parent). Diverges
// from both where attrs' own vocabulary diverges:
//
//   - Modern `@attrs.define` (not the legacy `@attr.s`) + `attrs.field()`,
//     both accessed off a single `import attrs` — attrs exposes its whole
//     public surface (`define`, `field`, `validators`, `setters`, `Factory`)
//     under that one module object, so unlike python-pydantic.ts's per-name
//     `from pydantic import ...` there's nothing to track beyond "did this
//     module use attrs at all" (`ctx.needsAttrs`).
//   - Validation constraints (`minLength`/`maximum`/`pattern`/… — the same
//     `meta` keys json-schema.ts's `passthroughKeys` already reads) become
//     `attrs.field(validator=...)` calls against `attrs.validators.*`
//     (`min_len`, `max_len`, `matches_re`, `ge`/`le`/`gt`/`lt`), chained with
//     `attrs.validators.and_(...)` when more than one applies to a field.
//     Deliberately NOT included here: `multipleOf` — attrs ships no
//     multiple-of validator, so (unlike Pydantic, which has `multiple_of` in
//     `Field()`) it's left out of `KNOWN_FIELD_META` below and falls through
//     to the same generic "unrecognized metadata" stub every other
//     unmodeled key gets, rather than inventing a bespoke lambda for it.
//   - Any *unrecognized* meta key left over on a field TypeRef becomes a
//     standalone `_validate_<field>(instance, attribute, value)` function
//     (attrs' own validator-callable signature) emitted just above the
//     class and wired in via `validator=`; on the *object's own* TypeRef it
//     becomes an `__attrs_post_init__` stub method — attrs' native
//     cross-field-validation hook, the closest analogue to Pydantic's
//     `@model_validator(mode="after")`.
//   - `meta.readonly` on a *field* becomes
//     `attrs.field(on_setattr=attrs.setters.frozen)` (per-field immutability
//     after `__init__`); on the *object's own* TypeRef it becomes
//     `@attrs.define(frozen=True)` (whole-instance immutability) — same
//     "field-level meaning generalizes to model-level" reuse
//     python-pydantic.ts documents for `ConfigDict(frozen=True)`.
//   - `meta.description`/`meta.deprecated` have no declarative Field()-style
//     home in attrs, so they're carried as `attrs.field(metadata={...})`
//     entries instead — attrs' own convention for attaching arbitrary
//     non-validating data to a field.
//   - Mutable `meta.default` values (list/object) are NOT safe to place as a
//     bare class-body literal the way python-pydantic.ts's comment
//     documents Pydantic being safe with (Pydantic deep-copies on every
//     instantiation; attrs does not) — they're wrapped as
//     `attrs.field(factory=lambda: ...)` instead, attrs' own mutable-default
//     mechanism. Immutable defaults (str/number/bool/None) stay plain
//     `= <literal>` class-body assignments, same as the other two Python
//     variants.
//   - `enum` renders as plain `class X(Enum):` (python-dataclass.ts's
//     choice), not Pydantic's `(str, Enum)` — attrs has no JSON-encoding
//     opinion of its own to motivate the string-backing pydantic leans on.
//   - Discriminated unions (`meta.discriminator`, the same open-metadata-bag
//     convention json-schema.ts's union handler reads): attrs has no native
//     discriminated-union construct (unlike Pydantic's `Discriminator(...)`),
//     so this degrades to python-dataclass.ts's inline-comment treatment,
//     extended to name the idiomatic attrs/cattrs escape hatch — a
//     `cattrs.register_structure_hook` keyed on the discriminator field.
//
// Field order: like python-pydantic.ts (and unlike python-dataclass.ts),
// fields are emitted in source order with no required-before-optional
// reshuffle — attrs' generated `__init__` positional params still need to
// read the way the source schema does. But attrs (like stdlib dataclasses,
// unlike Pydantic) DOES enforce "no mandatory attribute after one with a
// default" for positional params, raising `ValueError: No mandatory
// attributes allowed after an attribute with a default value` at class-
// definition time otherwise. Rather than reshuffle (which would lose the
// source-order fidelity above), any mandatory field that appears *after* a
// defaulted one in source order is emitted with `attrs.field(kw_only=True)`
// — it drops out of the positional `__init__` signature and becomes
// keyword-only, which attrs allows to interleave with defaulted params
// freely.
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
  "discriminator",
  // Provenance keys (see index.ts's TypeRef doc comment) — not validation
  // intent, nothing to stub.
  "typeName",
  "declarationFile",
  // NOT included: "multipleOf" — attrs has no built-in multiple-of
  // validator (see the file-header comment), so it deliberately falls
  // through to the generic unrecognized-metadata stub below instead of
  // getting its own bespoke lambda.
])

type FieldDecl = {
  name: string
  type: string
  hasDefault: boolean
  defaultExpr: string
  isMutableDefault: boolean
  validatorExprs: string[]
  extraValidatorFn?: { name: string; lines: string[] }
  metadataKwargs: string[]
  onSetattrFrozen: boolean
  kwOnly: boolean
  comment?: string
}

type Decl =
  | {
      kind: "class"
      name: string
      docstring?: string
      frozen: boolean
      fields: FieldDecl[]
      postInitStub?: string[]
    }
  | { kind: "enum"; name: string; members: readonly string[] }
  | { kind: "protocol"; name: string; methodLines: string[] }

interface Ctx {
  decls: Decl[]
  // Guards against re-emitting the same nested class twice and against
  // infinite recursion on a self-referential object graph — same role as
  // python-dataclass.ts's/python-pydantic.ts's `seen`.
  seen: Set<string>
  typingImports: Set<string>
  needsAttrs: boolean
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
// (for mutable values, see `isMutableDefault` below) inside an
// `attrs.field(factory=lambda: ...)`.
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

// Build the `attrs.validators.*` call expressions implied by a TypeRef's
// `meta` — the same validation-constraint keys json-schema.ts's
// `passthroughKeys` reads, translated to attrs' validator vocabulary.
// `multipleOf` is deliberately absent — see the file-header comment.
function fieldValidators(meta: Readonly<Record<string, unknown>>): string[] {
  const validators: string[] = []
  if (typeof meta.minLength === "number") validators.push(`attrs.validators.min_len(${meta.minLength})`)
  if (typeof meta.maxLength === "number") validators.push(`attrs.validators.max_len(${meta.maxLength})`)
  if (typeof meta.pattern === "string") validators.push(`attrs.validators.matches_re(${quote(meta.pattern)})`)
  if (typeof meta.minimum === "number") validators.push(`attrs.validators.ge(${meta.minimum})`)
  if (typeof meta.maximum === "number") validators.push(`attrs.validators.le(${meta.maximum})`)
  if (typeof meta.exclusiveMinimum === "number") validators.push(`attrs.validators.gt(${meta.exclusiveMinimum})`)
  if (typeof meta.exclusiveMaximum === "number") validators.push(`attrs.validators.lt(${meta.exclusiveMaximum})`)
  return validators
}

// `attrs.field(metadata={...})` entries — attrs' own place for
// non-validating field data, since (unlike Pydantic's `Field()`) attrs has
// no dedicated `description`/`deprecated` keyword.
function fieldMetadataKwargs(meta: Readonly<Record<string, unknown>>): string[] {
  const entries: string[] = []
  if (typeof meta.description === "string") entries.push(`"description": ${quote(meta.description)}`)
  if (meta.deprecated === true) entries.push(`"deprecated": True`)
  return entries
}

// Meta keys left over once every convention this projector knows how to
// render (constraints, description, deprecated, readonly, default,
// optional/nullable, discriminator, provenance) has been consumed. A
// non-empty result means the TypeRef's open metadata bag is carrying
// validation intent this projector has no declarative way to express —
// surfaced as a validator stub rather than silently dropped.
function unrecognizedMeta(meta: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(meta).filter((key) => !KNOWN_FIELD_META.has(key))
}

const discriminatorComment = (propertyName: string): string =>
  `  # discriminated by ${quote(propertyName)} — attrs has no native discriminated-union support;` +
  ` consider a cattrs structuring hook (cattrs.register_structure_hook) keyed on this field`

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
    ctx.needsAttrs = true

    const fields: FieldDecl[] = []
    // attrs raises at class-definition time if a mandatory (no-default)
    // field's positional `__init__` param follows a defaulted one — track
    // whether a defaulted field has been seen yet so any mandatory field
    // after it can be forced `kw_only=True` (see file-header comment).
    let seenDefault = false
    for (const [fieldName, fieldRef] of Object.entries(s.fields)) {
      const rawType = toAttrsType(fieldRef, capitalize(fieldName), ctx)
      const isOptional = fieldRef.meta.optional === true
      const hasExplicitDefault = fieldRef.meta.default !== undefined
      // `nullable` already wrapped `rawType` in `| None` inside toAttrsType
      // — avoid double-wrapping when the field is *also* omittable.
      const fieldType =
        isOptional && fieldRef.meta.nullable !== true && !rawType.endsWith("| None") ? `${rawType} | None` : rawType

      const extra = unrecognizedMeta(fieldRef.meta)
      const extraValidatorFn =
        extra.length > 0
          ? {
              name: `_validate_${fieldName}`,
              lines: [
                `def _validate_${fieldName}(instance: object, attribute: object, value: object) -> None:`,
                `    # TODO: unmodeled validation metadata on "${fieldName}": ${extra.join(", ")}`,
              ],
            }
          : undefined

      const builtinValidators = fieldValidators(fieldRef.meta)
      const validatorExprs = extraValidatorFn === undefined ? builtinValidators : [...builtinValidators, extraValidatorFn.name]

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
        validatorExprs,
        metadataKwargs: fieldMetadataKwargs(fieldRef.meta),
        onSetattrFrozen: fieldRef.meta.readonly === true,
        kwOnly: !hasDefault && seenDefault,
      }
      if (extraValidatorFn !== undefined) field = { ...field, extraValidatorFn }
      if (comment !== undefined) field = { ...field, comment }
      fields.push(field)
      if (hasDefault) seenDefault = true
    }

    const objectExtra = unrecognizedMeta(ref.meta)
    const postInitStub =
      objectExtra.length > 0
        ? [
            "    def __attrs_post_init__(self) -> None:",
            `        # TODO: unmodeled validation metadata on "${name}": ${objectExtra.join(", ")}`,
          ]
        : undefined

    const frozen = ref.meta.readonly === true
    const docstring = typeof ref.meta.description === "string" ? ref.meta.description : undefined

    let decl: Decl = { kind: "class", name, frozen, fields }
    if (docstring !== undefined) decl = { ...decl, docstring }
    if (postInitStub !== undefined) decl = { ...decl, postInitStub }
    ctx.decls.push(decl)
    return name
  },
  // A class instance carries only nominal identity (className/source), never
  // structure (see type-ir's TypeKinds.instance doc comment) — the caller
  // assembling this generated source is responsible for importing className,
  // same convention as python-dataclass.ts's/python-pydantic.ts's `instance`
  // handler.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "array" }
    return `list[${toAttrsType(s.element, ctxName, ctx)}]`
  },
  tuple: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const parts = s.elements.map((element, i) => toAttrsType(element, `${ctxName}${i + 1}`, ctx))
    return `tuple[${parts.join(", ")}]`
  },
  // No native async-stream construct in the language itself; `AsyncIterator`
  // (typing / collections.abc) is the idiomatic equivalent of an
  // `async function` producing values over time — same as
  // python-dataclass.ts's/python-pydantic.ts's stream handler.
  stream: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "stream" }
    ctx.typingImports.add("AsyncIterator")
    return `AsyncIterator[${toAttrsType(s.element, ctxName, ctx)}]`
  },
  // No pagination convention in Python's standard vocabulary — degrades
  // honestly to `list[T]` over the page's element type, same as the other
  // Python variants' page handler.
  page: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "page" }
    return `list[${toAttrsType(s.element, ctxName, ctx)}]`
  },
  map: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = toAttrsType(s.key, `${ctxName}Key`, ctx)
    const value = toAttrsType(s.value, `${ctxName}Value`, ctx)
    return `dict[${key}, ${value}]`
  },
  union: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "union" }
    const parts = s.variants.map((variant, i) => toAttrsType(variant, `${ctxName}Variant${i + 1}`, ctx))
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
  // Plain `Enum` (not Pydantic's `(str, Enum)`) — attrs carries no JSON-
  // encoding opinion of its own to motivate string-backing, same as
  // python-dataclass.ts's enum handler.
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
    const params = s.params.map((param, i) => toAttrsType(param.type, `${ctxName}Param${i + 1}`, ctx))
    const returnType = toAttrsType(s.returnType, `${ctxName}Return`, ctx)
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
      const params = m.params.map((p) => `${p.name}: ${toAttrsType(p.type, capitalize(p.name), ctx)}`)
      const returnType = toAttrsType(m.returnType, `${capitalize(methodName)}Return`, ctx)
      methodLines.push(`    def ${methodName}(self, ${params.join(", ")}) -> ${returnType}: ...`)
    }
    ctx.decls.push({ kind: "protocol", name, methodLines })
    return name
  },
}

/** Convert a `TypeRef` to an attrs-flavored Python type *expression* (e.g.
 * `list[str]`, `int | None`, or a class name for object/enum shapes) — the
 * building block `toAttrs` uses for the module-level render. `ctxName` names
 * any nested class/enum this call generates (capitalized per Python
 * convention); side effects (new `Decl`s, imports) land on `ctx`. */
export function toAttrsType(ref: TypeRef, ctxName: string, ctx: Ctx): string {
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
  // Per-field validator stub functions must exist at module scope before the
  // class that references them via `validator=`.
  for (const field of decl.fields) {
    if (field.extraValidatorFn !== undefined) lines.push(...field.extraValidatorFn.lines, "")
  }

  lines.push(`@attrs.define(${decl.frozen ? "frozen=True" : ""})`, `class ${decl.name}:`)
  if (decl.docstring !== undefined) lines.push(`    ${quote(decl.docstring)}`)
  if (decl.fields.length === 0 && decl.docstring === undefined && decl.postInitStub === undefined) {
    lines.push("    pass")
    return lines
  }
  for (const field of decl.fields) {
    const kwargs: string[] = []
    if (field.hasDefault) {
      kwargs.push(field.isMutableDefault ? `factory=lambda: ${field.defaultExpr}` : `default=${field.defaultExpr}`)
    }
    if (field.validatorExprs.length === 1) kwargs.push(`validator=${field.validatorExprs[0]}`)
    else if (field.validatorExprs.length > 1) kwargs.push(`validator=attrs.validators.and_(${field.validatorExprs.join(", ")})`)
    if (field.metadataKwargs.length > 0) kwargs.push(`metadata={${field.metadataKwargs.join(", ")}}`)
    if (field.onSetattrFrozen) kwargs.push("on_setattr=attrs.setters.frozen")
    if (field.kwOnly) kwargs.push("kw_only=True")

    // A single non-mutable `default=...` kwarg is exactly what a plain
    // `= <literal>` class-body assignment already means — `attrs.field()`
    // is only needed once something beyond a plain default is in play.
    const needsField = kwargs.length > 0 && !(kwargs.length === 1 && kwargs[0]!.startsWith("default="))
    const assignment = needsField ? ` = attrs.field(${kwargs.join(", ")})` : field.hasDefault ? ` = ${field.defaultExpr}` : ""
    lines.push(`    ${field.name}: ${field.type}${assignment}${field.comment ?? ""}`)
  }
  if (decl.postInitStub !== undefined) lines.push("", ...decl.postInitStub)
  return lines
}

/**
 * Render a `TypeRef` as a standalone Python module: every nested
 * object/enum/interface promoted to a top-level `attrs.define`-decorated
 * class / `Enum` / `Protocol`, plus (for shapes with no class of their own —
 * unions, primitives, arrays, …) a `Name = <expr>` type alias for `ref`
 * itself. `name` seeds both the alias name and the base for any nested class
 * names derived from it.
 */
export function toAttrs(ref: TypeRef, name = "Root"): string {
  const ctx: Ctx = { decls: [], seen: new Set(), typingImports: new Set(), needsAttrs: false, needsEnum: false }
  const expr = toAttrsType(ref, name, ctx)

  // Object/enum/interface shapes already emit a top-level class named `expr`
  // (via the `seen`-guarded push in their handlers above) — no separate alias
  // needed. Everything else gets `name = <expr>`.
  const hasOwnDeclaration = ctx.decls.some((decl) => decl.name === expr)

  const lines: string[] = ["from __future__ import annotations"]
  if (ctx.needsEnum) lines.push("from enum import Enum")
  const typingNames = [...ctx.typingImports].sort()
  if (typingNames.length > 0) lines.push(`from typing import ${typingNames.join(", ")}`)
  if (ctx.needsAttrs) lines.push("import attrs")
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
