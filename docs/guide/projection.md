# Projecting the Type IR

`@rhi-zone/fractal-type-ir` ships 70 projector modules — pure functions that
render a `TypeRef` (or `TypeRefDocument`) into a target language, validation
library, schema format, wire format, or reference-doc page. This page is a
map of that catalog: what exists, how it's grouped, and why one language can
have half a dozen projectors instead of one.

For the projector mechanism itself — `resolve(kind, handlers)`, the
`ancestors`/`registerParent` subtyping fallback, why a projector only needs
handlers for the kinds it special-cases — see
[Type IR reference: how projectors work](../reference/type-ir/index.md#how-projectors-work).
This page assumes that model and focuses on breadth.

## What a projector is, briefly

A projector is a pure function `TypeRef => string` (source-code projectors:
TypeScript, Python, Go, …) or `TypeRef => <document>` (schema/wire-format
projectors that build a structured object — a JSON Schema document, an
OpenAPI document, a SQL column descriptor — rather than text). Internally,
every one dispatches on `ref.shape.kind` through `resolve(kind, handlers)`,
falling back through the kind's ancestor chain when it has no direct
handler. That's the entire contract; the rest of this page is about what
sits behind it.

## The catalog

70 files in `packages/type-ir/src/` are target projectors (counted directly
from the directory listing, excluding `*.test.ts`, the `from-*.ts` importers,
and the utilities `derive.ts`/`compile.ts` that transform or compile
`TypeRef`s rather than target an external format).

### Languages with multiple serialization-library variants

The recurring shape: one language, several projector modules, one per
validation/serialization library that language's ecosystem actually uses.
This is the pattern worth internalizing — a projector targets a _library_,
not just a language.

| Language   | Variants                                                                                        | Count | Reference                                           |
| ---------- | ----------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------- |
| TypeScript | native, Zod, Valibot, TypeBox, io-ts, Yup, Superstruct, Runtypes, ArkType, Effect Schema, JSDoc | 11    | [typescript.md](../reference/type-ir/typescript.md) |
| Python     | dataclasses, Pydantic, attrs, msgspec, cattrs                                                   | 5     | [python.md](../reference/type-ir/python.md)         |
| C++        | nlohmann/json, RapidJSON, simdjson, Boost.JSON, Glaze                                           | 5     | [cpp.md](../reference/type-ir/cpp.md)               |
| Go         | encoding/json, easyjson, jsoniter, sonic                                                        | 4     | [go.md](../reference/type-ir/go.md)                 |
| Java       | Jackson, Gson, Moshi, JSON-B                                                                    | 4     | [java.md](../reference/type-ir/java.md)             |
| Kotlin     | kotlinx.serialization, Jackson, Gson                                                            | 3     | [kotlin.md](../reference/type-ir/kotlin.md)         |
| Swift      | Codable, SwiftyJSON, ObjectMapper                                                               | 3     | [swift.md](../reference/type-ir/swift.md)           |
| C#         | System.Text.Json, Newtonsoft, ServiceStack                                                      | 3     | [csharp.md](../reference/type-ir/csharp.md)         |
| Dart       | json_serializable, Freezed, built_value                                                         | 3     | [dart.md](../reference/type-ir/dart.md)             |
| Ruby       | Sorbet, dry-types, RBS                                                                          | 3     | [ruby.md](../reference/type-ir/ruby.md)             |
| PHP        | native, Symfony, JMS                                                                            | 3     | [php.md](../reference/type-ir/php.md)               |

Subtotal: 47 projectors across 11 languages.

### Single-target languages

One projector module because one library dominates or the ecosystem has a
single obvious wire-format convention:

| Language    | Target                        | File                           |
| ----------- | ----------------------------- | ------------------------------ |
| Rust        | serde                         | `rust-serde.ts`                |
| Haskell     | aeson                         | `haskell-aeson.ts`             |
| Elm         | `elm/json` decoders/encoders  | `elm-json.ts`                  |
| Flow        | Flow's own type syntax        | `flow-native.ts`               |
| Objective-C | Foundation (`NSCoding`-style) | `objc-foundation.ts`           |
| Crystal     | `JSON::Serializable`          | `crystal-json-serializable.ts` |

Subtotal: 6 projectors. See [other-languages.md](../reference/type-ir/other-languages.md).

### Schema and wire formats

These don't emit source code — they emit a structured document (JSON Schema,
an OpenAPI document object, a SQL DDL string, a `.proto` file) meant to be
consumed by other tooling, not compiled.

| Family                     | Variants                          | Count |
| -------------------------- | --------------------------------- | ----- |
| JSON Schema                | draft 2020-12, draft-07, draft-04 | 3     |
| OpenAPI                    | 3.0, 2.0                          | 2     |
| JSON Type Definition (JTD) | —                                 | 1     |
| Standard Schema            | —                                 | 1     |
| Protobuf                   | —                                 | 1     |
| Cap'n Proto                | —                                 | 1     |
| FlatBuffers                | —                                 | 1     |
| SQL DDL                    | generic + MSSQL variant           | 2     |
| GraphQL SDL                | —                                 | 1     |
| JSON-RPC                   | —                                 | 1     |

Subtotal: 14 projectors. See [schema-formats.md](../reference/type-ir/schema-formats.md)
and [wire-formats.md](../reference/type-ir/wire-formats.md).

### Doc-page generators

These consume a whole `TypeRefDocument` and emit human-readable reference
pages (one page per named type), not code or a machine-readable schema:

| Target     | File                      |
| ---------- | ------------------------- |
| Docusaurus | `docusaurus-reference.ts` |
| Starlight  | `starlight-reference.ts`  |
| MkDocs     | `mkdocs-reference.ts`     |

Subtotal: 3 projectors. See [doc-projectors.md](../reference/type-ir/doc-projectors.md).

**Total: 47 + 6 + 14 + 3 = 70 projectors.**

## Why so many variants per language

Each variant targets a library with a different runtime tradeoff, and the
projector source usually says so directly — most cite the target library's
own docs or spec sections inline, per the codebase convention of putting
spec references in projector source rather than in a separate design doc.
A few concrete examples, read from the module comments themselves:

- **Zod vs. Valibot vs. TypeBox** (`typescript-zod.ts`, `typescript-valibot.ts`,
  `typescript-typebox.ts`) all validate TypeScript objects at runtime, but
  for different reasons. Zod is the ecosystem default — broad library
  interop, one schema object per type. Valibot's projector builds pipelines
  of standalone validation _actions_ (`v.pipe(v.string(), v.email())`)
  rather than method chains, because Valibot's own design optimizes for
  tree-shaking — unused actions don't ship. TypeBox's projector emits
  builder calls (`Type.Object({...})`) whose runtime representation is
  itself JSON-Schema-shaped, which is the whole point of the library:
  the schema _is_ a JSON Schema document, so it can be handed directly to a
  JSON Schema-consuming tool without a separate export step.
- **msgspec vs. attrs vs. Pydantic** (`python-msgspec.ts`, `python-attrs.ts`,
  `python-pydantic.ts`) target three different points on Python's
  validation-library spectrum. msgspec's projector module doc calls out
  that it's a sibling of `python-attrs.ts` structurally but diverges
  wherever msgspec's own vocabulary diverges — e.g. `multipleOf` gets a
  direct `msgspec.Meta(multiple_of=...)` home that attrs' validator
  vocabulary has no equivalent for, because msgspec is built for decode
  speed and ships that constraint as a first-class citizen
  (see msgspec's own [constraints docs](https://jcristharif.com/msgspec/constraints.html)).
  Pick msgspec when decode/encode throughput matters; pick attrs when you
  want validation as an opt-in layered on plain classes; pick Pydantic when
  you want the batteries-included default with the largest plugin
  ecosystem.
- **SwiftyJSON/ObjectMapper vs. Codable** (`swift-swiftyjson.ts`,
  `swift-objectmapper.ts`, `swift-codable.ts`) split along a similar axis:
  Codable is the language-native protocol with zero dependencies; the other
  two exist for codebases that adopted them before Codable existed, or that
  need SwiftyJSON's permissive dynamic-subscript access to loosely-typed
  JSON.

The general rule: when a projector variant exists, it's because the target
library makes an observably different runtime/bundle-size/ergonomics
tradeoff that a single "canonical" projector for the language couldn't
represent faithfully.

## `TypeRefDocument`-aware projectors vs. bare-`TypeRef` projectors

Most projectors take a bare `TypeRef` and return a string or document for
that one type. A smaller set operates on a full `TypeRefDocument`
(`{ root, defs }`) instead, because they need a registry to resolve named
references against or because they emit one output per named definition:

- The three doc-page generators (Docusaurus, Starlight, MkDocs) — one output
  page per entry in `defs`.
- `from-protobuf` and other importers that produce multiple related types
  land in a `TypeRefDocument` rather than a single `TypeRef`, for the
  inverse reason: a `.proto` file's messages reference each other by name.
- Any projector rendering `{ kind: "ref", target }` needs `defs` to resolve
  the target — a bare `TypeRef` has no registry to look it up in.

See [Type IR reference: `TypeRefDocument`](../reference/type-ir/index.md#typerefdocument-named-recursive-types)
for the full model; a `TypeRef` with no `defs` is just a document with no
shared definitions, so document-aware projectors work on both.

## Adding a new target

A projector is "just" a `resolve(kind, handlers)` dispatch table plus a
render entry point, so a new one follows the same skeleton every existing
projector does:

```ts
import { resolve, type TypeRef, type TypeShape } from "./index.ts";

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string;

const handlers: Record<string, Converter> = {
  boolean: () => "bool",
  string: () => "String",
  // ...one entry per kind this target needs to special-case
};

export function toNewTarget(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers);
  return converter === undefined
    ? /* fallback for unhandled kinds */ ""
    : converter(ref.shape, ref.meta);
}
```

Only kinds the target needs to render _differently_ from their parent need a
handler — everything else falls back through `ancestors()`. Sibling
projectors for the same language (e.g. `python-attrs.ts` and
`python-msgspec.ts`) are the fastest way to see how much of that table is
shared structure vs. library-specific divergence; the per-language reference
pages linked above walk a worked example per variant.

## See also

- [Type IR reference index](../reference/type-ir/index.md) — the model
  (`TypeRef`, `TypeShape`, `meta`), the kind vocabulary, the subtyping
  mechanism, and the full page list.
- Per-language/format reference pages: [typescript.md](../reference/type-ir/typescript.md),
  [python.md](../reference/type-ir/python.md), [go.md](../reference/type-ir/go.md),
  [java.md](../reference/type-ir/java.md), [kotlin.md](../reference/type-ir/kotlin.md),
  [swift.md](../reference/type-ir/swift.md), [csharp.md](../reference/type-ir/csharp.md),
  [cpp.md](../reference/type-ir/cpp.md), [rust.md](../reference/type-ir/rust.md),
  [ruby.md](../reference/type-ir/ruby.md), [php.md](../reference/type-ir/php.md),
  [dart.md](../reference/type-ir/dart.md), [other-languages.md](../reference/type-ir/other-languages.md),
  [schema-formats.md](../reference/type-ir/schema-formats.md),
  [wire-formats.md](../reference/type-ir/wire-formats.md),
  [doc-projectors.md](../reference/type-ir/doc-projectors.md).
- [derive.md](../reference/type-ir/derive.md) — structural `TypeRef → TypeRef`
  transforms (`partial`, `pick`, `nullable`, …), a different family from the
  projectors on this page: they stay inside the IR rather than rendering out
  of it.
