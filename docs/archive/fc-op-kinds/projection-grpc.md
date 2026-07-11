# Mental Model of the gRPC Projection

What concepts/distinctions gRPC encodes about an operation, grounded in the real
gRPC/protobuf model and in server-less's actual gRPC projection macro.

Source (server-less):
`/home/me/git/rhizone/server-less/crates/server-less-macros/src/grpc.rs` (339 lines).

Purpose: extract gRPC's mental model so that, across ≥2 projections, we can separate
distinctions that RECUR (→ agnostic op-core metadata keys) from gRPC-only distinctions
(→ `grpc:`-namespaced keys).

---

## 1. The concepts gRPC encodes about an operation

gRPC/protobuf models an operation as an **RPC method inside a service**, with a strongly
typed request message and response message, a streaming shape, and a wire-level status
result. The full concept list:

| # | Concept | What gRPC needs |
|---|---------|-----------------|
| 1 | **Service grouping** | Every RPC belongs to exactly one `service`. Namespacing unit. |
| 2 | **Method name** | The RPC's identity within the service (`rpc Foo(...)`). |
| 3 | **Streaming shape** | One of four: unary, server-streaming, client-streaming, bidi. Encoded as `stream` keyword on request and/or response. |
| 4 | **Request message** | A named protobuf message: the input, decomposed into numbered fields. |
| 5 | **Response message** | A named protobuf message: the output. |
| 6 | **Field numbers** | Every message field has a stable integer tag; the wire format is field-number-addressed, not name-addressed. |
| 7 | **Field types & modifiers** | proto scalar/message types, `optional`, `repeated`. |
| 8 | **Package** | proto namespace for the whole file (`package foo.bar;`). |
| 9 | **Status codes** | `google.rpc.Status` / gRPC status enum (OK, NOT_FOUND, DEADLINE_EXCEEDED, …) — the result channel. |
| 10 | **Deadlines / timeouts** | Per-call deadline propagated as a header; a transport/runtime concern. |
| 11 | **Metadata (headers)** | Arbitrary key→value pairs on the call (auth, tracing). |
| 12 | **`idempotency_level`** | protobuf `MethodOptions` field: `IDEMPOTENCY_UNKNOWN` / `NO_SIDE_EFFECTS` / `IDEMPOTENT`. Lets infra retry / cache / GET-map safely. |

---

## 2. For each concept: what gRPC NEEDS, and where it could come from

Legend for "source":
- **inferred-from-type** — derivable from the operation's Rust/host signature (return type, param types).
- **agnostic-property** — a property the op-core would carry regardless of projection (safety, arity, name).
- **grpc-authoring** — a gRPC-specific declaration with no meaning outside gRPC.

| Concept | gRPC needs | Could come from | Classification |
|---------|-----------|-----------------|----------------|
| Service grouping | A grouping key per RPC | agnostic-property (op's module/namespace) | **[LIKELY-AGNOSTIC]** — grouping is a cross-cutting concept; REST has resource/collection, CLI has command groups. |
| Method name | Identity string | agnostic-property (op name) | **[LIKELY-AGNOSTIC]** — every projection needs the op's name. |
| Streaming shape | unary vs stream on each side | inferred-from-type (`impl Stream`) OR agnostic-property (arity/cardinality of input & output) | **[LIKELY-AGNOSTIC]** — "does this produce one value or many" is a general op property; SSE/websocket/pagination projections want it too. gRPC's *four-way* encoding is a gRPC refinement, but the underlying one-vs-many axis recurs. |
| Request message | Named struct of inputs | inferred-from-type (params) | **[MIXED]** — "the op has inputs" is agnostic; the *protobuf message layout* (a distinct named type per method) is gRPC-specific. |
| Response message | Named struct of output | inferred-from-type (return, Result unwrapped) | **[MIXED]** — output existence is agnostic; the message wrapping is gRPC-specific. |
| **Field numbers** | Stable integer tag per field | grpc-authoring (must be pinned & never reused) | **[GRPC-SPECIFIC]** — wire-format identity. No agnostic meaning. This is the canonical gRPC-only key. |
| Field types & `optional`/`repeated` | proto types | inferred-from-type (`Option`→optional, `Vec`→repeated) | **[MIXED]** — nullability/multiplicity are agnostic axes; the proto *scalar mapping* is gRPC-specific. |
| Package | proto namespace | agnostic-property (app/module name) OR grpc-authoring override | **[MIXED]** — a namespace concept recurs, but the `package foo.bar;` syntax is gRPC-form. |
| Status codes | enum result on the wire | agnostic-property (op's error taxonomy / safety) partially | **[MIXED]** — the *mapping* of errors→codes recurs (HTTP status, exit codes), but the specific gRPC status enum values are gRPC-form. |
| Deadlines / timeouts | per-call deadline | runtime/caller, not the op def | **[GRPC-SPECIFIC]** (transport concern) — though "this op has a max duration / is long-running" could be an agnostic hint. Weakly agnostic at best. |
| Metadata (headers) | k→v envelope | caller/runtime | **[GRPC-SPECIFIC]** at the wire level; conceptually every protocol has an envelope, but the concept is too generic to be a shared *op* distinction. |
| **`idempotency_level`** | `NO_SIDE_EFFECTS` / `IDEMPOTENT` / `UNKNOWN` | **agnostic-property (op safety/idempotency axis)** | **[LIKELY-AGNOSTIC] — the headline case.** See §3. |

---

## 3. `idempotency_level` — literally the agnostic safety/idempotency axis

protobuf's `MethodOptions.idempotency_level` (`NO_SIDE_EFFECTS` / `IDEMPOTENT` /
`IDEMPOTENCY_UNKNOWN`) is **not a gRPC-transport concept** — it is a declaration about the
*operation's semantics*: whether calling it changes state, and whether calling it twice is
the same as calling it once.

This is exactly the safety/idempotency axis that recurs across projections:

- **HTTP/REST**: `NO_SIDE_EFFECTS` ↔ safe methods (GET/HEAD) — cacheable, retryable, GET-mappable. `IDEMPOTENT` ↔ PUT/DELETE — retryable but not cacheable. Neither ↔ POST.
- **CLI / job runners**: idempotent ops are safe to re-run on failure.
- **gRPC**: `NO_SIDE_EFFECTS` methods may be sent as cacheable GET-style requests.

So `idempotency_level` is a **strong [LIKELY-AGNOSTIC]** signal: it should live as an
op-core safety property (e.g. `safety: pure|idempotent|effectful` or the two-bit
side-effects × idempotent decomposition), and the gRPC projection should *read* it to emit
`option idempotency_level = ...`, exactly as the HTTP projection reads it to choose the
verb. This is the clearest cross-protocol distinction in the whole gRPC surface — it is the
same axis wearing gRPC clothes.

---

## 4. Classification summary

**[LIKELY-AGNOSTIC]** (candidate agnostic op-core keys — recur across projections):
- **`idempotency_level` → safety/side-effects/idempotency axis** (headline; shared with HTTP verb choice).
- Streaming/cardinality (one-vs-many input & output) — shared with SSE/pagination/stream projections.
- Method name / op identity.
- Service/module grouping (namespace).
- Error taxonomy (maps to status codes here, HTTP codes / exit codes elsewhere) — the *taxonomy* is agnostic even if the *values* are not.
- Input/output existence and their nullability (`optional`) & multiplicity (`repeated`).

**[GRPC-SPECIFIC]** (→ `grpc:`-namespaced keys — no meaning outside gRPC):
- **Field numbers** (wire-format tags; stability is the user's burden).
- protobuf **message layout** (a distinct named `{Method}Request`/`{Method}Response` message per RPC).
- proto **scalar type mapping** (`int32`, `bytes`, `google.protobuf.Empty`, …).
- `package` **syntax** / `syntax = "proto3"`.
- gRPC **status enum values** specifically.
- **Deadlines/timeouts** and **metadata headers** (transport/runtime, not op-definition).
- The gRPC **four-way streaming** encoding (refinement of the agnostic one-vs-many axis).

---

## 5. What server-less actually does (cited: `grpc.rs`)

The server-less macro `#[grpc(...)]` is a **derive-from-signature** projection: it infers
almost everything from the Rust type and accepts only two authoring keys.

**Metadata keys consumed** — exactly two, both optional; unknown keys produce a
`did_you_mean` error listing only `["package", "schema"]`:
- `package` (`LitStr`) — proto package; falls back to `app_meta.name` snake-cased, then to
  the struct name snake-cased. Never required.
- `schema` (`LitStr`) — path to a `.proto` file, `include_str!`'d and diffed at compile time
  for validation. Enables `validate_schema` / `assert_schema_matches`; omitting it just
  drops those methods.

**Everything else is inferred, never declared:**
- **Service name** = the Rust struct name as-is (no override key).
- **RPC method name** = Rust method name → `UpperCamelCase`.
- **Request/response message names** = `{Method}Request` / `{Method}Response`, fully derived.
- **Streaming shape** = from `ret.is_stream` (return is `impl Stream<Item = T>`).
  **Only unary vs server-streaming** is modelled; **client-streaming and bidi are not**.
- **Field numbers** = sequential 1-based by parameter order; **no way to pin them**. A
  comment (~lines 148–155) explicitly warns that presence-validation does *not* catch
  field-number reordering and that stability is the user's responsibility.
- **Proto field types** = `rust_type_to_proto_scalar` by last-segment ident match; unknown
  types fall through to `bytes`.
- **`optional`** = param is `Option<T>` (`param.is_optional`).
- **`repeated`** = param is `Vec<T>`.
- **`Context` params** are filtered out of schema fields via `partition_context_params`.
- **`Result<T,E>`** unwrapped to `T` via `unwrap_result_ok_type`; **E is discarded**.
- **`google.protobuf.Empty`** as the fallback message when a type is absent.
- Doc comments emitted as inline `// {doc}` before the `rpc` line.
- Hardcoded `syntax = "proto3"`.

**Notably absent from server-less's projection:**
- **No `idempotency_level`** — the one clearly-agnostic safety axis is not modelled at all.
  (This is a gap the op-core work can fill: carry it agnostically, read it here.)
- **No status codes** — no `google.rpc.Status`, no error-detail mapping (E is dropped).
- **No deadlines/timeouts, no metadata headers.**
- **No field-number pinning** — the biggest gRPC-specific stability concern is left to the
  user by comment, not by mechanism.

**Reading:** server-less treats the Rust signature as the single source of truth and derives
the entire proto shape from it, accepting only `package` (a namespace hint) and `schema` (a
validation anchor) as authoring. It captures the *structural* gRPC concepts (service,
method, messages, streaming-once, field types) but **none of the semantic op-level ones**
(idempotency, status/error taxonomy) — precisely the concepts that would be **agnostic** and
shared with other projections. That absence is itself evidence for where the agnostic
op-core keys should live: server-less had to drop exactly the cross-protocol distinctions
because its projection had nowhere protocol-neutral to read them from.
