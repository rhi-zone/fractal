# Architecture layers

> **Provenance:** Design session 2026-07-14.

---

## Three independent layers

The system separates into three layers that don't depend on each other's
internals:

1. **Combinators** — compose routing functionality. Take routers, produce
   routers (Parsec-style). This is the authoring surface. The combinators
   ARE the library — maximally unopinionated, combinator-based, the same
   relationship Parsec has to parsing.

2. **Constructors / DU** — constructors produce DU variants: data describing
   routing steps. The DU is the serializable, inspectable representation of
   a routing expression. Constructors produce the DU; combinators compose
   functionality on top of it.

3. **Interpreter / projection layer** — consumes the DU to produce surfaces:
   HTTP dispatch, OpenAPI enumeration, MCP tools, CLI, SDK. Independent of
   the combinator layer. The relationship is analogous to serde's
   ser/de split — the data model (DU) is the contract, serializers
   (projections) are independent implementations against that contract.

Each layer can be reasoned about, tested, and changed without the others.
Combinators don't need to know which projections exist; projections don't
need to know which combinators produced the DU they're walking.

---

## Three consumption paths

The same combinator authoring surface supports three distinct paths to a
running system:

1. **Direct composition of combinators** — closures, opaque. No DU involved.
   Simplest path; no inspectability, no enumeration-based projections
   (OpenAPI, CLI help) available.

2. **DU + dynamic interpreter** — combinators produce DU, an interpreter
   walks it at runtime. Inspectable at runtime; no build step needed.

3. **DU + codegen'd evaluator** — a build step reads the DU (the input to
   codegen) and emits optimized code. The DU is not present in the output —
   it was never itself codegen'd, it is the input that codegen consumes to
   produce something else.

All three paths start from the same combinator expressions. Which path is
used is a deployment/optimization choice, not an authoring-time fork.

---

## Two authoring surfaces, both first-class

The design supports two authoring surfaces. Neither is second-class:

- **Combinator tree** — explicit routing composition via combinators.
- **Zero-ceremony bare functions** — function signature + name + JSDoc; a
  build step derives everything else.

These are two separate mental models for arriving at the same underlying
DU/expression. Having two mental models is fine. What is not fine is the
two models *conflicting* — each surface needs its own self-contained,
consistent story that does not contradict the other. Cross-checking the two
surfaces against each other is a validity requirement, not a nice-to-have.

---

## Prior art positioning

Fractal's approach avoids the main pain points identified in the prior-art
survey (`docs/design/prior-art/`) of existing typed clients and frameworks:

- **No live type inference** → no editor performance cliff. tRPC, Elysia,
  and Hono all degrade at scale because client types are inferred live from
  the server's route tree; fractal's build step precomputes rather than
  leaning on live inference.
- **No OpenAPI codegen for clients** → no generated-file-correctness cliff.
  Generated client files drift from spec or require regeneration discipline;
  fractal's DU-driven projection avoids that class of problem.
- **Can support both throw and return error conventions**, since fractal
  controls client generation end to end rather than adapting to a fixed
  convention baked into a third-party codegen tool.
- **Cache invalidation is composable and orthogonal to client generation** —
  not entangled with how the client is produced.
- **Build-step approach uses the TS Compiler API directly** (a standalone
  program), not `ts-patch` or a compiler-plugin hook. This avoids the
  fragility documented for typia (`docs/design/prior-art/dx-pain-typia.md`),
  where compiler-plugin integration is a persistent source of breakage
  across TypeScript versions.

---

## Type projection layer (separate from routing)

Types are not APIs. The routing DU/combinators handle API structure (how
requests find handlers). Type projection is a separate concern: deriving
data-layer artifacts from TypeScript types.

Fractal already does type projection — `schemaFromType` in fractal-codegen
derives JSON schemas from TS function parameter types for MCP input schemas.
A valibot codegen spike also exists. This is not new scope; it's recognizing
an existing capability as a deliberate, first-class concern.

### Type IR

The TS Compiler API's `ts.Type` is the input but not a suitable
intermediate:
- Not serializable (tied to a live `Program` instance)
- Version-coupled to TypeScript internals
- Full complexity of TS's type system

A fractal-owned type IR sits between `ts.Type` (input) and projections
(consumers). One translation from `ts.Type` to the IR; N projections from
the IR.

Design principles for the IR:

- **Extensible hierarchy, not flat, not closed.** Type constructors form a
  hierarchy (e.g. `int32` is a kind of `integer` which is a kind of
  `number`). The hierarchy is extensible — projections can introduce type
  concepts the core doesn't know about.
- **Fallback via hierarchy.** A projection that doesn't recognize a type
  walks up the hierarchy to the nearest known ancestor. No explicit fallback
  mapping needed; the hierarchy IS the fallback.
- **No blessed organizing principle.** The IR doesn't commit to a theory of
  which type concepts are first-class. Refinements, readonly markers,
  effects, linearity — whatever concepts projections need, they add. None
  is special.
- **Superset of all targets.** The IR should be able to represent anything
  any target needs, so projections are always narrowing (dropping what they
  can't express), never guessing (inventing what the IR didn't capture).
  The target set is open — the IR can't be designed by surveying a fixed
  list of targets.
- **Richer than TypeScript.** TS is one input, not the upper bound. SQL has
  numeric precision (decimal(10,2)), temporal types (timestamptz,
  interval), binary types (bytea), domain-specific types (geometry, cidr).
  The IR must be able to represent these.

A type system survey across JSON Schema, JTD, serde, TypeScript,
OCaml/ReasonML, Haskell, protobuf, SQL dialects, GraphQL, Cap'n Proto,
Avro, and Valibot/Zod/TypeBox is in progress — see
`docs/design/type-ir-survey.md` (when complete).

### SQL dialect projections

SQL has no single dialect. PostgreSQL, MySQL, SQLite each get their own
projector — same pattern as HTTP vs CLI vs MCP for the routing layer. One
type IR, N dialect interpreters.

### Spec references in projector code

Projector source code (the generators themselves, not their output) must
cite the relevant standard/dialect spec sections they implement. This makes
projectors auditable and verifiable — critical when LLMs may write or
modify projection code.

---

## Current assessment

**Fractal the router** — the combinator-based routing layer — is still not
fully designed. The combinator primitives are unsettled. The core question
("combinators for what") resolves to: combinators for composing typed
functions into a navigable structure (routing IS the API structure). But
the concrete design of those combinators is open.

**Fractal the type projection layer** is more tractable for now. The
infrastructure partially exists (codegen, TS Compiler API integration). The
path forward is: design a proper type IR, then build projections from it.

---

## Value prop (clarified)

The primary value is **typed, composable routing** — not stringly typed
like every incumbent (`app.get('/users/:id', handler)`). The route
structure is in the code, not in strings. No composition, no type safety on
the structure itself in incumbents.

Multi-surface projection (HTTP, CLI, MCP, OpenAPI, SDK) is a **natural
consequence** of not coupling routing to one protocol's string format — not
the primary differentiator. If routing isn't encoded in HTTP path strings,
it's already not HTTP-specific, and multi-surface projection costs
near-zero.

The cost of doing routing the incumbent way (stringly-typed, HTTP-specific)
is a full rewrite per surface. The cost of doing it right (typed,
composable) is near-zero for multi-surface.
