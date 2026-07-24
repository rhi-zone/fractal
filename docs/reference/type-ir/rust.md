# Rust

One projector: `rust-serde.ts`, TypeRef → idiomatic Rust structs/enums with
`serde` derives. IR field names are wire-format strings (arbitrary
camelCase/kebab-case); the projector converts to Rust's conventional
`snake_case` and emits `#[serde(rename = "...")]` whenever the converted form
doesn't round-trip, keeping the Rust identifier idiomatic while the wire
representation stays byte-for-byte unchanged.

## serde

```ts
import { toRust } from "@rhi-zone/fractal-type-ir/rust"
// or: import { toRust } from "@rhi-zone/fractal-type-ir/rust-serde"

toRust(t(types.object({
  id: t(types.string),
  name: t(types.string),
  email: t(types.string),
  age: opt(t(types.integer)),
})), "User")
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub age: Option<i64>,
}
```

Both `meta.optional` (may be absent from the wire) and `meta.nullable`
(present but may be `null`) collapse onto the same `Option<T>` +
`#[serde(skip_serializing_if = "Option::is_none")]` — serde's convention
doesn't distinguish "missing key" from "explicit null" the way the IR's two
flags do.
