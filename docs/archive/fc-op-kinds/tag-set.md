# Canonical Tag Set for the Protocol-Agnostic Operation Core

> Grounded in `projection-synthesis.md` (cross-projection matrix + agnostic key set)
> and `converged-model.md` (settled model + constraints).
>
> Provenance tags carried forward: **[CERTIFIED]** = user-stated/affirmed in
> converged-model.md; **[SYNTHESIS]** = derived from projection-synthesis.md mining;
> **[OPEN]** = unresolved.

---

## Framing: what a "tag" is (and is not)

A **tag** is an agnostic behavioral/semantic generalization of an operation — a marker
that *multiple* projections each specialize into their own surface (HTTP verb, CLI
confirm-prompt, MCP annotation hint, gRPC idempotency_level, GraphQL op type). Tags are
the generalizations that verbs/hints/etc. *fall out of*: you author the tag; the
projection-specific rendering is derived.

Tags are **one category** within a larger open metadata bag. The bag also holds:
- **Descriptive** metadata: `name`, `description` (from doc comments)
- **Structural** metadata: param optionality, param multiplicity, mount topology,
  `notFound`, input/output schema — mostly type-inferable
- **Per-projection namespaced** metadata: HTTP verb string, status codes, gRPC field
  numbers, CLI short-flag characters — only one projection reads each
- **Override/pin** metadata: explicit overrides when the inferred value is wrong
  (e.g. `#[route(method = "PUT")]`)

This document defines only the tag subset. The distinction is: a tag has *agnostic*
behavioral semantics and at least two projections independently specialize it; anything
narrower belongs in a projection namespace or the structural layer.

**[CERTIFIED]** The metadata bag is open/arbitrary. Tags are a standard library within
that bag, not a closed universe. Any consumer can define additional tags (§4).

---

## 1. The Canonical Tag Set

Tags are listed in dependency order (safer/weaker before stronger/narrower).

---

### `safe`  (alias: `readOnly`)

**Agnostic definition:** The operation produces no observable side-effects on persistent
state; calling it any number of times is equivalent to calling it once.

**Why must-be-authored:** The TS/Rust type system has no effect-system annotation
distinguishing pure reads from writes. Name-prefix heuristics (`get_`, `list_` → GET)
exist in server-less but are lossy and silent — the entire §5 of the synthesis
documents this failure mode across all five projections that encode the concept.

**Per-projection specialization:**

| Projection | Specialization |
|---|---|
| HTTP | Selects GET/HEAD verb class; safe methods are cacheable and bookmarkable (RFC 9110 §9.2.1) |
| CLI | Governs whether a `--dry-run` / preview mode would suppress the call; no confirm-prompt |
| MCP | Emitted as `annotations.readOnlyHint: true` in `ToolAnnotations` |
| gRPC | Emitted as `option idempotency_level = NO_SIDE_EFFECTS` in the RPC definition |
| GraphQL | Determines `query` op type; queries may execute in parallel (spec §6.2.1) |
| WS | No direct hint; safe ops are candidates for request/response (not push) patterns |

**Inferable or authored:** **Must-be-authored.** Partially inferable from name prefix
(the server-less heuristic), but explicitly lossy — fractal treats inference as an
overrideable default, never authoritative ([CERTIFIED] converged-model.md).

**Confidence:** HIGH — 5 of 6 projections independently encode the read/write
distinction. The sixth (WS) has no explicit hint but the semantic still applies.

---

### `idempotent`

**Agnostic definition:** Calling the operation multiple times with the same arguments
produces the same state as calling it once; repeat invocations are safe from the
caller's perspective.

**Why must-be-authored:** Idempotency is a semantic property of the operation's effect,
not visible in the return type or parameter types. `delete(id)` and `upsert(record)`
can both be idempotent despite different signatures.

**Per-projection specialization:**

| Projection | Specialization |
|---|---|
| HTTP | Selects PUT/DELETE verb class (idempotent with side effects) vs POST (not idempotent); controls retry safety in clients and load balancers |
| MCP | Emitted as `annotations.idempotentHint: true` in `ToolAnnotations` |
| gRPC | Emitted as `option idempotency_level = IDEMPOTENT` in the RPC definition |
| GraphQL | Queries are idempotent by spec convention; mutations are not (implicit — not an explicit hint) |
| CLI | Informs retry logic and scripting behavior; not yet a generated surface in server-less |
| WS | No explicit hint; idempotent ops are retryable on reconnect |

**Inferable or authored:** **Must-be-authored.** No TS/Rust effect system captures
idempotency. The gRPC `idempotency_level` field — the canonical protocol slot for this
concept — was left unset in server-less because there was no neutral place to source it
(synthesis §5).

**Confidence:** HIGH — 3 projections encode it explicitly (HTTP, MCP, gRPC); the
others have implicit or conventional treatments.

---

### `destructive`

**Agnostic definition:** The operation irrevocably destroys or removes existing state;
the effect cannot be undone by a subsequent operation without out-of-band recovery.

**Why must-be-authored:** Destructiveness is a domain judgment, not a type property.
`delete_user(id)` and `archive_user(id)` have the same signature but different
destructiveness.

**Per-projection specialization:**

| Projection | Specialization |
|---|---|
| HTTP | Selects DELETE verb; signals irreversibility to API tooling, audit logs, and gateway policy |
| CLI | Would trigger a confirmation prompt ("Are you sure? [y/N]") — noted as unimplemented in server-less because no `is_destructive` key existed to read (synthesis §5) |
| MCP | Emitted as `annotations.destructiveHint: true` in `ToolAnnotations`; lets models prompt users before execution |
| gRPC | No direct encoding; destructive semantics are informally a domain concern |
| GraphQL | No direct encoding; mutation type absorbs all writes |
| WS | No explicit hint |

**Inferable or authored:** **Must-be-authored.** Destructiveness cannot be inferred
from signature or name without domain knowledge.

**Confidence:** HIGH for the three projections that encode it (HTTP, CLI, MCP);
medium for the set being complete (gRPC and GraphQL simply don't model it at the
protocol level).

---

### `openWorld`

**Agnostic definition:** The operation may reach external systems, networks, or
resources outside the local service boundary; callers cannot assume its effects are
contained or sandboxable.

**Why must-be-authored:** External reach is an architectural fact about what the
implementation calls, invisible at the function signature.

**Per-projection specialization:**

| Projection | Specialization |
|---|---|
| MCP | Emitted as `annotations.openWorldHint: true`; lets models reason about sandboxing, permission scope, and environmental reach before invoking |
| HTTP | Informs caching policy (external calls not safely cached), rate-limiting decisions, and permission-gating; noted as a "latent need" in synthesis §1 |
| CLI | Could gate a sandbox/dry-run confirmation; no generated surface yet |
| gRPC | No encoding |
| GraphQL | No encoding |
| WS | No encoding |

**Inferable or authored:** **Must-be-authored.** External reach is determined by
implementation, not signature.

**Confidence:** WEAK — only 1 projection encodes it explicitly (MCP); HTTP encodes it
latently. The synthesis rated this as "MCP explicit + HTTP latent — 2". The tag earns
its place in the standard library because MCP's `openWorldHint` is a real emitted field
and the concept is meaningful to any projection that reasons about sandboxing, but
consumers should treat it as advisory.

---

### `streaming`

**Agnostic definition:** The operation yields a sequence of items over time rather than
a single value; the response channel carries a multiplicity of results.

**Why type-inferable:** The return type directly encodes this: `impl Stream<Item=T>` or
`impl Iterator<Item=T>` (Rust) / `AsyncIterable<T>` or `Iterable<T>` (TS). No
annotation required; a projection can read the return shape.

**Per-projection specialization:**

| Projection | Specialization |
|---|---|
| HTTP | Return type maps to SSE (`text/event-stream`) or chunked transfer encoding |
| CLI | Drives `--jsonl` line-by-line emission mode (`cli.rs:2140–2157`) |
| gRPC | Emits `stream` keyword on the response type in `.proto`; server-streaming RPC shape |
| GraphQL | Maps to `subscription` op type (spec §6.2.3) |
| WS | `is_stream` flag recognized; server pushes via `WsSender` injection (`ws.rs:945`) |
| MCP | No current spec analog; subscription semantics are a gap |

**Inferable or authored:** **Type-inferable** from the return type wrapper. This is the
one tag that requires no authoring when the return type is correct — projections detect
it directly.

**Confidence:** HIGH — 5 of 6 projections emit different surfaces for it, all derived
from the same return shape.

---

### Non-tags evaluated and rejected from the tag set

**`replace` / `partial` (PUT vs PATCH generalization):**
These are HTTP-verb-level distinctions, not agnostic behavioral facts. The converged
model explicitly certified that "the read→GET/replace→PUT/remove→DELETE/partial→PATCH
table was assistant-invented and is REJECTED" ([CERTIFIED] converged-model.md). The
full-replace vs partial-update distinction belongs in `http:` namespace as a verb
override, not in the agnostic tag set.

**`notFound` / absent-outcome:**
This is structural, not behavioral. It is type-inferable from `Option<T>` *return* (as
distinct from `Option<T>` *param*). The projection-synthesis correctly classifies it as
a structural key: HTTP → 404, CLI → exit 1 + "Not found", GraphQL → nullable null,
gRPC → NOT_FOUND status. It belongs in the structural layer of the metadata bag, not
as a tag.

---

## 2. The Implication Lattice

Tags are not independent. The following implications hold from their agnostic
definitions and propagate to projections automatically:

```
safe ⇒ idempotent
```
Rationale: an operation with no observable side-effects trivially satisfies
idempotency. HTTP GET is both safe and idempotent. A projection that needs to select
between `IDEMPOTENT` and `NO_SIDE_EFFECTS` can use safe-ness to imply idempotency
rather than requiring both assertions.

```
safe ⇒ ¬destructive
```
Rationale: an operation that destroys state produces an observable side-effect, so it
cannot be safe. The two tags are mutually exclusive by definition.

```
destructive ⇒ ¬safe
```
Directly follows from the above (contrapositive of `safe ⇒ ¬destructive`). Stated
separately to make the HTTP dispatch rule readable: safe→GET, destructive→DELETE.

```
destructive ∧ idempotent  is valid
```
Rationale: deleting a resource by id is both destructive (irreversibly removes state)
and idempotent (deleting an already-deleted resource leaves the same state). HTTP DELETE
is the canonical example. Authors may assert both; neither tag implies the other.

```
streaming is orthogonal to all above
```
Streaming is a cardinality property of the output channel, not a side-effect property.
`streaming ∧ safe` (a streaming read) and `streaming ∧ ¬safe` (streaming a mutation's
progress) are both valid combinations.

```
openWorld is orthogonal to all above
```
External reach is an architectural fact independent of idempotency, safety, or
destructiveness. A safe read can be openWorld (fetching from an external API); a
destructive write can be intra-service.

### Projection dispatch rules (derived from lattice)

These rules let a projection decide its surface from the tag set without ad-hoc
branching:

**HTTP verb selection:**
```
safe            → GET / HEAD
idempotent ∧ ¬safe ∧ destructive  → DELETE
idempotent ∧ ¬safe ∧ ¬destructive → PUT
¬idempotent                        → POST
(no tag asserted)                  → POST (conservative default)
```

**gRPC idempotency_level:**
```
safe       → NO_SIDE_EFFECTS
idempotent → IDEMPOTENT
(neither)  → (omitted, default UNKNOWN)
```

**GraphQL op type:**
```
safe  → query
¬safe → mutation
streaming → subscription (orthogonal; can combine with safe/¬safe)
```

---

## 3. Tag vs Non-Tag Metadata Taxonomy

The open metadata bag on every op contains:

| Category | What it holds | Source | Examples |
|---|---|---|---|
| **Tags** (this document) | Agnostic behavioral/semantic properties; ≥2 projections specialize them | Must-be-authored (except `streaming`) | `safe`, `idempotent`, `destructive`, `openWorld`, `streaming` |
| **Descriptive** | Human-readable identification | Type-inferable from method ident + doc comments | `name` (from method name), `description` (from `///` / JSDoc) |
| **Structural** | Input/output shape, cardinality, presence, tree topology | Type-inferable from parameter and return types | `param.optional` (`Option<T>`), `param.multiple` (`Vec<T>`), `mount` (`&T` return), `notFound` (`Option<T>` return), `inputSchema`, `outputSchema` |
| **Per-projection namespaced** | One projection reads, others ignore; not lifted to agnostic core | Must-be-authored; override via projection namespace | `http.verb`, `http.path`, `http.statusCode`, `grpc.fieldNumbers`, `cli.shortFlag`, `mcp.title`, `ws.path` |
| **Override/pin** | Explicit corrections where inference is wrong or insufficient | Must-be-authored | `#[route(method = "PUT")]`, `#[param(name = "user_id")]` |

**Decision rule for "is this a tag?":**
A candidate is a tag if and only if:
1. It is a behavioral or semantic property of the operation (not a type shape or wire-format detail), AND
2. At least two projections independently encode it in their surface (≥2 from the synthesis matrix), AND
3. It cannot be reliably inferred from the TS/Rust type system alone (except `streaming`).

If a candidate fails test (2), it belongs in a projection namespace. If it fails test
(3) but passes the others, it is a structural key, not a tag.

---

## 4. Openness — Defining a New Tag

The mechanism must allow a consumer to introduce a new tag and wire projections to
specialize it, without editing the fractal core. This follows directly from
[CERTIFIED] converged-model.md: "the operation-characterization is ARBITRARY METADATA.
An op is a function carrying an open metadata bag; each protocol PROJECTION reads the
keys it recognizes and ignores the rest."

### Declaring a new tag

A tag is just a key in the metadata bag. No registration in core is needed — the bag
is a plain object:

```ts
// consumer defines a new behavioral tag
const cacheable = Symbol("cacheable");  // or a plain string key

// author it on an op
const getUser = defineOp(
  async (id: string): Promise<User> => { /* ... */ },
  {
    safe: true,
    idempotent: true,       // implied by safe, but explicit is fine
    [cacheable]: {
      ttl: 60,              // seconds; tag carries structured metadata
      varyOn: ["id"],
    },
  }
);
```

### Writing a projection that reads the new tag

A projection is a pure function `(opTree, metadata, types) => surface`. It reads
the keys it knows and ignores the rest:

```ts
// consumer writes a CDN-config projection
function httpCacheProjection(op: Op): CacheDirective | null {
  const cfg = op.metadata[cacheable];
  if (!cfg) return null;
  return {
    "Cache-Control": `public, max-age=${cfg.ttl}`,
    "Vary": cfg.varyOn.join(", "),
  };
}

// compose with the standard HTTP projection — core projection is unmodified
function myHttpProjection(op: Op): RouteConfig {
  const base = standardHttpProjection(op);       // core, reads safe/idempotent/etc.
  const cacheHeader = httpCacheProjection(op);   // consumer extension, reads cacheable
  return { ...base, extraHeaders: cacheHeader ?? {} };
}
```

Core projections silently skip unknown keys. The consumer's `cacheable` tag is invisible
to gRPC, CLI, GraphQL, and WS projections unless those projections also import and read
`httpCacheProjection`. This is the intended behavior: a new tag composes into exactly
the projections its author wires it into, with zero impact on the rest.

### Symbol vs string keys

String keys risk collision across consumers. Symbol keys (or namespaced strings like
`"acme:cacheable"`) guarantee isolation. The canonical tags (`safe`, `idempotent`,
`destructive`, `openWorld`, `streaming`) use plain strings because they are the shared
standard library; consumer-defined tags should prefer namespaced strings or symbols.

---

## Summary

**Canonical tag set (5 tags):**

| Tag | Agnostic definition | Inferable? | Projections | Confidence |
|---|---|---|---|---|
| `safe` | No observable side-effects | Must-be-authored (name prefix is lossy heuristic) | HTTP (GET), CLI (no confirm), MCP (`readOnlyHint`), gRPC (`NO_SIDE_EFFECTS`), GraphQL (`query`) | HIGH (5/6) |
| `idempotent` | Repeat calls leave identical state | Must-be-authored | HTTP (PUT/DELETE), MCP (`idempotentHint`), gRPC (`IDEMPOTENT`) | HIGH (3 explicit) |
| `destructive` | Irrevocably removes state | Must-be-authored | HTTP (DELETE), CLI (confirm-prompt), MCP (`destructiveHint`) | HIGH (3 explicit) |
| `openWorld` | May reach external systems | Must-be-authored | MCP (`openWorldHint`), HTTP (caching/gating, latent) | WEAK (1 explicit + 1 latent) |
| `streaming` | Yields item sequence over time | Type-inferable (`Stream`/`AsyncIterable` return) | HTTP (SSE), CLI (`--jsonl`), gRPC (server-streaming), GraphQL (`subscription`), WS (push) | HIGH (5/6) |

**Rejected from tag set:** `replace`/`partial` (HTTP-verb taxonomy, [CERTIFIED]
rejected); `notFound` (structural, type-inferable from `Option<T>` return).

**Implication lattice:** `safe ⇒ idempotent`; `safe ⇒ ¬destructive`; `destructive ⇒ ¬safe`; `destructive ∧ idempotent` is valid; `streaming` and `openWorld` are orthogonal to all.

**Openness:** new tags are plain keys in the open metadata bag; projections are pure
functions that read known keys and skip unknown ones; no core edits required.

---

*Grounded in `projection-synthesis.md` (matrix §1, behavioral keys §2.1, gaps §5) and
`converged-model.md` (arbitrary-metadata [CERTIFIED]; verb-taxonomy rejection [CERTIFIED]).*
