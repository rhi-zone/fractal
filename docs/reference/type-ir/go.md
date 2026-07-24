# Go

Four projectors emit idiomatic Go type declarations — structs with `json`
tags, slices, maps, string-backed const enums, and a marker-interface
encoding of unions — one per JSON library. `go-jsoniter` and `go-sonic` are
drop-in, reflection-compatible replacements for `encoding/json` (same
`json:"..."` tags, no library-specific syntax), so their output is
byte-identical to `go-encoding-json`'s; they exist as separate entry points
so callers can name the variant they're targeting explicitly. `go-easyjson`
is the one structural outlier: it needs a `//easyjson:json` directive comment
for its code generator, and it has no polymorphic-interface dispatch, so
unions render differently.

## encoding/json

```ts
import { toGo } from "@rhi-zone/fractal-type-ir/go"
// or: import { toGo } from "@rhi-zone/fractal-type-ir/go-encoding-json"

toGo(t(types.object({
  id: t(types.integer),
  name: t(types.string),
  email: t(types.string),
  isActive: t(types.boolean),
  tags: t(types.array(t(types.string))),
})), "User")
```

```go
type User struct {
	Id int `json:"id"`
	Name string `json:"name"`
	Email string `json:"email"`
	IsActive bool `json:"isActive"`
	Tags []string `json:"tags"`
}
```

### easyjson

```ts
import { toEasyjson } from "@rhi-zone/fractal-type-ir/go-easyjson"
```

Struct fields and tags are identical to `encoding/json`; every hoisted
struct additionally gets a `//easyjson:json` directive comment, the marker
[`easyjson -all`](https://github.com/mailru/easyjson) scans for to generate
`MarshalEasyJSON`/`UnmarshalEasyJSON`:

```go
//easyjson:json
type User struct {
	Id int `json:"id"`
	// ...
}
```

Unions diverge structurally too — easyjson's generator has no
polymorphic-interface dispatch, so a discriminated union renders as a
`json.RawMessage`-backed named type instead of `go-encoding-json`'s
marker-interface encoding:

```go
// go-encoding-json:
type ApiResponse interface {
	isApiResponse()
}
type ApiResponseObject struct { /* ... */ }
func (ApiResponseObject) isApiResponse() {}

// go-easyjson:
// ApiResponse is a discriminated union deferred via json.RawMessage — re-unmarshal into one of: ApiResponseObject, ApiResponseObject2.
type ApiResponse json.RawMessage
```

### jsoniter

```ts
import { toJsoniter } from "@rhi-zone/fractal-type-ir/go-jsoniter"
```

[jsoniter](https://github.com/json-iterator/go) reads the exact same
`json:"..."` tags via reflection — no build-time codegen, no directive
comment, no jsoniter-specific tag key. Output is byte-for-byte identical to
`encoding/json`'s; only the caller's own `var json =
jsoniter.ConfigCompatibleWithStandardLibrary` changes at the call site,
which is outside what a type-declaration projector emits:

```go
type User struct {
	Id int `json:"id"`
	// ...
}
```

### sonic

```ts
import { toSonic } from "@rhi-zone/fractal-type-ir/go-sonic"
```

[sonic](https://github.com/bytedance/sonic) also reads standard `json:"..."`
tags reflectively (its speed comes from JIT-compiling an encoder/decoder per
type at runtime, not from codegen), so its declarations are identical to
`encoding/json`'s and `jsoniter`'s too:

```go
type User struct {
	Id int `json:"id"`
	// ...
}
```
