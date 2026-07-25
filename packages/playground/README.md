# @rhi-zone/fractal-playground

Browser playground for `@rhi-zone/fractal-type-ir` — convert between any supported ingestor/projector format live in your browser.

## What it does

A Vite+Solid+CodeMirror web app with split panes: pick an input format (JSON Schema, GraphQL SDL, SQL DDL, Elasticsearch mapping, Cap'n Proto, ...), paste or edit some content, then pick an output format (TypeScript, Zod, Python dataclass, Rust, Go, Java, Protocol Buffers, SQL, ...) and watch the conversion happen in real time. Syntax-highlighted editors in both panes, error messages when conversion fails.

Covers 585 input × output format combinations.

## Supported formats

**Input:** JSON Schema, JSON instance, JSON corpus, JSON Type Definition, GraphQL SDL, SQL DDL, Cassandra CQL, Elasticsearch mapping, OpenAPI 3.0/2.0 schema, Standard Schema (JSON envelope), Cap'n Proto, FlatBuffers schema.

**Output:** TypeScript, JSDoc, Flow; Zod, TypeBox, io-ts, Yup, Effect Schema, Valibot, Runtypes, Superstruct, ArkType; Python (dataclass, Pydantic, attrs); Go, Java (Jackson, Gson, Moshi), Rust (serde), Swift, C#, Kotlin, Dart, Objective-C, C++, Crystal, PHP, Ruby (Sorbet), Elm, Haskell; GraphQL SDL, SQL (standard + MSSQL), Protocol Buffers, Cap'n Proto, FlatBuffers, JSON Type Definition, JSON Schema (2020-12, draft-07, draft-04), OpenAPI (3.0, 2.0).

## Run locally

```bash
npm run dev
# → http://localhost:5173/
```

Browse to the dev server and experiment with format conversions. Each time you switch input formats, a representative sample populates the input pane; edit it, and the output updates as you type.

```bash
npm run build   # compile to dist/
npm run preview # serve the built bundle locally
npm run typecheck
```

## See also

- [`@rhi-zone/fractal-type-ir`](../type-ir) — the engine behind the conversions
- [Full docs](https://docs.rhi.zone/fractal/)
