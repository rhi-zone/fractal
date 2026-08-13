import { ancestors, resolve, type TypeRef, type TypeRefDocument, type TypeShape } from "./index.ts";
import { quote } from "./codegen-helpers.ts";
import { toJsonSchema } from "./json-schema.ts";

// ============================================================================
// MkDocs-Material reference-page projector — TypeRefDocument -> one Markdown
// page per `doc.defs` entry, targeting MkDocs-Material's Markdown extension
// set (admonitions, content tabs, abbreviations). MkDocs has no JSX runtime,
// so output is plain Markdown, not MDX.
//
// Every other projector in this package renders a single TypeRef to a single
// string. This one is document-shaped instead (`Map<filename, content>`)
// because a reference site is inherently multi-page: each named def gets its
// own page, and pages cross-link each other by kebab-case filename (`ref`
// kinds resolve to `[Name](name-kebab.md)`) rather than inlining the
// referenced type's structure.
// ============================================================================

// Converts an arbitrary def name (PascalCase, camelCase, snake_case, ...)
// into the kebab-case stem used for both the page's filename and every
// cross-link that targets it, so a link built from a def name and a filename
// built from the same name always agree.
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

// YAML double-quoted scalar (block-flow-safe subset — escapes backslashes and
// double quotes, same convention as this file's `quote()` for code contexts)
// — used for frontmatter values, which may contain `:`/`#`/other characters
// that break YAML's plain-scalar form.
function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function isKind(kind: string, ancestor: string): boolean {
  return kind === ancestor || ancestors(kind).includes(ancestor);
}

// ============================================================================
// Type-expression rendering — a simple TypeScript-like inline syntax, shared
// by the fenced-code signature block (`linked: false`) and table/prose cells
// that should cross-link `ref` kinds to their own page (`linked: true`).
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
  // Purely nominal — no structural fields to render (see type-ir's
  // TypeKinds.instance doc comment); the class name is the whole story.
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
  // `method` has no explicit entry — falls back to `function`'s arrow syntax
  // via `registerParent("method", "function")` (index.ts), same convention
  // typescript-native.ts uses. The `interface` handler below renders each
  // method with method-signature syntax instead.
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
// Referenced-def collection — walks a TypeRef's own structure (never crossing
// into a resolved `ref`'s target body, same convention `childTypeRefs` in
// index.ts follows) gathering every `ref.target` it finds, so the page's
// closing abbreviation block can emit one `*[Name]: ...` per type actually
// mentioned on that page.
// ============================================================================

type CollectHandler = (shape: TypeShape, out: Set<string>) => void;

const collectHandlers: Record<string, CollectHandler> = {
  object: (shape, out) => {
    const s = shape as TypeShape & { kind: "object" };
    for (const field of Object.values(s.fields)) collectRefNames(field, out);
  },
  array: (shape, out) => collectRefNames((shape as TypeShape & { kind: "array" }).element, out),
  stream: (shape, out) => collectRefNames((shape as TypeShape & { kind: "stream" }).element, out),
  page: (shape, out) => collectRefNames((shape as TypeShape & { kind: "page" }).element, out),
  tuple: (shape, out) => {
    for (const e of (shape as TypeShape & { kind: "tuple" }).elements) collectRefNames(e, out);
  },
  map: (shape, out) => {
    const s = shape as TypeShape & { kind: "map" };
    collectRefNames(s.key, out);
    collectRefNames(s.value, out);
  },
  union: (shape, out) => {
    for (const v of (shape as TypeShape & { kind: "union" }).variants) collectRefNames(v, out);
  },
  intersection: (shape, out) => {
    for (const m of (shape as TypeShape & { kind: "intersection" }).members)
      collectRefNames(m, out);
  },
  function: (shape, out) => {
    const s = shape as TypeShape & { kind: "function"; thisType?: TypeRef };
    for (const p of s.params) collectRefNames(p.type, out);
    collectRefNames(s.returnType, out);
    if (s.thisType !== undefined) collectRefNames(s.thisType, out);
  },
  interface: (shape, out) => {
    const s = shape as TypeShape & { kind: "interface" };
    for (const m of Object.values(s.methods)) collectRefNames(m, out);
  },
  ref: (shape, out) => out.add((shape as TypeShape & { kind: "ref" }).target),
};

function collectRefNames(ref: TypeRef, out: Set<string>): void {
  resolve(ref.shape.kind, collectHandlers)?.(ref.shape, out);
}

function oneLineSummary(name: string, ref: TypeRef | undefined): string {
  if (ref === undefined) return `${name} — undocumented reference.`;
  const description = typeof ref.meta.description === "string" ? ref.meta.description : undefined;
  if (description !== undefined) {
    const firstSentence = /^[^.!?]*[.!?]/.exec(description)?.[0] ?? description;
    return firstSentence;
  }
  const title = typeof ref.meta.title === "string" ? ref.meta.title : name;
  return `${title} — see reference page.`;
}

// ============================================================================
// Page sections
// ============================================================================

function frontmatter(title: string, description: string): string {
  return [
    "---",
    `title: ${yamlQuote(title)}`,
    `description: ${yamlQuote(description)}`,
    "---",
  ].join("\n");
}

function deprecatedAdmonition(meta: Readonly<Record<string, unknown>>): string | undefined {
  if (meta.deprecated === undefined || meta.deprecated === false) return undefined;
  const reason = typeof meta.deprecated === "string" ? meta.deprecated : undefined;
  return reason === undefined
    ? '!!! warning "Deprecated"'
    : ['!!! warning "Deprecated"', "", `    ${reason}`].join("\n");
}

function fieldRow(name: string, field: TypeRef): string {
  // Union/enum/intersection/function renderings contain literal `|`/`&`
  // characters that would otherwise be mis-parsed as extra table-cell
  // delimiters (GFM splits a row on every unescaped `|`, backticks included).
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

// A discriminated-union variant's display name: `meta.title` first, then the
// literal value of the field named by the union's own `meta.discriminator`
// (the tag that actually distinguishes it at runtime), then a positional
// fallback.
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

// 4-space-indents every line of a block for nesting inside a pymdownx
// content-tab (`=== "..."` bodies indent like a list item) — blank lines
// stay blank rather than gaining trailing whitespace.
function indent4(block: string): string {
  return block
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `    ${line}`))
    .join("\n");
}

function examplesSection(meta: Readonly<Record<string, unknown>>): string | undefined {
  const examples: unknown[] = [];
  if (meta.example !== undefined) examples.push(meta.example);
  if (Array.isArray(meta.examples)) examples.push(...meta.examples);
  if (examples.length === 0) return undefined;

  if (examples.length === 1) {
    return ["## Example", "", exampleBlock(examples[0])].join("\n");
  }

  // MkDocs-Material content tabs (pymdownx.tabbed): each `=== "Tab"` body is a
  // 4-space-indented block, same requirement as an indented list item. Every
  // tab shares one icon shortcode (`:material-file-code-outline:`, verified
  // to exist in Material's bundled icon set — see this package's mkdocs.yml
  // emission below for the matching pymdownx.emoji config) rather than a
  // per-index numeric icon, since Material's numeric icon set isn't
  // guaranteed to cover an arbitrarily large `examples` array.
  const tabs = examples.map((example, i) => {
    return [
      `=== ":material-file-code-outline: Example ${i + 1}"`,
      "",
      indent4(exampleBlock(example)),
    ].join("\n");
  });
  return ["## Examples", "", tabs.join("\n\n")].join("\n");
}

// Material grid cards (`.grid.cards` — reference/grids.md; requires
// `attr_list` + `md_in_html`, both enabled in this file's `toMkdocsYaml`
// output below): one card per def actually referenced from this page,
// giving a browsable "see also" index alongside (not instead of) the
// abbreviations block's inline hover tooltips below — the two serve
// different UX (browsable index vs. in-text hover), same way Docusaurus's
// "## Referenced Types" section and Starlight's cross-links both exist
// without being redundant with each other. `:material-cube-outline:`
// (verified against Material's bundled icon set) stands in for "a type" the
// way Docusaurus's `<TypeRef>` component conveys "this is a linked type"
// visually — Material has no per-kind icon vocabulary to draw from here, so
// one fixed icon is used for every card rather than inventing a kind-to-icon
// mapping this projector has no way to validate against Material's real set.
function relatedTypesSection(
  doc: TypeRefDocument,
  ref: TypeRef,
  selfName: string,
): string | undefined {
  const referenced = new Set<string>();
  collectRefNames(ref, referenced);
  referenced.delete(selfName);
  if (referenced.size === 0) return undefined;
  const cards = [...referenced].sort().map((name) => {
    const summary = oneLineSummary(name, doc.defs[name]);
    return [
      `-   :material-cube-outline: **[${name}](${fileName(name)})**`,
      "",
      "    ---",
      "",
      `    ${summary}`,
    ].join("\n");
  });
  return [
    "## Related Types",
    "",
    '<div class="grid cards" markdown>',
    "",
    cards.join("\n\n"),
    "",
    "</div>",
  ].join("\n");
}

function abbreviationsBlock(
  doc: TypeRefDocument,
  ref: TypeRef,
  selfName: string,
): string | undefined {
  const referenced = new Set<string>();
  collectRefNames(ref, referenced);
  referenced.delete(selfName);
  if (referenced.size === 0) return undefined;
  const lines = [...referenced]
    .sort()
    .map((name) => `*[${name}]: ${oneLineSummary(name, doc.defs[name])}`);
  return lines.join("\n");
}

// ============================================================================
// Page assembly
// ============================================================================

function renderPage(name: string, ref: TypeRef, doc: TypeRefDocument): string {
  const meta = ref.meta;
  const title = typeof meta.title === "string" ? meta.title : name;
  const description =
    typeof meta.description === "string" ? meta.description : `Reference for ${title}.`;
  const kind = ref.shape.kind;

  const sections: string[] = [frontmatter(title, description), `# ${title}`];

  const deprecated = deprecatedAdmonition(meta);
  if (deprecated !== undefined) sections.push(deprecated);

  if (typeof meta.description === "string") sections.push(meta.description);

  // Both a TypeScript-like expression and the def's real JSON Schema (via
  // json-schema.ts, exact per-kind semantics — same "can't drift" rationale
  // starlight-reference.ts's own signature `<Tabs>` documents), side by side
  // in a Material content tab. Icons verified against Material's bundled
  // icon set (see toMkdocsYaml's matching pymdownx.emoji config below).
  sections.push(
    [
      "## Type Signature",
      "",
      '=== ":material-language-typescript: TypeScript"',
      "",
      indent4(["```typescript", `type ${name} = ${renderTypeExpr(ref, false)}`, "```"].join("\n")),
      "",
      '=== ":material-code-json: JSON Schema"',
      "",
      indent4(["```json", JSON.stringify(toJsonSchema(ref), null, 2), "```"].join("\n")),
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

  const relatedTypes = relatedTypesSection(doc, ref, name);
  if (relatedTypes !== undefined) sections.push(relatedTypes);

  const abbreviations = abbreviationsBlock(doc, ref, name);
  if (abbreviations !== undefined) sections.push(abbreviations);

  return `${sections.join("\n\n").trimEnd()}\n`;
}

/**
 * Project a `TypeRefDocument` to a set of MkDocs-Material-compatible
 * Markdown reference pages — one per `doc.defs` entry, keyed by filename
 * (`options.basePath` prefixes every key, e.g. `"reference/"`, default none).
 * `doc.root` is not itself paged (it's the caller's entry point, not
 * necessarily a named, linkable type) — callers that want a root page should
 * add it to `defs` under whatever name they want it filed as.
 *
 * Every page is plain CommonMark + Material's admonition (`!!!`), content-tab
 * (`===`), and abbreviation (`*[Term]: ...`) extensions — deliberately not
 * MDX, which MkDocs cannot render.
 */
export function toMkdocsReference(
  doc: TypeRefDocument,
  options?: { basePath?: string },
): Map<string, string> {
  const basePath = options?.basePath ?? "";
  const pages = new Map<string, string>();
  for (const [name, ref] of Object.entries(doc.defs)) {
    pages.set(`${basePath}${fileName(name)}`, renderPage(name, ref, doc));
  }
  return pages;
}

// ============================================================================
// `mkdocs.yml` emission — every syntax feature `renderPage` above uses
// (admonitions, content tabs with icons, abbreviations, grid cards) requires
// a `markdown_extensions`/`theme` config that plain `mkdocs.yml` does not
// enable by default. Every block below mirrors Material's own "Setup"
// reference pages (theme features, palette toggle, content tabs, icon
// shortcodes, grid cards, social cards). `nav:` is generated flat, one entry
// per `doc.defs` name in insertion order (same order `toMkdocsReference`
// emits pages in); callers wanting a nested/grouped nav can treat this as a
// starting point and restructure the returned string's `nav:` block.
// ============================================================================

function navEntry(name: string, ref: TypeRef, basePath: string): string {
  const title = typeof ref.meta.title === "string" ? ref.meta.title : name;
  return `  - ${yamlQuote(title)}: ${basePath}${fileName(name)}`;
}

/**
 * Emit a `mkdocs.yml` for the pages `toMkdocsReference` produces, wired for
 * every Material-specific syntax feature this projector actually emits:
 * - `theme.features`: `navigation.tabs`, `navigation.top`, `content.tabs.link`
 *   (keeps a reader's tab choice in sync across pages), `content.code.copy`,
 *   `content.code.annotate`, `search.suggest`, `search.highlight`.
 * - `theme.palette`: the standard light/dark scheme toggle (Material's own
 *   "Changing the colors" setup page's copy-paste block).
 * - `markdown_extensions`: `admonition` (deprecation notices), `pymdownx.details`,
 *   `pymdownx.superfences` + `pymdownx.tabbed` with `alternate_style: true`
 *   (content tabs), `pymdownx.emoji` configured for Material's own icon
 *   shortcodes (`material.extensions.emoji.twemoji`/`to_svg` — Material's
 *   "Icons, Emojis" setup page), `attr_list` + `md_in_html` (grid cards),
 *   `abbr` (the abbreviations block), `tables`, and `toc` with `permalink: true`.
 * - `nav`: one entry per `doc.defs` name, in the same order `toMkdocsReference`
 *   emits pages.
 * - `plugins`: `search` always; `social` only when `options.socialCards` is
 *   `true` — Material's social-cards plugin requires `site_url` to be set
 *   (its own "Setting up social cards" page: social previews need an
 *   absolute URL), so passing `socialCards: true` without `siteUrl` throws
 *   rather than emitting a config that would fail at `mkdocs build` time.
 */
export function toMkdocsYaml(
  doc: TypeRefDocument,
  options?: { siteName?: string; siteUrl?: string; basePath?: string; socialCards?: boolean },
): string {
  const siteName = options?.siteName ?? "Reference";
  const siteUrl = options?.siteUrl;
  const basePath = options?.basePath ?? "";
  const socialCards = options?.socialCards === true;
  if (socialCards && siteUrl === undefined) {
    throw new Error(
      "toMkdocsYaml: options.socialCards requires options.siteUrl (Material's social plugin needs an absolute site_url to compute preview URLs)",
    );
  }

  const lines: string[] = [`site_name: ${yamlQuote(siteName)}`];
  if (siteUrl !== undefined) lines.push(`site_url: ${yamlQuote(siteUrl)}`);

  lines.push(
    "",
    "theme:",
    "  name: material",
    "  features:",
    "    - navigation.tabs",
    "    - navigation.top",
    "    - content.tabs.link",
    "    - content.code.copy",
    "    - content.code.annotate",
    "    - search.suggest",
    "    - search.highlight",
    "  palette:",
    "    # Palette toggle for light mode",
    "    - scheme: default",
    "      toggle:",
    "        icon: material/brightness-7",
    "        name: Switch to dark mode",
    "    # Palette toggle for dark mode",
    "    - scheme: slate",
    "      toggle:",
    "        icon: material/brightness-4",
    "        name: Switch to light mode",
  );

  lines.push(
    "",
    "markdown_extensions:",
    "  - admonition",
    "  - pymdownx.details",
    "  - pymdownx.superfences",
    "  - pymdownx.tabbed:",
    "      alternate_style: true",
    "  - pymdownx.emoji:",
    "      emoji_index: !!python/name:material.extensions.emoji.twemoji",
    "      emoji_generator: !!python/name:material.extensions.emoji.to_svg",
    "  - attr_list",
    "  - md_in_html",
    "  - abbr",
    "  - tables",
    "  - toc:",
    "      permalink: true",
  );

  lines.push(
    "",
    "nav:",
    ...Object.entries(doc.defs).map(([name, ref]) => navEntry(name, ref, basePath)),
  );

  lines.push("", "plugins:", "  - search");
  if (socialCards) lines.push("  - social");

  return `${lines.join("\n")}\n`;
}
