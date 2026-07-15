# Handoff — 2026-07-16

## What happened this session

Design session covering value prop, architecture layers, type IR design, and
prior art research.

### Settled

1. **Value prop: typed, composable routing (not stringly-typed).** Every
   incumbent uses `app.get('/users/:id', handler)` — route structure encoded
   in strings. Fractal makes routing typed and composable. Multi-surface
   projection (HTTP, CLI, MCP, OpenAPI, SDK) is a natural consequence, not
   the primary differentiator.

2. **Routing IS the API structure.** Routing is not an HTTP concept. It's
   the navigable structure of typed functions that IS the API. HTTP paths,
   CLI subcommands, MCP tool names are projections of the same structure.

3. **Three architecture layers (independent):** Combinators (compose
   functionality, authoring surface), Constructors/DU (produce inspectable
   expression data), Interpreters/projections (consume DU to produce
   surfaces). Each independent of the others. The DU is the contract.

4. **Three consumption paths from one authoring surface:** Direct
   composition (closures, opaque), DU + dynamic interpreter (runtime, no
   build step), DU + codegen'd evaluator (build step reads DU, emits
   optimized code).

5. **Two authoring surfaces, both first-class:** Combinator tree (explicit
   composition) and zero-ceremony bare functions (build step derives
   everything). These don't conflict — the build step emits combinator
   expressions. Two mental models is fine; conflicting mental models is not.

6. **Type projection is separate from routing.** Types are not APIs. The
   routing DU handles API structure. Type projection handles data shapes.
   Same structural patterns (extensible DU, open metadata, interpreters) but
   different data.

7. **Type IR design: shape + metadata.**
   - Shape: extensible type hierarchy via subtyping (not taxonomy). `int32`
     → `integer` → `number`. No intermediate categories unless a projection
     would use them as fallback targets.
   - Metadata: open bag on every type node. Presence, direction, constraints
     — all conventional keys, not fixed axes. Conventions, not contracts.
   - Superset of all targets (target set is open). Richer than TypeScript.
   - Fallback via hierarchy (Avro precedent). No blessed organizing
     principle.

8. **Extensible DU + interpreter as the recurring pattern.** Augmentable
   TypeScript interface → discriminated union. Used for dispatch kinds, type
   IR, and anywhere a closed set would force core changes. Documented in
   CLAUDE.md as design philosophy.

9. **Open metadata bag over fixed schema.** Metadata is conventional keys on
   a plain object. No fixed spec. Documented in CLAUDE.md.

10. **Spec references in projector source code.** Projector code cites the
    spec sections it implements. LLMs are unreliable; inline references make
    projectors auditable.

11. **Build step uses TS Compiler API directly (standalone program), not
    ts-patch/compiler-plugin.** Avoids typia's fragility.

12. **Fractal avoids incumbent pain points by construction:** no live type
    inference (no editor perf cliff), no OpenAPI codegen for clients (no
    generated-file-correctness cliff), can support both throw and return
    error conventions, cache invalidation is composable and orthogonal.

### Open threads (carried forward, updated)

1. **Combinator primitives** — still open. The product question. What are
   the actual combinators? (Carried forward from previous session.)
2. **Concrete type hierarchy** — the shape axis of the type IR needs actual
   types and subtyping relationships sketched out. Survey is done
   (type-ir-survey.md), design principles settled, but the concrete
   hierarchy isn't built yet.
3. **Input extraction design** — carried forward. Now understood as
   metadata conventions on the type IR, but the specifics aren't designed.
4. **Output formatting design** — carried forward.
5. **Protocol behavior layer** (HEAD/OPTIONS/405/CORS) — carried forward.
6. **Tag-to-verb derivation soundness** — carried forward. Still leaky.
7. **Context accumulation at the type level** — carried forward.
8. **The built code doesn't match the combinator identity.** Current code
   is `node/op/service/param` (data-structure construction), not
   Parsec-style combinator composition. The expression model was supposed
   to bridge this but isn't implemented.
9. **Principled capability boundary** — carried forward.
10. **Design backlog #2-#10** from TODO.md — carried forward.

## Read order

1. `CLAUDE.md` — design philosophy (biases with reasoning), hard
   constraints, disposition
2. `docs/design/invariants.md` — authoritative constraints (wins on
   conflict)
3. `docs/design/architecture-layers.md` — layers, consumption paths,
   authoring surfaces, type IR, value prop
4. `docs/design/routing-expression-model.md` — expression model, pipeline,
   zero-ceremony
5. `docs/design/type-ir-survey.md` — survey of 12 type systems, synthesis
6. `docs/design/prior-art/` — tRPC, Effect, Hono, Elysia, server-less,
   zero-ceremony-ts, capnp-design-rationale, dx-pain-* files
7. `docs/design/router-model.md` — node shape, dispatch
8. `docs/design/dispatch-extensibility.md` — DU + dictionary
9. `TODO.md` — open threads, backlog
10. This file — session context

## Key files changed this session

- `CLAUDE.md` — added Design Philosophy section (9 biases with reasoning)
- `docs/design/architecture-layers.md` (NEW) — layers, consumption paths,
  authoring surfaces, type IR design, value prop
- `docs/design/type-ir-survey.md` (NEW) — survey of 12 type systems with
  synthesis
- `docs/design/prior-art/capnp-design-rationale.md` (NEW) — Cap'n Proto
  design decisions and rationale
- `docs/design/prior-art/dx-pain-trpc.md` (NEW) — tRPC DX pain points
- `docs/design/prior-art/dx-pain-hono.md` (NEW) — Hono DX pain points
- `docs/design/prior-art/dx-pain-elysia.md` (NEW) — Elysia DX pain points
- `docs/design/prior-art/dx-pain-express-fastify.md` (NEW) — Express/Fastify
  DX pain points
- `docs/design/prior-art/dx-pain-typia.md` (NEW) — Typia mechanism and DX
  pain points
- `docs/design/prior-art/dx-pain-rpc-clients.md` (NEW) — cross-ecosystem RPC
  client pain
- `docs/design/handoff.md` — this file (updated)
