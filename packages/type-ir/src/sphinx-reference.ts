import { ancestors, resolve, type TypeRef, type TypeRefDocument, type TypeShape } from "./index.ts"
import { quote } from "./codegen-helpers.ts"

// ============================================================================
// Sphinx reference-page projector — TypeRefDocument -> one reStructuredText
// (.rst) page per `doc.defs` entry, written for Sphinx's own native markup
// (docutils directives/roles), NOT MyST Markdown. MyST is a Sphinx *option*,
// not its default/idiomatic form, and adopting it here would blur the line
// with the MkDocs Markdown target (mkdocs-reference.ts) — RST is what makes
// this projector a genuinely distinct target rather than a reskinned
// mkdocs-reference.ts.
//
// Every other projector in this package renders a single TypeRef to a single
// string. This one is document-shaped instead (`Map<filename, content>`)
// because a reference site is inherently multi-page: each named def gets its
// own page, and pages cross-link each other via Sphinx's `:ref:` role against
// an explicit `.. _label:` target placed just before each page's title (RST
// has no implicit per-file anchor the way Markdown link targets do — the
// label must be declared).
// ============================================================================

// Converts an arbitrary def name (PascalCase, camelCase, snake_case, ...)
// into the kebab-case stem used for the page's filename, its `.. _label:`
// target, and every `:ref:` role that targets it, so a link built from a def
// name and a filename/label built from the same name always agree.
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function fileName(name: string): string {
  return `${kebabCase(name)}.rst`
}

function isKind(kind: string, ancestor: string): boolean {
  return kind === ancestor || ancestors(kind).includes(ancestor)
}

// RST title/section underline convention used consistently across every page
// this projector emits: docutils infers heading *level* from the first time
// it sees a given underline character on a page, so the character-per-level
// mapping only needs to stay consistent within one page, but keeping it
// consistent across every page keeps the whole generated site's heading
// hierarchy uniform too. docutils is strict about the underline being at
// least as long as the title text — `heading` always emits an exact-length
// underline, never a fixed-width one, so this can never desync.
const HEADING_CHARS = { page: "=", section: "-", subsection: "~", subsubsection: "^" } as const

function heading(text: string, level: keyof typeof HEADING_CHARS): string {
  return `${text}\n${HEADING_CHARS[level].repeat(text.length)}`
}

// A table cell / inline-text value must not carry raw newlines (they would
// break docutils' line-based block structure); collapse to spaces the same
// way mkdocs-reference.ts's `escapeTableCell` does for Markdown tables. RST
// list-table cells don't need `|`-escaping (that's a Markdown-table-specific
// delimiter with no RST equivalent), so this is strictly simpler.
function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, " ")
}

// ============================================================================
// Type-expression rendering — a simple TypeScript-like inline syntax, shared
// by the fenced `code-block:: typescript` signature block (`linked: false`)
// and table/prose cells that should cross-link `ref` kinds to their own page
// via a `:ref:` role (`linked: true`). Structurally identical to
// mkdocs-reference.ts's `renderTypeExpr` — the two projectors deliberately
// share the same TypeScript-like expression syntax for the fenced signature
// block (see docs/reference/type-ir/doc-projectors.md), differing only in
// how a `ref` kind renders when cross-linked.
// ============================================================================

type ExprConverter = (shape: TypeShape, linked: boolean) => string

const leaf =
  (type: string): ExprConverter =>
  () =>
    type

const complexKinds = new Set(["union", "object", "map", "intersection", "function", "method", "stream", "page", "interface"])

function link(name: string, linked: boolean): string {
  return linked ? `:ref:\`${name} <${kebabCase(name)}>\`` : name
}

const exprHandlers: Record<string, ExprConverter> = {
  boolean: leaf("boolean"),
  number: leaf("number"),
  integer: leaf("integer"),
  string: leaf("string"),
  null: leaf("null"),
  void: leaf("void"),
  unknown: leaf("unknown"),
  never: leaf("never"),
  object: (shape, linked) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const optional = field.meta.optional === true
      return `${name}${optional ? "?" : ""}: ${renderTypeExpr(field, linked)}`
    })
    return `{ ${fields.join("; ")} }`
  },
  // Purely nominal — no structural fields to render (see type-ir's
  // TypeKinds.instance doc comment); the class name is the whole story.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, linked) => {
    const s = shape as TypeShape & { kind: "array" }
    if (complexKinds.has(s.element.shape.kind)) return `Array<${renderTypeExpr(s.element, linked)}>`
    const element = renderTypeExpr(s.element, linked)
    // A `:ref:` role's closing backtick may not be immediately followed by
    // `[` — docutils only allows whitespace or a fixed closing-punctuation
    // set (`)]}>...`) right after an inline-markup end-string, and `[` (an
    // *opening* bracket) isn't in that set. Confirmed as a real
    // `sphinx-build` "Inline interpreted text ... without end-string"
    // warning during this projector's bar-D visual check, not assumed from
    // the docutils spec alone — a linked `X[]` array-of-ref rendered exactly
    // this way broke a real build. `\ ` is docutils' documented escape for
    // placing adjacent inline markup: a backslash-escaped space is invisible
    // in the rendered output but still counts as the whitespace boundary the
    // parser requires. Only needed when the element is itself a linked `ref`
    // (the only kind whose rendering ends in a role) — every other leaf kind
    // ends in plain text, which has no such adjacency restriction.
    return linked && s.element.shape.kind === "ref" ? `${element}\\ []` : `${element}[]`
  },
  tuple: (shape, linked) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `[${s.elements.map((e) => renderTypeExpr(e, linked)).join(", ")}]`
  },
  stream: (shape, linked) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `AsyncIterable<${renderTypeExpr(s.element, linked)}>`
  },
  page: (shape, linked) => {
    const s = shape as TypeShape & { kind: "page" }
    const inner = renderTypeExpr(s.element, linked)
    return s.style === "offset" ? `OffsetPage<${inner}>` : `CursorPage<${inner}>`
  },
  map: (shape, linked) => {
    const s = shape as TypeShape & { kind: "map" }
    return s.key.shape.kind === "string"
      ? `Record<string, ${renderTypeExpr(s.value, linked)}>`
      : `Map<${renderTypeExpr(s.key, linked)}, ${renderTypeExpr(s.value, linked)}>`
  },
  union: (shape, linked) => {
    const s = shape as TypeShape & { kind: "union" }
    return s.variants.map((v) => renderTypeExpr(v, linked)).join(" | ")
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    return typeof s.value === "string" ? quote(s.value) : String(s.value)
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return s.members.map(quote).join(" | ")
  },
  ref: (shape, linked) => {
    const s = shape as TypeShape & { kind: "ref" }
    return link(s.target, linked)
  },
  intersection: (shape, linked) => {
    const s = shape as TypeShape & { kind: "intersection" }
    return s.members.map((m) => renderTypeExpr(m, linked)).join(" & ")
  },
  function: (shape, linked) => {
    const s = shape as TypeShape & { kind: "function" }
    const thisParam = s.thisType === undefined ? [] : [`this: ${renderTypeExpr(s.thisType, linked)}`]
    const params = [...thisParam, ...s.params.map((p) => `${p.name}: ${renderTypeExpr(p.type, linked)}`)]
    return `(${params.join(", ")}) => ${renderTypeExpr(s.returnType, linked)}`
  },
  // `method` has no explicit entry — falls back to `function`'s arrow syntax
  // via `registerParent("method", "function")` (index.ts), same convention
  // typescript-native.ts uses. The `interface` handler below renders each
  // method with method-signature syntax instead.
  interface: (shape, linked) => {
    const s = shape as TypeShape & { kind: "interface" }
    const methods = Object.entries(s.methods).map(([name, methodRef]) => {
      const m = methodRef.shape as TypeShape & { kind: "method" | "function"; params?: unknown; returnType?: unknown }
      if (m.params === undefined || m.returnType === undefined) return `${name}(): ${renderTypeExpr(methodRef, linked)}`
      const mm = m as TypeShape & { kind: "method" | "function"; params: readonly { name: string; type: TypeRef }[]; returnType: TypeRef }
      const params = mm.params.map((p) => `${p.name}: ${renderTypeExpr(p.type, linked)}`)
      return `${name}(${params.join(", ")}): ${renderTypeExpr(mm.returnType, linked)}`
    })
    return `{ ${methods.join("; ")} }`
  },
}

export function renderTypeExpr(ref: TypeRef, linked = false): string {
  const converter = resolve(ref.shape.kind, exprHandlers)
  let type = converter === undefined ? "unknown" : converter(ref.shape, linked)
  if (ref.meta.nullable === true) type = `${type} | null`
  return type
}

// ============================================================================
// Page sections
// ============================================================================

// Sphinx's `deprecated` directive (`sphinx.domains.changeset.VersionChange`,
// `required_arguments = 1`, `optional_arguments = 1`, `final_argument_whitespace
// = True`) parses its `::`-line as up to *two* whitespace-separated
// arguments — version, then an inline one-line explanation — greedily
// splitting any multi-word single-line argument into both slots rather than
// treating it as one. Putting a multi-word reason directly on the `::` line
// (as this function did in an earlier draft) silently produces a garbled
// "Deprecated since version <first word>: <rest>" render — confirmed against
// real `sphinx-build` output during this projector's bar-D visual check, not
// assumed from the directive's own docs. The fix: only a single, non-data
// placeholder token goes on the `::` line (this projector has no real
// version/since information in `meta` — only a boolean-or-reason — so
// fabricating a plausible-looking version number here would misrepresent
// data that doesn't exist), and the actual reason is the *body* — an
// indented paragraph below a blank line, which docutils parses as directive
// content rather than as a second argument, so it renders as free text
// regardless of word count.
function deprecatedDirective(meta: Readonly<Record<string, unknown>>): string | undefined {
  if (meta.deprecated === undefined || meta.deprecated === false) return undefined
  const reason = typeof meta.deprecated === "string" ? meta.deprecated : undefined
  return reason === undefined ? ".. deprecated:: N/A" : [".. deprecated:: N/A", "", `   ${reason}`].join("\n")
}

function fieldTableRows(fields: Readonly<Record<string, TypeRef>>): string[] {
  return Object.entries(fields).flatMap(([name, field]) => {
    const type = escapeCell(renderTypeExpr(field, true))
    const required = field.meta.optional === true ? "No" : "Yes"
    const notes: string[] = []
    if (typeof field.meta.description === "string") notes.push(field.meta.description)
    if (field.meta.readonly === true) notes.push("read-only")
    if (field.meta.default !== undefined) notes.push(`default: \`\`${quote(field.meta.default)}\`\``)
    if (field.meta.deprecated !== undefined && field.meta.deprecated !== false) notes.push("**deprecated**")
    const description = escapeCell(notes.join(" — "))
    return [`   * - ${name}`, `     - ${type}`, `     - ${required}`, `     - ${description}`]
  })
}

function fieldsSection(fields: Readonly<Record<string, TypeRef>>): string {
  if (Object.keys(fields).length === 0) return [heading("Fields", "section"), "", "This type has no fields."].join("\n")
  const rows = fieldTableRows(fields)
  return [
    heading("Fields", "section"),
    "",
    ".. list-table::",
    "   :header-rows: 1",
    "   :widths: 20 25 10 45",
    "",
    "   * - Field",
    "     - Type",
    "     - Required",
    "     - Description",
    ...rows,
  ].join("\n")
}

function methodTableRows(methods: Readonly<Record<string, TypeRef>>): string[] {
  return Object.entries(methods).flatMap(([name, methodRef]) => {
    const description = escapeCell(typeof methodRef.meta.description === "string" ? methodRef.meta.description : "")
    // NOT wrapped in a `` `` `` literal span: a cross-linked signature
    // embeds `:ref:` roles (via `renderTypeExpr(ref, true)`), and docutils
    // does not parse inline markup inside a literal span — wrapping the
    // whole thing would render the role as dead literal text instead of a
    // working link. Confirmed against real `sphinx-build` HTML output during
    // this projector's bar-D visual check, not assumed. `fieldsSection`
    // above never had this bug because it already left the type cell
    // unwrapped for the same reason.
    const signature = escapeCell(renderTypeExpr(methodRef, true))
    return [`   * - ${name}`, `     - ${signature}`, `     - ${description}`]
  })
}

function methodsSection(methods: Readonly<Record<string, TypeRef>>): string {
  const rows = methodTableRows(methods)
  return [
    heading("Methods", "section"),
    "",
    ".. list-table::",
    "   :header-rows: 1",
    "   :widths: 25 35 40",
    "",
    "   * - Method",
    "     - Signature",
    "     - Description",
    ...rows,
  ].join("\n")
}

function membersSection(members: readonly string[]): string {
  return [heading("Members", "section"), "", ...members.map((m) => `- \`\`${quote(m)}\`\``)].join("\n")
}

// A discriminated-union variant's display name: `meta.title` first, then the
// literal value of the field named by the union's own `meta.discriminator`
// (the tag that actually distinguishes it at runtime), then a positional
// fallback. Identical selection logic to mkdocs-reference.ts's
// `variantName` — the two projectors are expected to agree on what a variant
// is *called*, differing only in markup.
function variantName(variant: TypeRef, index: number, discriminator: string | undefined): string {
  if (typeof variant.meta.title === "string") return variant.meta.title
  if (variant.shape.kind === "ref") return (variant.shape as TypeShape & { kind: "ref" }).target
  if (discriminator !== undefined && isKind(variant.shape.kind, "object")) {
    const s = variant.shape as TypeShape & { kind: "object" }
    const tag = s.fields[discriminator]
    if (tag !== undefined && tag.shape.kind === "literal") {
      const v = (tag.shape as TypeShape & { kind: "literal" }).value
      if (typeof v === "string") return v
    }
  }
  return `Variant ${index + 1}`
}

function variantsSection(variants: readonly TypeRef[], discriminator: string | undefined): string {
  const lines = [heading("Variants", "section"), ""]
  if (discriminator !== undefined) lines.push(`Discriminated by \`\`${discriminator}\`\`.`, "")
  variants.forEach((variant, i) => {
    const name = variantName(variant, i, discriminator)
    lines.push(heading(name, "subsection"), "")
    if (variant.shape.kind === "ref") {
      const target = (variant.shape as TypeShape & { kind: "ref" }).target
      lines.push(`See ${link(target, true)}.`, "")
      return
    }
    if (typeof variant.meta.description === "string") lines.push(variant.meta.description, "")
    lines.push(".. code-block:: typescript", "", `   ${renderTypeExpr(variant, false)}`, "")
    if (isKind(variant.shape.kind, "object")) {
      const s = variant.shape as TypeShape & { kind: "object" }
      if (Object.keys(s.fields).length > 0) {
        lines.push(heading("Fields", "subsubsection"), "", ...fieldTableListTable(s.fields), "")
      }
    }
  })
  return lines.join("\n").trimEnd()
}

// Same list-table body `fieldsSection` emits, minus its own section heading
// — used when fields need to nest under a heading level `fieldsSection`
// itself doesn't know about (a variant's own `Fields` subsubsection).
function fieldTableListTable(fields: Readonly<Record<string, TypeRef>>): string[] {
  return [
    ".. list-table::",
    "   :header-rows: 1",
    "   :widths: 20 25 10 45",
    "",
    "   * - Field",
    "     - Type",
    "     - Required",
    "     - Description",
    ...fieldTableRows(fields),
  ]
}

function exampleBlock(example: unknown): string[] {
  const json = JSON.stringify(example, null, 2)
  return [".. code-block:: json", "", ...json.split("\n").map((line) => `   ${line}`)]
}

function examplesSection(meta: Readonly<Record<string, unknown>>): string | undefined {
  const examples: unknown[] = []
  if (meta.example !== undefined) examples.push(meta.example)
  if (Array.isArray(meta.examples)) examples.push(...meta.examples)
  if (examples.length === 0) return undefined

  if (examples.length === 1) {
    return [heading("Example", "section"), "", ...exampleBlock(examples[0])].join("\n")
  }

  // Sphinx has no built-in (default-install) tabbed-content directive — a
  // tabs UI would need the third-party `sphinx-tabs` extension, which isn't
  // idiomatic to assume the way MkDocs-Material's bundled `pymdownx.tabbed`
  // is for the sibling mkdocs-reference.ts. Plain numbered subsections are
  // the docutils-native way to present multiple examples instead.
  const lines = [heading("Examples", "section"), ""]
  examples.forEach((example, i) => {
    lines.push(heading(`Example ${i + 1}`, "subsection"), "", ...exampleBlock(example), "")
  })
  return lines.join("\n").trimEnd()
}

// ============================================================================
// Page assembly
// ============================================================================

function renderPage(name: string, ref: TypeRef): string {
  const meta = ref.meta
  const title = typeof meta.title === "string" ? meta.title : name
  const kind = ref.shape.kind
  const label = kebabCase(name)

  // The `.. _label:` target must precede the title it labels — this is what
  // lets every other page's `:ref:` role resolve to this one (see the
  // module doc comment above).
  const sections: string[] = [[`.. _${label}:`, "", heading(title, "page")].join("\n")]

  const deprecated = deprecatedDirective(meta)
  if (deprecated !== undefined) sections.push(deprecated)

  if (typeof meta.description === "string") sections.push(meta.description)

  sections.push(
    [heading("Type Signature", "section"), "", ".. code-block:: typescript", "", `   type ${name} = ${renderTypeExpr(ref, false)}`].join(
      "\n",
    ),
  )

  if (isKind(kind, "object")) {
    const s = ref.shape as TypeShape & { kind: "object" }
    sections.push(fieldsSection(s.fields))
  } else if (kind === "instance") {
    const s = ref.shape as TypeShape & { kind: "instance" }
    sections.push(
      [
        heading("Fields", "section"),
        "",
        `This is a nominal instance of \`\`${s.className}\`\` (from \`\`${s.declarationFile}\`\`) — no structural fields are exposed.`,
      ].join("\n"),
    )
  } else if (isKind(kind, "interface")) {
    const s = ref.shape as TypeShape & { kind: "interface" }
    sections.push(methodsSection(s.methods))
  } else if (kind === "enum") {
    const s = ref.shape as TypeShape & { kind: "enum" }
    sections.push(membersSection(s.members))
  } else if (kind === "union") {
    const s = ref.shape as TypeShape & { kind: "union" }
    const discriminator = typeof meta.discriminator === "string" ? meta.discriminator : undefined
    sections.push(variantsSection(s.variants, discriminator))
  }

  const examples = examplesSection(meta)
  if (examples !== undefined) sections.push(examples)

  return `${sections.join("\n\n").trimEnd()}\n`
}

/**
 * Project a `TypeRefDocument` to a set of Sphinx-compatible reStructuredText
 * reference pages — one per `doc.defs` entry, keyed by filename
 * (`options.basePath` prefixes every key, e.g. `"reference/"`, default none).
 * `doc.root` is not itself paged (it's the caller's entry point, not
 * necessarily a named, linkable type) — callers that want a root page should
 * add it to `defs` under whatever name they want it filed as.
 *
 * Every page is native docutils/Sphinx markup — field-list-free plain RST,
 * `.. list-table::` for fields/methods, `.. code-block:: <lang>` for code,
 * `.. deprecated::` for deprecation, and `:ref:`/`.. _label:` for cross-page
 * links — deliberately not MyST Markdown, which is a Sphinx *option* rather
 * than its native/idiomatic form.
 */
export function toSphinxReference(doc: TypeRefDocument, options?: { basePath?: string }): Map<string, string> {
  const basePath = options?.basePath ?? ""
  const pages = new Map<string, string>()
  for (const [name, ref] of Object.entries(doc.defs)) {
    pages.set(`${basePath}${fileName(name)}`, renderPage(name, ref))
  }
  return pages
}
