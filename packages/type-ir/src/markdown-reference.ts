import { ancestors, resolve, type TypeRef, type TypeRefDocument, type TypeShape } from "./index.ts";
import { quote } from "./codegen-helpers.ts";

// ============================================================================
// Plain Markdown reference-page projector — TypeRefDocument -> one Markdown
// page per `doc.defs` entry, targeting *no* particular doc-site generator:
// generic CommonMark plus the GitHub Flavored Markdown (GFM) table extension
// only (tables are a GFM addition, not core CommonMark — see
// github.github.com/gfm's "Tables (extension)" section). Every other doc
// projector in this package (docusaurus-reference.ts, starlight-reference.ts,
// mkdocs-reference.ts, mkdocs-vanilla-reference.ts, sphinx-reference.ts)
// targets one specific consuming tool and leans on that tool's own syntax
// extensions (MDX components, `pymdownx` admonitions/content-tabs, RST
// directives). This target has no consuming tool at all — the output is
// meant to render correctly as plain Markdown anywhere a CommonMark/GFM
// renderer is used (GitHub's own file viewer, a generic Markdown previewer,
// a static site generator with no special config), so nothing here may
// depend on syntax any one tool would need to opt into.
//
// This file carries its own copy of every helper below — same
// decoupling convention `sphinx-reference.ts` established and
// `mkdocs-vanilla-reference.ts` followed — rather than importing from any
// sibling projector.
//
// No YAML frontmatter: unlike the three frontmatter-carrying targets
// (Docusaurus, Starlight, both MkDocs flavors), which all have a real
// consumer for `---`-fenced YAML page metadata (their own site generator's
// page-routing layer), a target with no consuming tool has nothing to parse
// that block — the same reasoning sphinx-reference.ts already gives for
// omitting RST frontmatter/docinfo, applied here for a different underlying
// reason (no frontmatter *consumer*, vs. RST having no frontmatter
// *convention* at all). Title and description render as plain heading +
// paragraph prose instead.
//
// Deprecation renders as a plain blockquote (`> **Deprecated.** reason`),
// same choice mkdocs-vanilla-reference.ts makes for the same reason —
// blockquotes are core CommonMark, no extension required. Multiple
// `meta.examples` render as numbered `### Example N` subsections rather than
// a tabbed UI, matching the same "no third-party extension assumed present"
// reasoning every non-Material target in this package already applies.
// There is no abbreviations-equivalent hover-tooltip section, matching
// mkdocs-vanilla-reference.ts's and sphinx-reference.ts's own reasoning:
// cross-linking is already fully covered by the inline `[Name](name.md)`
// links every Fields/Methods/Variants table renders, and there is no
// abbreviation-glossary convention in plain CommonMark/GFM to lean on.
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
  return `${kebabCase(name)}.md`;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function isKind(kind: string, ancestor: string): boolean {
  return kind === ancestor || ancestors(kind).includes(ancestor);
}

// ============================================================================
// Type-expression rendering — identical shape to every sibling doc
// projector's own (a simple TypeScript-like inline syntax), kept as an
// independent copy per this file's header comment.
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

function link(name: string, linked: boolean): string {
  return linked ? `[${name}](${fileName(name)})` : name;
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

// Plain blockquote — no admonition extension assumed available, same
// reasoning mkdocs-vanilla-reference.ts gives for its own.
function deprecatedNote(meta: Readonly<Record<string, unknown>>): string | undefined {
  if (meta.deprecated === undefined || meta.deprecated === false) return undefined;
  const reason = typeof meta.deprecated === "string" ? meta.deprecated : undefined;
  return reason === undefined ? "> **Deprecated.**" : `> **Deprecated.** ${reason}`;
}

function fieldRow(name: string, field: TypeRef): string {
  const type = escapeTableCell(renderTypeExpr(field, true));
  const required = field.meta.optional === true ? "No" : "Yes";
  const notes: string[] = [];
  if (typeof field.meta.description === "string") notes.push(field.meta.description);
  if (field.meta.readonly === true) notes.push("read-only");
  if (field.meta.default !== undefined) notes.push(`default: \`${quote(field.meta.default)}\``);
  if (field.meta.deprecated !== undefined && field.meta.deprecated !== false)
    notes.push("**deprecated**");
  const description = escapeTableCell(notes.join(" — "));
  return `| ${name} | ${type} | ${required} | ${description} |`;
}

function fieldsSection(fields: Readonly<Record<string, TypeRef>>): string {
  const rows = Object.entries(fields).map(([name, field]) => fieldRow(name, field));
  return [
    "## Fields",
    "",
    "| Field | Type | Required | Description |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function methodRow(name: string, methodRef: TypeRef): string {
  const description =
    typeof methodRef.meta.description === "string" ? methodRef.meta.description : "";
  const signature = escapeTableCell(renderTypeExpr(methodRef, true));
  return `| ${name} | \`${signature}\` | ${escapeTableCell(description)} |`;
}

function methodsSection(methods: Readonly<Record<string, TypeRef>>): string {
  const rows = Object.entries(methods).map(([name, m]) => methodRow(name, m));
  return [
    "## Methods",
    "",
    "| Method | Signature | Description |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function membersSection(members: readonly string[]): string {
  return ["## Members", "", ...members.map((m) => `- \`${quote(m)}\``)].join("\n");
}

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
  const lines = ["## Variants", ""];
  if (discriminator !== undefined) lines.push(`Discriminated by \`${discriminator}\`.`, "");
  variants.forEach((variant, i) => {
    const name = variantName(variant, i, discriminator);
    lines.push(`### ${name}`, "");
    if (variant.shape.kind === "ref") {
      const target = (variant.shape as TypeShape & { kind: "ref" }).target;
      lines.push(`See ${link(target, true)}.`, "");
      return;
    }
    if (typeof variant.meta.description === "string") lines.push(variant.meta.description, "");
    lines.push("```typescript", renderTypeExpr(variant, false), "```", "");
    if (isKind(variant.shape.kind, "object")) {
      const s = variant.shape as TypeShape & { kind: "object" };
      if (Object.keys(s.fields).length > 0) lines.push(fieldsSection(s.fields), "");
    }
  });
  return lines.join("\n").trimEnd();
}

function exampleBlock(example: unknown): string {
  return ["```json", JSON.stringify(example, null, 2), "```"].join("\n");
}

// Numbered subsections, not a tabbed UI — no tabs extension can be assumed
// present for a target with no consuming tool at all.
function examplesSection(meta: Readonly<Record<string, unknown>>): string | undefined {
  const examples: unknown[] = [];
  if (meta.example !== undefined) examples.push(meta.example);
  if (Array.isArray(meta.examples)) examples.push(...meta.examples);
  if (examples.length === 0) return undefined;

  if (examples.length === 1) {
    return ["## Example", "", exampleBlock(examples[0])].join("\n");
  }

  const sections = examples.map((example, i) =>
    [`### Example ${i + 1}`, "", exampleBlock(example)].join("\n"),
  );
  return ["## Examples", "", sections.join("\n\n")].join("\n");
}

// ============================================================================
// Page assembly
// ============================================================================

function renderPage(name: string, ref: TypeRef): string {
  const meta = ref.meta;
  const title = typeof meta.title === "string" ? meta.title : name;
  const kind = ref.shape.kind;

  const sections: string[] = [`# ${title}`];

  const deprecated = deprecatedNote(meta);
  if (deprecated !== undefined) sections.push(deprecated);

  sections.push(
    typeof meta.description === "string" ? meta.description : `Reference for ${title}.`,
  );

  sections.push(
    [
      "## Type Signature",
      "",
      "```typescript",
      `type ${name} = ${renderTypeExpr(ref, false)}`,
      "```",
    ].join("\n"),
  );

  if (isKind(kind, "object")) {
    const s = ref.shape as TypeShape & { kind: "object" };
    sections.push(
      Object.keys(s.fields).length > 0
        ? fieldsSection(s.fields)
        : "## Fields\n\nThis type has no fields.",
    );
  } else if (kind === "instance") {
    const s = ref.shape as TypeShape & { kind: "instance" };
    sections.push(
      `## Fields\n\nThis is a nominal instance of \`${s.className}\` (from \`${s.declarationFile}\`) — no structural fields are exposed.`,
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
 * Project a `TypeRefDocument` to a set of plain **CommonMark + GFM** (GitHub
 * Flavored Markdown, for its table extension only) reference pages — one per
 * `doc.defs` entry, keyed by filename (`options.basePath` prefixes every
 * key, e.g. `"reference/"`, default none). `doc.root` is not itself paged,
 * same convention as every other doc projector in this package — callers
 * that want a root page should add it to `defs` under whatever name they
 * want it filed as.
 *
 * Unlike every other doc projector in this package, this target has no
 * single consuming site generator to lean on: no YAML frontmatter (nothing
 * would parse it — see this file's header comment), no admonition/content-
 * tab/hover-card syntax any one tool would need to opt into. The output is
 * meant to render correctly as-is anywhere a plain CommonMark/GFM renderer
 * is used — a generic static-site build with no special Markdown config, a
 * repository file viewer, a Markdown previewer.
 */
export function toMarkdownReference(
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
