import { resolve, type TypeRef, type TypeRefDocument, type TypeShape } from "./index.ts"
import { toJsonSchema } from "./json-schema.ts"

// ============================================================================
// Starlight reference projector — TypeRefDocument -> one Astro Starlight MDX
// page per named entry in `doc.defs`.
//
// Unlike the single-expression projectors (typescript-native.ts) or the
// single-module declaration projectors (python-dataclass.ts), this projector
// is DOCUMENT-shaped: it needs one output artifact (a whole page) per named
// def, plus cross-links between those pages, so it returns `Map<filename,
// content>` rather than a single string. Only `doc.defs` entries get pages —
// `doc.root` is not a *named* type (see index.ts's TypeRefDocument doc
// comment) and has nowhere of its own to link to.
//
// The "Type Signature" section renders both a TypeScript-like expression
// (this package's typescript-native.ts idiom — approachable at a glance) and
// the def's JSON Schema (via json-schema.ts, already exact per-kind semantics)
// side by side in a `<Tabs>`, so the page never re-implements JSON Schema
// projection independently and can't drift from it.
// ============================================================================

/** kebab-case a def name for use as both a filename stem and a relative link
 * target — handles PascalCase/camelCase (`UserAccount` -> `user-account`),
 * snake_case, and already-kebab input uniformly. */
function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
}

/** YAML/JSX-safe double-quoted string literal — JSON's quoting rules are a
 * strict subset of YAML flow-scalar quoting and valid inside a JSX
 * expression, so a single helper covers both frontmatter and MDX body use. */
function quote(value: string): string {
  return JSON.stringify(value)
}

function defTitle(name: string, ref: TypeRef | undefined): string {
  if (ref !== undefined && typeof ref.meta.title === "string") return ref.meta.title
  return name
}

function linkHref(basePath: string, name: string): string {
  return `${basePath}${toKebabCase(name)}`
}

// ============================================================================
// Plain-text type-expression rendering (for the fenced ```ts signature block)
// — mirrors typescript-native.ts's toTypeScript, but a `ref` renders as the
// bare target name (a code block is not MDX, so it can't carry a live link;
// cross-linking happens separately in prose sections below).
// ============================================================================

type ExprConverter = (shape: TypeShape) => string

const exprLeaf =
  (type: string): ExprConverter =>
  () =>
    type

const exprComplexKinds = new Set(["union", "object", "map", "intersection", "function", "stream", "page", "interface"])

const exprHandlers: Record<string, ExprConverter> = {
  boolean: exprLeaf("boolean"),
  number: exprLeaf("number"),
  integer: exprLeaf("number"),
  int32: exprLeaf("number"),
  int64: exprLeaf("number"),
  float32: exprLeaf("number"),
  float64: exprLeaf("number"),
  string: exprLeaf("string"),
  uuid: exprLeaf("string"),
  uri: exprLeaf("string"),
  email: exprLeaf("string"),
  datetime: exprLeaf("Date"),
  date: exprLeaf("Date"),
  time: exprLeaf("string"),
  duration: exprLeaf("string"),
  bytes: exprLeaf("Uint8Array"),
  null: exprLeaf("null"),
  void: exprLeaf("void"),
  unknown: exprLeaf("unknown"),
  never: exprLeaf("never"),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const optional = field.meta.optional === true
      const readonly = field.meta.readonly === true
      return `${readonly ? "readonly " : ""}${name}${optional ? "?" : ""}: ${renderTypeExpr(field)}`
    })
    return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`
  },
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return exprComplexKinds.has(s.element.shape.kind) ? `Array<${renderTypeExpr(s.element)}>` : `${renderTypeExpr(s.element)}[]`
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `[${s.elements.map(renderTypeExpr).join(", ")}]`
  },
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `AsyncIterable<${renderTypeExpr(s.element)}>`
  },
  page: (shape) => {
    const s = shape as TypeShape & { kind: "page" }
    return s.style === "offset" ? `OffsetPage<${renderTypeExpr(s.element)}>` : `CursorPage<${renderTypeExpr(s.element)}>`
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return s.key.shape.kind === "string" ? `Record<string, ${renderTypeExpr(s.value)}>` : `Map<${renderTypeExpr(s.key)}, ${renderTypeExpr(s.value)}>`
  },
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    return s.variants.map(renderTypeExpr).join(" | ")
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (typeof s.value === "string") return quote(s.value)
    return String(s.value)
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return s.members.map(quote).join(" | ")
  },
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    return s.members.map(renderTypeExpr).join(" & ")
  },
  function: (shape) => {
    const s = shape as TypeShape & { kind: "function" }
    const thisParam = s.thisType === undefined ? [] : [`this: ${renderTypeExpr(s.thisType)}`]
    const params = [...thisParam, ...s.params.map((p) => `${p.name}: ${renderTypeExpr(p.type)}`)]
    return `(${params.join(", ")}) => ${renderTypeExpr(s.returnType)}`
  },
  interface: (shape) => {
    const s = shape as TypeShape & { kind: "interface" }
    const methods = Object.entries(s.methods).map(([name, methodRef]) => {
      const m = methodRef.shape as TypeShape & { kind: "method" | "function"; params: readonly { name: string; type: TypeRef }[]; returnType: TypeRef }
      const params = m.params.map((p) => `${p.name}: ${renderTypeExpr(p.type)}`)
      return `${name}(${params.join(", ")}): ${renderTypeExpr(m.returnType)}`
    })
    return methods.length === 0 ? "{}" : `{ ${methods.join("; ")} }`
  },
}

function renderTypeExpr(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, exprHandlers)
  let type = converter === undefined ? "unknown" : converter(ref.shape)
  if (ref.meta.nullable === true) type = `${type} | null`
  return type
}

// ============================================================================
// One-line human summary of a shape — used both as the `title` attribute for
// hover cross-links and as a `<LinkCard description>` for variant/field
// cross-references, so a reader gets useful context without navigating away.
// ============================================================================

function typeSummary(ref: TypeRef): string {
  if (typeof ref.meta.description === "string") return ref.meta.description
  const shape = ref.shape
  switch (shape.kind) {
    case "object": {
      const count = Object.keys((shape as TypeShape & { kind: "object" }).fields).length
      return `object with ${count} field${count === 1 ? "" : "s"}`
    }
    case "union": {
      const count = (shape as TypeShape & { kind: "union" }).variants.length
      return `union of ${count} variant${count === 1 ? "" : "s"}`
    }
    case "enum": {
      const count = (shape as TypeShape & { kind: "enum" }).members.length
      return `enum with ${count} member${count === 1 ? "" : "s"}`
    }
    case "interface": {
      const count = Object.keys((shape as TypeShape & { kind: "interface" }).methods).length
      return `interface with ${count} method${count === 1 ? "" : "s"}`
    }
    default:
      return renderTypeExpr(ref)
  }
}

/** A hover-annotated cross-link to a `defs` entry, per the spec's "native
 * title attribute for lightweight hover" convention. Falls back to a plain
 * inline code span for non-ref shapes (nothing to link to). */
function linkedType(ref: TypeRef, doc: TypeRefDocument, basePath: string): string {
  if (ref.shape.kind === "ref") {
    const target = (ref.shape as TypeShape & { kind: "ref" }).target
    const targetRef = doc.defs[target]
    const label = defTitle(target, targetRef)
    const summary = targetRef === undefined ? "unresolved reference" : typeSummary(targetRef)
    return `<span title=${quote(summary)}>[${label}](${linkHref(basePath, target)})</span>`
  }
  if (ref.shape.kind === "array") {
    const s = ref.shape as TypeShape & { kind: "array" }
    return `${linkedType(s.element, doc, basePath)}[]`
  }
  return `\`${renderTypeExpr(ref)}\``
}

// ============================================================================
// Page body sections
// ============================================================================

function renderFieldsTable(shape: TypeShape & { kind: "object" }, doc: TypeRefDocument, basePath: string): string {
  const rows = Object.entries(shape.fields).map(([name, field]) => {
    const type = linkedType(field, doc, basePath)
    const required = field.meta.optional === true ? "optional" : "required"
    const flags = [required]
    if (field.meta.nullable === true) flags.push("nullable")
    if (field.meta.readonly === true) flags.push("readonly")
    const descriptionParts: string[] = []
    if (typeof field.meta.description === "string") descriptionParts.push(field.meta.description)
    if (field.meta.default !== undefined) descriptionParts.push(`Default: \`${JSON.stringify(field.meta.default)}\``)
    if (field.meta.deprecated === true || typeof field.meta.deprecated === "string") {
      const reason = typeof field.meta.deprecated === "string" ? field.meta.deprecated : "deprecated"
      descriptionParts.push(`**Deprecated:** ${reason}`)
    }
    const description = descriptionParts.join(" ").replace(/\|/g, "\\|") || "—"
    return `| \`${name}\` | ${type} | ${flags.join(", ")} | ${description} |`
  })
  return ["| Field | Type | Constraints | Description |", "| --- | --- | --- | --- |", ...rows].join("\n")
}

function renderMethodsTable(shape: TypeShape & { kind: "interface" }, doc: TypeRefDocument, basePath: string): string {
  const rows = Object.entries(shape.methods).map(([name, methodRef]) => {
    const m = methodRef.shape as TypeShape & { kind: "method" | "function"; params: readonly { name: string; type: TypeRef }[]; returnType: TypeRef }
    const params = m.params.map((p) => `${p.name}: ${renderTypeExpr(p.type)}`).join(", ")
    const returnType = linkedType(m.returnType, doc, basePath)
    const description = typeof methodRef.meta.description === "string" ? methodRef.meta.description : "—"
    return `| \`${name}(${params})\` | ${returnType} | ${description} |`
  })
  return ["| Method | Returns | Description |", "| --- | --- | --- |", ...rows].join("\n")
}

function renderEnumSection(shape: TypeShape & { kind: "enum" }): string {
  const rows = shape.members.map((member) => `| \`${quote(member)}\` |`)
  return ["| Member |", "| --- |", ...rows].join("\n")
}

function renderVariantsSection(
  shape: TypeShape & { kind: "union" },
  meta: Readonly<Record<string, unknown>>,
  doc: TypeRefDocument,
  basePath: string,
): string {
  const parts: string[] = []
  if (typeof meta.discriminator === "string") {
    parts.push(`Discriminated by the \`${meta.discriminator}\` property.`, "")
  }
  for (const variant of shape.variants) {
    if (variant.shape.kind === "ref") {
      const target = (variant.shape as TypeShape & { kind: "ref" }).target
      const targetRef = doc.defs[target]
      const title = defTitle(target, targetRef)
      const description = targetRef === undefined ? "Unresolved reference." : typeSummary(targetRef)
      parts.push(`<LinkCard title=${quote(title)} description=${quote(description)} href=${quote(linkHref(basePath, target))} />`)
    } else {
      parts.push("```ts", renderTypeExpr(variant), "```")
    }
  }
  return parts.join("\n")
}

function renderExamplesSection(meta: Readonly<Record<string, unknown>>): string | undefined {
  const examples: unknown[] = Array.isArray(meta.examples) ? meta.examples : meta.example !== undefined ? [meta.example] : []
  if (examples.length === 0) return undefined
  return examples.map((example) => `<Code code={${quote(JSON.stringify(example, null, 2))}} lang="json" />`).join("\n\n")
}

/** Render the def's own top-level shape section (fields/methods/members/
 * variants) — dispatches on `resolve()` the same way every other projector in
 * this package does, so an extension-registered kind with no explicit
 * handler here falls back to its nearest ancestor's, and a kind with no
 * ancestor at all simply gets no shape-specific section (the type-signature
 * tabs above already cover it). */
function renderShapeSection(ref: TypeRef, doc: TypeRefDocument, basePath: string): string | undefined {
  const shape = ref.shape
  const kind = resolve(shape.kind, Object.fromEntries((["object", "interface", "enum", "union"] as const).map((k) => [k, k])))
  switch (kind) {
    case "object":
      return `### Fields\n\n${renderFieldsTable(shape as TypeShape & { kind: "object" }, doc, basePath)}`
    case "interface":
      return `### Methods\n\n${renderMethodsTable(shape as TypeShape & { kind: "interface" }, doc, basePath)}`
    case "enum":
      return `### Members\n\n${renderEnumSection(shape as TypeShape & { kind: "enum" })}`
    case "union":
      return `### Variants\n\n${renderVariantsSection(shape as TypeShape & { kind: "union" }, ref.meta, doc, basePath)}`
    default:
      return undefined
  }
}

function renderPage(name: string, ref: TypeRef, doc: TypeRefDocument, basePath: string): string {
  const title = defTitle(name, ref)
  const description = typeof ref.meta.description === "string" ? ref.meta.description : `Reference for ${title}.`

  const frontmatter = ["---", `title: ${quote(title)}`, `description: ${quote(description)}`, "tableOfContents:", "  maxHeadingLevel: 4", "---"].join(
    "\n",
  )

  const imports = "import { Tabs, TabItem, Aside, LinkCard, Code } from '@astrojs/starlight/components';"

  const sections: string[] = []

  if (ref.meta.deprecated === true || typeof ref.meta.deprecated === "string") {
    const reason = typeof ref.meta.deprecated === "string" ? ref.meta.deprecated : "This type is deprecated."
    sections.push(`<Aside type="caution">Deprecated: ${reason}</Aside>`)
  }

  if (typeof ref.meta.description === "string") {
    sections.push(ref.meta.description)
  }

  const jsonSchema = JSON.stringify(toJsonSchema(ref), null, 2)
  sections.push(
    [
      "### Type Signature",
      "",
      "<Tabs>",
      '<TabItem label="TypeScript">',
      "```ts",
      `type ${name} = ${renderTypeExpr(ref)};`,
      "```",
      "</TabItem>",
      '<TabItem label="JSON Schema">',
      "```json",
      jsonSchema,
      "```",
      "</TabItem>",
      "</Tabs>",
    ].join("\n"),
  )

  const shapeSection = renderShapeSection(ref, doc, basePath)
  if (shapeSection !== undefined) sections.push(shapeSection)

  const examplesSection = renderExamplesSection(ref.meta)
  if (examplesSection !== undefined) sections.push(`### Examples\n\n${examplesSection}`)

  return `${frontmatter}\n\n${imports}\n\n${sections.join("\n\n")}\n`
}

/**
 * Project a `TypeRefDocument` to a set of Starlight-compatible MDX reference
 * pages — one per named entry in `doc.defs` (see index.ts's TypeRefDocument
 * doc comment: `defs` is exactly the set of types with a name of their own;
 * `root` is not named and gets no page). Returned map keys are filenames
 * (`{kebab-case-name}.mdx`) suitable for writing directly into a Starlight
 * content collection directory; `options.basePath` (default `"./"`) controls
 * the relative-link prefix used for cross-references between pages, for
 * callers whose pages don't live in a flat sibling directory.
 */
export function toStarlightReference(doc: TypeRefDocument, options?: { basePath?: string }): Map<string, string> {
  const basePath = options?.basePath ?? "./"
  const pages = new Map<string, string>()
  for (const [name, ref] of Object.entries(doc.defs)) {
    pages.set(`${toKebabCase(name)}.mdx`, renderPage(name, ref, doc, basePath))
  }
  return pages
}
