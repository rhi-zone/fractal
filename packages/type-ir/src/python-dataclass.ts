import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// ============================================================================
// Python projector — TypeRef -> idiomatic Python 3.10+ type definitions.
//
// Unlike typescript.ts (which renders a single inline type expression), object
// shapes here need an actual named declaration (`@dataclass class Foo: ...`),
// so this projector accumulates a list of top-level declarations (`Decl`) as
// it walks the tree — nested object/enum fields get promoted to their own
// class, named from the field name (same "capitalize the field/context name"
// convention protobuf.ts's `toProtoMessage` uses for nested messages), and
// referenced by name from the parent dataclass's field annotation.
//
// Syntax choices (both explicitly requested, reconciled as follows): the
// lowercase builtin generics (`list[T]`, `dict[K, V]`, `tuple[T1, T2]`) are
// the "modern 3.10+" half — PEP 585 — replacing `List`/`Dict`/`Tuple` from
// `typing`. `Optional[T]`/`Union[T1, T2]` stay as literal `typing` constructs
// rather than the PEP 604 `X | Y` spelling, matching the exact forms named in
// the spec.
// ============================================================================

type FieldDecl = {
  name: string
  type: string
  optional: boolean
  comment?: string
}

type Decl =
  | { kind: "dataclass"; name: string; fields: FieldDecl[]; docstring?: string; deprecated?: string | true }
  | { kind: "enum"; name: string; members: readonly string[] }
  | { kind: "protocol"; name: string; methodLines: string[] }

interface Ctx {
  decls: Decl[]
  // Names already emitted as a top-level declaration — guards against
  // re-emitting the same nested type twice (e.g. a field type reused across
  // two fields with the same context name) and against infinite recursion
  // should a caller construct a self-referential object graph directly
  // (rather than via `ref`/`defs`, which this projector doesn't resolve —
  // see the `ref` handler below).
  seen: Set<string>
  // Names to import from `typing`, collected as they're used.
  imports: Set<string>
  needsDataclass: boolean
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

const handlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("float"),
  integer: leaf("int"),
  string: leaf("str"),
  null: leaf("None"),
  void: leaf("None"),
  unknown: (_shape, _ref, _ctxName, ctx) => {
    ctx.imports.add("Any")
    return "Any"
  },
  never: (_shape, _ref, _ctxName, ctx) => {
    ctx.imports.add("NoReturn")
    return "NoReturn"
  },
  object: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "object" }
    const name = capitalize(ctxName)
    if (ctx.seen.has(name)) return name
    ctx.seen.add(name)
    ctx.needsDataclass = true

    // Python dataclasses require every field with a default to come after
    // every field without one — optional fields (which get `= None`) are
    // therefore collected separately and appended after required fields,
    // regardless of the source object's own field order.
    const required: FieldDecl[] = []
    const optional: FieldDecl[] = []
    for (const [fieldName, fieldRef] of Object.entries(s.fields)) {
      const rawType = toPythonType(fieldRef, capitalize(fieldName), ctx)
      const isOptional = fieldRef.meta.optional === true
      // `nullable` already wrapped `rawType` in `Optional[...]` inside
      // toPythonType — avoid double-wrapping when the field is *also*
      // omittable.
      const fieldType =
        isOptional && fieldRef.meta.nullable !== true
          ? (ctx.imports.add("Optional"), `Optional[${rawType}]`)
          : rawType
      const comment =
        fieldRef.shape.kind === "union" && typeof fieldRef.meta.discriminator === "string"
          ? `  # discriminated by ${quote(fieldRef.meta.discriminator)}`
          : undefined
      const decl: FieldDecl = comment === undefined
        ? { name: fieldName, type: fieldType, optional: isOptional }
        : { name: fieldName, type: fieldType, optional: isOptional, comment }
      ;(isOptional ? optional : required).push(decl)
    }
    const docstring = typeof _ref.meta.description === "string" ? _ref.meta.description : undefined
    const deprecated =
      typeof _ref.meta.deprecated === "string" ? _ref.meta.deprecated : _ref.meta.deprecated === true ? true : undefined
    const decl: Decl = { kind: "dataclass", name, fields: [...required, ...optional] }
    if (docstring !== undefined) decl.docstring = docstring
    if (deprecated !== undefined) decl.deprecated = deprecated
    ctx.decls.push(decl)
    return name
  },
  // A class instance carries only nominal identity (className/source), never
  // structure (see type-ir's TypeKinds.instance doc comment) — the caller
  // assembling this generated source is responsible for importing className,
  // same convention as typescript.ts's `instance` handler.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "array" }
    return `list[${toPythonType(s.element, ctxName, ctx)}]`
  },
  tuple: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const parts = s.elements.map((element, i) => toPythonType(element, `${ctxName}${i + 1}`, ctx))
    return `tuple[${parts.join(", ")}]`
  },
  // No native async-stream construct in the language itself; `AsyncIterator`
  // (typing / collections.abc) is the idiomatic equivalent of an
  // `async function` producing values over time.
  stream: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "stream" }
    ctx.imports.add("AsyncIterator")
    return `AsyncIterator[${toPythonType(s.element, ctxName, ctx)}]`
  },
  // No pagination convention in Python's standard vocabulary — degrades
  // honestly to `list[T]` over the page's element type, same as the
  // protobuf/other projectors' page handler.
  page: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "page" }
    return `list[${toPythonType(s.element, ctxName, ctx)}]`
  },
  map: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = toPythonType(s.key, `${ctxName}Key`, ctx)
    const value = toPythonType(s.value, `${ctxName}Value`, ctx)
    return `dict[${key}, ${value}]`
  },
  union: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "union" }
    const parts = s.variants.map((variant, i) => toPythonType(variant, `${ctxName}Variant${i + 1}`, ctx))
    const unique = [...new Set(parts)]
    if (unique.length === 1) return unique[0]!
    ctx.imports.add("Union")
    return `Union[${unique.join(", ")}]`
  },
  literal: (shape, _ref, _ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "None"
    ctx.imports.add("Literal")
    if (typeof s.value === "string") return `Literal[${quote(s.value)}]`
    if (typeof s.value === "boolean") return `Literal[${s.value ? "True" : "False"}]`
    return `Literal[${s.value}]`
  },
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
  // is an object, the honest rendering is a single dataclass merging all
  // members' fields (mirrors what an intersection of object shapes actually
  // means structurally) — otherwise this degrades to `Any`, same fallback
  // protobuf.ts's intersection handler uses.
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
    ctx.imports.add("Any")
    return "Any"
  },
  function: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "function" }
    ctx.imports.add("Callable")
    const params = s.params.map((param, i) => toPythonType(param.type, `${ctxName}Param${i + 1}`, ctx))
    const returnType = toPythonType(s.returnType, `${ctxName}Return`, ctx)
    return `Callable[[${params.join(", ")}], ${returnType}]`
  },
  // `method` has no explicit entry — falls back to `function`'s Callable[...]
  // rendering via `registerParent("method", "function")` (index.ts), same as
  // typescript.ts's standalone-method fallback. The `interface` handler below
  // renders each method with proper `def` signatures instead, since that's
  // idiomatic once a callable belongs to a class's own member list.
  interface: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "interface" }
    const name = capitalize(ctxName)
    if (ctx.seen.has(name)) return name
    ctx.seen.add(name)
    ctx.imports.add("Protocol")
    const methodLines: string[] = []
    for (const [methodName, methodRef] of Object.entries(s.methods)) {
      const m = methodRef.shape as TypeShape & {
        kind: "method" | "function"
        params: readonly { name: string; type: TypeRef }[]
        returnType: TypeRef
      }
      const params = m.params.map((p) => `${p.name}: ${toPythonType(p.type, capitalize(p.name), ctx)}`)
      const returnType = toPythonType(m.returnType, `${capitalize(methodName)}Return`, ctx)
      methodLines.push(`    def ${methodName}(self, ${params.join(", ")}) -> ${returnType}: ...`)
    }
    ctx.decls.push({ kind: "protocol", name, methodLines })
    return name
  },
}

/** Convert a `TypeRef` to a Python type *expression* (e.g. `list[str]`,
 * `Optional[int]`, or a class name for object/enum shapes) — the building
 * block `toPython` uses for the module-level render. `ctxName` names any
 * nested class/enum this call generates (capitalized per Python convention);
 * side effects (new `Decl`s, `typing` imports) land on `ctx`. */
export function toPythonType(ref: TypeRef, ctxName: string, ctx: Ctx): string {
  const converter = resolve(ref.shape.kind, handlers)
  let type: string
  if (converter === undefined) {
    ctx.imports.add("Any")
    type = "Any"
  } else {
    type = converter(ref.shape, ref, ctxName, ctx)
  }
  if (ref.meta.nullable === true) {
    ctx.imports.add("Optional")
    type = `Optional[${type}]`
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
  const lines = ["@dataclass", `class ${decl.name}:`]
  if (decl.docstring !== undefined) lines.push(`    ${quote(decl.docstring)}`)
  if (decl.deprecated !== undefined) {
    lines.push(`    # Deprecated${decl.deprecated === true ? "" : `: ${decl.deprecated}`}`)
  }
  if (decl.fields.length === 0) {
    if (decl.docstring === undefined && decl.deprecated === undefined) lines.push("    pass")
    return lines
  }
  for (const field of decl.fields) {
    const defaultValue = field.optional ? " = None" : ""
    lines.push(`    ${field.name}: ${field.type}${defaultValue}${field.comment ?? ""}`)
  }
  return lines
}

/**
 * Render a `TypeRef` as a standalone Python module: every nested
 * object/enum/interface promoted to a top-level `@dataclass`/`Enum`/
 * `Protocol` class, plus (for shapes with no class of their own — unions,
 * primitives, arrays, …) a `Name = <expr>` type alias for `ref` itself.
 * `name` seeds both the alias name and the base for any nested class names
 * derived from it.
 */
export function toPython(ref: TypeRef, name = "Root"): string {
  const ctx: Ctx = { decls: [], seen: new Set(), imports: new Set(), needsDataclass: false, needsEnum: false }
  const expr = toPythonType(ref, name, ctx)

  // Object/enum/interface shapes already emit a top-level class named `expr`
  // (via the `seen`-guarded push in their handlers above) — no separate alias
  // needed. Everything else gets `name = <expr>`.
  const hasOwnDeclaration = ctx.decls.some((decl) => decl.name === expr)

  const lines: string[] = ["from __future__ import annotations"]
  if (ctx.needsDataclass) lines.push("from dataclasses import dataclass")
  if (ctx.needsEnum) lines.push("from enum import Enum")
  const typingNames = [...ctx.imports].sort()
  if (typingNames.length > 0) lines.push(`from typing import ${typingNames.join(", ")}`)
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
