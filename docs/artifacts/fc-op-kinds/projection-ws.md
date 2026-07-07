# WS Projection Mental Model

Mined from `server-less-macros/src/ws.rs` and `server-less-core/src/lib.rs`.

---

## Concept List

### Metadata Keys Consumed by the Macro

| Key    | Source   | Notes |
|--------|----------|-------|
| `path` | `#[ws(path = "...")]` attribute | Endpoint path for the HTTP upgrade route. Defaults to `"/ws"`. The only declared arg (ws.rs:273–309). |

No other metadata keys exist. All other behavior is inferred from the Rust signature.

---

### Concepts Inferred from the Op Signature

**`is_async`** [LIKELY-AGNOSTIC]
- ws.rs:945: `let requires_async = method.is_async || method.return_info.is_stream;`
- If true, sync dispatch returns an error. Agnostic: gRPC, HTTP SSE, and JSON-RPC all have the same sync/async split.

**`is_stream` (streaming cardinality)** [LIKELY-AGNOSTIC — cross-protocol key candidate]
- ws.rs:945: `method.return_info.is_stream` is checked to determine if the method requires async dispatch.
- This is the compile-time flag for "returns-many-over-time" vs "returns-once." gRPC server-streaming, GraphQL subscriptions, HTTP SSE, and WS all encode this same distinction.
- Critically: the WS projection does NOT emit streaming-over-frames dispatch from a `Stream` return type. It recognises the flag but collapses it into "requires async context." Actual server-push streaming is done imperatively via `WsSender` stored and driven from a background task (ws.rs:108–123). This means:
  - The `is_stream` flag exists and is load-bearing for the async gate,
  - but the WS projection has no mechanism to *emit* frames from a stream return — it outsources push to `WsSender`.
  - A future agnostic `streaming-cardinality` concept should distinguish "inferred from return type" (passive) from "explicitly requested sender handle" (active).

**`WsSender` parameter presence** [WS-SPECIFIC]
- ws.rs:168–203, 233: Detected by type name (`WsSender` or `server_less::WsSender`). Triggers a widened dispatch signature: `ws_dispatch(&self, __ctx, __sender, method, args)` (ws.rs:453–473).
- Methods that accept `WsSender` are excluded from `WsMount` dispatch (ws.rs:256–268): mount can't inject a connection-scoped handle — it has no socket.
- Semantics: hands the method a cloneable write-half of the socket split-sink so it can push frames out-of-band, store the sender in app state, or spawn background push loops.

**`Context` parameter presence** [LIKELY-AGNOSTIC]
- ws.rs:222, 593–610: Detected per-method. HTTP upgrade headers are extracted before `on_upgrade` and materialized into a `Context`; that context is passed through the connection loop into every dispatch.
- Cross-protocol: `Context` injection as a transparent request-metadata bag appears in every server-less projection.

**`#[server(hidden)]`** [LIKELY-AGNOSTIC]
- ws.rs:335–341: Hidden methods are dispatchable but absent from `ws_methods()` listings. Parallel to HTTP and other projections.

**`#[server(skip)]`** [LIKELY-AGNOSTIC]
- ws.rs:331: Excluded from the partition entirely (not dispatchable at all). Also agnostic.

**Wire name override** [LIKELY-AGNOSTIC]
- ws.rs:373, 929: `method.wire_name_or(|n| n)` — the string used in the JSON-RPC `"method"` field can differ from the Rust ident. Agnostic: every text-protocol projection needs this.

---

### WS-Specific Concepts Emitted

**JSON-RPC 2.0 frame protocol** [WS-SPECIFIC]
- ws.rs:6–10 (doc), 657–675, 704–738: Wire format is `{"method": "...", "params": {...}, "id": N}` for requests; `{"result": ..., "id": N}` or `{"error": {"message": "..."}, "id": N}` for responses.
- `id` field (ws.rs:669, 714, 727): opaque correlation token, optional.

**Frame-type discrimination** [WS-SPECIFIC]
- ws.rs:876–893: Text frames are dispatched; Binary, Ping, Pong are silently ignored; Close terminates the connection loop.
- This is WS-layer protocol: no equivalent exists in HTTP SSE or gRPC.

**HTTP upgrade handshake** [WS-SPECIFIC]
- ws.rs:845–858: A GET route is registered via axum's `WebSocketUpgrade` extractor. The generated `#handler_name` function accepts the upgrade, extracts headers into Context, then calls `on_upgrade` to hand off to the connection loop.
- OpenAPI: emits a GET endpoint with response code 101 "Switching Protocols" + `x-websocket-protocol` extension (ws.rs:795–841).

**Connection lifecycle** [WS-SPECIFIC]
- ws.rs:861–895: A per-connection async function (`#connection_fn_name`) owns the socket. It splits the socket into (sender, receiver), wraps the sender in `WsSender`, then runs a `while let Some(msg) = receiver.next().await` loop until close or error.
- Connection-scoped `WsSender` is created here (ws.rs:872) and passed into every dispatch call for that connection.

**Bidirectionality** [WS-SPECIFIC]
- WS supports client→server messages (received in the connection loop) and server→client push (via `WsSender`). HTTP SSE is server→client only. gRPC bidirectional streaming exists but is a separate RPC kind. This bidirectional nature is why `WsSender` is a first-class injection point rather than a result type.

**`WsMount` trait** [LIKELY-AGNOSTIC — structural pattern]
- lib.rs:272–289: `ws_mount_methods() / ws_mount_dispatch / ws_mount_dispatch_async`. Isomorphic to `JsonRpcMount` (lib.rs:248) and `McpNamespace` (lib.rs:221). The dot-separated namespacing composition pattern is agnostic; the trait name and feature gate are WS-specific.

---

## Cross-Protocol Candidates

| Concept | WS | JSON-RPC | gRPC | HTTP SSE | GraphQL Sub |
|---------|----|---------|----|---------|------------|
| Streaming cardinality (`is_stream`) | flag recognized, not emitted via frames | same | native (server-stream RPC kind) | native (stream body) | native (subscription op kind) |
| Server-push handle (`WsSender`-style) | explicit injection | N/A | stream write-half | response stream | subscription channel |
| Request/response correlation (`id`) | JSON-RPC id field | yes | gRPC stream sequence | N/A | subscription id |
| Context injection | HTTP upgrade headers | per-call | per-call metadata | HTTP headers | HTTP headers |
| Method name lookup | JSON "method" field | JSON "method" | proto method name | path/event name | operation name |

**Streaming cardinality is the strongest cross-protocol agnostic candidate.** All five protocols encode "this op emits zero-or-more items over time" as a distinct kind. The fractal op-kind model should name this concept at the agnostic layer and let each projection decide how to implement it (stream return type, `WsSender`, SSE response body, gRPC ServerStream).

---

## Key ws.rs Citations

| Concern | Lines |
|---------|-------|
| `WsArgs` / `path` metadata key | 273–309 |
| `is_async \|\| is_stream` async gate | 945 |
| `WsSender` injection detected, widens dispatch sig | 168–203, 453–473 |
| WsSender excluded from `WsMount` | 256–268 |
| Context extracted from HTTP upgrade headers | 593–610 |
| HTTP upgrade handler generated | 845–858 |
| Per-connection loop, frame discrimination | 861–895 |
| JSON-RPC parse + dispatch | 657–701 |
| JSON-RPC response formatting | 704–738 |
| OpenAPI 101 / `x-websocket-protocol` | 795–841 |
| `WsMount` trait definition | lib.rs:272–289 |
