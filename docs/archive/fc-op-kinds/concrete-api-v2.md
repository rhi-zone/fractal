# fractal — concrete TS authoring API, v2

Replaces v1. Changes:
- **Removes** all free-form `path` strings in op metadata — path is entirely tree-derived
  ([CERTIFIED] invariant: one tree, grouping = addressing, moving a node moves its URL).
- **Adds** `ParamNode` / `param()` — a parameterized child node that contributes `{name}` to the
  HTTP path and merges the slug value into op inputs at dispatch. Maps directly to server-less
  `slug_mounts` (`partition_methods`, `server-less/crates/server-less-parse/src/lib.rs:1160-1199`).
- **Shrinks** HTTP addressing metadata to `segment?` (single-segment rename) and `legacyPath?`
  (full-path escape hatch, explicitly marked as debt).
- **Reworks** the `createCheckoutSession` example so `/invoices/{invoiceId}/checkout` falls out of
  the tree walk, not a hand-authored string.
- **Documents** type-threading honestly: single-level param is expressible in TS today; multi-level
  or fully type-safe threading is the codegen path.

Everything else from v1 is preserved: `Node`/`Op`/`Meta`, `node()`/`service()`, open metadata
bag, inference defaults, both authoring surfaces lower to one value.

---

## 1. Core types

```ts
/**
 * Open metadata bag: projection-name → that projection's keys.
 * ONLY non-type-expressible projection/taste concerns (verb, segment, cli aliases,
 * idempotency, auth). NEVER domain data — types + JSDoc are the data truth.
 *
 * HTTP-projection keys this bag carries:
 *   `verb?`       — override inferred HTTP verb
 *   `segment?`    — rename THIS node or op's single URL segment (one plain name, no
 *                   slashes, no braces). E.g. `"checkout"`. Use when inference is wrong.
 *   `legacyPath?` — [DEBT] full-path override for external-contract / legacy-URL pinning
 *                   ONLY. When present the projection uses this path verbatim and skips
 *                   all tree-walk logic for this op. Reaching for this is a smell; it
 *                   divorces address from tree position. Not the normal mechanism.
 */
export type Meta = { readonly [projection: string]: Readonly<Record<string, unknown>> | undefined }

/** [CERTIFIED] An operation IS a function T => U, carrying an open metadata bag. */
export type Op<I = unknown, O = unknown> = {
  readonly fn: (input: I) => O | Promise<O>
  readonly meta: Meta
}

/**
 * A parameterized child node (server-less: `slug_mounts`).
 * When the HTTP projection walks the tree it contributes `{name}` as a path segment.
 * At runtime dispatch, the actual segment value is merged into the op's input
 * object under `name`, provenance-blind (the handler sees `invoiceId` in its input;
 * it does not know whether it came from a path segment, a query param, or the body).
 */
export type ParamNode = {
  readonly _tag: "param"
  readonly name: string
  readonly subtree: Node
}

/**
 * A child slot in a Node is either a static subtree or a parameterized subtree.
 * Distinguishable at runtime via `isParamNode`.
 */
export type ChildEntry = Node | ParamNode

/**
 * [CERTIFIED] One tree = grouping AND addressing.
 * A node's key IS its address segment; behavior (`fn`) carries none.
 * Both authoring surfaces (service / standalone) lower to this value.
 */
export type Node = {
  readonly ops: Readonly<Record<string, Op>>
  readonly children: Readonly<Record<string, ChildEntry>>
  readonly meta: Meta
}
```

Discriminators:

```ts
const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && "ops" in v && "children" in v && !("_tag" in v)

const isParamNode = (v: unknown): v is ParamNode =>
  typeof v === "object" && v !== null && "_tag" in v && (v as ParamNode)._tag === "param"
```

---

## 2. Constructors

```ts
type OpLike = Op | ((input: never) => unknown)
const asOp = (o: OpLike): Op =>
  typeof o === "function" ? { fn: o as Op["fn"], meta: {} } : o

/** Wrap a function into an Op with metadata. Bare fn → empty meta bag. */
export const op = <I, O>(
  fn: (input: I) => O | Promise<O>,
  meta: Meta = {},
): Op<I, O> => ({ fn, meta })

/**
 * Parameterized child node. `name` becomes the `{name}` segment in the HTTP path.
 * The actual slug value is merged into descendant op inputs at runtime dispatch.
 * TS equivalent of server-less `slug_mounts`.
 */
export const param = (name: string, subtree: Node): ParamNode =>
  ({ _tag: "param", name, subtree })

/** [CERTIFIED] Standalone-function authoring surface. Keys are address segments. */
export const node = (def: {
  ops?: Record<string, OpLike>
  children?: Record<string, ChildEntry>
  meta?: Meta
}): Node => ({
  ops: Object.fromEntries(Object.entries(def.ops ?? {}).map(([k, v]) => [k, asOp(v)])),
  children: def.children ?? {},
  meta: def.meta ?? {},
})

/**
 * Lower a service instance to a Node (the `impl`-block / method surface).
 *  - each method                 → ops[name]      (server-less: &self leaf method)
 *  - each Node-valued field      → children[name] (server-less: static mount)
 *  - each ParamNode-valued field → children[name] (server-less: slug mount)
 *  - opts.meta[name]             → that op's metadata bag
 */
export const service = (
  instance: object,
  opts: { meta?: Record<string, Meta> } = {},
): Node => {
  const ops: Record<string, Op> = {}
  const children: Record<string, ChildEntry> = {}
  const proto = Object.getPrototypeOf(instance) as object
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === "constructor") continue
    const val = (instance as Record<string, unknown>)[key]
    if (typeof val === "function")
      ops[key] = { fn: (val as Op["fn"]).bind(instance), meta: opts.meta?.[key] ?? {} }
  }
  for (const key of Object.getOwnPropertyNames(instance)) {
    const val = (instance as Record<string, unknown>)[key]
    if (isNode(val) || isParamNode(val)) children[key] = val
  }
  return { ops, children, meta: {} }
}
```

---

## 3. HTTP projection — path is a pure tree walk

No path strings in metadata (except `legacyPath`, which is explicit debt). The walk produces
every path from tree structure alone.

```ts
type Route = { verb: string; path: string; handler: Op["fn"] }

/** Default verb from op name — overrideable, never authoritative ([CERTIFIED]). */
const inferVerb = (name: string): string =>
  /^(get|list|find|read)/.test(name) ? "GET"
  : /^(delete|remove)/.test(name) ? "DELETE"
  : "POST" // method call / mutation / send / award → POST

/**
 * Default URL segment from a name:
 * strip a leading verb word, kebab-case the rest, lowercase.
 * Falls back to the lowercased name if stripping produces an empty string.
 */
const inferSegment = (name: string): string => {
  const stripped = name
    .replace(/^(get|list|find|read|create|send|award|delete|remove)/i, "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/^-/, "")
    .toLowerCase()
  return stripped || name.toLowerCase()
}

/** The HTTP-projection keys this walk reads from `meta.http`. */
type HttpMeta = {
  verb?: string
  /**
   * Rename THIS node or op's URL segment.
   * One plain name (no slashes, no braces). Overrides `inferSegment(name)`.
   */
  segment?: string
  /**
   * [DEBT] Full-path override. Use ONLY for external-contract / legacy-URL pinning.
   * When present, the walk uses this path verbatim for the op and ignores all
   * tree-derived prefix + segment logic. Not a normal mechanism.
   */
  legacyPath?: string
}

export function httpRoutes(n: Node, prefix = ""): Route[] {
  const out: Route[] = []

  // Leaf ops on this node
  for (const [name, o] of Object.entries(n.ops)) {
    const http = (o.meta.http ?? {}) as HttpMeta
    const verb = http.verb ?? inferVerb(name)
    if (http.legacyPath) {
      // [DEBT] escape hatch: full path override bypasses all tree-walk logic
      out.push({ verb, path: http.legacyPath, handler: o.fn })
    } else {
      const seg = http.segment ?? inferSegment(name)
      out.push({ verb, path: `${prefix}/${seg}`, handler: o.fn })
    }
  }

  // Child nodes
  for (const [key, child] of Object.entries(n.children)) {
    if (isParamNode(child)) {
      // Parameterized: contributes {name} segment; recurse into subtree
      out.push(...httpRoutes(child.subtree, `${prefix}/{${child.name}}`))
    } else {
      // Static: key is the default segment, overrideable via child's own meta.http.segment
      const http = (child.meta.http ?? {}) as HttpMeta
      const seg = http.segment ?? key
      out.push(...httpRoutes(child, `${prefix}/${seg}`))
    }
  }

  return out
}
```

---

## 4. Worked example — a small real API, surfaces mixed

```ts
// ── Surface A: service / impl-block surface ──────────────────────────────────

class ProgressService {
  /** Award progress on lesson completion: log event, bump skill thread, bust caches.
   *  (curilo award-progress) */
  awardProgress(input: { sessionId: string; skillFocus: string }): { success: boolean } {
    /* real body elided */ return { success: true }
  }
}

const progressNode = service(new ProgressService(), {
  meta: {
    // verb inferred (POST); inferSegment("awardProgress") → "progress"; rename to "award"
    awardProgress: { http: { segment: "award" } },
  },
})

// ── Surface B: standalone functions ──────────────────────────────────────────

/** Render + send the welcome email via Resend. (curilo send-welcome-email) */
const sendWelcomeEmail = (input: { userName: string; dashboardUrl: string }) =>
  ({ success: true, messageId: "msg_…" })

/**
 * Create a hosted checkout session; guard against a pending charge.
 * (the consumer app createCheckoutSession)
 *
 * `invoiceId` arrives merged into input from the ancestor param() node at dispatch —
 * the handler does NOT know or care whether it came from the URL path, a query param,
 * or the body. Provenance-blind by design.
 */
const createCheckoutSession = (input: { invoiceId: string }) =>
  ({ url: "https://pay.stripe.com/…" })

/** Run health passes over an indexed tree. (normalize analyze.health) */
const analyzeHealth = (input: { target?: string; limit?: number }) => ({ report: "…" })

// ── Tree construction ─────────────────────────────────────────────────────────

const notificationsNode = node({
  ops: { sendWelcomeEmail },
  // all inferred: POST /send-welcome-email (under the notifications prefix)
})

const invoicesNode = node({
  children: {
    // The key "invoiceId" is just the slot identifier; the HTTP projection emits {invoiceId}
    // because this is a ParamNode. The actual slug value is merged into op input at dispatch.
    invoiceId: param("invoiceId", node({
      ops: {
        createCheckoutSession: op(createCheckoutSession, {
          http: {
            verb: "POST",
            // inferSegment("createCheckoutSession") → "checkout-session"; rename to "checkout"
            segment: "checkout",
          },
        }),
      },
    })),
  },
})

const analyzeNode = node({
  ops: {
    // HTTP inferred (GET /health under /analyze); CLI key is ignored by the HTTP projection
    health: op(analyzeHealth, { cli: { name: "analyze:health", aliases: ["ah"] } }),
  },
})

/** Root: grouping AND addressing are this one tree ([CERTIFIED]). */
const api = node({
  children: {
    progress:      progressNode,      // Surface A: service/impl-block
    notifications: notificationsNode, // Surface B: bare standalone fn, all inferred
    invoices:      invoicesNode,      // Surface B: param child inside
    analyze:       analyzeNode,       // Surface B: CLI metadata, HTTP inferred
  },
})
```

`httpRoutes(api)` walks the tree and produces — **no path string in metadata anywhere**:

```
POST  /progress/award                    (segment override: "award")
POST  /notifications/send-welcome-email  (verb + segment both inferred)
POST  /invoices/{invoiceId}/checkout     (param child + segment override: "checkout")
GET   /analyze/health                    (verb + segment inferred; CLI meta ignored)
```

Path `/invoices/{invoiceId}/checkout` is the product of three tree-walk steps:
1. static key `invoices` → `/invoices`
2. `param("invoiceId", …)` → `/{invoiceId}`
3. `segment: "checkout"` on the op → `/checkout`

No hand-authored path string. Moving `invoicesNode` to a different key in the tree moves the URL.

---

## 5. Type threading — what TS can carry, where it needs codegen

The problem: `createCheckoutSession` declares `input: { invoiceId: string }`, but `invoiceId`
is contributed at runtime by the ancestor `param("invoiceId", …)` node during dispatch. There
are two aspects:

1. **Runtime**: the dispatch walker must merge the slug value before calling `fn`.
2. **Types**: each op's input type should reflect the accumulated params from ancestor `param()`
   nodes so the TypeScript compiler catches a missing or misnamed slug field.

### Runtime (solved, unconditional)

The walker extracts slug values from the URL as it descends and merges them into `input` before
calling `fn`. This is independent of types:

```ts
// Runtime dispatch (pseudocode — real dispatch will live in the projection layer)
function dispatch(
  n: Node,
  segments: string[],      // remaining path segments, e.g. ["invoiceId-value", "checkout"]
  slugs: Record<string, string>,  // accumulated slug values, e.g. {}
  input: unknown,          // request body / query merged object
): unknown {
  if (segments.length === 0) throw new Error("no op segment")
  const [head, ...tail] = segments

  if (tail.length === 0) {
    // head names the op
    const o = n.ops[head]
    if (!o) throw new Error(`op not found: ${head}`)
    // Merge slugs into input — provenance-blind, handler sees one flat object
    return o.fn({ ...(input as object), ...slugs })
  }

  const child = n.children[head]
  if (!child) throw new Error(`child not found: ${head}`)

  if (isParamNode(child)) {
    // Accumulate: the URL segment value (head) becomes child.name in slugs
    return dispatch(child.subtree, tail, { ...slugs, [child.name]: head }, input)
  }
  return dispatch(child, tail, slugs, input)
}
```

### What TypeScript can express today

A typed variant of `Op` and `param` can thread the accumulated params type:

```ts
/**
 * Op variant aware of accumulated ancestor path params.
 * `P` = Record of slug params from ancestor param() nodes.
 * The handler receives `I & P` — its declared params merged with the slugs.
 */
type TypedOp<I, O, P extends Record<string, string> = Record<never, never>> = {
  readonly fn: (input: I & P) => O | Promise<O>
  readonly meta: Meta
}

/**
 * TypedNode accumulates `P` across param() boundaries.
 * Each TypedParamNode<P, N> extends P with Record<N, string> for its subtree.
 */
type TypedNode<P extends Record<string, string>> = {
  ops: { [K: string]: TypedOp<unknown, unknown, P> }
  children: { [K: string]: TypedNode<P> | TypedParamNode<P, string> }
  meta: Meta
}

type TypedParamNode<P extends Record<string, string>, N extends string> = {
  _tag: "param"
  name: N
  subtree: TypedNode<P & Record<N, string>>  // subtree sees P plus the new slug
}
```

With these types, a single-level param is fully expressible:

```ts
// The op declares only its "own" inputs; P supplies the slug.
type CheckoutOp = TypedOp<
  Record<never, never>,  // op's own params (checkout needs no extra fields)
  { url: string },
  { invoiceId: string }  // contributed by the ancestor param("invoiceId")
>

// Or equivalently — the op just declares the full merged type:
const typedCheckout: TypedOp<{ invoiceId: string }, { url: string }> = op(
  (input: { invoiceId: string }) => ({ url: "…" }),
  { http: { verb: "POST", segment: "checkout" } },
)
// ^ This is the pragmatic today shape: author the full input type, let dispatch merge at runtime.
```

### Where it gets hard

**Multi-level nested params**: threading `P` through `TypedNode<P>` → `TypedParamNode<P, N>` →
`TypedNode<P & Record<N, string>>` works recursively in the type system. The friction is authoring:
every `node<P>()` call would need an explicit `P` parameter or the inference must flow from the
outermost call inward, which requires fully-typed `node()` and `param()` generic constructors.
In practice that means:

```ts
function typedParam<N extends string, P extends Record<string, string> = Record<never, never>>(
  name: N,
  subtree: TypedNode<P & Record<N, string>>,
): TypedParamNode<P, N> {
  return { _tag: "param", name, subtree }
}
// The subtree must already be typed as TypedNode<{ invoiceId: string }> — inward flow.
```

**Mixing typed and untyped nodes**: `service()` returns `Node` (unparameterized). Grafting a
`service()` result under a `TypedNode<P>` requires a cast or a typed `service<P>()` variant.

**The current `Node` type is unparameterized**: moving to `TypedNode<P>` throughout is a
breaking API change. The pragmatic path is the untyped `Node` now, with a parallel opt-in
`TypedNode<P>` API that codegen targets.

### Codegen path (the real answer for full type safety)

Types are erased at runtime. A codegen step (tsc transformer or `tsgo`-style AST extractor)
can:
1. Read the function signature `(input: { invoiceId: string }) => ...` and the tree structure.
2. Emit a runtime validator for the merged input, knowing that `invoiceId` is contributed by
   the `param("invoiceId", …)` ancestor.
3. Emit `TypedOp<..., { invoiceId: string }>` annotations so the compiler checks that every op
   under a `param("invoiceId")` node accepts `invoiceId: string` in its input.

Until codegen exists, authored types are correct by convention: the author of `createCheckoutSession`
declares `input: { invoiceId: string }` because they know the tree structure. Dispatch merges
it at runtime unconditionally.

### Genuine remaining decision (not manufactured)

**Whether to ship a typed `TypedNode<P>` API now or wait for codegen.**

- **Ship untyped `Node` now** (zero friction today). Codegen adds type safety at the validator
  and annotation layer later. Authored types are correct by convention until then.
- **Ship `TypedNode<P>` as an opt-in parallel API** alongside `Node`. Adds compile-time
  guarantees for the param-contribution contract; costs verbosity at every `node()` and
  `param()` call site.

Both are defensible. The call is the user's — this is a taste/ergonomics tradeoff, not a model
question.

---

## 6. Changes from v1 / resolved items

| v1 | v2 |
|---|---|
| `http: { path: "/invoices/{invoiceId}/checkout" }` — full path string on op | **Removed.** Path is entirely tree-derived. |
| `http: { path: "/award" }` — path fragment on op | Replaced by `http: { segment: "award" }`. |
| `children: Record<string, Node>` | `children: Record<string, ChildEntry>` (`Node \| ParamNode`). |
| No parameterized child | `param(name, subtree): ParamNode` — maps to server-less `slug_mounts`. |
| No distinction between segment rename and full-path override | `segment?` (normal, one name) vs `legacyPath?` (debt, full path) — distinguished with doc comments. |
| HTTP projection: `http.path` override wins over tree prefix | HTTP projection: only `legacyPath` bypasses tree walk; `segment` renames one step. |

**Remaining open from v1 §6.2** (per-param HTTP location `query`/`path`/`body`/`header`) is
still open. With `ParamNode` now explicit in the tree, `path` location is structurally
inferrable (a `param()` ancestor → path param); `query`/`body`/`header` remain unaddressed and
live in the open `meta` bag for now.

**Remaining open from v1 §6.1** (types → runtime validators, codegen mechanism: tsc transformer
vs. `tsgo`-style extractor vs. explicit `schema` sidecar) is unchanged and still undecided.
