// packages/http-api-projector/src/http-route-reference.ts — @rhi-zone/fractal-http-api-projector
//
// Route-level doc-page projector — OpenApiDoc -> one Docusaurus/Starlight MDX
// page per (path, method) operation, each embedding a live
// `<ApiExplorer/>` component (@rhi-zone/fractal-api-explorer) so a reader can
// fire a real request at the documented route without leaving the page.
//
// Why a NEW projector rather than stretching an existing one: type-ir's
// `toDocusaurusReference`/`toStarlightReference` (packages/type-ir/src/
// {docusaurus,starlight}-reference.ts) are TypeRefDocument projectors — they
// know nothing about HTTP verbs, paths, or routes, only named `defs` entries
// in a type hierarchy. Forcing an HTTP route through that shape (e.g. by
// encoding it as a `function`-kind or `interface`-kind TypeRef def) was
// considered and rejected as a semantic hack before this file was written
// (see docs/design/mocked-fetch-backend.md) — a route isn't a named type,
// it's a (path, verb) pair with a request/response SHAPE, and forcing it into
// one of those kinds would mean either lying about what a `function`-kind def
// represents (function-kind is functions-only, per that kind's own
// contract elsewhere in type-ir) or growing `interface`-kind well past
// "a named type with methods" for no shared benefit. This projector
// therefore lives here, in http-api-projector, next to `HttpRoute`/
// `OpenApiDoc`/`listRoutes` — the concepts it actually needs — and produces
// its own MDX independently, following the SAME output convention as the
// type-ir reference projectors (`Map<filename, content>`, `options.basePath`,
// an MDX-comment note for a component the projector doesn't itself ship) so
// a caller composing both into one doc site sees one consistent shape.
//
// Input is an already-built `OpenApiDoc` (see openapi.ts's `toOpenApi`/
// `toOpenApiFromRoute`) rather than a raw `Node`/`HttpRoute` tree — the
// OpenAPI doc is already the single source of truth this package computes
// for "every route's path, verb, operationId, summary/description,
// deprecated flag, and request/response JSON Schema"; re-deriving that from
// the tree a second time here would duplicate `buildDoc`'s treeId/pathMap/
// schema-resolution logic for no benefit. A caller with a `Node` tree calls
// `toOpenApi(node, opts)` once and feeds the same doc to both this and
// `toOpenApiFromRoute`'s other consumers.
//
// See also:
//   packages/http-api-projector/src/openapi.ts        — OpenApiDoc, toOpenApi
//   packages/api-explorer/src/api-explorer.tsx         — the embedded component
//   packages/api-explorer/src/fetch-context.tsx        — how a real fetch (e.g.
//     toDropInFetch(createFetch(tree))) reaches every embed, site-wide
//   packages/type-ir/src/docusaurus-reference.ts       — the <TypeRef> precedent
//     this file's own "projector doesn't ship the component" MDX note mirrors
//   docs/design/mocked-fetch-backend.md                — full design history

import type { OpenApiDoc, OpenApiOperation, OpenApiSchema } from "./openapi.ts"

/** Options shared by both target renderers. */
export type HttpRouteReferenceOpts = {
  /** Prefixed onto returned Map keys (e.g. `"api/routes"` ->
   * `"api/routes/books-list.mdx"`); cross-page navigation isn't emitted by
   * this projector (unlike the type-ir reference projectors, route pages
   * don't cross-link each other), so this only affects the returned keys
   * themselves. */
  readonly basePath?: string
  /** The package name a caller's doc site should import `ApiExplorer` from
   * — only used by the Starlight renderer's `import` line (Docusaurus's
   * `<ApiExplorer/>` tag is emitted import-free, same convention as
   * `<TypeRef>` in docusaurus-reference.ts). Defaults to
   * `"@rhi-zone/fractal-api-explorer"`, the actual companion package. */
  readonly apiExplorerImport?: string
}

// ============================================================================
// Shared page-data extraction
// ============================================================================

/** One (path, method) operation, flattened out of `OpenApiDoc.paths` into
 * the shape a single generated page needs — kept as an internal type since
 * neither renderer needs callers to construct one directly. */
type RoutePage = {
  readonly path: string
  readonly method: string
  readonly operation: OpenApiOperation
}

function routePages(doc: OpenApiDoc): RoutePage[] {
  const out: RoutePage[] = []
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      out.push({ path, method, operation })
    }
  }
  return out
}

/** `"books.list"` -> `"books-list"`, `"GET /widgets/{id}"`-derived fallback
 * names stay filesystem-safe the same way. Mirrors the kebab-case helpers in
 * type-ir's docusaurus-reference.ts/starlight-reference.ts, extended to also
 * fold the `.`-joined operationId convention (`toOpenApi`'s `codenName`
 * dotted rendering, openapi.ts) down to one separator. */
function fileStem(operationId: string): string {
  return operationId
    .replace(/\./g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function requestBodySchema(operation: OpenApiOperation): OpenApiSchema | undefined {
  return operation.requestBody?.content["application/json"].schema
}

function responseSchema(operation: OpenApiOperation): OpenApiSchema {
  return operation.responses["200"].content["application/json"].schema
}

/** JS-expression-safe serialization of a schema for embedding as a JSX
 * attribute value inside `{…}` — plain `JSON.stringify` is already valid JS
 * object-literal syntax, same convention `starlight-reference.ts`'s
 * `renderExamplesSection` and `docusaurus-reference.ts`'s example blocks
 * both rely on for embedding arbitrary JSON into generated output. */
function schemaProp(name: string, schema: OpenApiSchema | undefined): string {
  return schema === undefined ? "" : ` ${name}={${JSON.stringify(schema)}}`
}

function schemaBlock(title: string, schema: OpenApiSchema | undefined): string[] {
  if (schema === undefined) return []
  return [`### ${title}`, "", "```json", JSON.stringify(schema, null, 2), "```", ""]
}

/**
 * Escape MDX-significant `{`/`}` in text destined for a RAW (non-code-span,
 * non-frontmatter) line of generated Markdown/MDX body content — e.g. a
 * `# ${title}` heading built from a path template like `/books/{bookId}`.
 * MDX parses an unescaped `{...}` anywhere in flow content as a JS
 * expression, not literal text (unlike a backtick code span, which IS
 * literal per CommonMark — the request-line `` `${method} ${path}` `` lines
 * elsewhere in this file don't need this because they're already
 * backtick-wrapped). Frontmatter fields (YAML) don't need this either — YAML
 * doesn't give `{`/`}` any special meaning in a quoted scalar.
 *
 * Found via examples/doc-site-verification's real `docusaurus build` pass
 * (docs/design/mocked-fetch-backend.md's dated write-up): a fixture route's
 * `# GET /books/{bookId}` heading (this file's Docusaurus renderer, `title`
 * falling back to `${method} ${path}` when `operation.summary` is unset)
 * crashed Docusaurus's SSG step with `ReferenceError: bookId is not
 * defined` — MDX evaluated `{bookId}` as a bare identifier expression. Only
 * that one call site was actually exercised, but `operation.description`
 * (bodyLines below) is the same defect class — arbitrary authored text
 * inserted as a RAW MDX line — so it's fixed here too rather than left as a
 * known-identical latent bug.
 */
function mdxEscapeText(s: string): string {
  return s.replace(/[{}]/g, (c) => `\\${c}`)
}

function frontmatterTitle(page: RoutePage): string {
  return page.operation.summary ?? `${page.method.toUpperCase()} ${page.path}`
}

function frontmatterDescription(page: RoutePage): string {
  return page.operation.description ?? `Reference for \`${page.method.toUpperCase()} ${page.path}\`.`
}

function bodyLines(page: RoutePage): string[] {
  const { operation } = page
  const lines: string[] = []

  if (operation.deprecated === true) {
    lines.push("**Deprecated.**", "")
  }

  if (operation.description !== undefined) {
    lines.push(mdxEscapeText(operation.description), "")
  }

  if (operation.tags !== undefined && operation.tags.length > 0) {
    lines.push(`Tags: ${operation.tags.map((t) => `\`${t}\``).join(", ")}`, "")
  }

  lines.push(...schemaBlock("Request Body", requestBodySchema(operation)))
  lines.push(...schemaBlock("Response (200)", responseSchema(operation)))

  return lines
}

// ============================================================================
// Docusaurus renderer
// ============================================================================

function renderDocusaurusPage(page: RoutePage, opts: HttpRouteReferenceOpts): string {
  const { path, method, operation } = page
  const title = frontmatterTitle(page)
  const description = frontmatterDescription(page)

  const lines: string[] = []
  lines.push("---")
  lines.push(`id: ${fileStem(operation.operationId)}`)
  lines.push(`title: ${JSON.stringify(title)}`)
  lines.push(`description: ${JSON.stringify(description)}`)
  lines.push("---")
  lines.push("")
  lines.push(
    "{/* This page embeds an `<ApiExplorer .../>` component for a live, in-page " +
      "request/response demo. It is not shipped by this projector — add " +
      `\`${opts.apiExplorerImport ?? "@rhi-zone/fractal-api-explorer"}\`'s ` +
      "\`ApiExplorer\` to this Docusaurus site's global MDX components (same " +
      "wiring the \`<TypeRef>\` note elsewhere in this doc set describes), and " +
      "wire a real `fetch` implementation site-wide via `ApiExplorerFetchProvider` " +
      "(e.g. `toDropInFetch(createFetch(tree))` for a docs build with no deployed " +
      "server yet) — see that package's fetch-context.tsx for why a fetch " +
      "*function* can't be passed as a per-page prop here. */}",
  )
  lines.push("")
  lines.push(`# ${mdxEscapeText(title)}`)
  lines.push("")
  lines.push(`\`${method.toUpperCase()} ${path}\``)
  lines.push("")
  lines.push(...bodyLines(page))
  lines.push("## Try it")
  lines.push("")
  lines.push(
    `<ApiExplorer method=${JSON.stringify(method.toUpperCase())} path=${JSON.stringify(path)}` +
      `${schemaProp("requestSchema", requestBodySchema(operation))}` +
      `${schemaProp("responseSchema", responseSchema(operation))} />`,
  )
  lines.push("")

  return `${lines.join("\n").trimEnd()}\n`
}

/**
 * Project an `OpenApiDoc` to a Docusaurus-ready page set: one MDX file per
 * (path, method) operation, keyed by filename. Mirrors
 * `toDocusaurusReference`'s `Map<filename, content>` + `options.basePath`
 * convention (type-ir's docusaurus-reference.ts) — see this module's own
 * header comment for why this is a separate projector rather than an
 * extension of that one.
 */
export function toDocusaurusRouteReference(doc: OpenApiDoc, opts: HttpRouteReferenceOpts = {}): Map<string, string> {
  const pages = new Map<string, string>()
  const prefix = opts.basePath !== undefined ? `${opts.basePath.replace(/\/+$/, "")}/` : ""
  for (const page of routePages(doc)) {
    pages.set(`${prefix}${fileStem(page.operation.operationId)}.mdx`, renderDocusaurusPage(page, opts))
  }
  return pages
}

// ============================================================================
// Starlight renderer
// ============================================================================

function renderStarlightPage(page: RoutePage, opts: HttpRouteReferenceOpts): string {
  const { path, method, operation } = page
  const title = frontmatterTitle(page)
  const description = frontmatterDescription(page)
  const apiExplorerImport = opts.apiExplorerImport ?? "@rhi-zone/fractal-api-explorer"

  const lines: string[] = []
  lines.push("---")
  lines.push(`title: ${JSON.stringify(title)}`)
  lines.push(`description: ${JSON.stringify(description)}`)
  lines.push("---")
  lines.push("")
  lines.push(`import { ApiExplorer } from ${JSON.stringify(apiExplorerImport)};`)
  lines.push("")
  lines.push(`\`${method.toUpperCase()} ${path}\``)
  lines.push("")
  lines.push(...bodyLines(page))
  lines.push("### Try it")
  lines.push("")
  // Starlight is Astro-islands-based: a component needs an explicit
  // hydration directive to run client-side at all. `client:only` is broken
  // specifically inside MDX (see docs/design/mocked-fetch-backend.md's
  // verified findings — window-not-defined errors), so this uses
  // `client:load` (hydrate immediately on page load), not `client:only`.
  lines.push(
    `<ApiExplorer client:load method=${JSON.stringify(method.toUpperCase())} path=${JSON.stringify(path)}` +
      `${schemaProp("requestSchema", requestBodySchema(operation))}` +
      `${schemaProp("responseSchema", responseSchema(operation))} />`,
  )
  lines.push("")

  return `${lines.join("\n").trimEnd()}\n`
}

/**
 * Project an `OpenApiDoc` to a Starlight-ready page set: one MDX file per
 * (path, method) operation. Mirrors `toStarlightReference`'s convention
 * (type-ir's starlight-reference.ts) — an explicit `import` line (Starlight
 * already requires this for its own `<Tabs>`/`<Aside>` components, unlike
 * Docusaurus's global-MDX-component convention) plus a `client:load`
 * hydration directive on the emitted tag, per this file's header comment.
 */
export function toStarlightRouteReference(doc: OpenApiDoc, opts: HttpRouteReferenceOpts = {}): Map<string, string> {
  const pages = new Map<string, string>()
  for (const page of routePages(doc)) {
    pages.set(`${fileStem(page.operation.operationId)}.mdx`, renderStarlightPage(page, opts))
  }
  return pages
}
