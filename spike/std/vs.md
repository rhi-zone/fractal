# std vs Hono vs Elysia — head-to-head

The std model: the ONLY framework type is the web standard itself —
`Handler = (req: Request) => Response | undefined | Promise<…>`. Combinators
(`path`, `methods`, `choice`, `mount`, `param`) are plain functions returning a
`Handler`. A typed client is derived from an inert `.meta` the combinators bolt
on (read only at the type level + by the client walker, never on the dispatch
path). Evidence cited below lives in this spike: `std.ts`, `meta.ts`,
`client.ts`, `app.test.ts` (23 assertions), `client.test.ts` (14 + type-level),
`scale/logs/table.md`.

| Criterion | vs Hono | vs Elysia | Verdict |
|---|---|---|---|
| Elegance | One type, plain functions; no `Context`/`c`. | No chained `.get().post()` builder, no `t.Object` DSL. | **Win** |
| HTTP-correctness | Auto-405+`Allow`, auto-HEAD, OPTIONS built into `methods`. | Same. | **Win/parity** |
| Tighter / more general core | Core is one type alias; routing is URL-rewriting. | Far smaller surface. | **Win** |
| Runtime-agnosticism | Pure WHATWG `Request`/`Response`; one `toFetch` adapter. | No Bun coupling. | **Win** |
| Barrier to entry | It's just `fetch`. No framework vocabulary to learn. | No schema-builder to learn. | **Win** |
| Type-safety (typed client at scale) | `hc` is O(N²), crashes stock tsc. Ours is linear, survives. | Eden treaty same blow-up. | **Win** |

## Concrete evidence

**Elegance / tighter core.** A handler is literally `(Request) => Response | undefined`.
There is no `Context` object, no `c.req` / `c.json()` indirection (Hono), no
chained router builder accumulating a `Routes` tuple, and no `Elysia` instance
or `t`-DSL. Params are read straight off the `Request`. `methods`/`path`/`choice`
are ~10-line functions (`std.ts`). The whole framework type surface is one line.

**HTTP-correctness.** `methods` returns 405 with a correct `Allow` header for a
known path + wrong verb, auto-derives HEAD from GET (empty body), and answers
OPTIONS with 204+`Allow` — all proven in `app.test.ts` (`DELETE /users -> 405`,
`Allow` lists GET,POST not DELETE; `HEAD /users -> 200` empty body; `OPTIONS ->
204`). These hold unchanged under the meta-carrying combinators
(`client.test.ts` re-asserts the 405+`Allow` case). Hono and Elysia also do
405/HEAD, so this is parity on behaviour — but ours gets it from a 25-line
`methods` with no router object, which is the tighter-core win.

**Runtime-agnosticism.** The core imports nothing but WHATWG globals; the single
`toFetch(app)` adapter yields `(Request) => Promise<Response>`, which is exactly
what Bun / Deno / Cloudflare / Node (via the standard adapter) want. No
per-runtime code. The typed client's in-process transport (`client.ts::inProcess`)
runs the SAME handler in memory — server and client are one value, no network,
no second code path.

**Barrier to entry.** Nothing to learn beyond `Request`/`Response` you already
know from `fetch`. A handler you can write in isolation IS a valid app; there is
no instance to construct, no decorator/plugin protocol, no context lifecycle.

**Type-safety at scale — the crux.** The typed client (`Client<App>`) is derived
FLAT from `.meta`: a single mapped-type pass over each `path` record's keys (with
`as` key-remapping) and over each `choice` alt union — never an N-deep recursive
fold and never an N-way `UnionToIntersection`. Measured (`scale/logs/table.md`,
reproduce with `cd scale && bun generate.ts && bun run.ts`):

| N | std inst (tsgo) | std inst (stock tsc 6.0.3) | chained baseline A (tsgo) | baseline A (stock tsc) |
|---|---|---|---|---|
| 100 | 15,017 | 13,974 | 58,184 | — |
| 300 | 37,619 | 36,576 | 215,120 | 201,019 (ok) |
| 600 | 71,391 | 70,348 | 675,556 | **CRASH (stack overflow)** |
| 900 | **105,219** | **104,176 (ok)** | **1,406,020** | **CRASH** |

std is **~linear** (≈117 instantiations/route; 9× routes → 7× cost) where the
chained-builder baseline (`docs/design/scale.md` variant A — the Hono-`hc` /
Eden-treaty shape) is **O(N²)** (9× routes → 24× cost) and **crashes stock tsc
between N=300 and N=600**. At 900 routes std is **13× fewer instantiations than A
on tsgo and completes on stock tsc 6.0.3 where A hard-crashes** — the exact
failure mode that sinks `hc` and Eden at scale. This is the headline competitive
result.

**Orthogonal validation.** `validated(schema, fn)` (`meta.ts`) is opt-in and
composes as a plain `Handler` into any `methods` table. It validates
`req.json()` against a Standard Schema (types-only dependency; a hand-rolled
`StandardSchemaV1` fixture in `client.test.ts`), renders 400 on failure, and
attaches the input type to `.meta` so the client's request `body` is typed from
the validator — proven by the `client.test.ts` negative tests (wrong body shape,
missing body, wrong param key, unknown route, body-on-GET all fail to compile).
Validation is not baked into the core (unlike Elysia's `t`-schema being part of
the route definition); it's a wrapper you reach for only where you want it.

## Honest notes / where it's a wash or unfinished

- **`choice` and the client (the iron flag).** The prior `spike/typed-client.ts`
  warned that `choice` collapses branches and erases meta for the client. This
  spike resolves it: meta-`choice` keeps a `ChoiceMeta<[...altMetas]>` tuple
  (it does NOT collapse to one handler's meta), and `Client<App>` walks the alt
  union flatly (`client.ts::FlatChoice`). So routes behind `choice` ARE fully
  covered by the typed client — verified at runtime (`/users` collection and
  `/users/{id}` item live under one `choice` and both appear on the client) and
  at scale (the generator nests `param→methods` and the client keys them). Caveat:
  two alts that resolve to the SAME structural key (e.g. two handlers both at
  `/users`) merge their verb records by intersection — fine for distinct verbs,
  but it cannot represent two *different bodies* for the same path+verb. That is
  a real-but-rare ambiguity, not a blocker.

- **`param` stashes the consumed segment on a request header** (`x-param-<name>`,
  read via `paramValue`) so the inner handler can still read it AFTER `param`
  advanced the URL. This keeps "params are read off the Request" literally true
  (the Request stays the only side channel — no ctx object), but it is the one
  spot that felt slightly forced: app.ts reads the id *before* `rest` and closes
  over it, whereas a reusable `param` combinator must hand the value forward, and
  a header is the only standard carrier on a `Request`. It works and stays within
  the rules, but it's the least elegant seam.

- **405 from the client / response typing breadth.** The client return type is
  the success body only; error responses (400/404/405) surface at runtime but are
  not in the typed return union. Matching Hono/Elysia here would need typed error
  outputs — future work, not done.

- **HTTP-correctness is parity, not a strict win, on behaviour.** Hono and Elysia
  also do 405/HEAD/OPTIONS. Our advantage is doing it from a one-type core, not
  doing more.
