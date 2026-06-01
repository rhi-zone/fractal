# fractal — TODO

## State (verified against repo, 2026-05-31)

Bun-workspaces monorepo, `@rhi-zone` scope, vite + tsgo + vitest, normalize,
VitePress docs. **Entirely local — no remote, not pushed.**

### Package inventory (`packages/`)

11 published packages + 1 private internal test package:

| Package | Status |
|---|---|
| `core` (`@rhi-zone/fractal-core`) | Built & green |
| `transport` (`@rhi-zone/fractal-transport`) | Built & green |
| `codec-json` | Built & green |
| `codec-structured-clone` | Built & green |
| `protocol-correlation` | Built & green |
| `channel-http` | Built & green |
| `channel-websocket` | Built & green |
| `channel-worker` | Built & green |
| `channel-stdio` | Built & green |
| `preset-websocket` | Built & green |
| `standard-schema` (`@rhi-zone/fractal-standard-schema`) | Built & green |
| `transport-conformance` (`@rhi-zone/fractal-transport-conformance`) | **Private, unpublished** — transport-agnosticism conformance tests only |

### Build tiers (manual, topological)

Root `build` script sequences manually: `core` → `transport` → codecs/protocol
(parallel) → channels (parallel) → `preset-websocket` → `standard-schema`/examples.
Holding fine at current dep-graph depth; revisit if it grows.

### What is built

**Node algebra (`fractal-core`):**
- 4 primitives: leaf, branch, annotate (capabilities), seq (`.then`/`.pipe` chain)
- Streaming leaves via `AsyncIterable` with cancellation
- `UClient` typed-client derivation
- Self-describing capabilities (each carries its own injected error + required handle)
- Gradual typing: untyped → unknown
- Laws property-tested via a deterministic sampler (fast-check not yet installed)

**Transport layer (`fractal-transport` + per-axis packages):**
- Kernel: interfaces + `compose` / `attach` / `composeRequestResponse` /
  `serveExchange` + dispatcher + `clientOver`
- Codecs: `codec-json`, `codec-structured-clone`
- Protocol: `protocol-correlation` (duplex correlation)
- Channels: `channel-websocket`, `channel-worker`, `channel-stdio`, `channel-http`
- Preset: `preset-websocket` (`serveWs` / `wsClient` convenience over bare `compose`)
- Proven: transport-agnosticism (identical Results over HTTP/WS/worker/stdio),
  full streaming + cancel + per-call meta, reserved seams for Cap'n Proto codec
  and JSON-RPC protocol (type-verified to compose with zero core changes),
  runtime-agnostic (Bun + Node 20+)

**`transport-conformance` (private):** Transport-agnosticism conformance tests
(HTTP / WS / worker / stdio produce identical Results). Not published; devDeps only.

**`standard-schema` (`@rhi-zone/fractal-standard-schema`):** OpenAPI / JSON-Schema
projection from the inert node tree. Exports `toOpenApi(tree, info)` and
`toJsonSchema(node, opts)`. Built & green.

---

## Decisions (record to avoid losing context)

- **Composition is core; structure is reflectable; HANDLERS ARE CODE.** Deliberate
  recorded exception to the ecosystem principle "prefer data over code at every
  seam" — data at the composition seam, code at the leaf. No serializable
  handlers, no decl/impl registry.

- **Capabilities = type-PRESERVING cross-cutting effects** (auth, rate-limiting,
  logging). Each carries its own injected error + required handle; NO central
  error map. `seq` = type-CHANGING transforms (input validation lives here, not
  in capabilities).

- **Transport factors into channel × codec × protocol.** HTTP/WS/worker/stdio
  are channel instances. Two channel families — duplex (correlation) vs
  request-response — verified IRREDUCIBLE via a prototype spike; deliberately
  kept, not a wart.

- **Streaming = `AsyncIterable`, fully implemented.** Not a carveout or future
  plan.

- **Presets only where friction is irreducible.** Principle: "if writing a preset
  yourself is hard, that's a combinator-power issue — fix the combinator." This
  caught and fixed one real gap (missing `serveExchange` assembler) before a
  preset was added.

- **Naming: descriptive, no misnomers.** Retired: `rpc`, `ipc`, `rpc-dispatch`, `facade`.

- **CapGrant is ONE type, parameterized by the transport-native `Raw`.** `CapGrant<Raw>`
  (`fractal-transport`) takes a `DispatchRequest<Raw>`, which carries a required `raw: Raw`
  slot — the typed escape hatch for transport-native extras (HTTP headers/method, …).
  Grants read native data via `req.raw`. `HttpCapGrant = CapGrant<HttpRequestLike>` is a
  thin alias for discoverability at HTTP call sites. Each transport threads its native
  request through `raw` (HTTP: the `HttpRequestLike`; WS/in-process/tests: `undefined`), so
  the prior `as unknown as` adapter-casting trick in `buildDispatcher`/`adaptGrants`/
  `serveExchange` — which smuggled HTTP fields onto a lied-about `DispatchRequest` — is gone.

- **Runtime floor: Node 20** (nixpkgs non-EOL).

- **Intentional test-runner split.** `channel-http`, `channel-websocket`,
  `transport-conformance`, and `todo-api` run `bun test` (via `bun:test` imports)
  because they boot real Bun servers/streams; all other packages run `vitest run`.

---

## Remaining

### 1. DOGFOOD — usable-before-publish gate (highest priority)

Port one small, representative slice of **the reference consumer app (private)**
to fractal end-to-end: a few real endpoints with auth + input validation + a
real use-case call. Compare against its current imperative HTTP route/middleware
framework backend. Surface gaps (missing capabilities, ergonomic friction, type
holes).

**NON-INVASIVE** — build a parallel proof; do NOT modify the app's working
backend.

### ~~2. `fractal-standard-schema` implementation~~ DONE

`toOpenApi(tree, info)` and `toJsonSchema(node, opts)` are implemented and green.
The package projects the inert node tree to OpenAPI / JSON Schema documents.

### 3. Reactivity-as-a-capability (deferred)

Design and build on the streaming substrate: live queries, invalidation, binding
to the reactive client library. Requires a reactive client lib to exist first.

### 4. Wire real fast-check property tests

The deterministic sampler is the current stand-in. Once `fast-check` is
installed, port the existing property test scaffolding.

### 5. Build ordering

If the dep graph grows significantly, replace the manual tier script with a
full topological build. Holding fine now.

### 6. Node WebSocket server adapter

`channel-websocket` server side is Bun-native today. Document the BYO-`ws`
path (`wsServerChannel`) or provide a Node adapter.

### 7. Streaming-through-seq

Stream as a non-tail operand / map-over-stream. Reserved, not built.

### 8. Additional codecs and protocols

Seams are reserved and type-verified to compose. Build when actually needed:
- Codecs: Cap'n Proto, Protobuf, MessagePack
- Protocols: JSON-RPC, dbus

### 9. PUBLISH (after dogfood passes)

- Create `github.com/rhi-zone/fractal`, push, set pages/topics/homepage.
- Ecosystem docs-sync in `~/git/rhizone/github-io` — 7 touchpoints:
  1. `docs/about.md`
  2. `README.md`
  3. `docs/.vitepress/config.ts`
  4. `docs/index.md`
  5. `docs/projects/index.md`
  6. NEW `docs/projects/fractal.md`
  7. `~/git/rhizone/profile/profile/README.md`
  Reflect the multi-package structure; suggested badges: Semantics + Code
  (matching the nearest sibling in the ecosystem).

---

## Pointers

- Scaffolding plan + docs-sync detail: `~/.claude/plans/kind-snuggling-codd.md`
- Commit history: `git log --oneline` in this repo
- Ecosystem design principles: `~/git/rhizone/github-io/docs/decisions/throughlines.md`
- Node algebra / optics direction: `docs/design/optics-direction.md`
