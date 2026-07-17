# Operation layer design — first-principles analysis

Status: design draft, not settled. Presents tradeoffs for the author to decide.

This document works through the operation layer from first principles, grounded
in what's actually built and what the consumer-app evidence requires. It does
NOT restate the requirements (see `operation-layer-spec.md` for those) — it
analyzes the structural questions that must be answered before implementation.

---

## 1. Identity — settled

Fractal is a codebase compression substrate. It gives codebases a skeleton —
the central structure supporting the entire app — as a single source of truth,
with everything else derived from it.

The "Parsec-style combinator composition" label was aspirational naming that
didn't match the built code. The actual pattern across the routing tree AND
the type IR: inspectable declarations (data) interpreted by projectors to
produce surfaces. The built code (`op`/`node`/`service` producing inspectable
data, 21 type-ir projectors interpreting `TypeRef`) already implements this
identity.

The "combinator identity gap" was a symptom of unclear self-description, not
a structural deficiency. The routing-expression-model.md's proposed primitives
(`match`/`consume`/`capture`) map onto existing Node features:

| Proposed primitive | Existing realization |
|--------------------|---------------------|
| `consume(segment, next)` | `children[key]` — keyed dispatch on path segment |
| `capture(name, next)` | `fallback: { name, subtree }` — wildcard capture |
| `match(accessor, cases)` | `children` + `meta.http.dispatch: DispatchMarker` |
| `pipe(f, g)` | `compose()` in `packages/api-tree` |
| `alt(f, g)` | Multiple candidates from `candidatesForUrl()` |

**What this means for the operation layer**: an operation declaration is another
aspect of the skeleton — the single source of truth about what an operation IS.
Routes, auth checks, audit calls, admin UI actions, error mappings are all
projections of that truth.

The remaining structural question is whether Node is expressive enough as the
skeleton's expression type, or whether it needs new variants (§2).

---

## 2. `match` — structural or interpretive?

Currently, method dispatch uses a branch node whose children are method names,
with `meta.http.dispatch: { kind: "method" }` telling the HTTP projector to
interpret children as method cases instead of path segments. This works but
has a cost: the expression itself doesn't distinguish "these children are path
segments" from "these children are match cases" — only the projector knows,
by reading metadata.

**Option 2A: match is metadata (current design)**

```typescript
node({
  children: { GET: op(getUser), POST: op(createUser) },
  meta: { http: { dispatch: { kind: "method" } } }
})
```

- Pro: simpler Node type, fewer variants to handle
- Pro: match semantics are always projection-specific anyway
- Con: expression is ambiguous without reading metadata
- Con: non-HTTP projectors can't distinguish path segments from match cases
  without knowing about `meta.http.dispatch`

**Option 2B: match is structural (new Node field)**

```typescript
// Node gains a `match` field
type Node = {
  handler?: Handler
  children?: Record<string, Node>       // path segments (keyed dispatch)
  fallback?: { name: string; subtree: Node }  // wildcard capture
  match?: { on: string; cases: Record<string, Node> }  // case analysis
  meta: Meta
}

// Usage — accessor is protocol-agnostic
node({
  match: { on: "method", cases: { GET: op(getUser), POST: op(createUser) } }
})
```

- Pro: expression is unambiguous — `children` is always path segments,
  `match.cases` is always case analysis
- Pro: protocol-agnostic — `on: "method"` is interpreted by each projector
  (HTTP reads HTTP method, CLI reads subcommand verb, etc.)
- Pro: projectors don't need to detect DispatchMarker to understand the tree
  structure
- Con: more complex Node type
- Con: `on` accessor needs its own extensibility model (what values are valid?)

**Option 2C: match is a DU variant (Node becomes a discriminated union)**

```typescript
type Expr =
  | { kind: "handler"; fn: Handler; meta: Meta }
  | { kind: "branch"; children: Record<string, Expr>; fallback?: ...; meta: Meta }
  | { kind: "match"; on: string; cases: Record<string, Expr>; meta: Meta }
```

- Pro: cleanest separation — each variant has exactly the fields it needs
- Pro: exhaustive pattern matching in projectors
- Con: breaking change to all existing code
- Con: the existing Node shape works, and the DU might be over-engineering

**Observation**: Option 2B is the minimal structural change. Option 2C is the
principled version but costs a full rewrite. Option 2A works today but makes
the expression opaque to non-HTTP projectors.

---

## 3. Operations are nodes with conventional metadata

The operation-layer-spec documents 10 capabilities. The question is: does
"operation" need its own type, or is it a Node leaf with rich metadata?

**Argument for a separate Operation type:**
- Operations have richer semantics than a bare Node leaf
- A typed Operation could provide structure guarantees
- Operations might exist outside routing trees (batch jobs, event handlers)

**Argument for operations-as-nodes:**
- Consistent with "open metadata bag over fixed schema" (CLAUDE.md)
- Consistent with how type-ir works — TypeRef.meta can be arbitrarily complex
- A Node without children/fallback is already `{ handler, meta }` — works
  outside a tree
- Projectors already walk nodes — no new mechanism needed
- No fixed schema means new operation concerns (new projectors) add their own
  meta keys without touching the core

**The type-ir precedent**: TypeRef.meta carries `nullable`, `optional`,
`description`, `deprecated`, `default`, `brand`, `discriminator`,
`constraints` (min/max/pattern/exclusive bounds) — all as conventions, not
a fixed schema. 21 projectors read what they recognize, ignore the rest.
This works at scale.

**Decision point B**: separate Operation type, or operations-as-nodes with
conventional metadata keys? The analysis favors nodes-with-metadata (consistency
with the existing pattern), but a separate type would give compile-time
structure guarantees.

---

## 4. Metadata namespace conventions

If operations are nodes with metadata (§3), the 10 capabilities from the spec
need namespace conventions. The key split: operation-level metadata (portable
across projections) vs projection-specific metadata.

**Operation-level (meta.op.\*) — any projector might use:**

| Key | Shape | Source in spec |
|-----|-------|---------------|
| `meta.op.name` | `string` | §1.1 — operation identity |
| `meta.op.entity` | `string` | §1.1 — owning entity |
| `meta.op.auth` | `AuthSpec` | §6 — scope/role + relational guards |
| `meta.op.audit` | `AuditSpec` | §7 — action/entity/payload sources |
| `meta.op.sideEffects` | `SideEffect[]` | §8 — events, cache, session |
| `meta.op.sessionInput` | `Record<string, Source>` | §5 — session-derived fields |

**Type-level (already exists as TypeRef):**

| Key | Shape | Source in spec |
|-----|-------|---------------|
| `meta.input` | `TypeRef` | §1.2 — input type |
| `meta.output` | `TypeRef` | §1.2 — output type |

**HTTP-projection (meta.http.\*) — HTTP projector only:**

| Key | Shape | Source in spec |
|-----|-------|---------------|
| `meta.http.verb` | `string` | §4 — HTTP method |
| `meta.http.path` | `string` | §4 — path override |
| `meta.http.status` | `number` | §4 — success status |
| `meta.http.errorMap` | `Record<string, number>` | §10 — error→status |

**UI-projection (meta.ui.\*) — admin/client UI projector:**

| Key | Shape | Source in spec |
|-----|-------|---------------|
| `meta.ui.label` | `string` | §9 — display label |
| `meta.ui.confirm` | `string \| boolean` | §9 — confirmation prompt |
| `meta.ui.enabledExpr` | `string` | §9 — conditional enable |
| `meta.ui.fixedInput` | `Record<string, unknown>` | §9 — pre-filled fields |

This namespacing falls out of the "which projector reads it" question.
Operation-level metadata is cross-cutting (auth is enforced by HTTP, CLI,
and MCP projectors alike). Projection-specific metadata is ignored by
unrelated projectors.

---

## 5. Handler error model

The spec describes handlers that throw typed errors with error codes, plus an
errorMap that maps codes to HTTP statuses. The existing core has `Result<T, E>`
with `ok`/`err`/`map`/`bind`. The guardrails say "don't use Kleisli-as-base —
base is T => U + compose."

**Option 5A: handlers throw, errorMap translates**

```typescript
// Handler
async function createLocation(input: CreateInput): Promise<Location> {
  if (duplicate) throw new OpError("LOCATION_DUPLICATE")
  return location
}
// Metadata
meta.http.errorMap = { LOCATION_DUPLICATE: 409 }
```

- Pro: simplest for handler authors — no monadic ceremony
- Pro: consistent with the guardrail (base is `T => U`)
- Pro: matches the consumer app's existing pattern
- Con: errors are invisible to the type system (throws are untyped in TS)
- Con: errorMap can't be verified against actual throw sites at compile time

**Option 5B: handlers return Result, errorMap translates**

```typescript
async function createLocation(input: CreateInput): Promise<Result<Location, OpError>> {
  if (duplicate) return err({ code: "LOCATION_DUPLICATE" })
  return ok(location)
}
```

- Pro: errors are typed — the type system tracks them
- Pro: errorMap can be verified against the Result's error type
- Con: monadic ceremony for handler authors (every return is `ok(...)`)
- Con: guardrails explicitly caution against Kleisli-as-base

**Option 5C: both valid, projector handles either**

```typescript
// Projector normalizes: if handler returns Result, use it; if it throws, catch
type HandlerResult<O, E> = O | Result<O, E>
```

- Pro: handler authors choose their style
- Con: two paths through the projector — more complexity, more edge cases
- Con: ambiguous API surface — "which style should I use?" has no answer

**Observation**: the guardrail leans toward 5A. The consumer app already uses
throws. But 5B's type safety is real. This is a genuine tradeoff the author
should decide.

---

## 6. What this means for the expression model

If the analysis above holds, the routing-expression-model.md's proposed
primitives are already realized (§1 table), with one possible structural
addition (`match`, §2). The "operation layer" is not a new layer — it's
metadata conventions on leaf nodes, interpreted by projectors.

**Implications:**

1. No new expression type is needed (unless §2 decision goes to 2B or 2C).
2. The "combinator identity" is better stated as "inspectable routing
   expressions + interpreters" than "Parsec-style combinators." The
   composition style is structural (nesting), not functional (`>>=`). This
   isn't a deficiency — it's a deliberate choice that enables inspection.
3. Builder functions (ergonomic helpers for setting operation metadata) are
   useful but not structurally necessary:
   ```typescript
   // Ergonomic builder — sugar over op() + meta
   const createLocation = operation({
     name: "createLocation",
     entity: "location",
     input: types.object({ name: types.string, ... }),
     output: locationTypeRef,
     handler: createLocationHandler,
     auth: { scope: "locations:write" },
     audit: { action: "create", entity: "location" },
     http: { verb: "POST", status: 201 },
   })
   // Desugars to: op(handler, { op: { name, entity, auth, audit }, http: {...}, input, output })
   ```
4. Projector updates are the real work — each projector needs to interpret the
   new metadata keys. But this is incremental (one projector at a time) and
   follows the exact pattern the 21 type-ir projectors already use.

---

## 7. Open questions for the author

Ordered by dependency (earlier decisions gate later ones):

1. **§2 — `match` structural vs interpretive**: Does Node need a `match` field
   (2B), or is the current metadata-based dispatch (2A) sufficient? This
   affects whether Node's shape changes.

2. **§3 — Operations as nodes vs separate type**: Does the open-metadata-bag
   pattern extend to operations, or do operations earn their own type?

3. **§5 — Handler error model**: throws (5A), Result (5B), or both (5C)?
   The guardrails lean toward 5A; type safety leans toward 5B.

4. **§1 — Combinator identity naming**: Should the constructors be renamed/
   aliased to make the combinator nature explicit (`consume`/`capture`/`match`
   alongside or instead of `node`/`op`), or is the current naming fine?

5. **Builder API shape**: If operations are nodes-with-metadata, should there
   be an `operation()` builder (§6 example), or is `op()` + explicit meta
   sufficient?

6. **The "is `service()` an operation factory" question**: `service()` reflects
   class methods into leaf nodes. It already accepts per-method meta via
   `opts.meta`. Is this sufficient for operation metadata, or does the
   reflection need to be smarter (e.g., reading decorators, inferring
   operation identity from method names)?
