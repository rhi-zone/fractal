import { ancestors, resolve, type TypeRef, type TypeRefDocument, type TypeShape } from "./index.ts";
import { quote } from "./codegen-helpers.ts";

// ============================================================================
// Org mode reference-page projector — TypeRefDocument -> one Emacs Org (.org)
// page per `doc.defs` entry, written for Org's own native markup (the plain-
// text outline/markup format Org mode itself parses — not any one export
// backend's HTML/LaTeX output). Genuinely new target, not a reskin of a
// Markdown/RST sibling: Org's structural unit is the headline (`*` depth),
// not a fenced/directive block, and its native cross-reference mechanism is
// a `CUSTOM_ID` property plus a `file:` link with a `::#id` search option —
// neither has an equivalent in this package's other doc projectors. This
// file carries its own copies of `kebabCase`/`renderTypeExpr`/etc. rather
// than importing them, same decoupling convention `sphinx-reference.ts` and
// `mkdocs-vanilla-reference.ts` already follow for every doc-projector
// target in this package.
//
// Every syntax fact this file depends on was checked against Org's own
// manual (orgmode.org/manual, plus the canonical Worg syntax reference)
// rather than assumed from Markdown/RST familiarity:
//   - Headlines are `*` repeated per depth, a space, then title text —
//     Org infers heading level directly from star count, unlike RST's
//     underline-length matching (sphinx-reference.ts's `HEADING_CHARS`
//     concern) or Markdown's `#` count; there is no separate "underline
//     must match title length" invariant to maintain here.
//   - A `:PROPERTIES: … :END:` drawer must sit immediately below the
//     headline it belongs to (no blank line between), one `:KEY: value`
//     line per property. `:CUSTOM_ID:` is Org's documented mechanism for a
//     stable, linkable anchor on a headline (Property Syntax / Internal
//     Links in the manual) — the structural equivalent of
//     `sphinx-reference.ts`'s `.. _label:` target, placed after the
//     headline instead of before it because that is where Org's own
//     grammar requires a property drawer to live.
//   - Cross-*file* links use `[[file:<page>.org::#<custom-id>][<text>]]` —
//     the `::` search-option syntax documented for `file:`/`id:` links,
//     where a search string starting with `#` resolves to the entry whose
//     `CUSTOM_ID` matches (External Links / Internal Links in the manual).
//   - `#+TITLE:` and `#+DESCRIPTION:` are real in-buffer export keywords
//     (Export Settings in the manual) — Org's nearest analogue to the YAML
//     frontmatter the Markdown-family targets emit. Unlike
//     `sphinx-reference.ts`'s RST target (which has no per-file
//     description convention at all and so omits one on a def with no
//     `meta.description`), Org does have one, so this target follows
//     `mkdocs-vanilla-reference.ts`'s convention instead: always emit both
//     keywords, synthesizing a `"Reference for X."` fallback when
//     `meta.description` is absent.
//   - `#+BEGIN_SRC <lang>` / `#+END_SRC` fence source blocks; unlike RST's
//     `.. code-block::` directive (which requires indented body content),
//     Org's block content needs no indentation to parse.
//   - Table rows are `|`-delimited; the header/body separator is a
//     `|-...-|` rule line (any run length works — Org does not require
//     dash-count to match visual column width, unlike RST's list-table
//     indentation rules). A literal `|` inside a cell must be escaped as
//     `\vert{}` (the documented escape — Org tables have no other way to
//     quote a column separator).
//   - Inline emphasis: `*bold*`, `/italic/`, `~code~`, `=verbatim=`,
//     `+strikethrough+`. `~code~`/`=verbatim=` content is not reprocessed
//     for nested Org syntax — the same "literal markers can't safely wrap
//     an embedded link" concern `sphinx-reference.ts`'s method-signature
//     fix (its bar-D defect #2) found for RST literal spans applies here
//     too, so a cross-linked signature cell is left unwrapped rather than
//     put inside `~…~`.
//   - Org has no bundled admonition/callout syntax analogous to MkDocs-
//     Material's `!!!` — same absent-extension reasoning
//     `mkdocs-vanilla-reference.ts` gives for its own target, so
//     deprecation renders as a `#+BEGIN_QUOTE` block (a real, extension-
//     free Org block type) with a bold "Deprecated." lead-in, mirroring
//     that file's blockquote choice rather than inventing a custom block
//     type this projector can't guarantee any consumer's Org config
//     styles meaningfully.
// ============================================================================

export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function fileName(name: string): string {
  return `${kebabCase(name)}.org`;
}

function isKind(kind: string, ancestor: string): boolean {
  return kind === ancestor || ancestors(kind).includes(ancestor);
}

// A table cell must not carry a raw newline (breaks Org's line-based table
// parsing) or a raw `|` (Org's column separator, with no other quoting
// mechanism — `\vert{}` is the documented escape for a literal pipe).
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\vert{}").replace(/\r?\n/g, " ");
}

const HEADING_CHARS = { page: 1, section: 2, subsection: 3, subsubsection: 4 } as const;

function heading(text: string, level: keyof typeof HEADING_CHARS): string {
  return `${"*".repeat(HEADING_CHARS[level])} ${text}`;
}

// ============================================================================
// Type-expression rendering — same TypeScript-like inline syntax every
// sibling doc projector shares for the fenced signature block (`linked:
// false`), differing only in how a `ref` kind cross-links (`linked: true`).
// ============================================================================

type ExprConverter = (shape: TypeShape, linked: boolean) => string;

const leaf =
  (type: string): ExprConverter =>
  () =>
    type;

const complexKinds = new Set([
  "union",
  "object",
  "map",
  "intersection",
  "function",
  "method",
  "stream",
  "page",
  "interface",
]);

// Cross-file link to another def's page, targeting its `CUSTOM_ID` via the
// `::#id` file-link search option (see this file's header comment). No
// adjacency escape is needed the way `sphinx-reference.ts` needs one for a
// linked array element (`X[]`): Org's link grammar requires a literal `[[`
// to open a link, so a bare `[]` immediately after this link's closing `]]`
// (from an array shorthand like `Owner[]`) can't be misparsed as opening a
// new one — confirmed against the real `org-lint`/export check this
// target's bar-D verification runs (see docs/roadmap.md).
function link(name: string, linked: boolean): string {
  return linked ? `[[file:${fileName(name)}::#${kebabCase(name)}][${name}]]` : name;
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
    const s = shape as TypeShape & { kind: "object" };
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const optional = field.meta.optional === true;
      return `${name}${optional ? "?" : ""}: ${renderTypeExpr(field, linked)}`;
    });
    return `{ ${fields.join("; ")} }`;
  },
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, linked) => {
    const s = shape as TypeShape & { kind: "array" };
    return complexKinds.has(s.element.shape.kind)
      ? `Array<${renderTypeExpr(s.element, linked)}>`
      : `${renderTypeExpr(s.element, linked)}[]`;
  },
  tuple: (shape, linked) => {
    const s = shape as TypeShape & { kind: "tuple" };
    return `[${s.elements.map((e) => renderTypeExpr(e, linked)).join(", ")}]`;
  },
  stream: (shape, linked) => {
    const s = shape as TypeShape & { kind: "stream" };
    return `AsyncIterable<${renderTypeExpr(s.element, linked)}>`;
  },
  page: (shape, linked) => {
    const s = shape as TypeShape & { kind: "page" };
    const inner = renderTypeExpr(s.element, linked);
    return s.style === "offset" ? `OffsetPage<${inner}>` : `CursorPage<${inner}>`;
  },
  map: (shape, linked) => {
    const s = shape as TypeShape & { kind: "map" };
    return s.key.shape.kind === "string"
      ? `Record<string, ${renderTypeExpr(s.value, linked)}>`
      : `Map<${renderTypeExpr(s.key, linked)}, ${renderTypeExpr(s.value, linked)}>`;
  },
  union: (shape, linked) => {
    const s = shape as TypeShape & { kind: "union" };
    return s.variants.map((v) => renderTypeExpr(v, linked)).join(" | ");
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" };
    return typeof s.value === "string" ? quote(s.value) : String(s.value);
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" };
    return s.members.map(quote).join(" | ");
  },
  ref: (shape, linked) => {
    const s = shape as TypeShape & { kind: "ref" };
    return link(s.target, linked);
  },
  intersection: (shape, linked) => {
    const s = shape as TypeShape & { kind: "intersection" };
    return s.members.map((m) => renderTypeExpr(m, linked)).join(" & ");
  },
  function: (shape, linked) => {
    const s = shape as TypeShape & { kind: "function" };
    const thisParam =
      s.thisType === undefined ? [] : [`this: ${renderTypeExpr(s.thisType, linked)}`];
    const params = [
      ...thisParam,
      ...s.params.map((p) => `${p.name}: ${renderTypeExpr(p.type, linked)}`),
    ];
    return `(${params.join(", ")}) => ${renderTypeExpr(s.returnType, linked)}`;
  },
  interface: (shape, linked) => {
    const s = shape as TypeShape & { kind: "interface" };
    const methods = Object.entries(s.methods).map(([name, methodRef]) => {
      const m = methodRef.shape as TypeShape & {
        kind: "method" | "function";
        params?: unknown;
        returnType?: unknown;
      };
      if (m.params === undefined || m.returnType === undefined)
        return `${name}(): ${renderTypeExpr(methodRef, linked)}`;
      const mm = m as TypeShape & {
        kind: "method" | "function";
        params: readonly { name: string; type: TypeRef }[];
        returnType: TypeRef;
      };
      const params = mm.params.map((p) => `${p.name}: ${renderTypeExpr(p.type, linked)}`);
      return `${name}(${params.join(", ")}): ${renderTypeExpr(mm.returnType, linked)}`;
    });
    return `{ ${methods.join("; ")} }`;
  },
};

export function renderTypeExpr(ref: TypeRef, linked = false): string {
  const converter = resolve(ref.shape.kind, exprHandlers);
  let type = converter === undefined ? "unknown" : converter(ref.shape, linked);
  if (ref.meta.nullable === true) type = `${type} | null`;
  return type;
}

// ============================================================================
// Page sections
// ============================================================================

function frontKeywords(title: string, description: string): string {
  return [`#+TITLE: ${title}`, `#+DESCRIPTION: ${description}`].join("\n");
}

// A property drawer must sit immediately below its headline (no blank
// line) — see this file's header comment.
function propertyDrawer(customId: string): string {
  return [":PROPERTIES:", `:CUSTOM_ID: ${customId}`, ":END:"].join("\n");
}

// No bundled admonition syntax to assume (see this file's header comment);
// `#+BEGIN_QUOTE` is a real, extension-free Org block, same choice
// `mkdocs-vanilla-reference.ts` makes with a plain blockquote.
function deprecatedBlock(meta: Readonly<Record<string, unknown>>): string | undefined {
  if (meta.deprecated === undefined || meta.deprecated === false) return undefined;
  const reason = typeof meta.deprecated === "string" ? meta.deprecated : undefined;
  const lead = reason === undefined ? "*Deprecated.*" : `*Deprecated.* ${reason}`;
  return ["#+BEGIN_QUOTE", lead, "#+END_QUOTE"].join("\n");
}

function tableSeparator(columns: number): string {
  return `|${Array.from({ length: columns }, () => "---").join("+")}|`;
}

function fieldRow(name: string, field: TypeRef): string {
  const type = escapeCell(renderTypeExpr(field, true));
  const required = field.meta.optional === true ? "No" : "Yes";
  const notes: string[] = [];
  if (typeof field.meta.description === "string") notes.push(field.meta.description);
  if (field.meta.readonly === true) notes.push("read-only");
  if (field.meta.default !== undefined) notes.push(`default: ~${quote(field.meta.default)}~`);
  if (field.meta.deprecated !== undefined && field.meta.deprecated !== false)
    notes.push("*deprecated*");
  const description = escapeCell(notes.join(" — "));
  return `| ${name} | ${type} | ${required} | ${description} |`;
}

function fieldsSection(fields: Readonly<Record<string, TypeRef>>): string {
  if (Object.keys(fields).length === 0)
    return [heading("Fields", "section"), "", "This type has no fields."].join("\n");
  const rows = Object.entries(fields).map(([name, field]) => fieldRow(name, field));
  return [
    heading("Fields", "section"),
    "",
    "| Field | Type | Required | Description |",
    tableSeparator(4),
    ...rows,
  ].join("\n");
}

// Same list-body `fieldsSection` emits, minus its own heading — used when a
// variant's own Fields table needs to nest under a heading level
// `fieldsSection` itself doesn't know about.
function fieldTableBody(fields: Readonly<Record<string, TypeRef>>): string[] {
  return [
    "| Field | Type | Required | Description |",
    tableSeparator(4),
    ...Object.entries(fields).map(([name, field]) => fieldRow(name, field)),
  ];
}

function methodRow(name: string, methodRef: TypeRef): string {
  const description =
    typeof methodRef.meta.description === "string" ? methodRef.meta.description : "";
  // Not wrapped in `~…~`: a cross-linked signature embeds a `[[file:…]]`
  // link (via `renderTypeExpr(ref, true)`), and Org's `~code~`/`=verbatim=`
  // markers are not reprocessed for nested syntax — wrapping the whole
  // signature would render the link as dead literal text instead of a
  // working cross-reference (see this file's header comment).
  const signature = escapeCell(renderTypeExpr(methodRef, true));
  return `| ${name} | ${signature} | ${escapeCell(description)} |`;
}

function methodsSection(methods: Readonly<Record<string, TypeRef>>): string {
  const rows = Object.entries(methods).map(([name, m]) => methodRow(name, m));
  return [
    heading("Methods", "section"),
    "",
    "| Method | Signature | Description |",
    tableSeparator(3),
    ...rows,
  ].join("\n");
}

function membersSection(members: readonly string[]): string {
  return [heading("Members", "section"), "", ...members.map((m) => `- ~${quote(m)}~`)].join("\n");
}

// A discriminated-union variant's display name — identical selection logic
// to every sibling doc projector's `variantName` (title > discriminator's
// literal tag > positional fallback), so the two projectors agree on what a
// variant is *called*, differing only in markup.
function variantName(variant: TypeRef, index: number, discriminator: string | undefined): string {
  if (typeof variant.meta.title === "string") return variant.meta.title;
  if (variant.shape.kind === "ref") return (variant.shape as TypeShape & { kind: "ref" }).target;
  if (discriminator !== undefined && isKind(variant.shape.kind, "object")) {
    const s = variant.shape as TypeShape & { kind: "object" };
    const tag = s.fields[discriminator];
    if (tag !== undefined && tag.shape.kind === "literal") {
      const v = (tag.shape as TypeShape & { kind: "literal" }).value;
      if (typeof v === "string") return v;
    }
  }
  return `Variant ${index + 1}`;
}

function variantsSection(variants: readonly TypeRef[], discriminator: string | undefined): string {
  const lines = [heading("Variants", "section"), ""];
  if (discriminator !== undefined) lines.push(`Discriminated by ~${discriminator}~.`, "");
  variants.forEach((variant, i) => {
    const name = variantName(variant, i, discriminator);
    lines.push(heading(name, "subsection"), "");
    if (variant.shape.kind === "ref") {
      const target = (variant.shape as TypeShape & { kind: "ref" }).target;
      lines.push(`See ${link(target, true)}.`, "");
      return;
    }
    if (typeof variant.meta.description === "string") lines.push(variant.meta.description, "");
    lines.push("#+BEGIN_SRC typescript", renderTypeExpr(variant, false), "#+END_SRC", "");
    if (isKind(variant.shape.kind, "object")) {
      const s = variant.shape as TypeShape & { kind: "object" };
      if (Object.keys(s.fields).length > 0)
        lines.push(heading("Fields", "subsubsection"), "", ...fieldTableBody(s.fields), "");
    }
  });
  return lines.join("\n").trimEnd();
}

function exampleBlock(example: unknown): string {
  return ["#+BEGIN_SRC json", JSON.stringify(example, null, 2), "#+END_SRC"].join("\n");
}

// Numbered subsections, not a tabbed UI — Org has no bundled tabs concept
// to assume, same choice sphinx-reference.ts and mkdocs-vanilla-reference.ts
// make for their own multi-example rendering.
function examplesSection(meta: Readonly<Record<string, unknown>>): string | undefined {
  const examples: unknown[] = [];
  if (meta.example !== undefined) examples.push(meta.example);
  if (Array.isArray(meta.examples)) examples.push(...meta.examples);
  if (examples.length === 0) return undefined;

  if (examples.length === 1) {
    return [heading("Example", "section"), "", exampleBlock(examples[0])].join("\n");
  }

  const lines = [heading("Examples", "section"), ""];
  examples.forEach((example, i) => {
    lines.push(heading(`Example ${i + 1}`, "subsection"), "", exampleBlock(example), "");
  });
  return lines.join("\n").trimEnd();
}

// ============================================================================
// Page assembly
// ============================================================================

function renderPage(name: string, ref: TypeRef): string {
  const meta = ref.meta;
  const title = typeof meta.title === "string" ? meta.title : name;
  const description =
    typeof meta.description === "string" ? meta.description : `Reference for ${title}.`;
  const kind = ref.shape.kind;
  const customId = kebabCase(name);

  const sections: string[] = [
    frontKeywords(title, description),
    [heading(title, "page"), propertyDrawer(customId)].join("\n"),
  ];

  const deprecated = deprecatedBlock(meta);
  if (deprecated !== undefined) sections.push(deprecated);

  if (typeof meta.description === "string") sections.push(meta.description);

  sections.push(
    [
      heading("Type Signature", "section"),
      "",
      "#+BEGIN_SRC typescript",
      `type ${name} = ${renderTypeExpr(ref, false)}`,
      "#+END_SRC",
    ].join("\n"),
  );

  if (isKind(kind, "object")) {
    const s = ref.shape as TypeShape & { kind: "object" };
    sections.push(fieldsSection(s.fields));
  } else if (kind === "instance") {
    const s = ref.shape as TypeShape & { kind: "instance" };
    sections.push(
      [
        heading("Fields", "section"),
        "",
        `This is a nominal instance of ~${s.className}~ (from ~${s.declarationFile}~) — no structural fields are exposed.`,
      ].join("\n"),
    );
  } else if (isKind(kind, "interface")) {
    const s = ref.shape as TypeShape & { kind: "interface" };
    sections.push(methodsSection(s.methods));
  } else if (kind === "enum") {
    const s = ref.shape as TypeShape & { kind: "enum" };
    sections.push(membersSection(s.members));
  } else if (kind === "union") {
    const s = ref.shape as TypeShape & { kind: "union" };
    const discriminator = typeof meta.discriminator === "string" ? meta.discriminator : undefined;
    sections.push(variantsSection(s.variants, discriminator));
  }

  const examples = examplesSection(meta);
  if (examples !== undefined) sections.push(examples);

  return `${sections.join("\n\n").trimEnd()}\n`;
}

/**
 * Project a `TypeRefDocument` to a set of Emacs Org (`.org`) reference
 * pages — one per `doc.defs` entry, keyed by filename (`options.basePath`
 * prefixes every key, e.g. `"reference/"`, default none). `doc.root` is not
 * itself paged, same convention as every other doc projector in this
 * package — callers that want a root page should add it to `defs` under
 * whatever name they want it filed as.
 *
 * Every page is native Org markup — headline-depth sectioning, a
 * `:PROPERTIES:`/`:CUSTOM_ID:` drawer for the page's own cross-link anchor,
 * `|`-delimited tables for Fields/Methods, `#+BEGIN_SRC <lang>` for code,
 * a `#+BEGIN_QUOTE` block for deprecation, and `[[file:…::#id][…]]` links
 * for cross-page references — not any one export backend's rendered output
 * (HTML/LaTeX/etc.), the same "the source markup is the target, not a
 * downstream render" framing every other projector in this package uses.
 */
export function toOrgModeReference(
  doc: TypeRefDocument,
  options?: { basePath?: string },
): Map<string, string> {
  const basePath = options?.basePath ?? "";
  const pages = new Map<string, string>();
  for (const [name, ref] of Object.entries(doc.defs)) {
    pages.set(`${basePath}${fileName(name)}`, renderPage(name, ref));
  }
  return pages;
}
