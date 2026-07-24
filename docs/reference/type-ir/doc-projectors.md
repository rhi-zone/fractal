# Doc projectors

Unlike every code-generating projector above (`TypeRef => string`), these
three take a whole `TypeRefDocument` — `root` + `defs` — and produce a
`Map<string, string>` of generated documentation *pages* (filename → Markdown/
MDX content), one per named `defs` entry. `doc.root` gets no page of its own
(it's typically the operation/entry-point shape that *uses* the named types,
not a named type itself) — a caller wanting a page for it adds it to `defs`
under a name first. All three cross-link `ref` targets to each other's pages
by kebab-case filename.

## Docusaurus

```ts
import { toDocusaurusReference } from "@rhi-zone/fractal-type-ir/docusaurus-reference"

const pages = toDocusaurusReference({
  root: t(types.ref("User")),
  defs: {
    User: t(types.object({
      id: t(types.integer),
      name: t(types.string),
    }), { description: "A registered user." }),
  },
})
// pages.get("user.mdx")
```

````mdx
---
id: user
title: User
description: "A registered user."
sidebar_position: 1
---

{/* This page uses a `<TypeRef name="..." summary="..." />` component for
inline hover-card type references. It is not shipped by type-ir — add a
companion `TypeRef` React component to this Docusaurus site's
`src/components/` ... */}

# User

A registered user.

## Type Signature

```ts
type User = { id: number; name: string };
```

## Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | number | yes |  |
| `name` | string | yes |  |
````

One MDX page per `defs` entry, one `## Fields`/`## Variants`/`## Members`/
`## Methods` section chosen by the def's kind (falls back through the
subtyping chain — `resolve`/`ancestors` — the same way a code projector's
handler table does), plus a `## Referenced Types` section listing every `ref`
touched while rendering, rendered as a `<TypeRef name=… summary=… />`
component the generated page does *not* ship (a companion component the
consuming Docusaurus site must add). `options.basePath` prefixes the returned
map's keys (`"api/types"` → `"api/types/user.mdx"`); cross-link hrefs stay
page-relative regardless, since every page in the set lives in one directory.

## Starlight

```ts
import { toStarlightReference } from "@rhi-zone/fractal-type-ir/starlight-reference"

const pages = toStarlightReference({
  root: t(types.ref("User")),
  defs: { User: t(types.object({ id: t(types.integer) })) },
})
// pages.get("user.mdx")
```

````mdx
---
title: "User"
description: "Reference for User."
tableOfContents:
  maxHeadingLevel: 4
---

import { Tabs, TabItem, Aside, LinkCard, Code } from '@astrojs/starlight/components';

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

## MkDocs

```ts
import { toMkdocsReference, renderTypeExpr, kebabCase } from "@rhi-zone/fractal-type-ir/mkdocs-reference"

const pages = toMkdocsReference({
  root: t(types.ref("User")),
  defs: { User: t(types.object({ id: t(types.integer) })) },
})
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
type User = { id: number }
```

## Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | number | yes |  |
````

Plain CommonMark + MkDocs-Material's extensions (admonitions `!!!`, content
tabs `===`, abbreviations `*[Term]: ...`) — deliberately **not** MDX, which
MkDocs cannot render. `renderTypeExpr(ref, linked?)` and `kebabCase(name)`
are exported as standalone helpers (the same ones `renderPage` uses
internally) for callers assembling their own page layout instead of using
`toMkdocsReference` wholesale. `options.basePath` (default none) prefixes
every returned filename, e.g. `"reference/"` → `"reference/user.md"`.
