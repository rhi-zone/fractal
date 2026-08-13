# Doc projectors

Unlike every code-generating projector above (`TypeRef => string`), these
four take a whole `TypeRefDocument` — `root` + `defs` — and produce a
`Map<string, string>` of generated documentation _pages_ (filename → Markdown/
MDX/RST content), one per named `defs` entry. `doc.root` gets no page of its
own (it's typically the operation/entry-point shape that _uses_ the named
types, not a named type itself) — a caller wanting a page for it adds it to
`defs` under a name first. All four cross-link `ref` targets to each other's
pages by kebab-case filename (Sphinx via an explicit `:ref:`/`.. _label:`
pair rather than a bare Markdown link, since RST has no implicit per-file
anchor — see its section below).

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
