import { ancestors, resolve, type TypeRef, type TypeRefDocument, type TypeShape } from "./index.ts";
import { quote } from "./codegen-helpers.ts";

// ============================================================================
// Plain-docutils reference-page projector — TypeRefDocument -> one
// reStructuredText (.rst) page per `doc.defs` entry, targeting *core*
// docutils only (the `docutils` PyPI package's own `rst2html`/`rst2html5`
// writers), not Sphinx. `sphinx-reference.ts` renders three Sphinx-specific
// constructs this file deliberately avoids, each confirmed against a real
// core-docutils installation (nixpkgs' `python3Packages.docutils`, via
// `rst2html --report=2`) rather than assumed from memory:
//
//   - `:ref:`/`.. _label:` (sphinx.domains.std, the StandardDomain's
//     cross-reference role) has no core-docutils equivalent — bare docutils
//     has no multi-document project graph to resolve a label against (that
//     graph, and the toctree that builds it, is Sphinx's own addition on
//     top of the parser). Cross-page links here are plain external-style
//     hyperlink references to the sibling def's own generated filename
//     (`` `Name <name.rst>`_ ``) — the RST-native counterpart to
//     `mkdocs-vanilla-reference.ts` linking to a sibling `name.md`, not a
//     built-URL guess this projector has no way to make on a caller's
//     behalf.
//   - `.. code-block:: <lang>` is `sphinx.directives.code.CodeBlock`, an
//     extended directive (adds `:caption:`/`:linenos:`/etc.). Core docutils'
//     own code directive is the plainer `.. code:: <lang>`
//     (`docutils.parsers.rst.directives.body.CodeBlock`, part of docutils
//     since 0.9) — same fenced-block shape, no Sphinx-only options used.
//   - `.. deprecated:: <version>` is `sphinx.domains.changeset.VersionChange`,
//     part of Sphinx's changeset domain. Core docutils' nearest native
//     construct is the generic titled admonition directive
//     (`docutils.parsers.rst.directives.admonitions.Admonition`,
//     `.. admonition:: Deprecated`), which renders as the same kind of
//     callout box without inventing new syntax or a fake version slot this
//     projector has no real data for. Confirmed empirically that
//     `.. admonition::` requires non-empty body content (an
//     argument-only admonition is a docutils ERROR, not a no-op) — see
//     `deprecatedAdmonition` below for the fallback sentence used when
//     `meta.deprecated` carries no reason string.
//
// This file carries its own copy of every helper below rather than
// importing from sphinx-reference.ts, same decoupling convention that file
// itself established relative to mkdocs-reference.ts.
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
  return `${kebabCase(name)}.rst`;
}

function isKind(kind: string, ancestor: string): boolean {
  return kind === ancestor || ancestors(kind).includes(ancestor);
}

// Same heading-underline convention sphinx-reference.ts uses — a core RST
// feature (docutils infers heading level from underline-character order of
// first appearance), not a Sphinx addition. Kept identical across both RST
// targets so a def's page looks structurally the same whichever target
// generated it.
const HEADING_CHARS = { page: "=", section: "-", subsection: "~", subsubsection: "^" } as const;

function heading(text: string, level: keyof typeof HEADING_CHARS): string {
  return `${text}\n${HEADING_CHARS[level].repeat(text.length)}`;
}

function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

// ============================================================================
// Type-expression rendering — structurally identical to
// sphinx-reference.ts's own, differing only in how a cross-linked `ref`
// kind renders (a plain hyperlink reference to a sibling page instead of a
// `:ref:` role).
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

// A plain external-style hyperlink reference (core docutils: any inline
// text followed by `<uri>` and a trailing `_`) pointed at the sibling def's
// own generated filename — see this file's header comment for why this
// stands in for Sphinx's `:ref:` role.
function link(name: string, linked: boolean): string {
  return linked ? `\`${name} <${fileName(name)}>\`_` : name;
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
    if (complexKinds.has(s.element.shape.kind))
      return `Array<${renderTypeExpr(s.element, linked)}>`;
    const element = renderTypeExpr(s.element, linked);
    // Same adjacency rule sphinx-reference.ts's array handler documents and
    // works around: a hyperlink reference's end-string (here the trailing
    // `_`, not a role's closing backtick) may not be immediately followed
    // by `[` — confirmed against a real `rst2html --report=2` run (no
    // WARNING/ERROR) with the `\ ` escape in place, and confirmed to
    // reproduce the warning without it.
    return linked && s.element.shape.kind === "ref" ? `${element}\\ []` : `${element}[]`;
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

// Core docutils' generic titled-admonition directive stands in for Sphinx's
// version-aware `.. deprecated::` — see this file's header comment.
// `.. admonition:: Deprecated` with no body is a docutils ERROR ("Content
// block expected"), confirmed against a real `rst2html --report=2` run, so
// a reason-less deprecation still needs a body sentence rather than an
// empty directive.
function deprecatedAdmonition(meta: Readonly<Record<string, unknown>>): string | undefined {
  if (meta.deprecated === undefined || meta.deprecated === false) return undefined;
  const reason = typeof meta.deprecated === "string" ? meta.deprecated : "This type is deprecated.";
  return [".. admonition:: Deprecated", "", `   ${reason}`].join("\n");
}

function fieldTableRows(fields: Readonly<Record<string, TypeRef>>): string[] {
  return Object.entries(fields).flatMap(([name, field]) => {
    const type = escapeCell(renderTypeExpr(field, true));
    const required = field.meta.optional === true ? "No" : "Yes";
    const notes: string[] = [];
    if (typeof field.meta.description === "string") notes.push(field.meta.description);
    if (field.meta.readonly === true) notes.push("read-only");
    if (field.meta.default !== undefined)
      notes.push(`default: \`\`${quote(field.meta.default)}\`\``);
    if (field.meta.deprecated !== undefined && field.meta.deprecated !== false)
      notes.push("**deprecated**");
    const description = escapeCell(notes.join(" — "));
    return [`   * - ${name}`, `     - ${type}`, `     - ${required}`, `     - ${description}`];
  });
}

function fieldsSection(fields: Readonly<Record<string, TypeRef>>): string {
  if (Object.keys(fields).length === 0)
    return [heading("Fields", "section"), "", "This type has no fields."].join("\n");
  const rows = fieldTableRows(fields);
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
  ].join("\n");
}

function methodTableRows(methods: Readonly<Record<string, TypeRef>>): string[] {
  return Object.entries(methods).flatMap(([name, methodRef]) => {
    const description = escapeCell(
      typeof methodRef.meta.description === "string" ? methodRef.meta.description : "",
    );
    // Unwrapped, not `` `` ``-literal-quoted — same reasoning
    // sphinx-reference.ts's `methodTableRows` gives: docutils does not
    // parse inline markup (including a hyperlink reference) inside a
    // literal span, so wrapping this cell would render a cross-linked
    // signature as dead literal text instead of a working link.
    const signature = escapeCell(renderTypeExpr(methodRef, true));
    return [`   * - ${name}`, `     - ${signature}`, `     - ${description}`];
  });
}

function methodsSection(methods: Readonly<Record<string, TypeRef>>): string {
  const rows = methodTableRows(methods);
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
  ].join("\n");
}

function membersSection(members: readonly string[]): string {
  return [heading("Members", "section"), "", ...members.map((m) => `- \`\`${quote(m)}\`\``)].join(
    "\n",
  );
}

// Same selection order as mkdocs-reference.ts/sphinx-reference.ts's own
// `variantName`: `meta.title`, then the discriminator's literal tag, then a
// positional fallback — kept identical so a variant is called the same
// thing across every doc target.
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
  if (discriminator !== undefined) lines.push(`Discriminated by \`\`${discriminator}\`\`.`, "");
  variants.forEach((variant, i) => {
    const name = variantName(variant, i, discriminator);
    lines.push(heading(name, "subsection"), "");
    if (variant.shape.kind === "ref") {
      const target = (variant.shape as TypeShape & { kind: "ref" }).target;
      lines.push(`See ${link(target, true)}.`, "");
      return;
    }
    if (typeof variant.meta.description === "string") lines.push(variant.meta.description, "");
    lines.push(".. code:: typescript", "", `   ${renderTypeExpr(variant, false)}`, "");
    if (isKind(variant.shape.kind, "object")) {
      const s = variant.shape as TypeShape & { kind: "object" };
      if (Object.keys(s.fields).length > 0) {
        lines.push(heading("Fields", "subsubsection"), "", ...fieldTableListTable(s.fields), "");
      }
    }
  });
  return lines.join("\n").trimEnd();
}

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
  ];
}

function exampleBlock(example: unknown): string[] {
  const json = JSON.stringify(example, null, 2);
  return [".. code:: json", "", ...json.split("\n").map((line) => `   ${line}`)];
}

function examplesSection(meta: Readonly<Record<string, unknown>>): string | undefined {
  const examples: unknown[] = [];
  if (meta.example !== undefined) examples.push(meta.example);
  if (Array.isArray(meta.examples)) examples.push(...meta.examples);
  if (examples.length === 0) return undefined;

  if (examples.length === 1) {
    return [heading("Example", "section"), "", ...exampleBlock(examples[0])].join("\n");
  }

  // Same reasoning sphinx-reference.ts gives for its own numbered
  // subsections: no tabbed-content directive is part of a default install
  // (core docutils has even less UI-chrome surface than a default Sphinx
  // install does), so plain numbered subsections are the only
  // docutils-native way to present more than one example.
  const lines = [heading("Examples", "section"), ""];
  examples.forEach((example, i) => {
    lines.push(heading(`Example ${i + 1}`, "subsection"), "", ...exampleBlock(example), "");
  });
  return lines.join("\n").trimEnd();
}

// ============================================================================
// Page assembly
// ============================================================================

function renderPage(name: string, ref: TypeRef): string {
  const meta = ref.meta;
  const title = typeof meta.title === "string" ? meta.title : name;
  const kind = ref.shape.kind;

  // No `.. _label:` cross-reference target — nothing on this page's own
  // title needs an anchor, since cross-page links are plain hyperlink
  // references to a sibling filename (see this file's header comment), not
  // a role resolved against a per-page label the way Sphinx's `:ref:` is.
  const sections: string[] = [heading(title, "page")];

  const deprecated = deprecatedAdmonition(meta);
  if (deprecated !== undefined) sections.push(deprecated);

  if (typeof meta.description === "string") sections.push(meta.description);

  sections.push(
    [
      heading("Type Signature", "section"),
      "",
      ".. code:: typescript",
      "",
      `   type ${name} = ${renderTypeExpr(ref, false)}`,
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
        `This is a nominal instance of \`\`${s.className}\`\` (from \`\`${s.declarationFile}\`\`) — no structural fields are exposed.`,
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
 * Project a `TypeRefDocument` to a set of plain-**docutils**-compatible
 * reStructuredText reference pages — one per `doc.defs` entry, keyed by
 * filename (`options.basePath` prefixes every key, e.g. `"reference/"`,
 * default none). `doc.root` is not itself paged, same convention as every
 * other doc projector in this package — callers that want a root page
 * should add it to `defs` under whatever name they want it filed as.
 *
 * Every page is core docutils markup only — `.. list-table::` for
 * fields/methods, `.. code:: <lang>` (not Sphinx's extended
 * `.. code-block::`) for code, `.. admonition:: Deprecated` (not Sphinx's
 * `.. deprecated::`) for deprecation, and plain
 * `` `Name <name.rst>`_ `` hyperlink references (not Sphinx's
 * `:ref:`/`.. _label:` pair) for cross-page links — verified against a real
 * `docutils` install via `rst2html --report=2`, not assumed. See
 * `sphinx-reference.ts` for the Sphinx-flavored sibling target this file
 * deliberately does not import from or extend.
 */
export function toDocutilsReference(
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
