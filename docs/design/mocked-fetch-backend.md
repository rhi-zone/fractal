# Mocked-`fetch` HTTP backend — scoping notes

> Pre-implementation scoping document. Captures the idea's shape, the two
> use cases motivating it, and what this session found about the doc-embedding
> question one of those use cases depends on. Not a decision — the fractal-
> specific-vs-standalone-package question is explicitly preserved as open,
> per the project owner's own framing of it as unresolved.

## The idea

A new backend that compiles an `http-api-projector` API definition — the
same `api()`/`op()` tree every other HTTP backend (`createFetch`, `serveBun`,
`serveNode`, ...) consumes — to a *mocked* `fetch` function, instead of
running an actual server. Two separate motivating use cases were named, kept
separate below because they have different requirements and one of them has
a real open dependency the other doesn't.

## Open question, flagged by the project owner, preserved here: fractal-specific vs. standalone package

The project owner raised this themselves and it is not resolved in this
doc: should this ship as something specific to fractal's own `api-tree`/
`http-api-projector` types (consuming `HttpRoute`/`SchemaMap` directly), or
as a general-purpose mock-data-generator package (schema-in, fake-data-out,
independent of fractal's tree shape) that a fractal-specific mocked-`fetch`
adapter would then be a thin consumer of? A general package would be reusable
outside fractal entirely (e.g. against a raw JSON Schema or OpenAPI doc with
no fractal tree involved) at the cost of not being able to lean on
fractal-specific structure (route tree shape, tag metadata, co-located verb
handling) the way a fractal-specific implementation could. Both shapes, or
either alone, remain on the table.

## Architectural note: what "mocked" means here is itself ambiguous

Worth surfacing before scoping further, because it changes what "compiles to
a mocked fetch" actually requires building: `http-api-projector` already has
`createFetch(tree)`, which returns a `fetch`-shaped function that runs the
*real* tree — real handlers, real validation, real routing — entirely
in-process, with no listening socket and no real network I/O (see the
package README's usage example: `const fetch = createFetch(tree)`). So
"mocked fetch" could mean two different things, and the idea as described
doesn't disambiguate which:

- **(a) In-process real execution, mocked only in the sense of "no socket."**
  This is arguably already `createFetch` — it runs the actual tree's actual
  handler logic against an actual (in-memory) route match, just without
  opening a port. If this is what's meant, the "new backend" work is small:
  little beyond what already exists, maybe packaged/documented differently
  for the playground/docgen use cases below.
- **(b) Fabricated response data, no real handler execution at all.** The
  Postman-mock-server sense: given the tree's declared *shapes* (schemas,
  status codes, response types) but not necessarily any real handler
  implementation, synthesize plausible sample data and serve that. This is
  useful specifically when demoing or documenting an API whose real handler
  logic either doesn't exist yet, is unsafe to run client-side (e.g. a
  handler that would hit a real database), or shouldn't be exposed as
  working code in a doc/demo context. This is a materially different feature
  — it needs a data-fabrication step schema-in/sample-out, which is exactly
  the general-purpose-mock-data-generator shape from the open question above
  — not just a wrapper over `createFetch`.

Which of these (a), (b), or both) the idea is meant to cover isn't settled
by the prompt that motivated this doc, and the two use cases below don't
obviously demand the same answer — flagged as open rather than assumed.

## Use case 1: Postman-like interactive playground

An interactive UI where a user picks an operation from a fractal-defined API
tree, fills in inputs, and sees a request/response cycle happen — the same
demo value Postman/Insomnia/Hoppscotch provide for hand-written APIs, but
generated automatically from the tree's own shape instead of hand-configured
per endpoint.

`packages/playground/` (Vite + Solid + CodeMirror 6) already exists as a
browser-based, client-side schema-conversion tool (documented in
`docs/roadmap.md`'s "Web Playground" section) — but per that doc, it
currently does client-side format conversion only ("no HTTP mocking
involved currently", confirmed: nothing in `docs/roadmap.md` or
`docs/design/` currently describes an HTTP-request-simulation feature
there). Whether a Postman-like mode would live inside `packages/playground/`
as a new mode/tab, or as a separate tool, is not decided here — it depends
on the package-boundary question above (a fractal-specific mocked-fetch
consumer is a natural fit for extending the existing Solid app; a
standalone mock-data-generator package has no particular reason to live
there).

## Use case 2: embedded inside generated documentation

The idea's second use case is a live, interactive component embedded inside
generated docs (Docusaurus/Starlight/mkdocs/etc. output) — the project owner
was explicit that this only makes sense as a docgen feature *if* the
relevant doc generator can actually embed a live JS component; otherwise
this use case doesn't apply to docgen at all and use case 1 (a standalone
playground) is the only place it lands.

### What this session found about doc-projector embedding, and its confidence level

Read `docs/reference/type-ir/doc-projectors.md` in full. **[VERIFIED-LOCAL,
this session]** All three existing site-level doc projectors
(`toDocusaurusReference`, `toStarlightReference`, `toMkdocsReference`)
produce a `Map<filename, string>` of static Markdown/MDX *text* — there is
no live-component runtime shipped by any of them today, and no existing
fractal doc projector embeds or executes any interactive JS. This much is
directly confirmed by reading the doc, not inferred.

There is one relevant precedent already in the doc, though: the Docusaurus
projector's generated MDX references a `<TypeRef name=… summary=… />`
component for inline hover-card type references, and the doc is explicit
that this component **"is not shipped by type-ir"** — the generated page
assumes a companion React component the consuming Docusaurus site adds
itself under `src/components/`. That's the same shape a mocked-fetch
playground embed would need: fractal's generated MDX referencing a
component by name, with the actual interactive component shipped/registered
separately by the consuming site (or by a fractal-provided companion
package the site opts into) — a real precedent for "generated docs reference
a live component without fractal's projector directly executing anything,"
already in this codebase's design, not a novel mechanism this idea would
have to invent from scratch.

### Verified findings, this session (2026-08-12) — resolves the prior [UNVERIFIED] flag

The project owner resolved the scope question this doc previously left open:
**implement live-component embedding for whichever targets actually support
it; skip it for whichever don't.** This required settling, per-target,
whether "supports it" is actually true — done below by fetching each
generator's own current documentation, not by carrying forward the general
public-knowledge assumptions the earlier version of this doc flagged as
unverified.

**Docusaurus — supports it, confirmed.** Docusaurus's MDX docs state
directly: "You can also import your own components defined in other files or
third-party components installed via npm," and demonstrate importing a
custom component from a separate `.js`/`.tsx` file and using it as a JSX tag
inside an otherwise-Markdown page — a real, client-side-interactive React
component, not static markup. Source:
[Docusaurus — MDX and React](https://docusaurus.io/docs/markdown-features/react).
This is exactly the mechanism the existing `<TypeRef>` precedent in
`docusaurus-reference.ts` already relies on (see above) — that precedent
wasn't a guess, it matches Docusaurus's documented capability.

**Starlight — supports it, confirmed, via Astro islands.** Starlight's own
docs state that because it's built on Astro, MDX/Markdoc files can use
"components built with any supported UI framework (React, Preact, Svelte,
Vue, Solid, and Alpine)." Source:
[Starlight — Using Components](https://starlight.astro.build/components/using-components/).
The underlying mechanism is Astro's islands architecture — components ship
inert HTML by default and opt into client-side hydration via a `client:*`
directive (`client:load`, `client:idle`, `client:visible`, `client:only`).
One caveat surfaced during verification: `client:only` is reported broken
inside MDX specifically ("window not defined" errors) — see
[withastro/starlight discussion #2235](https://github.com/withastro/starlight/discussions/2235)
— so a Starlight embed would need `client:load` or `client:visible`, not
`client:only`, inside the generated MDX. This is a concrete implementation
constraint, not a capability blocker.

**MkDocs (Material) — does not support the same class of embedding.**
Material for MkDocs is, per its own documentation, a static Markdown-to-HTML
generator with no MDX and no in-page framework-component-import mechanism —
there is nothing in its docs equivalent to Docusaurus's `import Foo from
"./Foo"` or Starlight's per-file UI-framework component imports. Its
customization surface is `extra_javascript` (site-wide `<script>` includes
declared in `mkdocs.yml`) plus a `document$` lifecycle observable for
re-running JS after MkDocs-Material's instant-loading page swaps, and/or
overriding template blocks (`{% block scripts %}`) in a custom `main.html`.
Source: [Material for MkDocs — Customization](https://squidfunk.github.io/mkdocs-material/customization/).
Combined with standard Markdown's raw-HTML passthrough (confirmed separately:
plain `<iframe>` tags are known to work in MkDocs-Material pages, e.g.
[mkdocs/mkdocs discussion #3188](https://github.com/mkdocs/mkdocs/discussions/3188)),
it is technically possible to drop a raw custom-element tag
(`<my-widget ...></my-widget>`) directly into a page's Markdown source and
have a site-wide `extra_javascript` bundle register and hydrate it as a Web
Component. That route exists, but it is not really "MkDocs support" in the
sense the other two targets have it — raw-HTML-tag-plus-external-script
works on essentially *any* HTML output, MkDocs-generated or not, and is not
a documented MkDocs feature for this purpose. It's also structurally
different from what `mkdocs-reference.ts` emits today or from what
Docusaurus/Starlight's import-a-component idiom provides: there is no
declarative "reference a component by name" surface in MkDocs's authoring
format at all, only "embed literal HTML + separately wire up a script."
Confirms the reasoning `mkdocs-reference.ts`'s own doc comment already gives
("plain CommonMark ... deliberately **not** MDX, which MkDocs cannot
render") as the accurate account, not just the doc's stated justification.

**Net, per the project owner's resolved scope (implement where supported,
skip where not): Docusaurus and Starlight are in scope for live-component
embedding; MkDocs is out of scope** under this doc's reading of "supports
it" as "the generator's own authoring format has a component-reference
mechanism," which is what the two React-in-MDX/Astro-island targets have and
MkDocs's raw-HTML+`extra_javascript` route is not. If the project owner
later wants the raw-HTML/custom-element route pursued for MkDocs anyway
despite it not fitting that reading, that's a distinct, lower-level feature
(the projector would need to emit literal `<custom-element>` HTML plus
instructions for wiring `extra_javascript`) and is flagged here as a
possible-but-different follow-up, not folded into "MkDocs supports
embedding" as verified above.

### What embedding would concretely require on fractal's side, per in-scope target

**Docusaurus (`docusaurus-reference.ts`).** The projector already emits a
JSX component reference with no import statement
(`<TypeRef name={...} summary={...} />`, relying on the consuming site
registering `TypeRef` as a global MDX component — see the file's own
`renderPage` output). Emitting a playground embed is the same shape: a new
tag such as `<MockedFetchPlayground operation="..." tree={...} />` inside
`renderPage`'s output, with a new MDX-comment note (matching the existing
`<TypeRef>` note's pattern) telling the consuming site it must register a
`MockedFetchPlayground` component. No new *projector* machinery is needed —
the "emit a bare JSX component tag referencing something the site provides"
hook already exists and is exercised today. What's genuinely new: (a)
deciding how the operation's tree/schema data reaches the component (as a
serialized JSON prop, most likely — nothing in the projector currently
serializes tree data into a JSX prop), and (b) the `MockedFetchPlayground`
component itself, which depends on the still-unresolved mocked-`fetch`
backend work elsewhere in this doc, not on projector plumbing.

**Starlight (`starlight-reference.ts`).** The projector already emits an
explicit MDX `import { Tabs, TabItem, Aside, LinkCard, Code } from
'@astrojs/starlight/components'` line and uses the imported components as
JSX tags — i.e. it already has the "emit an import statement plus a
component usage" mechanism, one step beyond Docusaurus's import-free
`<TypeRef>` pattern. Extending this to a live playground is: add an import
line for the playground component (from wherever the consuming site or a
fractal-provided companion package places it) and emit its tag with an
explicit hydration directive, e.g. `<MockedFetchPlayground client:load
operation="..." tree={...} />` — the `client:load`/`client:visible`
requirement noted above is a one-line addition to that emitted tag, not new
architecture. Same open items as Docusaurus: prop-serialization strategy and
the playground component's own implementation are out of scope for this
projector-level change.

**MkDocs (`mkdocs-reference.ts`).** Out of scope per the above — no change
proposed here. Noted for completeness only: if ever revisited, it would need
genuinely new machinery (the projector currently has no path to emit raw
HTML tags at all, only CommonMark + MkDocs-Material Markdown extensions),
not an extension of an existing hook the way the other two targets have.

This also interacts with the ongoing, separately-scoped "production-grade
initiative across all doc-generation targets" work already tracked in
`docs/roadmap.md` (not modified by this doc, since that section is being
edited elsewhere).

## Resolved: is `createFetch`'s return a drop-in for global `fetch`?

A separate, narrower question than (a)/(b) above, but one the playground use
case (use case 1) depends on directly: the project owner's bar for "already
done" was whether `createFetch`'s returned function has the *exact* global
`fetch` call signature — `(input: RequestInfo | URL, init?: RequestInit) =>
Promise<Response>` — so a playground/doc-embed UI typed against `typeof
fetch` could swap it in with zero adaptation.

**[VERIFIED-LOCAL, this session]** It did not. `createFetch` (preset.ts)
returns `CompiledRouter` (compile.ts): `(req: Request) => Promise<Response>`
— one required `Request` parameter, not the wider `RequestInfo | URL` +
optional `RequestInit` global `fetch` accepts. Every existing caller in this
package (all of preset.test.ts, client.test.ts, codegen.test.ts, etc.)
already constructs a `Request` itself and calls `f(new Request(...))`
accordingly — none of them, nor `client.ts`'s own `fetch` option, ever calls
the wider form.

That narrower shape isn't an oversight — `CompiledRouter`/`Fetch` (layers.ts
declares an identical alias) is the composition contract every internal
layer in this package is built on: `corsLayer`, `autoMethodLayer`,
`withALS`, consumer `middleware`/`handlerMiddleware`, the webhook layers in
webhook.ts, and `compile.ts`'s own router compilers all take and return
exactly this shape, and their bodies read real `Request` members (`.method`,
`.url`, ...) directly. Widening it to the full `fetch` signature would force
every one of those internal layers to normalize `RequestInfo | URL` +
`RequestInit` into a `Request` on every call, for no benefit to the
in-process composition they're actually doing — pure ripple, no payoff.

Resolution landed as a **second, separate function** rather than changing
`createFetch`: `toDropInFetch(router: CompiledRouter, baseUrl?: string):
DropInFetch` (preset.ts, exported from the package root), where `DropInFetch
= (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>` is
the literal global-`fetch` type. It's a thin adapter — resolves a relative
`input` string/`URL` against `baseUrl` (default `http://localhost`, since
these requests never hit a real socket) into an absolute `URL` (`Request`,
unlike browser `fetch`, has no ambient document origin and throws on a bare
relative string), constructs a `Request`, and calls the wrapped router. Still
real in-process execution — no fabricated data, same as `createFetch`
itself; only the outer call signature changes. Usage:

```ts
import { createFetch, toDropInFetch } from "@rhi-zone/fractal-http-api-projector/preset"

const fetch = toDropInFetch(createFetch(tree))
const res = await fetch("/books/list") // string + no Request construction, like real fetch
```

Covered by new tests in `packages/http-api-projector/src/preset.test.ts`
("toDropInFetch" describe block) — relative string input, `RequestInit`
threading (method/headers/body), `URL` input, `Request` input (still
accepted, since `Request` is a valid `RequestInfo`), and custom `baseUrl`.
Full package test suite (647 tests) and `tsc --noEmit` both pass with this
change; no existing caller's types or behavior changed, since `createFetch`
and `CompiledRouter` are untouched.

This directly unblocks use case 1's "already done" bar for reading (a)
(in-process real execution) — a playground built against `toDropInFetch` can
use a stock `typeof fetch`-typed integration point. It does not touch
reading (b) (fabricated response data with no real handler execution),
which — per the "what mocked means" section above — is still open and would
need its own data-fabrication step regardless of this signature fix.

## See also

- `packages/http-api-projector/README.md` — `createFetch` and the existing
  in-process-fetch adapter this idea's "(a)" reading overlaps with.
- `packages/http-api-projector/src/preset.ts` — `createFetch`, `CompiledRouter`
  vs. `DropInFetch`, and `toDropInFetch`, the signature-compatibility
  resolution above.
- `docs/reference/type-ir/doc-projectors.md` — source of the embedding
  findings above; read this directly before scoping the docgen use case
  further, rather than relying on this doc's summary of it.
- `docs/roadmap.md` — "Web Playground" section (existing `packages/playground/`
  scope) and "Documentation Generation" / "Production-grade initiative"
  sections (doc-projector target list and status, not edited by this doc).
