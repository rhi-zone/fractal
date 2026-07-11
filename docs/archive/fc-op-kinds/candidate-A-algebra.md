# Candidate A — Operation Kinds from the Algebra of Functions

Framing: derive kinds ONLY from distinctions intrinsic to a morphism `T => U`
and composition. No notion of "effect", no protocol. Then map HTTP/CLI/MCP onto
them and audit for verb-leakage.

## 0. Setup: what "intrinsic" means after addressing is factored out

The tree IS the addressing/grouping hierarchy. So the *address* is supplied by a
node's position, not by the function. The operation on a node is therefore the
**residual morphism** after stripping addressing: `Args => Out`, where the node
carries a value type `T` (its "carrier"). Every categorical distinction below is
read relative to that carrier `T`.

This matters enormously and is examined in the weak-points section: stripping the
address collapses several naive distinctions into the *arguments*, which is also
where HTTP verbs encode their meaning. Keep this in view.

## 1. Which categorical distinctions are REAL vs COLLAPSE

Candidate axes intrinsic to `f: T => U`:

| axis | verdict | why |
|---|---|---|
| domain trivial? (`()=>U` vs `T=>U`) | **REAL** | terminal object 1 has no addressing input; a point is genuinely different from a map with a source |
| codomain relation to carrier (`=>T`, `=>part(T)`, `=>1`, `=>novel`) | **REAL** | endomap / projection / consumption / general are distinct arrows |
| totality vs partiality (`=>U` vs `=>U\|⊥`) | **REAL but a MODIFIER** | Kleisli decoration over a base arrow, not a new arrow |
| invertibility (iso / mono / epi) | **REAL but RELATIONAL** | a property of a *pair* of arrows, not of one arrow in isolation |
| left/right composability | **COLLAPSE** | every arrow composes on both sides given matching types; not distinguishing |
| arity / product source (`A×B=>U`) | **COLLAPSE** | currying `A×B=>U ≅ A=>(B=>U)`; arity is not intrinsic |

So the surviving *kind-bearing* axes are: **(domain trivial?)** × **(codomain
relation to carrier)**. Partiality and invertibility survive as a **modifier**
and a **relation** respectively — deliberately NOT kinds. This is a load-bearing
stance: it is exactly why nothing below maps to PATCH (see §4).

## 2. The candidate kind set (5 kinds + 2 modifiers)

1. **Produce** — `() => T`. Morphism from the terminal object; yields a value with
   no input. A named element/point. (e.g. `() => Config`)
2. **Fold** — `T => S` where S is a terminal or summary not reconstructing T
   (includes `T => ()`). Collapses/consumes the carrier to a scalar, aggregate,
   or acknowledgement. (e.g. `Cart => number` (count); `Session => ()` (end))
3. **Endo** — `T => T`. Codomain equals domain; evolves the carrier within its own
   type. (e.g. `Counter => Counter` (increment); `Doc => Doc` (normalize))
4. **Lens/Iso** — a morphism participating in a declared inverse pair on the node:
   `T <=> U`. Reversible reshaping/view whose partner exists in the tree.
   (e.g. `Celsius <=> Fahrenheit`; `Doc <=> Markdown`)
5. **Transform** — `A => B`, B novel, no inverse. The general residual morphism: a
   genuine computation with input producing a new thing. THE invocation.
   (e.g. `SearchQuery => Results`; `Order => Receipt`)

Modifiers (orthogonal, applied to any base kind):
- **partiality**: total (`=> U`) vs partial (`=> U | ⊥` / `Result<U>`). Kleisli.
- **direction/authority** (for Endo & Lens): input is *supplied-whole* vs
  *computed-from-old*. The type CANNOT tell these apart, so this is AUTHORED.

## 3. Per-kind: inference + projections

### Produce `() => T`
- (a) **Inferable**: arity 0. Trivially detected.
- (b) HTTP: **GET**. (c) CLI: `noun get` / bare `noun` printing the value.
  (d) MCP: a **Resource** (read-only) or a zero-arg tool.

### Fold `T => S`
- (a) **Partially inferable**: return is unit / boolean / number / aggregate that
  does not contain T → Fold; otherwise indistinguishable from Transform → **authored**.
- (b) HTTP: **GET** when pure/idempotent (`count`, `sum`); **DELETE** when the fold
  is the destructive consumer `T => ()` that removes the carrier — AUTHORED which.
  (The fact that one categorical kind spans both GET and DELETE is a non-leak tell.)
  (c) CLI: `noun count` / `noun delete`. (d) MCP: a tool returning a scalar/summary;
  destructive fold = tool gated by a confirm arg.

### Endo `T => T`
- (a) **Inferable that it's an Endo** (`paramType === returnType`), but its INTENT
  — replace-with-supplied-whole vs evolve/compute — is **authored** (direction
  modifier). Type is genuinely underdetermined here.
- (b) HTTP: **POST by default** (increment, normalize, rename are invocations);
  **PUT** only when authored as replace-whole. Crucially, NOT PATCH-by-type.
  (Endo→POST, not the naive PUT, is the key anti-leak signal.)
  (c) CLI: `noun <verb> [args]` (`counter increment`); replace = `noun set --from-file`.
  (d) MCP: a mutating tool; input schema = args (evolve) or full T (replace).

### Lens/Iso `T <=> U`
- (a) **Authored / relational**: requires a declared inverse partner. Can be
  *inferred* only if two co-located ops have mutually inverse types and lens-law
  shape; generally authored.
- (b) HTTP: the forward read → **GET**, the inverse → its own node (a writer).
  An iso has **no single HTTP verb** — it degrades to a GET+PUT pair. HTTP cannot
  express "these two are inverse". (c) CLI: `noun as <U>` / paired `noun from <U>`.
  (d) MCP: paired tools, or a resource + a writer tool.

### Transform `A => B`
- (a) **Inferable as the residual default**: novel codomain, no inverse, non-trivial
  domain.
- (b) HTTP: **POST** — the fixed call/invocation anchor. (c) CLI: `noun <verb> [args]`
  general subcommand. (d) MCP: a **tool** (the canonical MCP tool = an invocation).

## 4. Self-administered "secretly HTTP" test

Line-up against GET / POST / PUT / PATCH / DELETE:

| kind | naive verb guess | actual projection | leak? |
|---|---|---|---|
| Produce | GET | GET | rhymes |
| Fold | — | GET *or* DELETE (authored) | one kind spans two verbs → not a verb |
| Endo | PUT | **POST** default, PUT only if authored | mapping is non-obvious → not a renamed verb |
| Lens/Iso | — | GET + inverse-node (no single verb) | HTTP can't see it → upstream of HTTP |
| Transform | POST | POST (fixed anchor) | rhymes |
| — | PATCH | **nothing** maps here | PATCH re-expressed as *partiality modifier* |

**Verdict: PARTIAL PASS, honestly.** Genuine divergences prove the layer is not
reverse-engineered from verbs:
- **Produce, Lens-forward, and pure Folds ALL project to GET** (3 kinds → 1 verb):
  the categorical layer is *finer-grained* than HTTP, so it wasn't back-derived
  from HTTP's coarser joints.
- **Endo → POST, not PUT**: the naive verb expectation is wrong, which it wouldn't
  be if these were verbs in disguise.
- **No kind maps to PATCH.** PATCH is re-expressed as a *modifier* (partiality) on
  Endo/Replace — the categorical joints are cut differently from HTTP's.
- **Iso/Lens has no single verb** — a distinction HTTP literally cannot represent.

BUT do not overclaim: **Fold-as-DELETE** and **Endo-authored-as-PUT** are seams
where, if you squint, the set re-traces the verbs. So: distinct at the joints,
with two seams that rhyme with verbs. Not a clean pass.

## 5. Weakest points a red team should hit

**W1 — Addressing-stripping pushes the real distinctions into the args, exactly
where HTTP verbs also live.** Once the address is factored into the tree, most ops
collapse to `()=>T` (Produce) or `T=>T` (Endo), and the interesting differences
(view-vs-element, replace-vs-update-vs-invoke) migrate into the *arguments* and
into *authoring*. That is the same locus where the HTTP verb distinction lives, so
the framing may be re-deriving the verb set through the back door while calling it
"authored". The heavy reliance on the "authored" escape hatch concedes that the
function's TYPE does not determine the kind — which directly weakens the
"inferable from type" mandate.

**W2 — Endo is overloaded and Fold is fuzzy.** `T => T` absorbs replace (PUT),
patch (PATCH), and invoke (POST) into one bucket, disambiguated ONLY by authoring;
if the load-bearing distinctions are all authored, the *algebra* isn't doing the
work — taste is. Separately, Fold's boundary is soft: only `T => ()` is
categorically crisp; `T => summary` is just a Transform with a small codomain, so
Fold is partly a judgement call, not a clean categorical kind. Two of five kinds
being this soft is the thinnest part of the set.
