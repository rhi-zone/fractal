import { ancestors, resolve, type TypeRef, type TypeRefDocument, type TypeShape } from "./index.ts"
import { toTypeScript } from "./typescript-native.ts"

// ============================================================================
// Docusaurus reference-page projector — TypeRefDocument -> one MDX page per
// named `defs` entry, suitable for dropping into a Docusaurus `docs/`
// directory (https://docusaurus.io/docs/create-doc). Unlike the single-string
// projectors elsewhere in this package (typescript-native.ts, json-schema.ts,
// …), this one is inherently document-shaped: named types cross-link to each
// other via relative MDX paths, so it needs the whole `defs` map up front to
// know which `ref` targets resolve to a page versus render as plain text.
//
// This projector does NOT ship the `<TypeRef>` React component itself (that's
// a Docusaurus-site concern, living alongside the site's own component tree,
// not type-ir's output). Every generated page opens with an MDX comment
// pointing this out — see the note emitted in `renderPage` below — so a
// caller wiring the output into a real site knows what to add.
// ============================================================================

/** One rendered inline-type fragment: literal MDX/markdown text, or a
 * cross-link to another `defs` entry's page (rendered as a markdown link
 * everywhere except where noted). Kept as a list rather than a single string
 * so callers building tables/prose can compose fragments without re-parsing
 * markdown out of a flattened string. */
type Part = { text: string } | { link: string; href: string }

function isDefined(name: string, doc: TypeRefDocument): boolean {
  return Object.hasOwn(doc.defs, name)
}

/** kebab-case a type name for use as a filename/frontmatter id — `FooBar` ->
 * `foo-bar`, `HTTPStatus` -> `http-status`, `already-kebab` unchanged. */
function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
}

function fileName(name: string): string {
  return `${kebabCase(name)}.mdx`
}

function linkHref(name: string): string {
  return `./${fileName(name)}`
}

function code(text: string): Part[] {
  return [{ text }]
}

function join(parts: readonly Part[][], sep: string): Part[] {
  const out: Part[] = []
  parts.forEach((p, i) => {
    if (i > 0) out.push({ text: sep })
    out.push(...p)
  })
  return out
}

/** Flatten `Part[]` to a markdown string — literal fragments are concatenated
 * as-is (they already carry backticks/braces where needed), links render as
 * `` [`Name`](./name.mdx) `` so a cross-referenced type reads as inline code
 * with a hyperlink, matching how the surrounding literal syntax reads. */
function partsToMarkdown(parts: readonly Part[]): string {
  return parts.map((p) => ("link" in p ? `[\`${p.link}\`](${p.href})` : p.text)).join("")
}

// Kinds whose TypeScript-like rendering needs no extra parens/wrapping when
// nested (mirrors typescript-native.ts's own `complexKinds`, duplicated here
// because this renderer's Part-based composition doesn't share that module's
// string-only handler shape).
const complexKinds = new Set(["union", "object", "map", "intersection", "function", "method", "stream", "page"])

type LinkedConverter = (shape: TypeShape, doc: TypeRefDocument, refs: Set<string>) => Part[]

const leaf =
  (text: string): LinkedConverter =>
  () =>
    code(text)

function quote(value: string): string {
  return JSON.stringify(value)
}

const linkedHandlers: Record<string, LinkedConverter> = {
  boolean: leaf("boolean"),
  number: leaf("number"),
  integer: leaf("number"),
  string: leaf("string"),
  null: leaf("null"),
  void: leaf("void"),
  unknown: leaf("unknown"),
  never: leaf("never"),
  object: (shape, doc, refs) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const optional = field.meta.optional === true
      return [...code(`${name}${optional ? "?" : ""}: `), ...renderLinkedType(field, doc, refs)]
    })
    return [...code("{ "), ...join(fields, "; "), ...code(" }")]
  },
  instance: (shape) => code((shape as TypeShape & { kind: "instance" }).className),
  array: (shape, doc, refs) => {
    const s = shape as TypeShape & { kind: "array" }
    const el = renderLinkedType(s.element, doc, refs)
    return complexKinds.has(s.element.shape.kind)
      ? [...code("Array<"), ...el, ...code(">")]
      : [...el, ...code("[]")]
  },
  stream: (shape, doc, refs) => {
    const s = shape as TypeShape & { kind: "stream" }
    return [...code("AsyncIterable<"), ...renderLinkedType(s.element, doc, refs), ...code(">")]
  },
  page: (shape, doc, refs) => {
    const s = shape as TypeShape & { kind: "page" }
    const wrapper = s.style === "offset" ? "OffsetPage<" : "CursorPage<"
    return [...code(wrapper), ...renderLinkedType(s.element, doc, refs), ...code(">")]
  },
  tuple: (shape, doc, refs) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return [...code("["), ...join(s.elements.map((el) => renderLinkedType(el, doc, refs)), ", "), ...code("]")]
  },
  map: (shape, doc, refs) => {
    const s = shape as TypeShape & { kind: "map" }
    if (s.key.shape.kind === "string") {
      return [...code("Record<string, "), ...renderLinkedType(s.value, doc, refs), ...code(">")]
    }
    return [
      ...code("Map<"),
      ...renderLinkedType(s.key, doc, refs),
      ...code(", "),
      ...renderLinkedType(s.value, doc, refs),
      ...code(">"),
    ]
  },
  union: (shape, doc, refs) => {
    const s = shape as TypeShape & { kind: "union" }
    return join(
      s.variants.map((v) => renderLinkedType(v, doc, refs)),
      " | ",
    )
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    return code(typeof s.value === "string" ? quote(s.value) : String(s.value))
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return code(s.members.map(quote).join(" | "))
  },
  ref: (shape, doc, refs) => {
    const s = shape as TypeShape & { kind: "ref" }
    refs.add(s.target)
    return isDefined(s.target, doc) ? [{ link: s.target, href: linkHref(s.target) }] : code(s.target)
  },
  intersection: (shape, doc, refs) => {
    const s = shape as TypeShape & { kind: "intersection" }
    return join(
      s.members.map((m) => renderLinkedType(m, doc, refs)),
      " & ",
    )
  },
  function: (shape, doc, refs) => {
    const s = shape as TypeShape & { kind: "function" }
    const params = s.params.map((p) => [...code(`${p.name}: `), ...renderLinkedType(p.type, doc, refs)])
    return [...code("("), ...join(params, ", "), ...code(") => "), ...renderLinkedType(s.returnType, doc, refs)]
  },
  interface: (shape, doc, refs) => {
    const s = shape as TypeShape & { kind: "interface" }
    const methods = Object.entries(s.methods).map(([name, methodRef]) => {
      const m = methodRef.shape as TypeShape & {
        kind: "method" | "function"
        params?: readonly { name: string; type: TypeRef }[]
        returnType?: TypeRef
      }
      if (m.params === undefined || m.returnType === undefined) {
        return [...code(`${name}(): `), ...renderLinkedType(methodRef, doc, refs)]
      }
      const params = m.params.map((p) => [...code(`${p.name}: `), ...renderLinkedType(p.type, doc, refs)])
      return [...code(`${name}(`), ...join(params, ", "), ...code("): "), ...renderLinkedType(m.returnType, doc, refs)]
    })
    return [...code("{ "), ...join(methods, "; "), ...code(" }")]
  },
}

/** Render a `TypeRef`'s structure as markdown-ready `Part[]`, resolving
 * `ref` nodes against `doc.defs` into cross-page links, and recording every
 * ref target visited (resolvable or not) into `refs` so callers can render a
 * "Referenced Types" section afterward. Degrades to the literal `unknown`
 * for kinds with no registered handler (and no ancestor with one) — see
 * `resolve()`'s ancestor-fallback in index.ts. */
function renderLinkedType(ref: TypeRef, doc: TypeRefDocument, refs: Set<string>): Part[] {
  const converter = resolve(ref.shape.kind, linkedHandlers)
  let parts = converter === undefined ? code("unknown") : converter(ref.shape, doc, refs)
  if (ref.meta.nullable === true) parts = [...parts, ...code(" | null")]
  return parts
}

function description(meta: Readonly<Record<string, unknown>>): string | undefined {
  return typeof meta.description === "string" ? meta.description : undefined
}

function title(name: string, meta: Readonly<Record<string, unknown>>): string {
  return typeof meta.title === "string" ? meta.title : name
}

function deprecatedNote(meta: Readonly<Record<string, unknown>>): string | undefined {
  if (meta.deprecated === true) return "This type is deprecated."
  if (typeof meta.deprecated === "string") return meta.deprecated
  return undefined
}

/** OpenAPI's singular `meta.example` and JSON Schema's plural `meta.examples`
 * (see json-schema.ts's own handling of the same two conventions) — merged
 * into one ordered list, singular first. */
function examples(meta: Readonly<Record<string, unknown>>): unknown[] {
  const out: unknown[] = []
  if (meta.example !== undefined) out.push(meta.example)
  if (Array.isArray(meta.examples)) out.push(...meta.examples)
  return out
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function fieldsTable(fields: Readonly<Record<string, TypeRef>>, doc: TypeRefDocument, refs: Set<string>): string {
  const rows = Object.entries(fields).map(([name, field]) => {
    const type = partsToMarkdown(renderLinkedType(field, doc, refs))
    const required = field.meta.optional === true ? "no" : "yes"
    const bits: string[] = []
    const desc = description(field.meta)
    if (desc !== undefined) bits.push(desc)
    if (field.meta.readonly === true) bits.push("_read-only_")
    if (field.meta.default !== undefined) bits.push(`default: \`${JSON.stringify(field.meta.default)}\``)
    if (field.meta.nullable === true) bits.push("_nullable_")
    return `| \`${name}\` | ${type} | ${required} | ${escapeCell(bits.join(" — "))} |`
  })
  return ["| Field | Type | Required | Description |", "| --- | --- | --- | --- |", ...rows].join("\n")
}

function variantsSection(variants: readonly TypeRef[], doc: TypeRefDocument, refs: Set<string>): string {
  return variants
    .map((variant) => {
      const type = partsToMarkdown(renderLinkedType(variant, doc, refs))
      const desc = description(variant.meta)
      return desc === undefined ? `- ${type}` : `- ${type} — ${desc}`
    })
    .join("\n")
}

function paramsTable(
  params: readonly { readonly name: string; readonly type: TypeRef }[],
  returnType: TypeRef,
  doc: TypeRefDocument,
  refs: Set<string>,
): string {
  const rows = params.map((p) => {
    const type = partsToMarkdown(renderLinkedType(p.type, doc, refs))
    return `| \`${p.name}\` | ${type} |`
  })
  const table = ["| Parameter | Type |", "| --- | --- |", ...rows].join("\n")
  const ret = partsToMarkdown(renderLinkedType(returnType, doc, refs))
  return `${table}\n\n**Returns:** ${ret}`
}

/** Render one `defs` entry's full MDX page — frontmatter, deprecation
 * warning, description, type signature, kind-specific body (fields/variants/
 * members/parameters), examples, and a "Referenced Types" section for every
 * `ref` touched along the way. `index` seeds `sidebar_position` so pages sort
 * in `defs`-declaration order by default (a caller wanting a different order
 * edits the generated frontmatter, or sorts `doc.defs` before calling in). */
function renderPage(name: string, ref: TypeRef, doc: TypeRefDocument, index: number): string {
  const meta = ref.meta
  const heading = title(name, meta)
  const desc = description(meta) ?? `Reference for \`${name}\`.`
  const dep = deprecatedNote(meta)
  const refs = new Set<string>()

  const lines: string[] = []
  lines.push("---")
  lines.push(`id: ${kebabCase(name)}`)
  lines.push(`title: ${heading}`)
  lines.push(`description: ${JSON.stringify(desc)}`)
  lines.push(`sidebar_position: ${index}`)
  lines.push("---")
  lines.push("")
  lines.push(
    "{/* This page uses a `<TypeRef name=\"...\" summary=\"...\" />` component for " +
      "inline hover-card type references. It is not shipped by type-ir — add a " +
      "companion `TypeRef` React component to this Docusaurus site's " +
      "`src/components/` (rendering `name` as a term with a tooltip/popover " +
      "showing `summary`) for these to display as intended; until then they " +
      "render as plain elements. */}",
  )
  lines.push("")
  lines.push(`# ${heading}`)
  lines.push("")

  if (dep !== undefined) {
    lines.push(":::warning Deprecated")
    lines.push(dep)
    lines.push(":::")
    lines.push("")
  }

  lines.push(desc)
  lines.push("")

  lines.push("## Type Signature")
  lines.push("")
  lines.push("```ts")
  lines.push(`type ${name} = ${toTypeScript(ref)};`)
  lines.push("```")
  lines.push("")

  const kind = ref.shape.kind
  const resolvedKind = kind in linkedHandlers ? kind : ancestors(kind).find((a) => a in linkedHandlers)

  if (resolvedKind === "object") {
    const s = ref.shape as TypeShape & { kind: "object" }
    lines.push("## Fields")
    lines.push("")
    lines.push(fieldsTable(s.fields, doc, refs))
    lines.push("")
  } else if (resolvedKind === "union") {
    const s = ref.shape as TypeShape & { kind: "union" }
    lines.push("## Variants")
    lines.push("")
    if (typeof meta.discriminator === "string") {
      lines.push(`Discriminated by \`${meta.discriminator}\`.`)
      lines.push("")
    }
    lines.push(variantsSection(s.variants, doc, refs))
    lines.push("")
  } else if (kind === "enum") {
    const s = ref.shape as TypeShape & { kind: "enum" }
    lines.push("## Members")
    lines.push("")
    lines.push(s.members.map((m) => `- \`${JSON.stringify(m)}\``).join("\n"))
    lines.push("")
  } else if (kind === "interface") {
    const s = ref.shape as TypeShape & { kind: "interface" }
    lines.push("## Methods")
    lines.push("")
    for (const [methodName, methodRef] of Object.entries(s.methods)) {
      const m = methodRef.shape as TypeShape & {
        kind: "method" | "function"
        params?: readonly { name: string; type: TypeRef }[]
        returnType?: TypeRef
      }
      lines.push(`### \`${methodName}\``)
      lines.push("")
      if (m.params !== undefined && m.returnType !== undefined) {
        lines.push(paramsTable(m.params, m.returnType, doc, refs))
      }
      lines.push("")
    }
  } else if (resolvedKind === "function") {
    const s = ref.shape as TypeShape & {
      kind: "function" | "method"
      params: readonly { name: string; type: TypeRef }[]
      returnType: TypeRef
    }
    lines.push("## Parameters")
    lines.push("")
    lines.push(paramsTable(s.params, s.returnType, doc, refs))
    lines.push("")
  }

  const ex = examples(meta)
  if (ex.length > 0) {
    lines.push("## Examples")
    lines.push("")
    for (const example of ex) {
      lines.push("```json")
      lines.push(JSON.stringify(example, null, 2))
      lines.push("```")
      lines.push("")
    }
  }

  // Every `ref` target touched while rendering this page's signature/fields/
  // variants — surfaced as hover-card components (see the MDX-comment note
  // above) plus a plain link, so the page is useful even before the
  // companion component exists.
  const referenced = [...refs].filter((r) => r !== name).sort()
  if (referenced.length > 0) {
    lines.push("## Referenced Types")
    lines.push("")
    for (const refName of referenced) {
      const target = doc.defs[refName]
      const summary =
        target === undefined ? "Unresolved reference — no matching entry in defs." : (description(target.meta) ?? "")
      const trailer = isDefined(refName, doc) ? ` — [${refName}](${linkHref(refName)})` : " _(unresolved)_"
      lines.push(`- <TypeRef name={${JSON.stringify(refName)}} summary={${JSON.stringify(summary)}} />${trailer}`)
    }
    lines.push("")
  }

  return `${lines.join("\n").trimEnd()}\n`
}

/**
 * Project a `TypeRefDocument` to a Docusaurus-ready reference-page set: one
 * MDX file per `doc.defs` entry, keyed by filename (`type-name.mdx`, kebab-
 * cased from the def's own key). `doc.root` is not itself paginated here —
 * it's typically the operation/endpoint shape that *uses* the named `defs`
 * types, not a named type of its own; a caller that wants a page for it can
 * add it to `defs` under a name first.
 *
 * `options.basePath`, when given, is prefixed onto the returned Map's keys
 * (e.g. `"api/types"` -> `"api/types/foo-bar.mdx"`) — cross-link `href`s
 * inside each page stay page-relative (`./foo-bar.mdx`) regardless, since
 * Docusaurus resolves those against the *linking* page's own directory,
 * which `basePath` doesn't change (every page in the set lives in the same
 * directory, so this stays correct).
 */
export function toDocusaurusReference(doc: TypeRefDocument, options?: { basePath?: string }): Map<string, string> {
  const pages = new Map<string, string>()
  const names = Object.keys(doc.defs)
  const prefix = options?.basePath !== undefined ? `${options.basePath.replace(/\/+$/, "")}/` : ""
  names.forEach((name, index) => {
    const ref = doc.defs[name]!
    pages.set(`${prefix}${fileName(name)}`, renderPage(name, ref, doc, index + 1))
  })
  return pages
}
