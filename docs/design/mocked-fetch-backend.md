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

Beyond that direct textual finding, two things are relevant but
**[UNVERIFIED this session]** — general public knowledge, not confirmed by
fetching current Docusaurus/Starlight/MkDocs documentation in this session,
and should not be treated as settled:

- Docusaurus is MDX-based and MDX generally supports embedding React
  components inside otherwise-Markdown content, which is the mechanism the
  existing `<TypeRef>` precedent above already relies on. If that general
  understanding holds, a live mocked-fetch playground component is
  plausibly embeddable the same way `<TypeRef>` is designed to be.
- Starlight is Astro-based; Astro's MDX integration and "island" component
  model generally support embedding interactive UI-framework components
  (React/Solid/etc.) inside otherwise-static pages. If that holds, Starlight
  is plausibly also capable, by a different underlying mechanism (Astro
  islands) than Docusaurus's (plain MDX/React).
- MkDocs is the one case where the existing doc doesn't just leave the
  question open — it states MkDocs's projector deliberately emits "plain
  CommonMark + MkDocs-Material's extensions... deliberately **not** MDX,
  which MkDocs cannot render." If MDX genuinely is the embedding mechanism
  the other two rely on, this reads as a structural "no" for MkDocs
  specifically — but this session did not separately verify whether MkDocs
  has some non-MDX embedding mechanism of its own (an iframe-based plugin,
  a Material extension, etc.) that could still carry a live component by a
  different route. Treat "MkDocs can't do this" as the doc's own stated
  reason for choosing plain Markdown, not as an exhaustively researched
  verdict on every possible MkDocs embedding mechanism.

**Net: this session did not settle the embedding question.** What it did
establish directly is that no existing fractal doc projector embeds live
components today, and that the codebase already has one precedent
(`<TypeRef>`) for how a future embed *would* be wired if the target doc
generator supports it. Whether Docusaurus/Starlight actually do, and whether
MkDocs categorically doesn't, needs verification against each generator's
current documentation before this use case is scoped further — not asserted
here as settled either way.

### Consequence for scoping this use case

Given the above, the docgen-embedding use case should be treated as
conditional on that verification, per the project owner's own framing: if
Docusaurus/Starlight support live-component embedding (plausible, not yet
confirmed) and MkDocs structurally doesn't (suggested by the existing doc's
own reasoning, not yet independently confirmed), then this use case applies
to a subset of doc-generation targets, not all of them uniformly — which
also interacts with the ongoing, separately-scoped "production-grade
initiative across all doc-generation targets" work already tracked in
`docs/roadmap.md` (not modified by this doc, since that section is being
edited elsewhere).

## See also

- `packages/http-api-projector/README.md` — `createFetch` and the existing
  in-process-fetch adapter this idea's "(a)" reading overlaps with.
- `docs/reference/type-ir/doc-projectors.md` — source of the embedding
  findings above; read this directly before scoping the docgen use case
  further, rather than relying on this doc's summary of it.
- `docs/roadmap.md` — "Web Playground" section (existing `packages/playground/`
  scope) and "Documentation Generation" / "Production-grade initiative"
  sections (doc-projector target list and status, not edited by this doc).
