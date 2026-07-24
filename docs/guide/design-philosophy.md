# Design Philosophy

Biases, not mandates — the default direction to lean, with reasoning. Violate with cause.

The full source (including entries not yet summarized for the public guide) lives at [`docs/design/design-philosophy.md`](https://github.com/rhi-zone/fractal/blob/master/docs/design/design-philosophy.md) in the repo.

### Extensible DU + interpreter pattern

The recurring structural pattern: an augmentable TypeScript interface produces a discriminated union; interpreters (projections) handle the variants they recognize. Used for dispatch kinds, type IR nodes, and anywhere a closed set would force core changes for extension.

Why: closed unions require modifying the core to extend. Augmentable interfaces let consumers add variants at their own site. Collision is impossible by construction (interface keys are unique). The interpreter only needs to handle the variants it cares about.

### Open metadata bag over fixed schema

Metadata on nodes (routing, type IR, operations) is an open bag — a plain object with conventional keys. Projections read what they recognize, ignore the rest. No fixed axes, no blessed set of fields.

Why: fixed schemas require predicting all consumers upfront. An open bag lets new projections introduce new metadata keys without modifying the core. Conventions emerge from use, not from design-time enumeration. (Precedent: JSON Schema's unknown-keyword-ignored, JTD's `metadata` keyword, protobuf custom options, GraphQL directives — independently arrived at across systems.)

### Conventions, not contracts

Where the metadata bag has expected keys (`nullable`, `optional`, `default`, constraints), these are conventions — documented, tested, but not enforced by the IR. If you violate conventions, no guarantees it works. No fixed spec.

Why: contracts require the IR to understand every consumer's needs. Conventions let the IR stay small and stable while projections evolve independently.

### Hierarchy via subtyping, not taxonomy

Type hierarchies reflect actual subtyping relationships between concrete types (`int32` → `integer` → `number`, `uuid` → `string`, `timestamptz` → `timestamp`). No intermediate taxonomic categories (Scalar, Composite) unless a specific projection would use them as a fallback target.

Why: taxonomic superclasses add structure no one matches on. Subtyping hierarchies give projections a natural fallback — walk up to the nearest type you understand. Every node in the hierarchy is a valid fallback target. (Precedent: Avro's logical-type fallback is spec-mandated and works this way.)

### Three independent layers

1. **Combinators** — compose routing/API functionality. The authoring surface.
2. **Constructors / DU** — produce the serializable, inspectable expression data.
3. **Interpreters / projections** — consume the DU to produce surfaces.

These are independent. Combinators don't know which projections exist. Projections don't know which combinators produced the DU. The DU is the contract between them.

### Three consumption paths from one authoring surface

1. Direct composition of combinators (closures, opaque, simplest).
2. DU + dynamic interpreter (inspectable at runtime, no build step).
3. DU + codegen'd evaluator (build step reads DU as input, emits optimized code).

Which path is a deployment choice, not an authoring-time fork.

### Type projection is separate from routing

Routing (API structure) and type projection (data shapes) are independent concerns. Routing uses the routing DU (`Node`/`Meta` in `@rhi-zone/fractal-api-tree`). Type projection uses the type IR (`TypeRef` in `@rhi-zone/fractal-type-ir`). Both use the same structural patterns (extensible DU, open metadata, interpreter/projection) but operate on different data.

### Spec references in projector source code

Projector code (the generators, not their output) cites the relevant standard/dialect spec sections it implements. Makes projectors auditable and verifiable — critical when LLMs write or modify projection code.

Why: LLMs are unreliable. Inline spec references let anyone (human or LLM) verify the projector against the standard without hunting for the right spec section.

### Routing is the API structure

Routing is not an HTTP concept. It is the navigable structure of typed functions that IS the API. HTTP paths, CLI subcommands, MCP tool names are all projections of the same routing structure. The value of typed, composable routing (vs stringly-typed incumbents) is that multi-surface projection costs near-zero — if routing isn't encoded in HTTP path strings, it's already not HTTP-specific.
