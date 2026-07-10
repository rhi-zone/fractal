# Dispatch extensibility model

> **Provenance:** Settled design from working session 2026-07-10. Extends the dispatch model
> in [`router-model.md`](router-model.md).

---

## Core model

### Extensible dispatch kinds

The closed `DispatchMarker` union in `packages/http/src/project.ts` becomes an augmentable
TypeScript interface:

```ts
interface DispatchKinds {
  // batteries and app code augment this
}

type DispatchMarker = DispatchKinds[keyof DispatchKinds]
```

Each key maps to the dispatch data shape for that kind. The derived union `DispatchMarker`
widens automatically when the interface is augmented — no manual union maintenance.

### Batteries export matchers as plain functions

A battery (e.g., `fractal-date-versioning`) exports a matcher function. No type augmentation,
no global registration, no side effects. The battery is just a value.

### Declaration merging goes next to the tree

The developer who authors the tree augments `DispatchKinds` in their application code, next to
the tree file — NOT in the battery, NOT in the projector package. The developer controls the
types at the site where they're used.

### Projector takes a dictionary of matchers + the tree

```ts
httpProjection({ method: m, header: h, date: d }, tree)
```

Dictionary keys are the kind names. Collision is impossible by construction — a dictionary
can't have duplicate keys. Type checking happens at the call site where the tree meets the
projector: the tree's dispatch kinds must be covered by the dictionary keys.

### Runtime dispatch = map lookup by kind

The projector holds a `Record<string, Matcher>` built from the dictionary. At dispatch time:
read `node.meta.http.dispatch.kind`, look up the matcher in the map, call it. The entire
runtime mechanism is a map lookup.

### Matcher signature

```ts
type Matcher = (
  request: Request,
  children: Record<string, Node>,
  dispatchData: any,
) => string | undefined
```

Given the request, the children, and the dispatch config data from the node, returns the child
key to descend into, or `undefined` for no match.

### Matchers take no config

Per-node parameters (which header, which query param) are in the dispatch data on the node.
Per-kind defaults (e.g., "every date-dispatch node reads the same header") are tree transforms
— `(tree) => tree` composition, not matcher config.

### Compiled and runtime resolution both supported

Dispatch supports both compiled and runtime resolution — more flexible than compiled-only.

### Extensible projection namespaces in meta

`meta.http`, `meta.mcp`, etc. are extensible via the same augmentable-interface mechanism.

---

## Full flow — pseudocode

```ts
// --- Battery (separate package) ---
// Exports a plain function. No type augmentation. No side effects.
export const dateMatcher: Matcher = (req, children, data) => {
  const pin = req.headers.get(data.name)
  const sorted = Object.entries(children)
    .map(([key, child]) => ({ key, when: child.meta?.http?.when ?? key }))
    .sort((a, b) => a.when.localeCompare(b.when))
  let best: string | undefined
  for (const { key, when } of sorted) {
    if (when <= pin) best = key; else break
  }
  return best
}

// --- Application code (next to the tree) ---
import { dateMatcher } from "fractal-date-versioning"

// Declaration merging HERE — developer declares what kinds their tree uses
declare module "@rhi-zone/fractal-http" {
  interface DispatchKinds {
    date: { kind: "date"; name: string }
  }
}

const api = node({
  meta: { http: { dispatch: { kind: "date", name: "X-Api-Version" } } },
  children: {
    original: op(readV1, { tags: { readOnly: true }, http: { when: "2024-01-01" } }),
    revised:  op(readV2, { tags: { readOnly: true }, http: { when: "2024-06-01" } }),
  },
})

// --- Projector wiring ---
const fetch = httpProjection({
  method: methodMatcher,
  header: headerMatcher,
  date: dateMatcher,
}, api)
// TypeScript checks: tree's dispatch kinds ⊆ dictionary keys
```

---

## What this supersedes

- The closed `DispatchMarker` union in `packages/http/src/project.ts`.
- The hardcoded if/else dispatch in `buildRoutes` and `matchConditions`.
- Any global-registry or battery-side-augmentation proposals (rejected).
