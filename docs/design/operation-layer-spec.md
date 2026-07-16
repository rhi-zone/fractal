# Operation-layer IR: requirements from the consumer app evidence

Scope: this is a requirements document for fractal's operational-semantics
counterpart to type-ir — what a single "operation" declaration needs to be able
to express so that the consumer app's current hand-authored/duplicated surfaces (HTTP
route, audit call, CLI, admin-page action, error mapping) become PROJECTIONS of
one declaration instead of N independently-maintained files. Every claim below
cites the the consumer app file(s)/lines it is drawn from. No design proposal for
fractal itself is made here — only the shape of the problem.

Evidence base (read in full for this spec):
- `apps/web/src/server/lib/locations-usecases.ts` (lifted use-case handlers)
- `apps/web/src/client/components/admin/admin-location-descriptor.ts` (EntityDescriptor)
- `apps/web/src/server/api/admin-locations.ts` (route file, part generated / part hand-written)
- `packages/kernel/src/usecases/entityDescriptor.ts` (EntityDescriptor, EntityAuditSpec, EntityHttpBinding, EntityAction — lines 1493–2090ish)
- `packages/kernel/src/usecases/useCaseDescriptor.ts` (UseCaseDescriptor)
- `apps/web/src/server/lib/mountUseCase.ts` (UseCaseBinding / InputSource)
- `apps/the consumer app/src/boot.ts` (registration blocks for locations/api-keys/admin-staff/admin-onboarding)
- `apps/web/src/server/lib/admin-staff-usecases.ts`, `apps/web/src/server/api/admin-staff.ts` (self-guard, session-derived input, composite ops)
- `apps/web/src/server/lib/projectUseCase.ts` (error-code → HTTP status mapping)

---

## 1. What the operation layer needs to express

### 1.1 Operation identity (name, entity association)

Two independent identity fields exist today and are declared in two different
files with no static link between them:

- **Use-case name** (`UseCaseDescriptor.name`, `packages/kernel/src/usecases/useCaseDescriptor.ts:45`) —
  a namespaced string, `"admin.listLocations"` / `"admin.createLocation"` /
  `"admin.archiveLocation"` (`apps/web/src/server/lib/locations-usecases.ts:54,68,82`).
- **Entity association** (`EntityDescriptor.entity`, `entityDescriptor.ts:1551`) —
  `"admin.location"` (`admin-location-descriptor.ts:32`), which then references
  use-case names by STRING in `list`/`create`/`update`/`actions[].useCase`
  (`admin-location-descriptor.ts:36-38,67,82`).

The link from an `EntityDescriptor`'s `create: "admin.createLocation"` to the
actual `UseCaseDescriptor` is a runtime registry lookup by string
(`registry.register(d)` in `boot.ts:1087`, then resolved by name inside
`registerEntityRoutes`) — there is no type-checked reference, and nothing
prevents an entity descriptor pointing at a use-case name that was never
registered (this is the exact failure mode `boot.ts:1080-1095` guards against
with a runtime `logger.error`, not a compile error). **Requirement**: operation
identity must carry BOTH a globally-unique name and an (optional) owning-entity
tag as ONE declaration, not two files kept in sync by string convention.

### 1.2 Input/output types (link to type-ir TypeRef)

`UseCaseDescriptor.input`/`.output` are valibot `GenericSchema` values
(`useCaseDescriptor.ts:49,56`) — runtime validators AND the compile-time type
source (`InferOutput<S>`). Three schemas exist per entity today, hand-written
independently:
- `LocationCreateSchema` (`locations-usecases.ts:29-35`, reused for `formFields`)
- `ListLocationsInputSchema` / `ArchiveLocationInputSchema` (`locations-usecases.ts:38,41`)
- `LocationPatchSchema` (`admin-locations.ts:60-66`) — a NEAR-DUPLICATE of
  `LocationCreateSchema` with every field `optional()`, hand-maintained
  separately (drift risk: adding a field to one and forgetting the other).

`output` is optional and, for all three locations use-cases, absent — the
generic `OkEnvelope` is used instead of a real response shape
(`useCaseDescriptor.ts:51-56`). **Requirement**: input/output must resolve to a
type-ir `TypeRef`, not a valibot schema authored by hand per operation — the
`update` = `partial(create)` relationship (currently a manually re-typed
duplicate) should be a type-ir derivation, not a second declaration.

### 1.3 Handler binding (the function that does the work)

`UseCaseDescriptor.handler: (input: unknown, ctx?: UseCaseCtx) => Promise<Result<unknown, unknown>>`
(`useCaseDescriptor.ts:74`). In practice every lifted handler in
`locations-usecases.ts` is a thin `try { ok(await composerRootFn(...)) } catch
{ return err(...) }` wrapper (lines 59-65, 73-80, 87-98) over a PRE-EXISTING
composition-root function (`listLocations`/`createLocation`/`archiveLocation`
from `./locations.js`, imported line 26). The wrapper exists purely to bolt a
`Result` envelope and a fixed error code onto a function that already has the
real logic. **Requirement**: the operation layer needs a way to bind directly
to a typed function-with-throws AND declare its error-code mapping
declaratively (catch → code), rather than requiring a hand-written try/catch
wrapper per operation — this wrapper is boilerplate repeated 3x in one file
alone and structurally identical each time.

### 1.4 HTTP stereotype (method, path, input source, success status)

Two overlapping vocabularies exist:
- `EntityHttpBinding` derivation (`entityDescriptor.ts:1993-2090`) — stereotypes:
  `list→GET {base}` (query), `get→GET {base}/:id` (params), `create→POST
  {base}` (json, 201), `update→PATCH {base}/:id` (json), action→`POST
  {base}/:id/{action.id}` (json). Per-op `HttpBindingOverride`
  (`entityDescriptor.ts:1970-1983`) replaces method/path/inputSource/successStatus;
  locations overrides `create.successStatus: 200` and `archive.{method:
  DELETE, path: "/:id", inputSource: "params"}` (`admin-location-descriptor.ts:45-48`).
- Independently, `mountUseCase.ts`'s `InputSource` union (`mountUseCase.ts:69-80`)
  is a SUPERSET of `HttpInputSourceKind` (`entityDescriptor.ts:1963`) — it adds
  `session` and `merge` kinds the entity-descriptor stereotype vocabulary
  cannot express at all (see 1.5).

**Requirement**: one HTTP-shape vocabulary, not two (a "framework-neutral
subset" that a hand-written route's superset then has to escape from — see
1.5). The 1-in-4 locations routes (`PATCH`) that stays hand-written
(`admin-locations.ts:68-103`) is fully outside this vocabulary today.

### 1.5 Session-input threading

`InputSource` kind `"session"` (`mountUseCase.ts:74`, `SessionFieldMap`
line 67) injects `SessionUser` fields (`id`/`email`/`name`/`role`,
`mountUseCase.ts:64`) into a named input key, and `"merge"` combines it with
`json`/`query`/`params` (`mountUseCase.ts:75-80`). This exists BECAUSE
`EntityHttpBinding`/`HttpInputSourceKind` (the entity-descriptor stereotype
layer, `entityDescriptor.ts:1963`) has NO session variant — it is explicitly
scoped to `"json" | "query" | "params" | "none"`. Concretely, two of the four
`admin-staff.ts` routes are EXCLUDED from the lift specifically because they
need the session actor id and the descriptor layer has nowhere to declare that
(`admin-staff-usecases.ts:16-21`: `role`/`deactivate` "needs the SESSION actor
id ... which the descriptor's declarative input sources cannot inject").
**Requirement**: session-field injection must be a first-class op-level
declaration (not just an HTTP-mount-time binding concept), because it is the
single most-cited reason (2 of the 4 locations/staff hand-written exceptions)
an operation could NOT be lifted into the declarative layer.

### 1.6 Authorization (scope/role, self-guards)

Two disjoint mechanisms:
- `UseCaseDescriptor.scopes: readonly string[]` (`useCaseDescriptor.ts:60`) —
  declared but EMPTY (`scopes: []`) on all three locations use-cases
  (`locations-usecases.ts:58,72,86`); the real gate is
  `requireSessionMiddleware("admin")` applied to the whole Hono router
  (`admin-locations.ts:55`), a coarse role check outside the descriptor
  entirely.
- **Self-guards** — `userId === session.id && role !== "admin"` →
  `SELF_DEMOTE_BLOCKED` (`admin-staff.ts:281-286`) and `userId === session.id`
  → `SELF_DEACTIVATE_BLOCKED` (`admin-staff.ts:307-314`) are HAND-WRITTEN
  imperative guards comparing a session-derived id against the row/path id —
  not expressible in `scopes` (a static list) at all. These are explicitly
  named as one of the two reasons those routes are excluded from the lift
  (`admin-staff-usecases.ts:16-21`).

**Requirement**: authorization needs (a) a static scope/role requirement AND
(b) a relational guard predicate over `{session, input, row}` — e.g. "actor id
≠ target id, unless target role stays admin" — expressed declaratively, not
as inline `if` code duplicated per guarded operation (the pattern repeats
twice, near-identically, in `admin-staff.ts:281` and `:307`).

### 1.7 Audit spec (action name, entity tag, entity ID source, payload)

`EntityAuditSpec` (`entityDescriptor.ts:1530-1543`): `{action, entity,
entityIdFrom: "result.id"|"input.id", after?: "input"}`. Declared per-op on
`adminLocationEntity.audit` (`admin-location-descriptor.ts:50-62`): create →
`location.created`/`entityIdFrom: "result.id"`/`after: "input"`; archive →
`location.archived`/`entityIdFrom: "input.id"`/no `after`. Consumed by
`registerEntityRoutes` at the HTTP boundary — the comment is explicit that the
lifted handler "MUST NOT call `recordAuditEvent`" to avoid double-audit
(`locations-usecases.ts:8-12`).

**Gap, evidenced**: the `update` op's audit is NOT expressible in
`EntityAuditSpec` and stays hand-written (`admin-locations.ts:94-100`,
`recordAuditEvent` called directly) because it needs:
- a `before` value (a DB read PRIOR to the mutation) — `EntityAuditSpec` has no
  `before` field at all;
- a noop-skip (`if (result.kind === "noop") return ... /* no audit */`,
  `admin-locations.ts:90-92`) — conditional audit-or-not based on whether the
  mutation actually changed anything;
- (in `admin-staff.ts:294-295`) a `before`/`after` PAIR where `before` is a
  value computed BEFORE the mutation (`previousRole`, line 277), not derivable
  from `input` or `result` alone.

Also evidenced: `admin-staff-usecases.ts:22-25` — invitation-revoke's audit
`after: { userId: row.userId }` is a DB-FETCHED value, and the generator "only
supports `after: 'input'` (verbatim)", so lifting would "silently drop that
audit field." **Requirement**: audit payload sourcing needs at minimum
`result`, `input`, a pre-mutation `before` read, and DB-fetched auxiliary
values — not just the two-source enum that exists today — plus a
skip-if-noop predicate.

### 1.8 Side effects on success (events, cache invalidation)

Not evidenced as declarative ANYWHERE in the read files. `admin-staff.ts:322-324`
hand-writes a side effect after the mutation: `await setUserActive(...)` then
`// Invalidate any live sessions so the user is kicked out immediately` →
`await deleteUserSessions(db, userId)`, sequenced imperatively, with a comment
explaining WHY (kick out a deactivated user's live sessions). This is a
same-transaction-adjacent side effect entangled with the handler body itself,
not expressed by any of `UseCaseDescriptor`/`EntityDescriptor`/`EntityAuditSpec`.
`mountUseCase.ts:82-100` DOES have a declarative cache concept (read-response
caching via `ttlMs`/`keyFrom`), but that is read-side caching of the RESPONSE,
not invalidation of a cache as a post-mutation side effect. **Requirement**:
"on success, do X" (event emit, cache bust, session revocation) is currently
either invisible (buried in handler body, e.g. `deleteUserSessions`) or absent
entirely from the declarative layer; the op layer needs an explicit
success-effect list separate from the primary handler logic and separate from
audit.

### 1.9 UI presentation (trigger label, confirm prompt, enabled-when, icon)

`EntityAction` (`entityDescriptor.ts:594-654`+): `label?` (line 600, "defaults
to a humanized action id"), `confirm?: string` (line 609, a literal message
string, host `confirm()`), `enabledExpr?: unknown` (line 639, a serialized
`Expr` predicate — carried as `unknown` specifically so this metadata module
imports no `Expr`), `fixedInput?` (line 649, a constant input fragment),
`idField?`/`pathParams?` (id-routing). Concretely used in
`admin-location-descriptor.ts:63-92`: `archive` action gated
`enabledExpr: active === true`, label `"Archive"`; `reactivate` action reuses
`admin.updateLocation` with `fixedInput: {active: true}`, gated `active ===
false`, label `"Reactivate"`.

**Gap, evidenced**: `grep -n "icon"` over `entityDescriptor.ts` returns ZERO
matches — there is no icon field anywhere in the descriptor. **Requirement**:
label/confirm/enabled-when/fixedInput are already well-covered by
`EntityAction`; icon is entirely absent from the current surface and would
need to be added if the op layer is meant to fully replace bespoke per-row
buttons.

### 1.10 Error semantics (error codes → HTTP status, error display)

`packages/kernel`-adjacent `apps/web/src/server/lib/projectUseCase.ts`: a
generic heuristic `statusForCode` (lines 158-165) — suffix/prefix matching
(`*NOT_FOUND→404`, `UNAUTHORIZED|*UNAUTHENTICATED→401`, `FORBIDDEN|*FORBIDDEN→403`,
`INTERNAL_ERROR|*DB_ERROR→500`, else `400`) — overridable per-binding via an
`errorStatus` map consulted FIRST (`projectUseCase.ts:98,143,179-180`, e.g. to
pin `ALREADY_CONVERTED` to a specific status). Concretely, locations' lifted
handlers hand-pick codes to land on the heuristic correctly: `DB_ERROR` (falls
into `*DB_ERROR→500`, `locations-usecases.ts:63,77,92`) and
`LOCATION_NOT_FOUND` (falls into `*NOT_FOUND→404`, line 95) — i.e. authors are
ALREADY choosing error-code strings to hit specific HTTP statuses through a
naming convention, evidence that the current design already wants a
code→status mapping to be declarative, just expressed as a naming
superstition rather than a table. Malformed errors always degrade to
`INTERNAL_ERROR`/500 (`projectUseCase.ts:118`) so the mapping can never crash a
response. **Requirement**: the op layer should let an operation declare its
possible error codes AND their status directly (as `admin-staff.ts`'s
`SELF_DEMOTE_BLOCKED`/`SELF_DEACTIVATE_BLOCKED` → 400 already do implicitly via
the generic default), rather than relying on suffix-matching a string.

---

## 2. What a single declaration should derive (projections)

| Projection | Current mechanism | Evidence |
|---|---|---|
| HTTP route registration | Partially generated (`registerEntityRoutes` from `EntityHttpBinding`), partially hand-written per exception | `admin-locations.ts:54-56` (generated) vs `:68-103` (hand-written PATCH) |
| Valibot input schema | 100% hand-written per op, including a near-duplicate `partial()` schema for update | `locations-usecases.ts:29-41`, `admin-locations.ts:60-66` |
| CLI command | Design intent exists (`mountUseCase.ts:16-18`: "OpenAPI / CLI (built next): enumerate `routeManifest`... `{method, path, descriptorName, inputSource}` + the registry is enough") but NOT evidenced as built in the files read | `mountUseCase.ts:1-23` |
| OpenAPI spec | Same comment block states OpenAPI is a planned consumer of the manifest, not generated today | `mountUseCase.ts:16-18` |
| Audit recording at execution boundary | Split: generated for `create`/`archive` via `EntityAuditSpec` (`registerEntityRoutes`), hand-written for `update` (`recordAuditEvent` call) because of the `before`/noop-skip gap (§1.7) | `admin-location-descriptor.ts:50-62`; `admin-locations.ts:94-100` |
| Admin page projection | Via `EntityDescriptor` + `formFields`/`editFields`/`fields` consumed by a page-level projector (`page-admin-locations-projected.ts`, referenced but not read) plus a wrapper file (`admin-location-descriptor.ts` header comment lines 3-8 explains the descriptor was split into its own module specifically so BOTH the client projector and the server route generator import the same object without pulling in DOM side effects) | `admin-location-descriptor.ts:1-16` |
| Test mock registration | Hand-copied — `boot.ts` registers descriptors imperatively per slice (`for (const d of adminLocationsUseCaseDescriptors({db})) { registry.register(d) }`, repeated near-identically 4x for locations/api-keys/admin-staff/admin-onboarding, `boot.ts:1075-1163`), each block guarded by a duplicated `if (!composedUseCaseRegistry) logger.error(...)` | `boot.ts:1080-1095, 1102-1117, 1125-1140, 1148-1163` |
| Route manifest entry | `mountUseCase`'s module-level array, appended at mount time (`mountUseCase.ts:20-22`) | `mountUseCase.ts:1-23` |

The `boot.ts` registration blocks (§ table row "Test mock registration") are
the clearest EVIDENCE of a missing derivation: four structurally-identical
17-line blocks (`boot.ts:1075-1163`) that differ only in the descriptor
function called and the log-prefix string — this is exactly the kind of
per-instantiation boilerplate a single declaration + a generic
"register-all-descriptors-from-this-slice" projection should eliminate.

---

## 3. Current gap between EntityDescriptor and the ideal operation IR

**Gets right:**
- CRUD + action/command HTTP stereotyping with per-op override escape hatch
  (`HttpBindingOverride`) — covers the common case (`entityHttpBindings`,
  `entityDescriptor.ts:2042-2090`) while allowing exceptions to stay data, not
  code (locations' archive-as-DELETE, `admin-location-descriptor.ts:45-48`).
- UI action metadata (label/confirm/enabledExpr/fixedInput) is genuinely
  declarative and expressive enough that NEITHER of the two locations actions
  needed a hand-written UI branch.
- Simple audit (single id source, verbatim-input `after`) is fully declarative
  and covers 2 of 3 locations ops.
- The descriptor/registry separation (`UseCaseDescriptor` = what, binding =
  how) is architecturally sound — the split itself is not the gap.

**Gets wrong / incomplete:**
- Two competing, only-partially-overlapping HTTP-shape vocabularies
  (`HttpInputSourceKind` at the descriptor layer vs `InputSource` at the mount
  layer) — the descriptor layer is a strict subset missing exactly the cases
  (`session`, `merge`) that matter for authorization-adjacent ops (§1.5).
- Audit's `entityIdFrom`/`after` enum is too narrow: no `before`, no
  DB-fetched-value source, no noop-skip — provably true because the update op
  (the most audit-sensitive one, since it's a partial mutation) is EXCLUDED
  from every descriptor-driven entity examined (`locations`, implicitly also
  true for `admin-staff`'s role/deactivate).
- No representation for a relational authorization guard (self-demote/
  self-deactivate) at all — `scopes: []` is emitted even where the operation
  in question. Confirmed: real gates for the very ops we can see are
  imperative code, entirely outside descriptors.
- No representation for post-success side effects (session revocation,
  presumably events/cache elsewhere) — `deleteUserSessions` is invisible to
  any descriptor.
- No icon field despite label/confirm/enabled-when otherwise covering the
  UI-affordance surface.
- Input/output types are hand-authored valibot schemas per operation with no
  link to a shared type IR — the `create`/`update` schema pair is duplicated
  by hand (`LocationCreateSchema` vs `LocationPatchSchema`), a pure
  `Partial<T>` relationship expressed as two independent declarations that
  can silently drift.
- Registration is per-call-site imperative boilerplate (`boot.ts`'s four
  near-identical blocks) rather than a projection over "every descriptor this
  slice publishes."

**Can't express at all (found nowhere in the read files):**
- Before/after audit with a genuinely computed `before` (pre-mutation read).
- Conditional/skip-if-noop audit.
- Self-referential / relational authorization predicates.
- Session-derived input at the descriptor (entity) layer — only at the
  HTTP-mount layer, and even there scoped to a fixed `SessionField` union
  (`id`/`email`/`name`/`role`).
- Any success-side-effect declaration (events, cache invalidation, session
  revocation).
- Composite/multi-step operations (branch-on-existing + insert + send-email +
  mixed-source audit, i.e. `POST /invite`, `admin-staff-usecases.ts:12-15`) —
  explicitly named as one of the two structural reasons an op can't be lifted,
  distinct from the session-input gap.
- Icon / any visual affordance beyond label+confirm.

---

## 4. Concrete example: locations if fully declared once

### Today — files/declarations needed for the 4 locations ops (list, create, archive, update)

1. `locations-usecases.ts` (102 lines): 3 hand-written `UseCaseDescriptor`
   objects, each with its own valibot input schema and its own try/catch
   error-code wrapper around a composition-root call.
2. `admin-location-descriptor.ts` (135 lines): `EntityDescriptor` — entity
   identity, basePath, httpBindings overrides (2), audit specs (2, missing the
   3rd/update), 2 actions, field metadata, `formFields` (5 fields, hand-typed,
   duplicating the create schema in a second vocabulary) and `editFields` (5
   fields, hand-typed, duplicating `LocationPatchSchema` in a second
   vocabulary AGAIN — so the "shape of a location patch" now exists in THREE
   independently-maintained places: `LocationCreateSchema`,
   `LocationPatchSchema`, `editFields`).
3. `admin-locations.ts` (106 lines): route file — 3 GENERATED routes via
   `registerEntityRoutes`, 1 fully hand-written PATCH route (46 lines: its own
   copy of the patch schema — a FOURTH copy — session/param wiring, error
   mapping, before/after audit, noop-skip).
4. `boot.ts` (17 lines, `:1075-1095`): imperative registration block +
   null-check + per-descriptor error logging, structurally duplicated 3x more
   for sibling entities.

Total: 4 files, ~360 lines, 4 independent shapes for "what a location patch
looks like," 1 op (`update`) that opts out of every declarative mechanism the
other 3 use.

### If operation info were declared once (illustrative target shape, not a fractal design proposal)

```
operation admin.location.create:
  entity: admin.location
  input: LocationPatch          # type-ir TypeRef, required fields
  output: Location
  handler: locations.createLocation   # direct binding, typed throws
  errorMap: { DbError: 500 }
  http: { method: POST, successStatus: 200 }   # override from stereotype 201
  audit: { action: "location.created", entityIdFrom: result.id, after: input }
  ui: { form: derived-from(input) }

operation admin.location.update:
  entity: admin.location
  input: Partial<LocationPatch>       # type-ir derivation, not a new schema
  output: Location
  handler: locations.updateLocation
  errorMap: { NotFound: 404, DbError: 500 }
  audit:
    before: read(entity, input.id)
    after: result
    skipIf: result.kind == "noop"
  ui: { editForm: derived-from(input), action.reactivate: { fixedInput: {active:true}, enabledWhen: !active } }

operation admin.location.archive:
  entity: admin.location
  input: { id: string }
  output: { archived: boolean }
  handler: locations.archiveLocation
  errorMap: { NotFound: 404, DbError: 500 }
  http: { method: DELETE, path: "/:id", inputSource: params }
  audit: { action: "location.archived", entityIdFrom: input.id }
  ui: { action.archive: { label: "Archive", enabledWhen: active } }
```

**What would no longer need to exist**, if the above were real and every
projection listed in §2 were generated from it:
- `LocationCreateSchema`, `ArchiveLocationInputSchema`,
  `ListLocationsInputSchema` (hand-written valibot, `locations-usecases.ts:29-41`)
  — replaced by type-ir-derived schemas.
- `LocationPatchSchema` (`admin-locations.ts:60-66`) — replaced by a `Partial<>`
  derivation of the create type, not hand-retyped.
- The 3 try/catch wrapper handlers (`locations-usecases.ts:59-98`) — replaced
  by direct binding + declarative `errorMap`.
- The hand-written PATCH route body (`admin-locations.ts:68-103`, 36 lines) —
  replaced by a generated route once `before`/noop-skip audit and
  session-input are expressible.
- `formFields`/`editFields` as a SEPARATE hand-typed vocabulary
  (`admin-location-descriptor.ts:109-134`) — replaced by deriving the form
  field list from the same type-ir input type already used for validation.
- The per-entity `boot.ts` registration block (`boot.ts:1075-1095`, and its 3
  siblings) — replaced by one generic "register every operation this module
  exports" projection, since operations would be self-describing rather than
  requiring an imperative registration call site per slice.
- `admin-location-descriptor.ts` surviving ONLY as UI-specific residue (labels,
  badges, icons if added) — no longer the union of identity + HTTP + audit +
  input-shape + UI it is today, because those would already live on the
  operation declarations themselves and the entity descriptor would just
  reference operations by name for grouping/display purposes.

Net: 4 files / ~360 lines / 4 duplicated shapes of "location patch" collapses
toward 1 declaration per operation (4 operations) + type-ir types, with the
`update` op gaining audit/session capabilities it currently lacks rather than
being a permanent hand-written exception.
