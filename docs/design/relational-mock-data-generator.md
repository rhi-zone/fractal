# Relational mock-data generator — scoping notes

> Pre-implementation scoping document. Captures the idea's shape, what this
> session verified about the IR's current relation-modeling capability, prior
> art the design should be grounded in, and open questions. Not a decision —
> nothing here is built, and the open questions are laid out for the project
> owner rather than resolved.

## The idea

A standalone capability that generates *fabricated* data across an entire
schema graph — not one isolated type at a time, but a whole backend's worth
of entities — while keeping cross-entity references consistent: if generated
entity A has a field that is "a reference to entity B," the generated value
in that field actually names an id that exists among the generated B
records, the way a real foreign key would. Two motivating use cases, named
by the project owner as possibly-separable:

1. **Playground backend.** Mock an entire backend's worth of fake data (not
   real handler execution) to power an interactive playground in docs — a
   believable fake backend a user can click around in, where following a
   reference (e.g. a book's `authorId`) actually resolves to a plausible,
   consistent author record instead of a dangling or random id.
2. **Runnable doc snippets.** Generate example code embedded in
   documentation that a reader can actually execute (not just read as
   static text), against the same kind of fabricated-but-consistent data.

## How this differs from `toDropInFetch` / the already-built drop-in-fetch work

`docs/design/mocked-fetch-backend.md` scoped a related-sounding but
architecturally distinct idea, and the distinction that doc drew — reading
(a) vs. reading (b) of "mocked" — is exactly the line this doc sits on the
far side of:

- **`toDropInFetch`** (built, `packages/http-api-projector/src/preset.ts`) is
  reading (a): it wraps `createFetch`'s `CompiledRouter` — which runs the
  **real handler tree**, real routing, real validation, all in-process with
  no socket — behind the literal global-`fetch` call signature
  (`(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>`).
  There is no fabricated data anywhere in it; every response is whatever the
  real handler actually computes. It is a signature adapter, not a data
  generator.
- **This idea** is reading (b): given only a tree's *declared shapes*
  (`SchemaMap`/`TypeRef`s for requests and responses), with no real handler
  behind them at all (or deliberately not exercising the real one — e.g.
  because it would hit a real database, or the handler doesn't exist yet),
  synthesize plausible sample data and serve *that*. `mocked-fetch-backend.md`
  named this exact gap explicitly: reading (b) "needs a data-fabrication
  step schema-in/sample-out, which is exactly the general-purpose-mock-
  data-generator shape... not just a wrapper over `createFetch`" — this doc
  is that data-fabrication step, scoped on its own terms.

The two are compatible, not competing: a finished data-fabrication step
could plausibly sit behind a `fetch`-shaped adapter the same way
`toDropInFetch` sits in front of `CompiledRouter`, giving both use cases
(real execution, fabricated execution) the same drop-in-`fetch` integration
point. That composition isn't designed here — it falls out naturally once
both pieces exist — but it's why this doc treats `toDropInFetch` as
adjacent prior art rather than something to duplicate or replace.

The **new** difficulty this idea introduces that `toDropInFetch` never had
to face at all: `toDropInFetch` needed no data model, because it never
generates data — it only forwards to real handlers. This idea's whole job
*is* generating data, and generating it in a way that stays internally
consistent across entities, which is a different kind of problem (schema-
graph-aware synthesis) than anything already built in this codebase.

## What this session verified about relation/reference modeling in the IR

The prompt asked this as a genuinely open question rather than something to
assume either way. Verified this session by reading source, not inferred:

**`TypeRef`'s `ref` kind (`packages/type-ir/src/index.ts`) is a purely
structural/recursive-type marker, not a data-relation concept.**
`{ kind: "ref"; target: string }` resolves against a `TypeRefDocument`'s
`defs: Record<string, TypeRef>` (`resolveRef`, index.ts) — it exists so a
type can refer to another *named type definition* (e.g. a recursive type
referring to itself, or shared substructure), the same thing OpenAPI's
`$ref`/JSON Schema's `$ref` do. It says nothing about *data* identity —
there is no notion anywhere in `TypeKinds` of "this field's runtime value is
expected to equal another entity's id field." Confirmed by reading
`childTypeRefs`/`resolveRef`/`walkTypeRef` in full: every mechanism here
operates on the *type* graph (which shapes reference which other shapes),
never on an *instance*-level foreign-key-style relationship between two
separately-generated records.

**`http-api-projector`'s `HttpRoute` (`packages/http-api-projector/src/route.ts`)
carries no entity-relationship metadata either.** A route's `meta`/
`RouteLeafMeta` carry per-operation/per-route bookkeeping (method, path
params, tags, etc.) — nothing that names "this operation's request/response
schema is keyed on entity X" or relates one operation's schema to another's.
There is no entity concept above the level of individual request/response
`TypeRef`s at all; api-tree models *routes*, not a schema-wide entity graph.

**One directly relevant, currently-inert precedent: `from-sql.ts` already
parses real foreign-key constraints, but nothing consumes them.**
`packages/type-ir/src/from-sql.ts` parses `REFERENCES` clauses from `CREATE
TABLE` DDL (both inline column constraints and table-level `FOREIGN KEY ...
REFERENCES ...`) and attaches the result as `meta.references: { table:
string; column?: string }` on the referencing field's `TypeRef` (see the
`TABLE_CONSTRAINT_RE`/`REFERENCES` handling around from-sql.ts:412–590).
This is exactly the "field references another entity's identity" fact the
mock generator would need — captured today, for SQL input only. Grepping the
rest of the codebase for `.references` confirms it is written in exactly one
place (`from-sql.ts`) and read in **zero** places: the corresponding `sql.ts`
projector (TypeRef → `CREATE TABLE` text) never reads `meta.references` back
out to re-emit a `REFERENCES` clause, and no other package (api-tree,
http-api-projector, any other type-ir projector) reads it either. It is
parsed, attached to `meta`, and then never consumed — a one-way capture, not
a round-tripped or cross-package concept.

**Net finding: the concept is absent as a first-class IR feature, but there
is prior art for exactly where it would hang.** The IR's own design
philosophy is an open metadata bag over a fixed schema (`meta:
Record<string, unknown>` on every `TypeRef`, per `docs/design/design-
philosophy.md`) specifically so conventions like this don't need a `TypeKinds`
change — `from-sql.ts`'s `meta.references` shape is already exactly that
kind of convention, just currently scoped to one importer with no consumer.
Whether the mock generator should (a) standardize and generalize
`meta.references` into a cross-importer, cross-projector convention, (b)
invent a separate, mock-generator-specific metadata key so it doesn't take
on and depend on `from-sql.ts`'s SQL-specific parsing behavior, or (c)
require relations to be declared out-of-band (e.g. a side config the
generator consumes, not carried on the `TypeRef` at all — the shape
`@mswjs/data` and Mirage JS both use, see below) is an open question, not
resolved here.

## Prior art

Surveyed for how other ecosystems solve "generate fake data across a schema
graph while keeping foreign-key-shaped references consistent." The tools
split cleanly into two families by *where the relation information comes
from*, which maps directly onto the open question above.

**Family 1 — relations read from a real schema that already has them
(SQL/ORM schemas with actual FK constraints).**

- **[drizzle-seed](https://orm.drizzle.team/docs/seed-overview)** infers the
  FK dependency graph directly from a Drizzle schema and topologically
  orders table population accordingly (`getOrderedTablesList` — parents
  before children) so every generated child row's FK column names an id
  that already exists among that run's generated parent rows. Cyclic FK
  relationships (which have no valid topological order) are handled with a
  two-phase strategy: generate with the cyclic FK column initially `null`,
  then patch it in a second pass once both sides exist. Generation is
  deterministic (seeded PRNG, `pure-rand`'s xoroshiro128plus), which matters
  for reproducible playground/doc-snippet output. Documented limitation:
  cannot reliably infer relations across genuinely circular FK dependencies
  without that two-phase fallback.
- **Prisma's own seeding is unopinionated** (a plain `prisma/seed.ts`
  convention, no bundled relational generator) — the ecosystem fills the gap
  with **[@snaplet/seed](https://snaplet-seed.netlify.app/)**, which reads a
  Prisma (or introspected SQL) schema's real relations and generates
  relationship-aware data along with a fluent override API and a visual seed
  explorer, and **prisma-fabbrica**/hand-rolled Faker-plus-Prisma-Client
  approaches, which lean on the developer seeding parent records first and
  threading their real ids into child-record factories by hand (i.e. FK
  consistency is achieved by seeding order, not by the tool inferring or
  enforcing it).
- Plain **Faker.js**-based seeding (Laravel, and comparable JS patterns) has
  no relational awareness at all — the well-known pattern is "seed the
  parent model, capture its real id, thread that id into the Faker call for
  the child model's FK column," entirely by hand, per-relationship, with no
  schema-wide graph reasoning.

**Family 2 — relations hand-declared on an in-memory mock model, independent
of any real schema (closer to this idea's likely shape, since the IR has no
real FK constraints to read from for non-SQL sources).**

- **[@mswjs/data](https://github.com/mswjs/data)** is the most directly
  relevant precedent for the *playground backend* use case: an in-memory,
  ORM-inspired data-modeling library meant to pair with MSW request
  handlers. Models are hand-declared with explicit `oneOf()`/`manyOf()`
  relation properties (its own take on belongsTo/hasMany), and the library
  then provides Prisma-like relational querying (`.findFirst`, nested
  `where`, populated relations) over the resulting in-memory store — i.e.
  it does not infer relations from any external schema; the relations
  *are* the schema, hand-authored specifically for mocking purposes.
- **[Mirage JS](https://miragejs.com/docs/main-concepts/relationships/)**
  (and its Ember-CLI-Mirage predecessor) is the closest existing analogue to
  "fabricate a whole fake backend with relational integrity, serve it over
  intercepted HTTP requests": models declare `belongsTo()`/`hasMany()`
  relationships, Mirage auto-manages the resulting FK columns
  (`post.commentIds`, `post.comments`), and **factories** (its
  data-generation layer, distinct from models) use an `association()` helper
  plus `afterCreate` hooks to build up consistent, valid relational graphs
  of fabricated records on server startup — then Mirage's route handlers
  serve real HTTP requests against that in-memory relational store. This is
  architecturally the shape use case 1 (playground backend) describes almost
  exactly, modulo Mirage's models/relations being hand-authored per-project
  rather than derived from a fractal `TypeRef`/`HttpRoute` tree.

**Family 3 — schema-in/fake-out with no relational concept at all (the
"solved, but not the hard part" baseline).**

- **json-schema-faker** and **Prism**'s (Stoplight's OpenAPI mock server)
  built-in mock mode both generate a single schema's worth of sample data
  well, including semantic hints (`faker:`/`chance:` keyword extensions
  telling the generator "this string field should look like an email/name/
  etc."), but neither has any concept of a *second* schema's data needing to
  agree with the first's. Confirms that fabricating one entity's shape in
  isolation is the already-solved part of this problem (fractal's IR already
  has semantically-tagged kinds like `uuid`/`email` that a fabricator could
  key off directly, per `packages/type-ir/src/kinds/semantic-strings.ts`)
  and that the differentiator this idea is actually chasing — cross-entity
  referential consistency — is exactly the part these tools don't attempt.

**What this confirms for the design:** every family that achieves
referential consistency does so from an explicit relation graph, either
inferred from a real constrained schema (Family 1 — not available to
fractal for non-SQL sources, since the IR verification above found no
generalized cross-format relation concept) or hand-declared on a
mocking-specific model (Family 2 — the more likely shape here, and it
directly parallels the `meta.references`-generalization vs.
separately-declared-relations fork the IR-verification section above
already surfaced as open). No surveyed tool infers referential structure
from an *unconstrained* schema format (bare JSON Schema/OpenAPI/GraphQL SDL)
the way this idea would need to for non-SQL fractal sources — which is
itself useful negative evidence: if fractal wants relation-aware fabrication
for e.g. an OpenAPI-sourced tree, some explicit relation-declaration
mechanism looks necessary, not just an inference pass over existing IR data.

## The two use cases as possibly-separable capabilities

The project owner named both but did not say they must ship together or
share an implementation; laid out here as genuinely separable, per prior
art landing on different sides of a similar split:

- **Playground backend (use case 1).** Needs: a full in-memory relational
  data *store* (generate once, keep serving consistent reads/writes across
  a session — Mirage's/`@mswjs/data`'s shape), served behind something
  `fetch`-shaped so it can plug into a UI the way `toDropInFetch` already
  plugs a real router in. Naturally long-lived per playground session
  (mutations from a "create" operation should probably be visible to a
  subsequent "list" call in the same session, the way a real backend would
  behave — Mirage's model store does this; a one-shot fabrication would
  not).
- **Runnable doc snippets (use case 2).** Needs: fabricated data that's
  *reproducible* (the snippet in the doc and the data backing it need to
  match every time a reader runs it — points at drizzle-seed's seeded-PRNG
  determinism as the relevant prior-art property, not at its SQL-specific
  mechanism) but not necessarily long-lived or stateful across requests the
  way a playground session is — a snippet re-run from scratch each time
  could plausibly regenerate the same fabricated graph from the same seed
  rather than needing a persistent store.

Whether a shared "fabricate a relationally-consistent data graph from a
schema (+ relation declarations)" core sits underneath both, with each use
case wrapping it differently (one as a stateful store, one as a
deterministic one-shot generator), or whether they diverge enough to warrant
separate implementations, is not decided here.

## Open questions

Preserved as open per the project's disposition — laid out for the project
owner's call, not resolved:

1. **Standalone package vs. fractal-specific**, the same fork
   `mocked-fetch-backend.md` raised and left open for that idea — applies
   here too, and arguably more sharply, since a schema-in/fake-out-with-
   relations generator has plausible value entirely outside fractal (e.g.
   against a raw JSON Schema or OpenAPI doc with no fractal tree involved
   at all), the same way json-schema-faker and Prism are schema-format
   tools, not framework-specific ones.
2. **How relations get declared**, given the IR-verification finding above:
   generalize/formalize `from-sql.ts`'s existing (currently inert)
   `meta.references` convention across all importers and projectors, invent
   a separate mock-generator-specific metadata convention that doesn't
   inherit `from-sql.ts`'s SQL-specific parsing assumptions, or require
   relations declared out-of-band the way `@mswjs/data`/Mirage JS do (a
   config/DSL the generator consumes, decoupled from `TypeRef.meta`
   entirely). These have different blast radii — the first touches every
   existing importer/projector that currently ignores `meta.references`;
   the second and third don't touch existing code at all.
3. **Inference vs. declaration.** Even with a declaration mechanism chosen,
   should the generator attempt to *infer* likely relations for sources that
   don't declare them at all (e.g. heuristically treating a field literally
   named `authorId` as a probable reference to an `Author` entity's `id`),
   the way none of the surveyed prior art actually does for unconstrained
   schema formats? Heuristic inference is strictly worse than a declared
   relation (it can guess wrong), but zero-config "it just works" for common
   naming conventions is exactly the ergonomic bar tools like Prism set for
   the no-relations case.
4. **Cyclic references.** drizzle-seed's two-phase null-then-patch strategy
   is the only concretely surveyed answer; whether fractal's generator needs
   the same fallback (i.e. whether cyclic entity references are expected in
   practice for the schemas this would run against) isn't established here.
5. **Determinism/seeding contract**, particularly for use case 2: does a
   given doc snippet need the *exact same* fabricated values on every run
   (a fixed seed baked into the doc build), or merely internally-consistent
   values that can differ run to run? This affects whether doc snippets
   embed a seed as part of their generated output.
6. **Relationship to `toDropInFetch`.** Not decided here: whether a finished
   fabrication core eventually gets wrapped in something `fetch`-shaped
   alongside/behind `toDropInFetch` (see the architecture-differences
   section above), or stays a separate, non-`fetch`-shaped data-generation
   API that a playground consumes directly.
7. **State/mutation semantics for the playground use case.** If a playground
   session issues a "create" or "update" operation against the fake backend,
   does the fabricated store need to accept and persist that mutation for
   the rest of the session (Mirage's/`@mswjs/data`'s model), or is a
   read-only fabricated snapshot sufficient for the playground's purposes?
   This materially changes the scope of use case 1 alone.

## See also

- `docs/design/mocked-fetch-backend.md` — the related, already-partly-built
  idea this doc distinguishes itself from; specifically its "(a) vs (b)"
  framing of what "mocked" means, which this doc is entirely on the (b) side
  of, and its own still-open standalone-vs-fractal-specific question (open
  question 1 above mirrors it).
- `packages/http-api-projector/src/preset.ts` — `toDropInFetch`, the
  fetch-signature adapter this doc treats as adjacent, composable prior work
  rather than something to duplicate.
- `packages/type-ir/src/index.ts` — `TypeRef`'s `ref` kind
  (structural/recursive-type reference), `resolveRef`/`walkTypeRef`; source
  of this session's "no data-relation concept" finding.
- `packages/type-ir/src/from-sql.ts` — `meta.references` FK-constraint
  parsing (currently inert; see the IR-verification section above).
- `packages/type-ir/src/sql.ts` — the TypeRef→SQL projector that does *not*
  currently read `meta.references` back out; confirms the capture is
  one-way today.
- `packages/type-ir/src/kinds/semantic-strings.ts` — `uuid`/`email`/etc.
  semantically-tagged kinds a data fabricator could key sample-value
  generation off directly for the non-relational part of the problem.
- `docs/design/design-philosophy.md` — the open-metadata-bag-over-fixed-
  schema principle the `meta.references`-generalization option (open
  question 2) would extend rather than break from.
