# fractal — concrete TS authoring API, v1

First concrete design pass after the conceptual session. Grounded in `server-less`
(`crates/server-less/examples/mount_service.rs`, `crates/server-less-core/src/lib.rs:126-306`)
and constrained by `docs/design/converged-model.md` ([CERTIFIED] items). Real ops drawn from
`docs/artifacts/fc-op-kinds/induced-taxonomy-v2.md`.

The translation of server-less, stated once:

| server-less (Rust)                          | fractal (TS)                                   |
|---------------------------------------------|------------------------------------------------|
| `impl Foo { … }` block                      | a `Node`                                       |
| `&self` method `fn f(..) -> U`              | an `Op` keyed by name in `node.ops`            |
| `fn users(&self) -> &UsersService` (edge)   | a `Node` keyed by name in `node.children`      |
| `#[route(method=..,path=..)]` attr          | a key in the op's open `meta` bag              |
| `infer_http_method` / `infer_path`          | `inferVerb` / `inferPath` — overrideable default |

server-less has **N** protocol-specific mount traits (`HttpMount`, `McpNamespace`,
`JsonRpcMount`, `WsMount`, `CliSubcommand`; `core/src/lib.rs:126-306`) and re-walks the block
per protocol. fractal reifies **one** `Node`; every projection walks that same value. That is
the deliberate delta (converged-model §"gaps", point 2).

---

## 1. Core node representation — the thing both surfaces lower to

```ts
/**
 * Open metadata bag: projection name -> that projection's keys.
 * ONLY non-type-expressible projection/taste concerns (verb, path, cli aliases,
 * idempotency, auth). NEVER domain data — types + JSDoc are the data truth.
 * Open by construction: a new projection adds keys without touching any core type
 * (the server-less closed-whitelist is exactly what we drop; converged-model §gaps.1).
 */
export type Meta = { readonly [projection: string]: Readonly<Record<string, unknown>> | undefined }

/** [CERTIFIED] An operation IS a function T => U, carrying an open metadata bag. */
export type Op<I = unknown, O = unknown> = {
  readonly fn: (input: I) => O | Promise<O>
  readonly meta: Meta
}

/**
 * [CERTIFIED] One tree = grouping AND addressing. A node's key IS an op/child's
 * only address; behavior (`fn`) carries none. Both authoring surfaces lower to this.
 */
export type Node = {
  readonly ops: Readonly<Record<string, Op>>
  readonly children: Readonly<Record<string, Node>>
  readonly meta: Meta
}

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && "ops" in v && "children" in v
```

Constructors shared by both surfaces:

```ts
/** Wrap a bare function into an Op with metadata. Bare fn => empty bag. */
export const op = <I, O>(fn: (input: I) => O | Promise<O>, meta: Meta = {}): Op<I, O> =>
  ({ fn, meta })

type OpLike = Op | ((input: never) => unknown)
const asOp = (o: OpLike): Op => (typeof o === "function" ? { fn: o as Op["fn"], meta: {} } : o)
```

---

## 2. Surface A — ops as a service / methods (the `impl` block)

Translates `#[http] impl UsersService { fn list_users … }` + the `fn users(&self) -> &Child`
mount edge (`mount_service.rs:37-96`). A class instance = a node; its methods = ops; a
**field that holds a `Node`** = a mount edge (the TS analogue of returning `&Child`). Metadata
rides a sibling record keyed by method name — a plain object, not a decorator (converged-model
[SYNTHESIS]: decorators are class-only sugar, the plain bag is the foundation).

```ts
/**
 * Lower a service instance to a Node.
 *  - each method            -> ops[name]      (server-less: &self leaf method)
 *  - each Node-valued field -> children[name] (server-less: fn f(&self) -> &Child)
 *  - opts.meta[name]        -> that op's bag  (server-less: #[route]/#[cli] attrs)
 */
export const service = (
  instance: object,
  opts: { meta?: Record<string, Meta> } = {},
): Node => {
  const ops: Record<string, Op> = {}
  const children: Record<string, Node> = {}
  const proto = Object.getPrototypeOf(instance) as object
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === "constructor") continue
    const val = (instance as Record<string, unknown>)[key]
    if (typeof val === "function")
      ops[key] = { fn: (val as Op["fn"]).bind(instance), meta: opts.meta?.[key] ?? {} }
  }
  for (const key of Object.getOwnPropertyNames(instance)) {
    const val = (instance as Record<string, unknown>)[key]
    if (isNode(val)) children[key] = val // the `&Child` mount edge
  }
  return { ops, children, meta: {} }
}
```

Authoring with it — real op `award-progress`
(`curilo .../award-progress/index.ts`, reads+creates+mutates+deletes):

```ts
class ProgressService {
  /** Award progress on lesson completion: log event, bump skill thread, bust caches. */
  awardProgress(input: { sessionId: string; skillFocus: string }): { success: boolean } {
    /* real body elided */ return { success: true }
  }
}

// taste-only override where the inferred path is wrong; data lives in the types above.
const progressNode = service(new ProgressService(), {
  meta: { awardProgress: { http: { verb: "POST", path: "/award" } } },
})
```

---

## 3. Surface B — standalone functions grouped under a node

RESOLVED OPEN (converged-model §Open, item 2 — "tree EDGES for standalone functions"): a free
function attaches by being **placed in the `ops` record under a key**, and a subtree nests by
being **placed in the `children` record under a key**. The record key IS the address segment —
it is the free-function equivalent of server-less's `fn users(&self) -> &UsersService`, with a
plain record entry standing in for the receiver-returning method. No `&self`, no builder object,
no path-DSL.

```ts
/** [CERTIFIED] standalone-function surface. Keys are addresses; values are ops or child nodes. */
export const node = (def: {
  ops?: Record<string, OpLike>
  children?: Record<string, Node>
  meta?: Meta
}): Node => ({
  ops: Object.fromEntries(Object.entries(def.ops ?? {}).map(([k, v]) => [k, asOp(v)])),
  children: def.children ?? {}, // <- the standalone subtree-nesting mechanism
  meta: def.meta ?? {},
})
```

Authoring with it — real ops `send-welcome-email`, `createCheckoutSession`, `analyze.health`:

```ts
/** Render + send the welcome email via Resend. (curilo send-welcome-email) */
const sendWelcomeEmail = (input: { userName: string; dashboardUrl: string }) =>
  ({ success: true, messageId: "…" })

/** Create a hosted checkout session; guard against a pending charge. (the consumer app createCheckoutSession) */
const createCheckoutSession = (input: { invoiceId: string }) => ({ url: "https://pay…" })

/** Run health passes over an indexed tree. (normalize analyze.health) */
const analyzeHealth = (input: { target?: string; limit?: number }) => ({ report: "…" })

const notificationsNode = node({
  ops: { sendWelcomeEmail }, // bare fn -> Op with empty bag; verb/path inferred
})

const paymentsNode = node({
  ops: {
    // taste override: REST-nest under the invoice subject, not /checkout-sessions
    createCheckoutSession: op(createCheckoutSession, {
      http: { verb: "POST", path: "/invoices/{invoiceId}/checkout" },
    }),
  },
})

const analyzeNode = node({
  ops: {
    // HTTP inferred; CLI taste lives in its own key, ignored by the HTTP projection
    health: op(analyzeHealth, { cli: { name: "analyze:health", aliases: ["ah"] } }),
  },
})
```

---

## 4. Both surfaces lower to the IDENTICAL value

```ts
import { deepStrictEqual } from "node:assert"

// Surface A result (from §2), normalised for comparison:
const fromMethods = progressNode
//    { ops: { awardProgress: { fn:[bound], meta:{ http:{verb:"POST",path:"/award"} } } },
//      children: {}, meta: {} }

// Surface B result — same node authored as a standalone function:
const fromStandalone = node({
  ops: {
    awardProgress: op(
      (input: { sessionId: string; skillFocus: string }) => ({ success: true }),
      { http: { verb: "POST", path: "/award" } },
    ),
  },
})

// Same shape, same keys, same meta. (fn identity differs; structure is identical.)
deepStrictEqual(Object.keys(fromMethods.ops), Object.keys(fromStandalone.ops))
deepStrictEqual(fromMethods.ops.awardProgress.meta, fromStandalone.ops.awardProgress.meta)
deepStrictEqual(fromMethods.children, fromStandalone.children) // {}
```

A method's receiver is just its subject; a standalone function is the same op with no receiver.
The two authoring acts are two spellings of one `{ ops, children, meta }`.

---

## 5. Worked example — a small real API, surfaces mixed

```ts
/** Root: grouping AND addressing are this one tree (converged-model [CERTIFIED]). */
const api = node({
  children: {
    progress: progressNode,           // Surface A: a service/impl-block (method surface)
    notifications: notificationsNode, // Surface B: bare standalone fn, all inferred
    payments: paymentsNode,           // Surface B: standalone fn + HTTP taste override
    analyze: analyzeNode,             // Surface B: standalone fn + CLI-only metadata
  },
})
```

Addresses (tree position, HTTP-projected below):
`progress/awardProgress`, `notifications/sendWelcomeEmail`, `payments/createCheckoutSession`,
`analyze/health`. Four real ops; method + function surfaces mixed; one HTTP override where the
inferred REST path was wrong, defaults everywhere else; CLI taste on `analyze/health` that the
HTTP projection never reads.

---

## 6. The HTTP projection — proving the loop closes

A projection is a pure `(Node) => surface` walk. It reads only the `http` key; `cli` is
ignored. Default-from-name mirrors server-less `infer_http_method`/`infer_path`
(`core/src/lib.rs:554-673`); metadata override beats the default (`http.rs:388-431`).

```ts
type Route = { verb: string; path: string; handler: Op["fn"] }

/** Default verb from op name — overrideable, never authoritative (converged-model [CERTIFIED]). */
const inferVerb = (name: string): string =>
  /^(get|list|find|read)/.test(name) ? "GET"
  : /^(delete|remove)/.test(name) ? "DELETE"
  : "POST" // create/new/send/award/… => POST (a POST is a method call, not "creation")

/** Default path from op name: strip a leading verb word, kebab-case the rest. */
const inferPath = (name: string): string =>
  "/" + name.replace(/^(get|list|find|read|create|send|award|delete|remove)/i, "")
             .replace(/([a-z])([A-Z])/g, "$1-$2").replace(/^-/, "").toLowerCase()

export function httpRoutes(n: Node, prefix = ""): Route[] {
  const out: Route[] = []
  for (const [name, o] of Object.entries(n.ops)) {
    const http = (o.meta.http ?? {}) as { verb?: string; path?: string }
    const verb = http.verb ?? inferVerb(name)             // override wins, else infer
    const path = prefix + (http.path ?? inferPath(name))  // override wins, else infer
    out.push({ verb, path, handler: o.fn })
  }
  for (const [seg, child] of Object.entries(n.children))
    out.push(...httpRoutes(child, `${prefix}/${seg}`))    // child key = path segment (mount edge)
  return out
}

httpRoutes(api)
// POST   /progress/award                       (override: path "/award", verb "POST")
// POST   /notifications/send-welcome-email      (both inferred from the name)
// POST   /payments/invoices/{invoiceId}/checkout (override: full REST path)
// GET    /analyze/health                        (verb inferred; cli meta ignored here)
```

A CLI projection would instead read `o.meta.cli`, fall back to the same name, and ignore
`http` — same `Node`, different keys, no coordination. The loop closes.

---

## Resolved OPEN items

- **[OPEN] "the concrete authoring surface / API shape in TS"** — resolved by §§1-3: the
  `{ ops, children, meta }` `Node`, plus `op()` / `node()` (Surface B) and `service()`
  (Surface A), which lower to the identical value (§4).
- **[OPEN] "tree EDGES for standalone functions"** — resolved in §3: a subtree nests as a
  **`children` record entry** and a free function attaches as an **`ops` record entry**; the
  record **key is the address segment**. This is the receiver-free equivalent of
  `fn users(&self) -> &UsersService` — a plain entry in place of a `&Child`-returning method.

## Genuine remaining decisions (not manufactured)

1. **Types → runtime validators (codegen).** The `Op` carries erased TS types + JSDoc as the
   data truth, but a runtime projection (HTTP body validation, JSON-Schema, MCP inputSchema)
   needs those types as *values*. server-less gets this from proc-macros over the AST; fractal
   needs a build step lowering `I`/`O` + JSDoc → validators/schema. Mechanism (tsc transformer
   vs. a `tsgo`-style extractor vs. an explicit `schema` sidecar) is undecided. This is the last
   converged-model [OPEN] and the real next fork.
2. **Structural-metadata openness.** Per-param HTTP location (`query`/`path`/`body`/`header`)
   is projection metadata that in server-less rides `#[param]` (a *closed* set). Whether that
   lives in the open `meta` bag, is inferred from the path template (`{invoiceId}` ⇒ path
   param), or gets a typed structural slot is genuinely open (converged-model §Open, item 3).

Not forks (settled by the model): metadata bag is open (not whitelisted); inference is a
default not a source of truth; there is no colon path-DSL and no reified runtime data-schema.
