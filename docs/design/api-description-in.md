# API descriptions in

> **Provenance:** session 2026-09-30. Built in `packages/api-tree/src`
> (`api-description.ts`, `lower.ts`, `from-*.ts`, `overlay.ts`). Decisions
> below were made by the implementing agent under a delegated "design and
> build" ask, not certified by the project owner. Items marked
> **[UNCERTIFIED]** are the ones most worth a look.

## What this adds

Before this, fractal's in side only brought in *types* (type-ir's
`from-*` ingesters). The API structure itself (operations, addresses,
projection metadata) could only come from an authored TypeScript tree. This
adds the missing in side: any API description document becomes a `Node`
tree plus types, which every existing projector already consumes. With the
existing out side, that makes fractal any format in, any format out.

```
format document ──from-<format>──▶ ApiDescription ──transforms──▶ ApiDescription
   (overlay.ts: doc => doc)          (plain JSON)    (plain functions)
                                                            │ lower()
                                                            ▼
                                     Node tree + types keyed by handler
                                                            │ schemaMap / typeRefMap
                                                            ▼
                                     every existing projector (openapi, mcp,
                                     graphql, json-rpc, cli, http client…)
```

## Layers

1. **Importers** (`from-<format>.ts`): pure `document => { api, diagnostics }`.
   They know one format each and nothing about `Node`. Anything the format
   says that the result can't hold is a `Diagnostic`, never a silent drop.
2. **`ApiDescription`** (`api-description.ts`): a flat list of addressed
   operations (`address`, `input`, `output`, open `meta`), group meta at
   addresses, and named `defs`. Plain JSON by invariant.
3. **`lower()`** (`lower.ts`): `ApiDescription => { tree, types, defs }`.
   One handler per operation (caller-supplied via `bind`, else one that throws
   `UnboundOperationError`). Types are keyed by handler identity;
   `schemaMap`/`typeRefMap` re-key them per projector convention
   (`routeKeys`, `nameKeys`) by walking whatever tree is finally projected.

## Formats

| importer | reads | addressing |
|---|---|---|
| `from-openapi.ts` `fromOpenApiDocument` | OpenAPI 3.0/3.1, Swagger 2.0 | URL path, then lowercased method |
| `from-asyncapi.ts` `fromAsyncApiDocument` | AsyncAPI 2.x, 3.0 | channel address, then operation id (or `send`/`receive`) |
| `from-graphql.ts` `fromGraphqlSchema` | GraphQL SDL | flat root field name (`[operationType, name]` on a clash) |
| `from-protobuf.ts` `fromProtobufSource` | `.proto` services (proto3, proto2) | package segments, service, method |
| `from-capnp.ts` `fromCapnpSchema` | Cap'n Proto interfaces | interface (nested interfaces nest), method |
| `from-openrpc.ts` `fromOpenRpcDocument` | OpenRPC 1.x | method name split on `.` |
| `from-mcp.ts` `fromMcpListing` | MCP tools/prompts/resources/templates list results | `tools/<name>`, `prompts/<name>`, ... |
| `from-smithy.ts` `fromSmithyModel` | Smithy 2.0 JSON AST | service, resources (identifiers as params), operation |
| `from-wsdl.ts` `fromWsdlDocument` | WSDL 1.1 and 2.0 (embedded XSD via type-ir `from-xsd.ts`) | portType/interface, operation |
| `from-raml.ts` `fromRamlDocument` | RAML 1.0 and 0.8 (type-ir `from-raml.ts` for RAML types) | URL path, then method (`http-address.ts`) |
| `from-typespec.ts` `fromTypeSpecSource` | TypeSpec, via `@typespec/compiler` + `@typespec/http` | namespace, interface, operation |
| `from-postman.ts` `fromPostmanCollection` | Postman Collection v2.1/v2.0 (types inferred from examples, marked `meta.inferred`) | URL path, then method (`http-address.ts`) |
| `overlay.ts` `applyOverlay` | OpenAPI Overlay 1.0/1.1/1.2 over any JSON document | n/a (document to document) |

Each importer's header lists its own mapping, spec references, and what it
reports as a diagnostic. URL-shaped importers share `http-address.ts`, so the
URL-mirroring address convention lives in one place. On the out side,
json-rpc-api-projector gained `toOpenRpc`, and `toOpenApi` now places
parameters by the same rules as the runtime decode. type-ir gained `from-smithy.ts` (Smithy shapes to
TypeRefs) and its Cap'n Proto parser now reads interfaces.

## Decisions

**Flat operation list as the importer target, not `Node` directly.**
Importers stay plain data to plain data, so the format knowledge has no
dependency on fractal's runtime model and can be carried to another codebase
by porting only the target shape. It also matches the "structure is
optionally part of the skeleton: explicit / flat / inferred" invariant: the
list is the flat form, `lower()` is the one place it becomes explicit.
Alternatives: importers build `Node` directly (one less layer, but every
importer depends on `op`/`api`/handlers and isn't serializable); importers
emit fractal TypeScript source that the existing TS pipeline reads (keeps "TS
types are the truth" literally, but adds a codegen round trip and loses
anything TS can't spell).

**Types ride beside the tree, keyed by handler, not in `meta`.** The
certified model says metadata is only for non-type-expressible projection
concerns and never a second source for domain data, so input/output types
are sibling fields on `Operation` and an external map after lowering, the
same place `extractToolTypeRefs` already puts them. Keying by handler (not by
path) means a `Node => Node` transform after lowering keeps types attached as
long as it keeps the leaf.

**[UNCERTIFIED] The imported document is the source of truth for imported
APIs.** "Truth = inferred TS types + JSDoc" is certified for authored trees.
For an imported API there is no TS; the document is the only source, and
types reach projectors in the same lowered TypeRef/JSON Schema form the TS
extractor produces. This reads the invariant as "no *second* source", which
is an interpretation, not something the owner has said.

**OpenAPI addresses mirror the URL.** `/pets/{petId}` GET is address
`pets/{petId}/get` with `meta.http = { method: "GET", moveTo: ".." }`, so the
http projector puts it back on exactly its URL, and path params are real
named fallbacks. The operation key is the lowercased method (always present,
always unique per path); `operationId` rides on `meta.openapi.operationId`,
which the openapi projector already emits verbatim. **[UNCERTIFIED]** keying
by `operationId` instead would give nicer derived names in mcp/graphql/cli
(`listPets` vs `pets_get`); it's one `flatMapOperations` away either way.

**Method semantics become tags from the spec, not a name table.**
GET/HEAD/OPTIONS/TRACE get `tags.readOnly` (RFC 9110 §9.2.1 safe methods),
PUT/DELETE and the safe methods get `tags.idempotent` (§9.2.2). This is the
spec's own definition of those methods, not the rejected read→GET style
table, and it's what lets graphql pick query vs mutation and mcp set hints.

## Forge's features as special cases

| forge | general mechanism here |
|---|---|
| overlays (OpenAPI Overlay subset, two hardcoded targets) | `applyOverlay` over any JSON document with real RFC 9535 JSONPath, before any importer runs; plus `ApiDescription => ApiDescription` functions after |
| `x-fern-ignore` | `flatMapOperations(api, op => cond ? [] : op)` |
| `x-forge-aliases` | `flatMapOperations(api, op => [op, { ...op, address }])` |
| `x-fern-sdk-group-name` / method-name (regrouping) | a new `address` (see limit below) |
| `x-forge-hidden` | `patchOperations(api, where, { cli: { hidden: true } })` |
| `x-forge-params`, `x-forge-args` (CLI arg tweaks) | `meta.cli.*` / `meta.cli.sourceMap` via `patchOperations`; per-field defaults/descriptions are TypeRef meta on the input type |
| `x-fern-availability` (alpha/beta/ga/deprecated) | deprecated → `tags.deprecated`; every `x-*` passes through verbatim under `meta.openapi` (no new lifecycle key invented) |
| `x-forge-commands` group descriptions | `patchGroup(api, address, { description })` |
| `x-forge-require-confirmation` | `tags.destructive` (already read by cli and mcp) |
| OpenAPI-only input | one importer per format, all targeting the same `ApiDescription` |

Forge's closed allowlist of `x-forge-*` keys is the opposite of the open meta
bag, so none of these needed a new mechanism.

## Known limits

- **Re-addressing an HTTP-bound operation moves its URL.** `moveTo` is
  relative and a wildcard it creates is named `"param"`, so an operation
  whose address doesn't mirror its URL (forge-style regrouping, protobuf
  `google.api.http`, Smithy `@http`) can't carry an exact http binding.
  Importers keep such bindings verbatim under `meta.<format>` with a
  diagnostic. TypeSpec is hit hardest: its addresses have no param segments,
  so only param-free routes whose containers are named like the route get
  `meta.http`. Fixing it would need named wildcards in `moveTo`, which brushes
  against the "no bound-variable machinery" invariant; open for the owner.
- **Non-2xx responses / error types** have no slot in `Operation` yet;
  importers report them as a diagnostic.
- **Client/bidi streaming** has no representation in the tree model
  (protobuf skips such rpcs with a diagnostic).
- **One flat `schemaMap` per convention.** With `namespace: "mcp"`, a tool
  and a prompt sharing a `meta.mcp.name` share one key.
- **Projector-side losses seen in round trips:** type-ir's `toGraphQL` prints
  `ID` as `String`; the graphql projector always names roots
  Query/Mutation/Subscription; mcp regenerates `idempotentHint: true` from
  `readOnly`.
