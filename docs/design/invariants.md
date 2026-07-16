# Canonical design invariants

The settled model, mined verbatim from the design conversation. **Authoritative
where any other design doc conflicts** — including
[`function-core-and-projection.md`](./function-core-and-projection.md), which is
fuller but partly superseded. Each invariant pairs a crisp statement with the
user's own words; the quotes are load-bearing and preserved verbatim.

---

## Identity

Fractal is a codebase compression substrate. It gives codebases a skeleton —
the central structure supporting the entire app — as a single source of truth,
with everything else derived from it.

The type IR, routing tree, and (future) operation layer are all aspects of this
skeleton: one declaration IS the truth, and the surfaces (HTTP routes, CLI
commands, OpenAPI specs, validation schemas, admin UIs, audit logs) flow from it.

The previous label — "Parsec-style combinator composition" — was aspirational
naming that didn't match the built code. The actual pattern: inspectable
declarations (data) interpreted by projectors to produce surfaces. The
combinator identity gap (TODO.md) was a symptom of unclear self-description,
not a structural deficiency in the code.

---

## SUPERSEDED / CORRECTED (see [`converged-model.md`](./converged-model.md))

> Added 2026-07 after the operation/projection model converged. The current
> authoritative synthesis is [`converged-model.md`](./converged-model.md); prior art
> is `server-less` (`/home/me/git/rhizone/server-less`), which already implements the
> model. This section corrects specific items below that over-blessed
> assistant-invented material. Everything not listed here remains as stated.

- **(a) The `read→GET / replace→PUT / remove→DELETE / partial→PATCH` verb table is
  REJECTED.** It was assistant-invented, not a designed operation kind. Verbs are one
  lossy, downstream HTTP projection — not an agnostic kind/object. (Corrects the
  "CRITICAL" note under the POST invariant and Open question #1.)

- **(b) The operation-characterization is ARBITRARY, OPEN metadata — not a designed
  kind/verb set.** An op is a function carrying an open metadata bag; each protocol
  projection reads the keys it recognizes and ignores the rest. Metadata is only for
  non-type-expressible projection/taste concerns (verb, idempotency, cache, auth) —
  never a second source for domain data (types + JSDoc remain that).

- **(c) Any claim that the wire surface is "generated unaided with zero config"
  should read as "unaided defaults for the obvious + overrideable metadata for
  taste."** No deterministic program can divine taste; inference is a fine but always
  OVERRIDEABLE default, never authoritative. (Tempers the "codegen just works for
  whatever's obvious" invariant — losing unaided-projection-for-the-obvious is a
  dealbreaker, but total/objective projection is wrong.)

- **(d) Current authoritative synthesis: [`converged-model.md`](./converged-model.md);
  prior art: `server-less`.**

---

## Settled invariants

- **Core = plain functions + composition.** The base is `T => U` plus
  `(.) :: (a->b) -> (b->c) -> (a->c)`. Kleisli/applicative forms are DERIVED and
  strictly less general.
  > "the handler itself should be T => U, the transform should be arbitrary
  > T => U as well. and then: `(.) :: (a -> b) -> (b -> c) -> (a -> c)`..."
  > "i don't see how kleisli arrows aren't OBJECTIVELY strictly less general"
  > "we want to build a library/framework to transform/manipulate arbitrary data
  > into arbitrary other data"

- **One-directional transforms; no view/review.**
  > "wait, why do we need `review`."
  > "view + review is overkill and poisons the architectural purity of composability"
  > "correction: it's just a fucking FUNCTION"

- **Handler = a simple `f(options) => Result` over a strongly-typed named-params
  object; not a wire `body`.**
  > "the handler transformation function to be, well, a 'simple' function from T to U"
  > "building up a typed 'context'/'options'/'parameters' object as *the* input to
  > an arbitrary api function"
  > "`body` is the wrong input for the options object. it should be a strongly typed
  > 'named params' style object"
  > "the router itself imo should be a more or less shallow shim that reconciles the
  > input with the statically typed api function"

- **Handler is provenance-blind; HTTP source-markers and capabilities do not pass
  through to it.**
  > "and NEITHER of these should pass through to the api function"
  > "do caps not just... sit in the input shape and pass through untouched?"

- **`Request => T` and `U => Response` are plain functions — optionally
  handwritten, otherwise projected; not declarative markers.**
  > "f(Request) => Response. values are FUCKING PROJECTED (Request => T; U => Response)"
  > "in manually authored HTTP trees, Request => T are OPTIONALLY handwritten as
  > REGULAR FUNCTIONS because OBVIOUSLY"
  > "E -> HTTP Response is another plain function that the http package should
  > probably export for convenience"

- **Inputs are already typed; there is no "raw". Coercion is
  impossible-by-construction via the type system.**
  > "strings *are* already typed"
  > "input is not 'untyped', it is fully typed"
  > "a fucking string \"id\" is fucking fine"
  > "coercion is an implementation detail, and this should be impossible by
  > construction... via... the type system"

- **Single source of truth = inferred TS types + JSDoc (constraints AND
  descriptions). No reified runtime meta / no schema-as-second-source.**
  > "who the fuck said reified tree"
  > "why not? types are readable by typescript api"
  > "the fuck? hello? jsdoc says hi?"
  > "not to mention fucking *descriptions* are also readable from jsdoc..."
  > "didn't we agree to use inferred types?"

  (An earlier `{closure, metadata}` idea was floated, then ABANDONED — do not
  resurrect it.)

- **Codegen "just works for whatever's obvious"; the user writes as much or as
  little as they want; output must be as good as handwritten, structurally and
  semantically.**
  > "the point of codegen is to just work for whatever's obvious"
  > "as good as a handwritten one structurally and semantically"
  > "codegen'd is more consistent = better"

  > **CORRECTED (c):** read "generated unaided / just works" as "unaided defaults for
  > the obvious + overrideable metadata for taste" — never total/objective
  > projection. See [`converged-model.md`](./converged-model.md).

- **One explicit nested routing tree; combinators name the node kind via a record
  API (`path({ classes: ... })`); no `tree([])`, no opaque `leaf`, no scattered
  declarations.**
  > "when routing is just multiple unrelated declarations then the mental model of
  > how routing slices is fucking intractable"
  > "what the fuck is tree([]). why not path({ classes: })"
  > "what happened to the fucking routing combinators"
  > "what the fuck is leaf. a) slop b) monolithic"

- **No colon path-DSL, no bound-variable machinery; a plain string segment
  suffices.**
  > "how. the fuck. would bound variables even work. a fucking string \"id\" is
  > fucking fine"

- **The IR is the abstract (protocol-agnostic) tree; the HTTP tree is a projection
  of it; the tree stays explicit but not protocol-specific.**
  > "the tree (if any) should still be explicit, no? just not a protocol specific one."
  > "keep in mind that decisions may not cut across a clean axis."

- **`NoInfer<T>` + a root anchor is the inference mechanism.** The mechanism is
  accepted; the assistant's "bottom-up forces it" rationale was NOT accepted.
  > "says who, exactly?"

- **POST = a method call / invocation. `new T()` / "create" is NOT a method
  call.** Reject `create → POST /collection` and arbitrary name→verb tables.
  > "i am FUCKING SAYING post is a METHOD CALL and `new T()` is NOT A FUCKING METHOD CALL"
  > "why the FUCK does create translate to POST /todos"
  > "POST is method call not fucking create... i'd probably prefer POST /the/:path/here/new"

  **CRITICAL:** the `read→GET / replace→PUT / remove→DELETE / partial→PATCH`
  scheme was **assistant-invented** and is **NOT user-settled**. It is recorded
  here only as the assistant's unconfirmed proposal — it is not part of the model.
  **CORRECTED (a/b):** this table is now explicitly REJECTED; verbs are downstream
  projection metadata, not a designed kind. See
  [`converged-model.md`](./converged-model.md).

- **verb / path / placement (query/body/header/cookie) are projected from binding
  + convention; never authored as ceremony on the leaf. `InputSource`-style enums
  are an HTTP-shape leak.**
  > "f(Request) => Response. values are FUCKING PROJECTED"
  > "disturbingly http shaped"

- **`methods({})` is an HTTP construct that must still exist for dispatch;
  bespoke verb/path = explicit overrides.**
  > "how the fuck is methods() not a fucking HTTP construct"
  > "where the FUCK did methods({}) go"

  > **STALE (2026-07-10):** `methods({})` as a distinct combinator was replaced by
  > `meta.http.dispatch = "method"` on a node — see [`router-model.md`](router-model.md).
  > The intent (HTTP method-dispatch must exist; bespoke verb/path = explicit overrides)
  > remains valid; the mechanism changed.

- **API-first; clean interfaces; the HTTP router is both dogfood for the generic
  core AND a wanted product with SOTA DX + SOTA perf.**
  > "the interface(s) themselves should be clean."

- **"data over code" is NOT a forcing principle here** (it was poisoning context).
  > "the data over code thing is kinda poisoning context"

- **Tagged-union discriminant fields are named `kind`, not `type` and not
  per-site names like `by`.**

  Applies to all serializable tagged-union ("frozen call") data —
  `MatchCondition`, `meta.http.dispatch`, and any future plug-in or config data
  of the same shape.

  Rationale: this codebase reifies types as its core thesis ("the typed thing is
  the truth; type is inferred from TS"), placing it in compiler/language-tooling
  territory (Rust `ExprKind`/`TokenKind`, Clang/LLVM AST, Kubernetes `kind`)
  where `kind` is standard precisely to avoid colliding with the loaded word
  "type." Reading `type: "date"` in a system where "type" means the inferred TS
  type is genuinely ambiguous; `kind` is not.

  The one override: when serializing INTO an external wire format that fixes its
  own discriminant (e.g. JSON:API / Redux use `type`), match that format at the
  boundary. The internal convention is `kind`.

  Shape framing: such a value is a frozen function application — `kind` is the
  callee (which matcher / variant), the remaining fields are its arguments; the
  nullary case may degenerate to a bare string tag (e.g. `"method"`). The
  discriminant exists because the value is data resolved to a function later by
  the projection — a closure at that boundary would lose
  serialization/introspection.

- **Reject `Result<T,E> | Response` escape hatch; want a canonical stream
  construct.**
  > "why not a canonical stream construct?"

- **Rewrite salvaging infra; read existing code critically, not blessed.**
  > "existing code should be read critically not treated as blessed"

---

## Open questions

Unsettled — each must be resolved FROM the user's definition, not guessed.

1. The full verb/method model beyond "POST = method call" (the access-verb mapping
   is unconfirmed/assistant-invented).
2. Can one tree auto-derive both HTTP and CLI, given "http path/headers vs cli
   subcommands/env vars have no 1:1 mapping"? (User "kms"'d at "no single tree
   auto-derives both"; unreconciled.)
3. Node disambiguation: segment vs operation vs param within one node; where the
   input→options transform lives.
4. Authoring form for bespoke verb/path overrides — inline on the node vs a
   separate binding layer.
5. Higher-level magic/decorator/metadata layer (user is "not against" it;
   undesigned).
6. Creation / non-record output encoding (user leans explicit `POST /…/new`).
7. "Is it too general?" — never closed.

---

## Guardrails

The assistant regressed on these repeatedly. DO NOT repeat them.

1. Do not reintroduce a reified runtime meta/schema tree as a second source —
   truth is inferred types + JSDoc.
2. Do not treat input as "raw/untyped" needing validation — inputs (incl. strings)
   are already typed.
3. Do not leak HTTP shape (`body`/`query`/`header`/`verb`/`InputSource`) into the
   handler/options — those are projected, never reach the api function.
4. Do not propose bidirectional view/review or Kleisli-as-base — base is plain
   `T=>U` + `.`.
5. Do not lose the single explicit nested tree (no descriptors/flat
   declarations/`tree([])`/opaque `leaf`); keep record combinators + `methods({})`.
6. Do not map `create→POST` or invent name→verb tables — POST is a method call.
7. Do not force "data over code" / "compiled from descriptors."
