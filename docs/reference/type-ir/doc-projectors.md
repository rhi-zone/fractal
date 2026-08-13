# Doc projectors

Unlike every code-generating projector above (`TypeRef => string`), these
eight take a whole `TypeRefDocument` — `root` + `defs` — and produce a
`Map<string, string>` of generated documentation _pages_ (filename → Markdown/
MDX/RST/Org content), one per named `defs` entry. `doc.root` gets no page of
its own (it's typically the operation/entry-point shape that _uses_ the named
types, not a named type itself) — a caller wanting a page for it adds it to
`defs` under a name first. All eight cross-link `ref` targets to each other's
pages by kebab-case filename (Sphinx via an explicit `:ref:`/`.. _label:`
pair, since RST has no implicit per-file anchor; Docutils via a plain
external-style hyperlink reference to the sibling `.rst` file instead, since
`:ref:` itself is a Sphinx-only role with no bare-docutils equivalent; Org
mode via a `:CUSTOM_ID:` property drawer plus a `[[file:page.org::#id][…]]`
link, Org's own native cross-file anchor mechanism — see each target's own
section below).

## Docusaurus

```ts
import { toDocusaurusReference } from "@rhi-zone/fractal-type-ir/docusaurus-reference";

const pages = toDocusaurusReference({
  root: t(types.ref("User")),
  defs: {
    User: t(
      types.object({
        id: t(types.integer),
        name: t(types.string),
      }),
      { description: "A registered user." },
    ),
  },
});
// pages.get("user.mdx")
```

````mdx
---
id: user
title: User
description: "A registered user."
sidebar_position: 1
---

{/_ This page uses a `<TypeRef name="..." summary="..." />` component for
inline hover-card type references. It is not shipped by type-ir — add a
companion `TypeRef` React component to this Docusaurus site's
`src/components/` ... _/}

# User

A registered user.

## Type Signature

```ts
type User = { id: number; name: string };
```

## Fields

| Field  | Type   | Required | Description |
| ------ | ------ | -------- | ----------- |
| `id`   | number | yes      |             |
| `name` | string | yes      |             |
````

One MDX page per `defs` entry, one `## Fields`/`## Variants`/`## Members`/
`## Methods` section chosen by the def's kind (falls back through the
subtyping chain — `resolve`/`ancestors` — the same way a code projector's
handler table does), plus a `## Referenced Types` section listing every `ref`
touched while rendering, rendered as a `<TypeRef name=… summary=… />`
component the generated page does _not_ ship (a companion component the
consuming Docusaurus site must add). `options.basePath` prefixes the returned
map's keys (`"api/types"` → `"api/types/user.mdx"`); cross-link hrefs stay
page-relative regardless, since every page in the set lives in one directory.

## Starlight

```ts
import { toStarlightReference } from "@rhi-zone/fractal-type-ir/starlight-reference";

const pages = toStarlightReference({
  root: t(types.ref("User")),
  defs: { User: t(types.object({ id: t(types.integer) })) },
});
// pages.get("user.mdx")
```

````mdx
---
title: "User"
description: "Reference for User."
tableOfContents:
  maxHeadingLevel: 4
---

import { Tabs, TabItem, Aside, LinkCard, Code } from "@astrojs/starlight/components";

### Type Signature

<Tabs>
<TabItem label="TypeScript">
```ts
type User = { id: number };
```
</TabItem>
<TabItem label="JSON Schema">
```json
{ "type": "object", "properties": { "id": { "type": "integer" } }, "required": ["id"] }
```
</TabItem>
</Tabs>

### Fields

...
````

One Astro Starlight MDX page per `defs` entry. The "Type Signature" section
renders both a TypeScript-like expression (this package's `typescript-native.ts`
idiom) and the def's JSON Schema (via `json-schema.ts`) side by side in a
`<Tabs>`, so the page can't drift from the exact per-kind JSON Schema
semantics by re-implementing them independently. Deprecation renders as an
`<Aside type="caution">`. `options.basePath` (default `"./"`) controls the
relative-link prefix used for cross-page references.

## MkDocs (Material)

```ts
import {
  toMkdocsReference,
  toMkdocsYaml,
  renderTypeExpr,
  kebabCase,
} from "@rhi-zone/fractal-type-ir/mkdocs-reference";

const doc = {
  root: t(types.ref("User")),
  defs: { User: t(types.object({ id: t(types.integer) })) },
};
const pages = toMkdocsReference(doc);
// pages.get("user.md")
const mkdocsYml = toMkdocsYaml(doc);
```

````markdown
---
title: "User"
description: "Reference for User."
---

# User

## Type Signature

=== ":material-language-typescript: TypeScript"

    ```typescript
    type User = { id: number }
    ```

=== ":material-code-json: JSON Schema"

    ```json
    { "type": "object", "properties": { "id": { "type": "integer" } }, "required": ["id"] }
    ```

## Fields

| Field | Type   | Required | Description |
| ----- | ------ | -------- | ----------- |
| `id`  | number | yes      |             |
````

This target is the **Material for MkDocs** theme (squidfunk's
`mkdocs-material` — #3 in docs/roadmap.md's popularity ranking), not plain
MkDocs — see "MkDocs (vanilla)" below for that genuinely separate target.
Every page is CommonMark plus Material's bundled `pymdownx`/`admonition`
extension set — deliberately **not** MDX, which MkDocs cannot render:

- **Type Signature** renders as a content tab (`=== "..."`) with both a
  TypeScript-like expression and the def's real JSON Schema (via
  `json-schema.ts`, exact per-kind semantics — same "can't drift" rationale
  `starlight-reference.ts`'s own signature `<Tabs>` documents) side by side,
  each tab prefixed with a Material icon shortcode.
- **Deprecation** renders as a `!!! warning "Deprecated"` admonition.
- **Multiple `meta.examples`** render as content tabs, one per example.
- **`## Related Types`** renders Material's grid-cards syntax
  (`<div class="grid cards" markdown>`) — one card per def actually
  referenced from the page, each linking to that def's own page — as a
  browsable "see also" index, alongside (not instead of) the
  abbreviations block below.
- **Trailing abbreviations block** (`*[Term]: ...`) still renders one entry
  per referenced def, giving inline hover tooltips anywhere that def's name
  appears in body prose — unchanged from before.

Every icon shortcode this projector emits (`:material-language-typescript:`,
`:material-code-json:`, `:material-file-code-outline:` for example tabs,
`:material-cube-outline:` for grid cards) was checked against Material's
actual bundled icon set (`squidfunk/mkdocs-material`'s
`material/templates/.icons/material/*.svg`), not assumed to exist.

`toMkdocsYaml(doc, options?)` emits a real `mkdocs.yml` wired for every
syntax feature above: `theme: name: material` with a features list
(`navigation.tabs`, `navigation.top`, `content.tabs.link`,
`content.code.copy`, `content.code.annotate`, `search.suggest`,
`search.highlight`) and the standard light/dark palette toggle; a
`markdown_extensions` block (`admonition`, `pymdownx.details`,
`pymdownx.superfences` + `pymdownx.tabbed` with `alternate_style: true`,
`pymdownx.emoji` configured for Material's icon shortcodes, `attr_list` +
`md_in_html` for grid cards, `abbr`, `tables`, `toc` with
`permalink: true`); a flat `nav:` (one entry per `doc.defs` name); and a
`plugins:` list (`search` always, `social` when `options.socialCards` is
`true` — which requires `options.siteUrl`, since Material's social-cards
plugin needs an absolute `site_url` to compute preview URLs, and
`toMkdocsYaml` throws rather than emit a config that would fail at
`mkdocs build` time). Every config block was reproduced from Material's own
"Setup" reference pages, not invented, and this target's whole generated
output (pages + `mkdocs.yml`) has been verified against a real
`mkdocs build --strict` (using `mkdocs-material`) run locally — see
docs/roadmap.md's doc-generator "basics" bar-D note.

`renderTypeExpr(ref, linked?)` and `kebabCase(name)` are exported as
standalone helpers (the same ones `renderPage` uses internally) for callers
assembling their own page layout instead of using `toMkdocsReference`
wholesale. `options.basePath` (default none) prefixes every returned
filename, e.g. `"reference/"` → `"reference/user.md"`.

## MkDocs (vanilla)

```ts
import {
  toMkdocsVanillaReference,
  renderTypeExpr,
  kebabCase,
} from "@rhi-zone/fractal-type-ir/mkdocs-vanilla-reference";

const pages = toMkdocsVanillaReference({
  root: t(types.ref("User")),
  defs: { User: t(types.object({ id: t(types.integer) })) },
});
// pages.get("user.md")
```

````markdown
---
title: "User"
description: "Reference for User."
---

# User

## Type Signature

```typescript
type User = { id: number };
```

## Fields

| Field | Type   | Required | Description |
| ----- | ------ | -------- | ----------- |
| `id`  | number | yes      |             |
````

Plain **MkDocs** (the `mkdocs` PyPI project, #2 in docs/roadmap.md's
popularity ranking) with its default theme and default
`markdown_extensions` (`toc`, `tables`, `fenced_code_blocks` — per
mkdocs.org's "Writing Your Docs" page) only — a genuinely separate target
from Material for MkDocs above, not a stripped-down variant of it: nothing
here emits `!!!` admonitions, `=== "Tab"` content tabs, or `*[Term]: ...`
abbreviations, since none of those are enabled by plain MkDocs without a
`markdown_extensions` config this projector has no way to guarantee the
consuming site has set up. YAML frontmatter is still used — unlike RST
(see Sphinx below), MkDocs parses `---`-fenced YAML page meta-data
natively, not via an extension. Deprecation renders as a plain blockquote
(`> **Deprecated.** reason`); multiple `meta.examples` render as numbered
`### Example N` subsections rather than a tabbed UI; there is no
abbreviations-equivalent hover-tooltip section, same reasoning Sphinx below
gives for omitting one — cross-linking is already fully covered by the
inline `[Name](name.md)` links every Fields/Methods/Variants table renders.
This target's generated output has been verified against a real
`mkdocs build --strict` (plain `mkdocs`, no Material theme installed) run
locally — see docs/roadmap.md's doc-generator "basics" bar-D note.

`renderTypeExpr(ref, linked?)` and `kebabCase(name)` are exported as
standalone helpers, same convention as every other doc projector in this
package. `options.basePath` (default none) prefixes every returned
filename, e.g. `"reference/"` → `"reference/user.md"`.

## Org mode

```ts
import {
  toOrgModeReference,
  renderTypeExpr,
  kebabCase,
} from "@rhi-zone/fractal-type-ir/org-mode-reference";

const pages = toOrgModeReference({
  root: t(types.ref("User")),
  defs: { User: t(types.object({ id: t(types.integer) })) },
});
// pages.get("user.org")
```

```org
#+TITLE: User
#+DESCRIPTION: Reference for User.

* User
:PROPERTIES:
:CUSTOM_ID: user
:END:

** Type Signature

#+BEGIN_SRC typescript
type User = { id: integer }
#+END_SRC

** Fields

| Field | Type | Required | Description |
|---+---+---+---|
| id | integer | Yes | |
```

Native Emacs Org markup — the plain-text outline format Org mode itself
parses, not any one export backend's rendered HTML/LaTeX. One `.org` page
per `defs` entry. Org's structural unit is the headline (`*` repeated per
depth — level inferred from star count, unlike RST's underline-length
matching or Markdown's `#` count, so there is no per-page "underline must
match title length" invariant to maintain the way `sphinx-reference.ts`
needs one), and its cross-reference mechanism is a `:CUSTOM_ID:` property
on the target headline plus a `[[file:page.org::#id][text]]` link — the
structural equivalent of Sphinx's `.. _label:`/`:ref:` pair, placed inside
a `:PROPERTIES:` drawer that must sit immediately below the headline it
belongs to (no blank line in between — Org's own placement rule).
`#+TITLE:` and `#+DESCRIPTION:` are real in-buffer export keywords (Org's
nearest analogue to YAML frontmatter); unlike the RST target, which has no
per-file description convention and so omits one on a def with no
`meta.description`, Org does have `#+DESCRIPTION:`, so this target follows
the MkDocs-family convention instead — always emitting both keywords, with
a synthesized `"Reference for X."` fallback when `meta.description` is
absent. `#+BEGIN_SRC <lang>` / `#+END_SRC` fences code without requiring
indented content (unlike RST's `.. code-block::` directive). Table rows
are `|`-delimited; a literal `|` inside a cell (a rendered union type, or
`meta.nullable`'s `| null` suffix, landing inside a Fields/Methods table
cell) is escaped as `\vert{}` — Org's only documented way to quote a
column separator, since an unescaped `|` would otherwise split the cell
into extra, invalid columns. Deprecation renders as a `#+BEGIN_QUOTE`
block with a bold `*Deprecated.*` lead-in rather than an admonition — Org
has no bundled callout/admonition syntax to assume, the same reasoning
`mkdocs-vanilla-reference.ts` gives for its own plain-blockquote choice.
Multiple `meta.examples` render as numbered `Example N` subsections rather
than a tabbed UI, for the same no-bundled-tabs reasoning. A cross-linked
method signature cell is left unwrapped rather than put inside `~…~`
(Org's inline-code/verbatim markers): `~…~`/`=…=` content is not
reprocessed for nested Org syntax, so wrapping a signature that embeds a
`[[file:…]]` link would render the link as dead literal text — the same
class of defect `sphinx-reference.ts`'s bar-D pass found and fixed for
RST's literal spans, checked here up front rather than found later.
`renderTypeExpr(ref, linked?)` and `kebabCase(name)` are exported as
standalone helpers, same convention as every other doc projector in this
package. `options.basePath` (default none) prefixes every returned
filename, e.g. `"reference/"` → `"reference/user.org"`.

This target's generated output has been verified against real Emacs Org
tooling — `org-lint` (via `emacs --batch`) and a real
`org-html-export-to-html` run — see docs/roadmap.md's doc-generator
"basics" bar-D note for what that check covered and found.

## Sphinx

```ts
import {
  toSphinxReference,
  renderTypeExpr,
  kebabCase,
} from "@rhi-zone/fractal-type-ir/sphinx-reference";

const pages = toSphinxReference({
  root: t(types.ref("User")),
  defs: { User: t(types.object({ id: t(types.integer) })) },
});
// pages.get("user.rst")
```

```rst
.. _user:

User
====

Type Signature
--------------

.. code-block:: typescript

   type User = { id: integer }

Fields
------

.. list-table::
   :header-rows: 1
   :widths: 20 25 10 45

   * - Field
     - Type
     - Required
     - Description
   * - id
     - integer
     - Yes
     -
```

Native docutils/Sphinx markup — reStructuredText, not MyST Markdown (MyST is
a Sphinx _option_, not its default/idiomatic form, and using it here would
blur the line with the MkDocs Markdown target above). Unlike the three
Markdown/MDX targets above, there is no YAML frontmatter block — RST has no
frontmatter convention, and Sphinx's own analogue (docinfo fields) is for
document metadata like author/date, not page routing — so a def with no
`meta.description` simply has no description paragraph, rather than falling
back to a synthesized `"Reference for X."` line the way the frontmatter-
carrying targets do. One `.rst` page per `defs` entry; each page opens with an explicit `.. _kebab-name:`
cross-reference target immediately before its title, which is what every
other page's `ref`-typed field/method/variant cross-links to via
`` :ref:`Name <kebab-name>` ``. Section headings use a fixed
underline-character-per-level convention consistent across every generated
page (`=` page title, `-` sections, `~` variant subsections, `^` a variant's
nested Fields table) — `docutils` is strict about underline length matching
the title text exactly, which `heading()` (internal) always computes rather
than hard-coding. Fields/Methods render as `.. list-table::` blocks;
deprecation renders as a `.. deprecated:: <reason>` directive (the directive
is documented as taking a version identifier as its argument, but docutils
doesn't validate that — the reason string is used directly rather than
inventing a fake version number). Multiple `meta.examples` render as
numbered `Example N` subsections rather than a tabbed UI, since a tabs
directive isn't part of a default Sphinx install (unlike MkDocs-Material's
bundled content-tabs extension) — introducing one would mean assuming a
third-party `sphinx-tabs` install this projector has no way to guarantee.
There is no abbreviations-equivalent section: Sphinx's nearest analogue
(`.. glossary::` + `:term:`) is idiomatic for a project-wide term glossary,
not a per-page "define every type mentioned on this page" block the way
MkDocs' `*[Term]: ...` abbreviation syntax is used here — cross-linking
itself is fully covered by the inline `:ref:` roles in Fields/Methods/
Variants tables, so nothing is lost by omitting it.
`renderTypeExpr(ref, linked?)` and `kebabCase(name)` are exported as
standalone helpers, same convention as the MkDocs projector.
`options.basePath` (default none) prefixes every returned filename, e.g.
`"reference/"` → `"reference/user.rst"`.

## Docutils

```ts
import {
  toRstReference,
  renderTypeExpr,
  kebabCase,
} from "@rhi-zone/fractal-type-ir/rst-reference";

const pages = toRstReference({
  root: t(types.ref("User")),
  defs: { User: t(types.object({ id: t(types.integer) })) },
});
// pages.get("user.rst")
```

```rst
User
====

Type Signature
--------------

.. code:: typescript

   type User = { id: integer }

Fields
------

.. list-table::
   :header-rows: 1
   :widths: 20 25 10 45

   * - Field
     - Type
     - Required
     - Description
   * - id
     - integer
     - Yes
     -
```

Plain **docutils** (the `docutils` PyPI project's own `rst2html`/`rst2html5`
writers), not Sphinx — the same vanilla-vs-flavored split as MkDocs above,
applied to the RST family: `sphinx-reference.ts`'s own header comment
identifies `:ref:`, `.. code-block::`, and `.. deprecated::` as genuine
Sphinx extensions over core docutils, not native RST, so this target
renders none of them. Instead:

- Cross-page links are plain external-style hyperlink references to the
  sibling def's own filename (`` `Name <name.rst>`_ ``), the RST-native
  counterpart to the vanilla-Markdown targets' `[Name](name.md)` — there is
  no `.. _label:`/`:ref:` pair, since that role is Sphinx's own
  `StandardDomain` addition and bare docutils has no multi-document project
  graph to resolve a label against in the first place. Each page therefore
  opens directly with its title, not a cross-reference target.
- Code blocks use the plain `.. code:: <lang>` directive
  (`docutils.parsers.rst.directives.body.CodeBlock`, part of core docutils
  since 0.9), not Sphinx's extended `.. code-block::`.
- Deprecation renders as a generic titled admonition
  (`.. admonition:: Deprecated`) rather than Sphinx's version-aware
  `.. deprecated::` directive — core docutils has no changeset/version
  concept, and the generic admonition directive is docutils' own
  closest-fit callout-box primitive. Confirmed against a real `rst2html`
  run that an argument-only admonition with no body is a docutils ERROR
  ("Content block expected"), so a reason-less deprecation
  (`meta.deprecated === true`) still renders a fallback body sentence
  rather than an empty directive.
- `.. list-table::` is unchanged from the Sphinx target — it's core
  docutils, not a Sphinx extension, so there was nothing to swap out.
- Multiple `meta.examples` render as numbered `Example N` subsections, same
  reasoning as the Sphinx target's own (no tabs directive is part of a
  default install — core docutils has even less UI chrome than Sphinx does).
- Same fixed underline-character-per-level heading convention as the Sphinx
  target (`=` page title, `-` sections, `~` variant subsections, `^` a
  variant's nested Fields table) — a core RST feature, not Sphinx-specific.

This target's generated output has been verified against a real
`rst2html --report=2` (warnings promoted to a non-zero exit) run over its
dedicated test fixture, with zero warnings once `pygments` is installed
alongside `docutils` — see docs/roadmap.md's doc-generator "basics" bar-D
note and `flake.nix`'s Python toolchain comment for why `pygments` needs to
be added explicitly here (unlike the Sphinx target, which bundles Pygments
as one of its own dependencies).
`renderTypeExpr(ref, linked?)` and `kebabCase(name)` are exported as
standalone helpers, same convention as every other doc projector in this
package. `options.basePath` (default none) prefixes every returned
filename, e.g. `"reference/"` → `"reference/user.rst"`.

## Plain Markdown (generator-agnostic)

```ts
import { toMarkdownReference } from "@rhi-zone/fractal-type-ir/markdown-reference";

const pages = toMarkdownReference({
  root: t(types.ref("User")),
  defs: { User: t(types.object({ id: t(types.integer) })) },
});
// pages.get("user.md")
```

````markdown
# User

Reference for User.

## Type Signature

```typescript
type User = { id: number };
```

## Fields

| Field | Type   | Required | Description |
| ----- | ------ | -------- | ----------- |
| `id`  | number | yes      |             |
````

Unlike every other target on this page, this one isn't built for any
particular consuming tool — no doc-site generator, no static-site build.
Every page is plain **CommonMark plus the GFM (GitHub Flavored Markdown)
table extension** and nothing else, meant to render correctly as-is
wherever a generic CommonMark/GFM renderer is used: a repository file
viewer, a Markdown previewer, a static-site generator with no special
Markdown config. Nothing here leans on syntax any one tool would need to
opt into:

- **No YAML frontmatter.** Every other target on this page carries
  `---`-fenced frontmatter because its own consuming tool actually parses
  it for page routing/metadata. A target with no consuming tool has
  nothing to parse that block, so title and description render as a plain
  `# Heading` and prose paragraph instead — the same reasoning the Sphinx
  section above gives for omitting RST frontmatter, for a related but
  distinct underlying reason (no frontmatter _consumer_ here, versus RST
  having no frontmatter _convention_ at all).
- **Deprecation** renders as a plain blockquote (`> **Deprecated.**
  reason`) — core CommonMark, no extension required.
- **Multiple `meta.examples`** render as numbered `### Example N`
  subsections rather than a tabbed UI, same reasoning the MkDocs (vanilla)
  and Sphinx sections give for their own numbered subsections — no tabs
  extension can be assumed present for a target with no consuming tool at
  all.
- There is **no abbreviations-equivalent hover-tooltip section** — same
  reasoning as MkDocs (vanilla)/Sphinx: cross-linking is already covered
  by the inline `[Name](name.md)` links every Fields/Methods/Variants
  table renders.

`renderTypeExpr(ref, linked?)` and `kebabCase(name)` are exported as
standalone helpers, same convention as every other doc projector in this
package. `options.basePath` (default none) prefixes every returned
filename, e.g. `"reference/"` → `"reference/user.md"`.

This target has no single real tool to build the output against the way
MkDocs/Sphinx do, since it isn't tied to any doc-site generator — its
generated pages have instead been verified by parsing them with a real,
spec-compliant GFM parser (`remark` + `remark-gfm`) and confirming a clean
parse into the expected AST node types (tables as `table` nodes, fenced
code blocks as `code` nodes, cross-links as `link` nodes), covered by
`markdown-reference.test.ts`'s own dedicated bar-D section — see
docs/roadmap.md's doc-generator "basics" bar-D note for how this compares
to the ad hoc real-`mkdocs build`/`sphinx-build` verification the other
targets use.
