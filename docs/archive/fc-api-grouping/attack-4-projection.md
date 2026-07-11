# Attack 4 — HTTP/CLI projection forces a forbidden second source of truth

*Red-team of `design.md` §0, §3.3, §4.4. Posture: broken by default; prove it.
Target claim (§0, §3.3): "carrier + ops is the protocol-agnostic truth. HTTP/CLI are
computed FROM a carrier, downstream, never authored per-surface"; the mapping is
**verb-kind → method** (`make`→POST, `op`→PATCH, `read`→GET), "no per-op HTTP
annotation is ever needed, and nothing HTTP-shaped can flow back." Guardrail #1/#3
forbid a surface-shaped second source of truth.*

The design's own §4.4 concedes this is the soft spot but treats it as "coarse, likely
survives only the demo." That undersells it. The taxonomy is not merely coarse — it is
the **wrong shape**, and two of its failures are unfixable by a bigger override table.

---

## The spine: an information-theoretic impossibility

The projector's only inputs are (role, TS types, JSDoc). Role carries
`log2(3) ≈ 1.58` bits. The HTTP endpoint it must emit is a joint choice over at least:

| free variable | values | in role? | in types? |
|---|---|---|---|
| method | GET/POST/PUT/PATCH/DELETE | partial | no |
| idempotency (retry-safety) | yes/no | **no** | **no** |
| success status | 200/201/202/204 | partial | no |
| path shape / nesting order | flat / nested-N | no | **no** |
| body transport | query / json / multipart | no | partial |
| cacheability (ETag/max-age) | volatile / cacheable | no | no |
| auth scope | open-ended | no (2 buckets max) | no |

Several rows are provably absent from BOTH role and types. Since the output entropy
exceeds the input entropy, the missing bits must be supplied from outside the carrier —
i.e. a per-op HTTP table. That table is keyed by surface concern, lives in the http
package, and is exactly the "surface-shaped second source of truth" #1/#3 forbid. The
claim "no per-op HTTP annotation is ever needed" is therefore **false by counting**,
before we look at a single example. The examples below just exhibit the missing bits.

---

## Break 1 (STRONGEST, near-fatal) — the taxonomy is a value-transform algebra; REST is stored-resource CRUD. Their R and D don't correspond, and fetch-by-id actively mis-projects to POST.

`read` is defined (§1) as `(t: T, ...a) => U` — it takes an **already-materialized T**.
But the archetypal HTTP endpoint, `GET /users/:id`, has no `T` in hand; it **produces**
a `User` from a key. Run the design's own decision procedure (§3.1) on
`getUser(id: UserId) => User`:

> Step 1: "Does `f` return `T` and its purpose is to yield a valid `T`? (args are
> ingredients, not the maintained subject)" — **yes**. File under `User` with `make`.

`make` → **POST** (§3.3). So the single most common REST endpoint in existence,
`GET /users/:id`, projects to `POST /users`. This is not coarseness; it is a category
error. The design's `read` is a **false friend** for HTTP GET: `read` means
"transform a value I already hold," HTTP GET means "load a value by key." They are
different primitives.

Map CRUD onto the role algebra and the hole is structural:

- **C**reate → `make` → POST ✓ (but upsert/PUT lost — see Break 2)
- **R**ead (fetch-by-id / list) → **no faithful role**; type-signatures as `make` → POST ✗✗✗
- **R**ead (transform in-hand) → `read` → GET ✓ — but this is rarely a network endpoint
- **U**pdate → `op` → PATCH ✓ (but PUT lost — Break 2)
- **D**elete (hard removal, `T => ∅`) → **no role**; `read` needs `U` non-carrier, `op`
  needs `T=>T`. Removal is neither. ✗

The carrier core has no notion of loading or removing a stored resource, because it is a
pure value-transformation algebra. REST is CRUD over a resource store. The "R" (fetch)
and "D" (remove) of the projection target have **no source** in the core. You cannot
"just add an override" for method here: the op that should exist (`load`) is filed under
the wrong verb by the total decision procedure, so its **default** is wrong and its
override would have to contradict the procedure. Either the taxonomy grows a
`load`/`remove` role (expanding the "source of truth" the design says is closed at three),
or you concede persistence/CRUD-R-D is a separate layer NOT projected from the core —
which guts "HTTP is computed from a carrier."

## Break 2 (fatal to the claim) — idempotency is invisible to both type and role, yet decides PUT vs PATCH vs POST and upsert.

Two endomaps:

```ts
User.op("replace",   (u, full: User) => full);          // idempotent → PUT
User.op("increment", (u) => ({ ...u, n: u.n + 1 }));    // non-idempotent → POST/PATCH
```

Both are `(t: User, …) => User` — **byte-identical types**, identical role (`op`), so
both project to PATCH. But one is idempotent (safe to retry, PUT) and one is not.
Idempotency is `f(f(x)) === f(x)` — a property of the **function body**, invisible to the
signature and absent from {make, op, read}. Same story for `make`: server-assigns-id
`register(data) => User` is POST; client-supplies-key `upsert(id, data) => User` is an
idempotent PUT. (The arg-shape *partially* rescues this one — "id present ⇒ PUT" is
type-derivable — but not the `op` case above, and not idempotent-POST-with-Idempotency-Key.)
The `law` hook cannot save it: reading a runtime closure to decide a method is undecidable,
and adding an idempotency predicate per op just IS the per-op annotation, relabeled.

Conclusion: idempotency must be authored per op, in a place the type system cannot hold.
Forced second source of truth.

## Break 3 (fatal) — auth scope and status/caching have zero carrier representation.

Every real API gates routes: `transfer:create` vs `account:read`, per-field authz. Role
gives at most two buckets (write for make/op, read for read); reality needs open-ended,
resource-specific scopes. There is nowhere in `carrier<T>()` to put "this op requires
scope X." Likewise `202 Accepted` (async make) vs `201`, `204 No Content`,
`Cache-Control`/`ETag` (volatility is a domain fact not in any type). All are per-op HTTP
bits with no carrier home. Auth alone is unavoidable and by itself forces per-route config.

## Break 4 (survivable but real) — reads that must be POST split HTTP into two axes role collapses into one.

Search/GraphQL with a 4KB filter body: role says GET, transport says POST (URL length
limits; structured filters don't serialize to query strings). Steelman: "non-scalar args
⇒ body ⇒ POST" is type-derivable, so the projector *can* pick POST from arg shape. But
then it has silently discarded the read's **safety/caching** semantics — the role said
"cacheable, safe," transport POST defeats HTTP caching. This exposes the root disease:
HTTP has **two orthogonal axes** — (a) safety/idempotency semantics, (b) transport shape
(args in URL vs body) — and role encodes only (a). Large-body reads are precisely where
they diverge. One knob cannot set two axes. (Also: collection `search(...) => User[]` has
no `t: T` and so isn't even a well-formed `read` under `(t:T,…)=>U` — same hole as Break 1.)

## Break 5 (survivable) — nesting is unrepresentable in a symmetric carrier.

`Assignment` (§2d) has FK fields `{user, project}`. To emit
`POST /users/:uid/projects/:pid/assignments` the projector needs the **nesting order**
(user⊃project vs project⊃user) and which FKs are path parents. The carrier is symmetric in
user/project; the URL is not. That ordering is pure surface info with no type
representation. The design's only escape is to mandate flat routes
(`POST /assignments?user=&project=`) — i.e. "HTTP is derived" really means "derived into
ONE fixed URL shape; any contract needing another shape is unsupported." The guardrail
survives only by amputating the requirement.

## Bulk / pagination / streaming / websockets (assorted)

- **Websockets/SSE/subscriptions**: `subscribe(t) => AsyncIterable<U>` is neither
  intro/endo/elim. The role algebra is **closed at three**; streaming needs a fourth role.
  Unsupported without expanding the source of truth.
- **Pagination**: `(cursor) => Page<U>` is type-derivable for params, but `Link` headers
  (RFC 5988) are HTTP response metadata that would have to be baked into the domain return
  type — leakage in the wrong direction.
- **Bulk**: `assignMany(pairs) => Assignment[]` roles as make/POST, but 207 Multi-Status /
  partial-success semantics aren't in the role.
- **Content negotiation / field selection / upload**: mostly *generic* projector features
  (Accept, `?fields=`, multipart-from-`Stream`-arg) — these are the design's genuinely
  strong cases; don't overclaim them as breaks.

---

## The reverse: does CLI projection work? (owner's open question)

**Yes — and that is the tell.** The same carrier drives CLI cleanly:
`fractal transfer create --from --to --amount`, `make/op/read` → subcommand groups, args
→ flags, `Result` → exit code, `--output json|table` → the generic content-negotiation
feature. CLI works *better* than HTTP for a precise reason: **CLI's semantic space is
low-dimensional.** A subcommand is name + flags + stdout + exit code. It has no
idempotency axis, no method, no caching, no resource-identity/path, no status taxonomy, no
per-route scope. The three roles are more than enough to cover it (arguably CLI needs zero
distinctions among make/op/read — every subcommand is equal).

So the answer to the owner's open question is the worst one: **one tree drives one surface
(CLI) faithfully and the other (HTTP) unfaithfully.** The "protocol-agnostic truth" is
not agnostic — it is **CLI-shaped**. It fits whichever surface carries the fewest semantic
axes. HTTP's extra axes (Breaks 1–3) have nowhere to live in a taxonomy sized for CLI.
Role is (near-)surjective onto CLI's semantic space and provably not surjective onto
HTTP's. Calling the low-demand surface's shape "protocol-agnostic" is the error.

---

## Verdict

**FATAL to the central claim** ("HTTP is computed from carrier + role alone; no per-op
HTTP annotation is ever needed; no surface-shaped second source of truth"). Proven three
independent ways: (Break 1) fetch-by-id and delete have no faithful role and fetch-by-id
mis-projects to POST; (Break 2) idempotency is invisible to type and role yet selects the
method; (Break 3) auth scope/status/caching have no carrier home. Each forces per-op HTTP
config, which is exactly the forbidden second source of truth.

**FIXABLE as an architecture** — the carrier-as-domain-truth + downstream-projector +
role-as-default skeleton survives, but only after the claim is retracted and rebuilt.

### Minimal fix (two parts, both required)

1. **Redefine "no second source of truth" precisely.** It must mean *"no re-declaration of
   DOMAIN facts (types, ops, invariants) per surface"* — NOT *"zero surface config."* Then
   permit a projection table that is (a) **purely additive** (only HTTP-only bits absent
   from the domain: method override, path template, status, scope, idempotency flag,
   cache policy), (b) **keyed to existing op names** (cannot invent or rename ops), and
   (c) **non-contradicting** (cannot change what the op *does*). Such a table is
   *decoration*, not duplication: it cannot drift from or contradict the carrier, and
   "nothing flows back into the op" is still literally true (the op never imports HTTP).
   Role stays the default for the 80%; the table supplies the 20% of bits role provably
   lacks. This is the honest version of §3.3.

2. **Fix the taxonomy hole (cannot be done by the table).** Either add explicit `load`
   (`key => T`, GET) and `remove` (`T => ∅`, DELETE) roles so CRUD-R/D have faithful
   sources and correct defaults, OR explicitly scope persistence OUT of the core and state
   that HTTP-CRUD is assembled by a persistence layer, not projected from the pure carrier
   — and drop the implication that the core alone yields a REST API. Without this, the
   default for `GET /users/:id` is POST, and no override table makes a *default* correct.

The design should also either add a `subscribe`/stream role or explicitly declare
streaming out of scope; and either mandate flat routing as a stated constraint or admit
nesting needs a path template in the (now-permitted) projection table.
