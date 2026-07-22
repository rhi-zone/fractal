import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// ============================================================================
// Pydantic v2 projector — TypeRef -> `pydantic.BaseModel` class definitions.
//
// Sibling of python-dataclass.ts (same "accumulate top-level Decls while
// walking the tree" structure, same nested-object/enum promotion convention:
// a nested field's context name gets capitalized and turned into its own
// class, referenced by name from the parent). The two diverge where Pydantic
// actually has more to say than the stdlib does:
//
//   - Validation constraints (`minLength`/`maximum`/`pattern`/… — the same
//     `meta` keys json-schema.ts's `passthroughKeys` already reads) become
//     `Annotated[T, Field(...)]` instead of being silently dropped, since
//     Pydantic can enforce them at runtime.
//   - `meta.discriminator` (the same open-metadata-bag convention
//     json-schema.ts's union handler reads for `discriminator: {
//     propertyName }`) becomes Pydantic's native `Annotated[Union[...],
//     Discriminator(...)]` instead of a comment.
//   - `meta.readonly` on an *object's own* TypeRef (not a field) is reused,
//     by direct analogy with its already-documented field-level meaning
//     ("read-only/immutable", per index.ts's TypeRef doc comment), as
//     `model_config = ConfigDict(frozen=True)` — the same key, generalized
//     from "this field can't be reassigned" to "this model can't be
//     reassigned", rather than inventing a new meta key for model-level
//     immutability.
//   - `meta.description` on an object's own TypeRef becomes the class
//     docstring (again reusing an already-established key, not a new one).
//   - Any *unrecognized* meta key left over on a field/object TypeRef after
//     every known convention above has been consumed is surfaced — per this
//     package's "open metadata bag over fixed schema" design (see
//     design-philosophy.md) — as a `@field_validator`/`@model_validator`
//     stub the developer fills in, rather than silently discarded. This is
//     the projector's only honest way to represent "there was validation
//     intent here Pydantic's declarative Field() can't already express."
//
// Field default ordering: unlike python-dataclass.ts, fields are emitted in
// their original source order with no required-before-optional reshuffle.
// Dataclasses need that reshuffle because their generated `__init__` takes
// ordered positional-or-keyword params (a param with a default can't precede
// one without). Pydantic's generated `__init__` takes a single `**data`, so
// there's no such ordering constraint — keeping source order is strictly
// more faithful.
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
  validatorStub?: string[]
}

type Decl =
  | {
      kind: "model"
      name: string
      docstring?: string
      configArgs: string[]
      fields: FieldDecl[]
      modelValidatorStub?: string[]
    }
  | { kind: "enum"; name: string; members: readonly string[] }
  | { kind: "protocol"; name: string; methodLines: string[] }

interface Ctx {
  decls: Decl[]
  // Guards against re-emitting the same nested class twice and against
  // infinite recursion on a self-referential object graph — same role as
  // python-dataclass.ts's `seen`.
  seen: Set<string>
  typingImports: Set<string>
  pydanticImports: Set<string>
  needsBaseModel: boolean
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
// object) as a Python literal. Pydantic (unlike stdlib dataclasses) deep-
// copies mutable defaults on every instantiation, so a plain `= [...]`/`=
// {...}` class-body literal is safe here — no `default_factory` needed.
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

// Build the `Field(...)` keyword arguments implied by a TypeRef's `meta` —
// the same validation-constraint keys json-schema.ts's `passthroughKeys`
// reads, translated to Pydantic v2's Field() vocabulary.
function fieldKwargs(meta: Readonly<Record<string, unknown>>): string[] {
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
  if (meta.deprecated === true) kwargs.push("deprecated=True")
  if (meta.readonly === true) kwargs.push("frozen=True")
  return kwargs
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
    ctx.needsBaseModel = true

    const fields: FieldDecl[] = []
    for (const [fieldName, fieldRef] of Object.entries(s.fields)) {
      const rawType = toPydanticType(fieldRef, capitalize(fieldName), ctx)
      const isOptional = fieldRef.meta.optional === true
      const hasExplicitDefault = fieldRef.meta.default !== undefined
      // `nullable` already wrapped `rawType` in `| None` inside
      // toPydanticType — avoid double-wrapping when the field is *also*
      // omittable.
      const fieldType =
        isOptional && fieldRef.meta.nullable !== true && !rawType.endsWith("| None") ? `${rawType} | None` : rawType

      const kwargs = fieldKwargs(fieldRef.meta)
      const annotated =
        kwargs.length > 0 ? (ctx.pydanticImports.add("Field"), ctx.typingImports.add("Annotated"), true) : false
      const type = annotated ? `Annotated[${fieldType}, Field(${kwargs.join(", ")})]` : fieldType

      const hasDefault = isOptional || hasExplicitDefault
      const defaultExpr = hasExplicitDefault ? pythonLiteral(fieldRef.meta.default) : "None"

      const extra = unrecognizedMeta(fieldRef.meta)
      const validatorStub =
        extra.length > 0
          ? [
              `    @field_validator(${quote(fieldName)})`,
              "    @classmethod",
              `    def _validate_${fieldName}(cls, v: object) -> object:`,
              `        # TODO: unmodeled validation metadata on "${fieldName}": ${extra.join(", ")}`,
              "        return v",
            ]
          : undefined
      if (validatorStub !== undefined) ctx.pydanticImports.add("field_validator")

      fields.push(
        validatorStub === undefined
          ? { name: fieldName, type, hasDefault, defaultExpr }
          : { name: fieldName, type, hasDefault, defaultExpr, validatorStub },
      )
    }

    const objectExtra = unrecognizedMeta(ref.meta)
    const modelValidatorStub =
      objectExtra.length > 0
        ? (ctx.pydanticImports.add("model_validator"),
          [
            '    @model_validator(mode="after")',
            `    def _validate_${name.toLowerCase()}(self) -> "${name}":`,
            `        # TODO: unmodeled validation metadata on "${name}": ${objectExtra.join(", ")}`,
            "        return self",
          ])
        : undefined

    const configArgs: string[] = []
    if (ref.meta.readonly === true) configArgs.push("frozen=True")
    if (configArgs.length > 0) ctx.pydanticImports.add("ConfigDict")

    const docstring = typeof ref.meta.description === "string" ? ref.meta.description : undefined

    let decl: Decl = { kind: "model", name, configArgs, fields }
    if (docstring !== undefined) decl = { ...decl, docstring }
    if (modelValidatorStub !== undefined) decl = { ...decl, modelValidatorStub }
    ctx.decls.push(decl)
    return name
  },
  // A class instance carries only nominal identity (className/source), never
  // structure (see type-ir's TypeKinds.instance doc comment) — the caller
  // assembling this generated source is responsible for importing className,
  // same convention as python-dataclass.ts's `instance` handler.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "array" }
    return `list[${toPydanticType(s.element, ctxName, ctx)}]`
  },
  tuple: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const parts = s.elements.map((element, i) => toPydanticType(element, `${ctxName}${i + 1}`, ctx))
    return `tuple[${parts.join(", ")}]`
  },
  // No native async-stream construct in the language itself; `AsyncIterator`
  // (typing / collections.abc) is the idiomatic equivalent of an
  // `async function` producing values over time — same as
  // python-dataclass.ts's stream handler.
  stream: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "stream" }
    ctx.typingImports.add("AsyncIterator")
    return `AsyncIterator[${toPydanticType(s.element, ctxName, ctx)}]`
  },
  // No pagination convention in Python's standard vocabulary — degrades
  // honestly to `list[T]` over the page's element type, same as
  // python-dataclass.ts's page handler.
  page: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "page" }
    return `list[${toPydanticType(s.element, ctxName, ctx)}]`
  },
  map: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = toPydanticType(s.key, `${ctxName}Key`, ctx)
    const value = toPydanticType(s.value, `${ctxName}Value`, ctx)
    return `dict[${key}, ${value}]`
  },
  union: (shape, ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "union" }
    const parts = s.variants.map((variant, i) => toPydanticType(variant, `${ctxName}Variant${i + 1}`, ctx))
    const unique = [...new Set(parts)]
    if (unique.length === 1) return unique[0]!
    ctx.typingImports.add("Union")
    const inner = `Union[${unique.join(", ")}]`
    // Pydantic v2's native discriminated-union support: `meta.discriminator`
    // is the same open-metadata-bag convention json-schema.ts's union
    // handler reads to emit `discriminator: { propertyName }`.
    if (typeof ref.meta.discriminator === "string") {
      ctx.typingImports.add("Annotated")
      ctx.pydanticImports.add("Discriminator")
      return `Annotated[${inner}, Discriminator(${quote(ref.meta.discriminator)})]`
    }
    return inner
  },
  literal: (shape, _ref, _ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "None"
    ctx.typingImports.add("Literal")
    if (typeof s.value === "string") return `Literal[${quote(s.value)}]`
    if (typeof s.value === "boolean") return `Literal[${s.value ? "True" : "False"}]`
    return `Literal[${s.value}]`
  },
  // String-backed (`str, Enum`) rather than plain `Enum`, so a member
  // serializes to its own string value under Pydantic's (and `json.dumps`'s)
  // default JSON encoding instead of an opaque `EnumName.MEMBER` repr.
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
  // is an object, the honest rendering is a single model merging all
  // members' fields (mirrors what an intersection of object shapes actually
  // means structurally) — otherwise this degrades to `Any`, same fallback
  // python-dataclass.ts's intersection handler uses.
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
    const params = s.params.map((param, i) => toPydanticType(param.type, `${ctxName}Param${i + 1}`, ctx))
    const returnType = toPydanticType(s.returnType, `${ctxName}Return`, ctx)
    return `Callable[[${params.join(", ")}], ${returnType}]`
  },
  // `method` has no explicit entry — falls back to `function`'s Callable[...]
  // rendering via `registerParent("method", "function")` (index.ts), same as
  // python-dataclass.ts's standalone-method fallback.
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
      const params = m.params.map((p) => `${p.name}: ${toPydanticType(p.type, capitalize(p.name), ctx)}`)
      const returnType = toPydanticType(m.returnType, `${capitalize(methodName)}Return`, ctx)
      methodLines.push(`    def ${methodName}(self, ${params.join(", ")}) -> ${returnType}: ...`)
    }
    ctx.decls.push({ kind: "protocol", name, methodLines })
    return name
  },
}

/** Convert a `TypeRef` to a Pydantic-flavored Python type *expression* (e.g.
 * `list[str]`, `int | None`, or a class name for object/enum shapes) — the
 * building block `toPydantic` uses for the module-level render. `ctxName`
 * names any nested class/enum this call generates (capitalized per Python
 * convention); side effects (new `Decl`s, imports) land on `ctx`. */
export function toPydanticType(ref: TypeRef, ctxName: string, ctx: Ctx): string {
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
    const lines = [`class ${decl.name}(str, Enum):`]
    for (const member of decl.members) lines.push(`    ${enumMemberName(member)} = ${quote(member)}`)
    return lines
  }
  if (decl.kind === "protocol") {
    const lines = [`class ${decl.name}(Protocol):`]
    lines.push(...(decl.methodLines.length > 0 ? decl.methodLines : ["    ..."]))
    return lines
  }

  const lines = [`class ${decl.name}(BaseModel):`]
  if (decl.docstring !== undefined) lines.push(`    ${quote(decl.docstring)}`)
  if (decl.configArgs.length > 0) lines.push(`    model_config = ConfigDict(${decl.configArgs.join(", ")})`)
  if (decl.fields.length === 0 && decl.configArgs.length === 0 && decl.docstring === undefined) {
    lines.push("    pass")
    return lines
  }
  for (const field of decl.fields) {
    const defaultValue = field.hasDefault ? ` = ${field.defaultExpr}` : ""
    lines.push(`    ${field.name}: ${field.type}${defaultValue}`)
  }
  for (const field of decl.fields) {
    if (field.validatorStub !== undefined) lines.push("", ...field.validatorStub)
  }
  if (decl.modelValidatorStub !== undefined) lines.push("", ...decl.modelValidatorStub)
  return lines
}

/**
 * Render a `TypeRef` as a standalone Python module: every nested
 * object/enum/interface promoted to a top-level `BaseModel`/`Enum`/
 * `Protocol` class, plus (for shapes with no class of their own — unions,
 * primitives, arrays, …) a `Name = <expr>` type alias for `ref` itself.
 * `name` seeds both the alias name and the base for any nested class names
 * derived from it.
 */
export function toPydantic(ref: TypeRef, name = "Root"): string {
  const ctx: Ctx = {
    decls: [],
    seen: new Set(),
    typingImports: new Set(),
    pydanticImports: new Set(),
    needsBaseModel: false,
    needsEnum: false,
  }
  const expr = toPydanticType(ref, name, ctx)

  // Object/enum/interface shapes already emit a top-level class named `expr`
  // (via the `seen`-guarded push in their handlers above) — no separate alias
  // needed. Everything else gets `name = <expr>`.
  const hasOwnDeclaration = ctx.decls.some((decl) => decl.name === expr)

  const lines: string[] = ["from __future__ import annotations"]
  if (ctx.needsEnum) lines.push("from enum import Enum")
  const typingNames = [...ctx.typingImports].sort()
  if (typingNames.length > 0) lines.push(`from typing import ${typingNames.join(", ")}`)
  const pydanticNames = [...(ctx.needsBaseModel ? ["BaseModel", ...ctx.pydanticImports] : ctx.pydanticImports)].sort()
  if (pydanticNames.length > 0) lines.push(`from pydantic import ${pydanticNames.join(", ")}`)
  lines.push("")

  const body: string[] = []
  for (const decl of ctx.decls) {
    body.push(...renderDecl(decl), "")
  }
  if (!hasOwnDeclaration) {
    const discriminatorComment =
      ref.shape.kind === "union" && typeof ref.meta.discriminator === "string"
        ? `  # discriminated by ${quote(ref.meta.discriminator)}`
        : ""
    body.push(`${name} = ${expr}${discriminatorComment}`, "")
  }
  lines.push(...body)

  return `${lines.join("\n").trimEnd()}\n`
}
