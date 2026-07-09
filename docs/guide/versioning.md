# Versioning Guide

> **Status: DESIGN — not yet implemented.** Describes the intended versioning model; only the
> pieces noted as "exists today" are built.

---

## Overview

Fractal's versioning model is deliberately layered: the simplest case needs zero new machinery,
and richer strategies opt in progressively. No single strategy is prescribed; the default is
intentionally minimal.

The vocabulary below assumes familiarity with attribute-dispatch and `compose` from the
[router model](../design/router-model.md).

---

## The default: version is just input (build nothing)

The version is an ordinary input value. A projection extracts it (from a header, query
parameter, or date) and passes it into the handler's input, provenance-blind. The handler —
arbitrary code — does whatever it wants with it.

This is the most general option: it handles any version difference, imposes no expressiveness
limits, and requires zero new machinery — it is already "handler is a function of its input."

Exact-match version **dispatch** (e.g., `X-Api-Version: v2` routing to a `v2` subtree) also
already works via attribute-dispatch. **Exists today.**

---

## Optional: isolate version logic via composed transforms

When versioning is pervasive or systematic and you want it **out of the handler**, model it as a
composition of transforms (Stripe/Cloudflare style):

- The handler operates on an **internal superset** shape — the union of everything all supported
  versions need. Every wire version (latest included) is a projection of it. This is what handles
  a newer version that *removed* richness an old client still needs: the superset keeps computing
  it; that version's projection just drops it.
- A **version is a composition of transforms against the superset** — `up` (migrate a request
  forward to the superset shape) and `down` (project a response back to the wire shape). Request
  flow: compose the applicable `up`s from the client's pinned version to current, run the handler,
  compose the `down`s back.

---

## Shapes (named composition-structures over transforms)

All shapes are just `compose` over `T => U` functions. Ship common ones as opt-in helpers:

### chain (linear diffs)
One delta per bump, composed sequentially, each reused by older versions. DRY on increments;
coupled; assumes linear history.

### star (independent projections from the superset)
Each version is its own standalone `up`/`down` pair. Independent, easy to reason about in
isolation, handles non-linear history. DRY recovered via shared helper functions.

### tree (branching)
Non-linear history and parallel tracks. Deltas are shared on a trunk and diverge at branches.
`chain` = a single-line tree; `star` = an all-independent tree. Use when parallel version tracks
need to share partial migrations.

### aspect / feature-composition
A version is expressed as a set of composed feature-deltas (a DAG or lattice), not a point on a
line. Useful when versions are better described by capability flags than by a linear sequence.

### lens
Where version ↔ superset is invertible, each version is one lens (`up = get`, `down = put`),
guaranteeing round-trip fidelity. Strongest correctness guarantee; requires full invertibility.

### tiered directionality
The *tier* of a change determines how much transform you need:

| Tier | Character | Transform needed |
|------|-----------|-----------------|
| breaking ("major") | Old shape invalid | Full `up` + `down` |
| additive ("minor") | Old requests still valid, new fields added | `down`-only (hide new fields for old clients) |
| patch | No shape change | Identity (no transform) |

Under a **tolerant reader** (client ignores unknown fields), minor/additive steps need **no
transform at all**; only a strict "never send unrequested fields" contract needs the
down-projection.

---

## Big steps / little steps (free)

Any transform can be factored into big-steps-made-of-little-steps to arbitrary depth, chosen
purely for authoring simplicity.

Because `compose` is associative and n-ary, the nesting flattens to one pipeline at runtime with
**zero extra machinery and zero runtime cost**. Little steps are just functions — shareable across
big steps (DRY). The decomposition is invisible outward; clients still pin at named versions.

---

## Handling loss

**down-loss** (new response → old shape drops new richness): benign and expected — old clients
should not see features they do not understand.

**up-loss** (old request → current shape cannot represent it): three cases:

1. **Inert dropped data**: the `up` transform stashes it in a passthrough bag; the `down`
   transform restores it. No handler involvement needed.
2. **Behaviorally meaningful dropped data**: fall back to **dispatch** — route to a
   version-specific handler via attribute-dispatch. The superset model does not help here; the
   behaviour difference must be handled explicitly.
3. **Genuinely removed capability**: a real breaking change. No versioning scheme recovers it;
   the capability is gone.

---

## What's actually new to build

Only the **version selector / matcher**:

- extract the version token from the request (header, query parameter, date field)
- match by **exact value**, or by an **ordered date-matcher** (Cloudflare/Stripe style: select
  the latest version ≤ the client's pinned date)

The transform side needs approximately nothing — it is `compose` + the superset pattern + optional
shape-helpers.

Ship everything as **opt-in, droppable batteries**. The default stays "version is input." Nothing
is forced; no single strategy is prescribed.
