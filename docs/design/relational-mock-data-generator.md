# Relational mock-data generator — scoping notes

> Pre-implementation scoping document. Captures the idea's shape, what this
> session verified about the IR's current relation-modeling capability
> (including a follow-up checking whether fractal's existing newtype/brand
> support can substitute for dedicated FK metadata, per the project owner's
> steer that relation-modeling should be opt-in/toolkit rather than
> core-IR), prior art the design should be grounded in, and open questions.
> Not a decision — nothing here is built, and the open questions are laid
> out for the project owner rather than resolved.

## The idea

A standalone capability that generates _fabricated_ data across an entire
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
- **This idea** is reading (b): given only a tree's _declared shapes_
  (`SchemaMap`/`TypeRef`s for requests and responses), with no real handler
  behind them at all (or deliberately not exercising the real one — e.g.
  because it would hit a real database, or the handler doesn't exist yet),
  synthesize plausible sample data and serve _that_. `mocked-fetch-backend.md`
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
_is_ generating data, and generating it in a way that stays internally
consistent across entities, which is a different kind of problem (schema-
graph-aware synthesis) than anything already built in this codebase.

## What this session verified about relation/reference modeling in the IR

The prompt asked this as a genuinely open question rather than something to
assume either way. Verified this session by reading source, not inferred:

**`TypeRef`'s `ref` kind (`packages/type-ir/src/index.ts`) is a purely
structural/recursive-type marker, not a data-relation concept.**
`{ kind: "ref"; target: string }` resolves against a `TypeRefDocument`'s
`defs: Record<string, TypeRef>` (`resolveRef`, index.ts) — it exists so a
type can refer to another _named type definition_ (e.g. a recursive type
referring to itself, or shared substructure), the same thing OpenAPI's
`$ref`/JSON Schema's `$ref` do. It says nothing about _data_ identity —
there is no notion anywhere in `TypeKinds` of "this field's runtime value is
expected to equal another entity's id field." Confirmed by reading
`childTypeRefs`/`resolveRef`/`walkTypeRef` in full: every mechanism here
operates on the _type_ graph (which shapes reference which other shapes),
never on an _instance_-level foreign-key-style relationship between two
separately-generated records.

**`http-api-projector`'s `HttpRoute` (`packages/http-api-projector/src/route.ts`)
carries no entity-relationship metadata either.** A route's `meta`/
`RouteLeafMeta` carry per-operation/per-route bookkeeping (method, path
params, tags, etc.) — nothing that names "this operation's request/response
schema is keyed on entity X" or relates one operation's schema to another's.
There is no entity concept above the level of individual request/response
`TypeRef`s at all; api-tree models _routes_, not a schema-wide entity graph.

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

## Follow-up: newtype/brand-based relation inference (project owner's steer)

After the IR-verification section above was written, the project owner
responded with a steer that reframes the "how relations get declared"
question (open question 2 below): **no dedicated relation-modeling concept
belongs in the core IR** — that stays the user's opt-in choice — but fractal
could ship "a fully featured toolkit of utilities" for building a fake
backend on top of whatever a user declares. Separately, they pointed out
fractal already has newtype/branded-type support usable for database ids,
and asked whether _that_ — rather than a new FK-shaped metadata key — could
double as the relation-detection mechanism: if entity A's id field is typed
`UserId` (a newtype/brand) and entity B has a field also typed `UserId`,
does that structural type-match already tell you B references A, with no
separate FK annotation needed?

This was checked against the actual IR source (`packages/type-ir/src`,
`from-typescript.ts`, `kinds/semantic-strings.ts`) rather than assumed.
Findings:

**What newtype support actually is.** There is no dedicated `Newtype`/
`Brand` entry in `TypeKinds` (`packages/type-ir/src/index.ts`). A branded
type is represented as an ordinary base-shape `TypeRef` carrying
`meta.brand: string` — a flat key in the same generic meta bag as
`optional`/`nullable`/`readonly`, not a wrapping IR node. It's produced by
`typeRefFromBrandedIntersection` in `from-typescript.ts` (~line 822) when
extracting a TS type like `type UserId = string & { __brand: "UserId" }` or
the `unique symbol`-tagged form fractal itself uses for `Uuid`/`Uri`/`Email`
(`packages/type-ir/src/kinds/semantic-strings.ts:23-56`). Those three names
specifically get _promoted_ to real registered `TypeKinds` (`uuid`, `uri`,
`email`, subtyped under `string`); every other brand name, including a
hypothetical `UserId`, falls through to the generic `meta.brand` string with
**no registry, no uniqueness enforcement, no namespacing** — two unrelated
fields anywhere in a schema can carry `meta.brand: "UserId"` and the IR has
no way to know whether that's the same concept or an accidental string
collision.

**Is there already an "this field is the id" concept?** Only inside the
SQL/CQL DDL importer, and it is unrelated to brands: `from-sql.ts` sets
`meta.primaryKey: boolean` on a column's `TypeRef` and `meta.primaryKey:
string[]` on the table's own `TypeRef` when parsing `CREATE TABLE ...
PRIMARY KEY` (documented at `from-sql.ts:26-38`, exercised by
`from-sql.test.ts:108-112`). This is the same family of convention as the
`meta.references` finding above — real, tested, but scoped to one importer
and never cross-referenced against `meta.brand` anywhere in the codebase.

**Feasibility of the two-part inference the project owner asked about:**

- _(a) "F is the id, inferred from F's type being a newtype."_ Not reliable
  from brand identity alone. `meta.brand` is symmetric — the exact same
  brand string is expected to appear on both an owning entity's id field
  _and_ every other entity's field that references it (that symmetry is the
  whole premise of the matching idea), so nothing in the type itself
  distinguishes "this is the primary identifier" from "this is a borrowed
  reference to someone else's identifier." Telling the two apart needs one
  more bit of information than the brand carries: either a naming
  convention (field name matches a per-entity id-field convention, e.g.
  `id`) or an explicit marker — the existing SQL-only `meta.primaryKey` key,
  generalized outside the SQL path, is the natural candidate since it
  already means exactly this.
- _(b) "B relates to A, inferred from B's field type matching A's id
  field's type."_ Not derivable from the IR as it stands today, for the
  same root reason as (a): nothing marks which entity _owns_ a given brand
  as its primary identifier. If both entity A (`id: UserId`) and, say,
  entity C (`createdBy: UserId`) exist, and B has a field typed `UserId`,
  brand-string matching alone cannot tell whether B references A or C —
  ownership isn't information the IR captures anywhere, brand-based or
  otherwise.
- _(c) Minimal addition that would make it work, and where it hangs._ Given
  the IR's existing generic `meta: Record<string, unknown>` bag on every
  `TypeRef` (`index.ts`), the same "conventions over contracts" mechanism
  `meta.references`/`meta.primaryKey` already use, the missing piece is a
  single opt-in marker of ownership — e.g. generalizing `meta.primaryKey`
  outside the SQL importer so any producer (hand-written schema, OpenAPI
  extractor, whatever) can mark "this field is entity E's primary
  identifier," paired with the field's existing `meta.brand`. Once that one
  marker exists, brand-string equality genuinely does become a usable,
  low-effort relation-detection mechanism for every _other_ field sharing
  that brand — no per-relationship FK annotation required, unlike
  `meta.references` which has to be declared on every referencing field
  individually. That is a real reduction in declaration burden compared to
  the FK-metadata framing the original IR-verification section above
  considered, and it requires **no new `TypeKinds` variant and no core-IR
  relation concept** — exactly the shape of the project owner's steer: the
  toolkit would supply the convention and the utilities that read it, a
  schema author opts in by marking one id field per entity (or by already
  having brand types and layering the marker on top), and nothing about
  relation-modeling becomes mandatory or built into the IR itself.

**Net assessment: newtype/brand matching is a real, feasible mechanism, but
it is a _refinement_ of the declaration question (open question 2), not a
replacement for declaring something.** It does not let the generator infer
relations from zero extra information — that was checked directly and does
not hold, per (a)/(b) above. What it changes is _how little_ has to be
declared: one ownership marker per entity's id field, reusing brand types
schemas may well already have for other reasons, versus one FK annotation
per referencing field. Whether that's the toolkit's actual mechanism, versus
the out-of-band-config shape Family 2 prior art below uses (`@mswjs/data`/
Mirage-style hand-declared relations), is still the project owner's call —
this section narrows the design space, it doesn't close it.

## Prior art

Surveyed for how other ecosystems solve "generate fake data across a schema
graph while keeping foreign-key-shaped references consistent." The tools
split cleanly into two families by _where the relation information comes
from_, which maps directly onto the open question above.

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
  relevant precedent for the _playground backend_ use case: an in-memory,
  ORM-inspired data-modeling library meant to pair with MSW request
  handlers. Models are hand-declared with explicit `oneOf()`/`manyOf()`
  relation properties (its own take on belongsTo/hasMany), and the library
  then provides Prisma-like relational querying (`.findFirst`, nested
  `where`, populated relations) over the resulting in-memory store — i.e.
  it does not infer relations from any external schema; the relations
  _are_ the schema, hand-authored specifically for mocking purposes.
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
  etc."), but neither has any concept of a _second_ schema's data needing to
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
from an _unconstrained_ schema format (bare JSON Schema/OpenAPI/GraphQL SDL)
the way this idea would need to for non-SQL fractal sources — which is
itself useful negative evidence: if fractal wants relation-aware fabrication
for e.g. an OpenAPI-sourced tree, some explicit relation-declaration
mechanism looks necessary, not just an inference pass over existing IR data.

## The two use cases as possibly-separable capabilities

The project owner named both but did not say they must ship together or
share an implementation; laid out here as genuinely separable, per prior
art landing on different sides of a similar split:

- **Playground backend (use case 1).** Needs: a full in-memory relational
  data _store_ (generate once, keep serving consistent reads/writes across
  a session — Mirage's/`@mswjs/data`'s shape), served behind something
  `fetch`-shaped so it can plug into a UI the way `toDropInFetch` already
  plugs a real router in. Naturally long-lived per playground session
  (mutations from a "create" operation should probably be visible to a
  subsequent "list" call in the same session, the way a real backend would
  behave — Mirage's model store does this; a one-shot fabrication would
  not).
- **Runnable doc snippets (use case 2).** Needs: fabricated data that's
  _reproducible_ (the snippet in the doc and the data backing it need to
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
2. **How relations get declared.** The project owner has steered part of
   this: no dedicated relation-modeling concept goes into the core IR;
   whatever mechanism is chosen is opt-in and lives in a toolkit of
   utilities fractal ships, not a `TypeKinds` addition. Within that
   constraint, still open: generalize/formalize `from-sql.ts`'s existing
   (currently inert) `meta.references` convention across all importers and
   projectors (one FK annotation per referencing field); generalize
   `from-sql.ts`'s `meta.primaryKey` outside the SQL importer and pair it
   with the existing `meta.brand` newtype convention so brand-string
   matching does the relation-detection work (one ownership marker per
   entity's id field — see the newtype/brand follow-up section above,
   which confirmed this is feasible but still requires that one marker,
   not zero declaration); or require relations declared fully out-of-band
   the way `@mswjs/data`/Mirage JS do (a config/DSL the generator consumes,
   decoupled from `TypeRef.meta` entirely). These have different blast
   radii — the first touches every existing importer/projector that
   currently ignores `meta.references`; the brand/primaryKey option and the
   out-of-band option don't touch existing code at all, but the brand
   option only pays off for schemas that already use (or adopt) newtype
   ids, while the out-of-band option works regardless of how a schema
   types its ids.
3. **Inference vs. declaration.** Even with a declaration mechanism chosen,
   should the generator attempt to _infer_ likely relations for sources that
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
   given doc snippet need the _exact same_ fabricated values on every run
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
  parsing (currently inert; see the IR-verification section above) and
  `meta.primaryKey`, the SQL-scoped precedent the newtype/brand follow-up
  section proposes generalizing.
- `packages/type-ir/src/sql.ts` — the TypeRef→SQL projector that does _not_
  currently read `meta.references` back out; confirms the capture is
  one-way today.
- `packages/type-ir/src/kinds/semantic-strings.ts` — `uuid`/`email`/etc.
  semantically-tagged kinds a data fabricator could key sample-value
  generation off directly for the non-relational part of the problem; also
  the `Uuid`/`Uri`/`Email` `unique symbol`-brand pattern examined in the
  newtype/brand follow-up section.
- `packages/type-ir/src/from-typescript.ts` — `typeRefFromBrandedIntersection`
  (~line 822), where an arbitrary TS branded type becomes `meta.brand` on
  extraction; source of the newtype/brand follow-up section's findings.
- `docs/design/design-philosophy.md` — the open-metadata-bag-over-fixed-
  schema principle the `meta.references`-generalization option (open
  question 2) would extend rather than break from.
