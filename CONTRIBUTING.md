# Contributing to fractal

fractal is two related libraries: **type-ir**, a type intermediate representation that
converts between 20+ schema/language formats, and the **fractal framework**, which projects
a single `api()`/`op()` tree to HTTP, GraphQL, MCP, CLI, and JSON-RPC surfaces. Most
contributions land in one of `packages/type-ir` (a serialization-variant projector/ingestor)
or the framework packages (`api-tree` + the `*-api-projector` packages).

## Getting started

This is a Nix + direnv project — don't assume any toolchain (`bun`, `go`, `rustc`, `ghc`,
`dotnet`, ...) is on your `$PATH` outside the dev shell.

```sh
direnv allow      # first time only, activates the flake automatically on cd
# or, without direnv:
nix develop

bun install
```

`flake.nix` provisions every language toolchain the type-ir projectors compile-check
against (Python, Go, Rust, Java/Kotlin, .NET, Ruby, PHP, Haskell, C++, Dart, Elm, Crystal,
Swift, Flow, Objective-C/GNUstep, plus protoc/capnp/flatc). If a tool isn't found, you're
almost certainly not inside the dev shell — `cd` back into the repo (direnv) or re-run
`nix develop`, don't reach for a system package manager.

## Monorepo layout

Workspaces (`package.json`):

| Package | Role |
|---|---|
| `packages/api-tree` | Core: `api()`/`op()` tree constructors, `Node`/`Handler`/`Meta`, `Result`, the tag lattice, source-level schema extraction, codegen CLI |
| `packages/type-ir` | Type IR — subtyping hierarchy + open metadata bag; ingests and projects 20+ formats (JSON Schema, OpenAPI, SQL DDL, Protobuf, Zod, per-language serialization libraries, doc-site references, ...) |
| `packages/http-api-projector` | HTTP projection of the api-tree — router, OpenAPI 3.1, typed client |
| `packages/graphql-api-projector` | GraphQL projection — SDL, resolver dispatch, subscriptions, typed client |
| `packages/mcp-api-projector` | MCP projection — tools, resources, prompts, sampling |
| `packages/cli-api-projector` | CLI projection — subcommand dispatch, shell completions, streaming |
| `packages/json-rpc-api-projector` | JSON-RPC 2.0 projection — HTTP POST + WebSocket transports, batch requests, typed client |
| `packages/auth-oidc` | Generic OIDC/JWT auth adapter (server-side JWKS validation + client-side token lifecycle) |
| `packages/playground` | Browser playground (Vite + Solid) exercising type-ir's ingestor/projector matrix live |
| `examples/library-api` | End-to-end example tree, projected through HTTP + MCP + codegen, used as a living integration test |

type-ir and the framework packages are independent: type-ir is useful standalone as a
conversion library; the framework packages depend on it for their type-shape output but
don't depend on each other.

## Development commands

From the repo root (`bun run --filter '*' <script>` under the hood):

```sh
bun run typecheck   # tsc --noEmit across every workspace
bun run test        # bun test across every workspace
```

Per-package, from inside `packages/<name>`:

```sh
bun test                 # this package only
bun test --watch
bun test src/foo.test.ts # single file
```

type-ir's compile-check suite shells out to real compilers to verify generated code
actually compiles (not just string-matches):

```sh
cd packages/type-ir
bun test src/compile-check.test.ts
```

This needs the full Nix dev shell — it invokes `tsc`, `go`, `cargo`, `swiftc`, `ghc`,
`dotnet`, `g++`, `crystal`, `ruby`, `php`, `protoc`, `capnp`, `flatc`, `clang`. A handful of
variants (Jackson/Gson/Moshi/kotlinx, most Dart variants, Elm, `csharp-newtonsoft`) are
`test.skip` because their reference library isn't a single nixpkgs derivation — see the
comments next to each `test.skip` in `packages/type-ir/src/compile-check.test.ts` for why.

Build the playground:

```sh
cd packages/playground
bun run build   # or `bun run dev` for a live server
```

Run the example end-to-end:

```sh
cd examples/library-api
bun test
bun run codegen   # regenerate src/generated/validators.ts from src/tree.ts
```

## Architecture overview

Three independent layers, from `docs/design/design-philosophy.md`:

1. **Combinators** — the authoring surface. `api()`/`op()`, `http.get`/`http.post`, layers
   like `corsLayer`/`autoMethodLayer`. Compose routing and API functionality.
2. **Constructors / DU** — produce the serializable, inspectable data. A `Node<P,Res>` tree
   (`{ meta, handler }`) for routing; a `TypeRef`/`TypeShape` discriminated union for type
   shapes. This is the contract between layers 1 and 3.
3. **Interpreters / projections** — consume the DU to produce a surface: an HTTP router, a
   GraphQL SDL string, an MCP tool list, a Rust struct, a SQL `CREATE TABLE`. Projections
   don't know which combinators produced the tree; combinators don't know which projections
   exist.

Two DUs, two independent concern-sets: routing (API structure — HTTP paths, CLI
subcommands, MCP tool names are all projections of one navigable structure) and type
projection (data shapes) are separate. `packages/api-tree` owns the routing DU;
`packages/type-ir` owns the type DU. Both are extensible: an augmentable TypeScript
interface (`TypeKinds`, or the routing `meta` shape) produces the union, and any
projector/interpreter only needs to handle the variants it recognizes — a closed union
would force a core change every time a new format needs a new case.

**type-ir projectors vs framework projectors** — don't confuse the two:
- A **type-ir projector** (`packages/type-ir/src/*.ts`) turns a `TypeRef` into source text
  or a document for one target: a language's native types, a serialization library's
  annotated classes, a schema/IDL format, a doc-site reference page. Pure function:
  `TypeRef → string` (or a small AST for structured formats).
- A **framework/API projector** (`packages/*-api-projector`) walks the routing tree
  (`Node`/`Meta`) and produces a live surface — router, resolver map, tool list — using
  type-ir under the hood wherever it needs to emit a wire schema (e.g. `http-api-projector`
  calling into type-ir for OpenAPI).

**Open metadata bags**: `meta` on both DUs is a plain object with conventional keys, not a
fixed schema. Projections read the keys they recognize and ignore the rest — this is what
lets a new projector introduce a new metadata key without touching the core. Where keys have
expected semantics (`nullable`, `optional`, `default`, `constraints`, `http.dispatch`, ...),
that's a documented and tested *convention*, not an IR-enforced contract — violate it and
nothing stops you, but nothing guarantees the result works either.

Read `docs/design/design-philosophy.md` in full before non-trivial architectural changes;
it also covers hierarchy-via-subtyping (no synthetic taxonomic categories — a Rust `i32`
projects toward `int32 → integer → number` and falls back along that chain, not through an
invented "Scalar" node) and why spec references belong inline in projector source.

## Adding a new projector

Mechanical pattern for a new type-ir serialization/language variant (e.g. `kotlin-gson.ts`,
`csharp-servicestack.ts`):

1. **Create `packages/type-ir/src/<lang>-<library>.ts`.** Open with a short header comment:
   what it emits, how it differs from sibling variants for the same language (if any), and
   spec links for the target language/library (see `kotlin-jackson.ts` or `go-easyjson.ts`
   for the shape). Export a `to<Library>(ref: TypeRef, name: string): string` function (or
   whatever the sibling projectors for that shape use — check a close analog first, don't
   invent a new function signature).
2. **Follow the existing pattern for that target family.** If there's already a projector for
   the same language (e.g. adding `go-jsoniter.ts` next to `go-easyjson.ts` and
   `go-encoding-json.ts`), read it first and mirror its kind-dispatch structure
   (`isA(kind, target)` walking `ancestors()`, a `switch`/dispatch over `TypeShape.kind`,
   the same fallback-to-parent-kind behavior). Divergence should be because the target
   library genuinely differs, not because the new file reinvents structure the sibling
   already solved.
3. **Add the subpath export** to `packages/type-ir/package.json`'s `exports` map:
   ```json
   "./<lang>-<library>": {
     "types": "./src/<lang>-<library>.ts",
     "import": "./src/<lang>-<library>.ts"
   }
   ```
   If it's the "default"/most idiomatic variant for that language, also point the bare
   `"./<lang>"` alias at it (see `"./go"` → `go-encoding-json.ts`, `"./kotlin"` →
   `kotlin-kotlinx.ts`).
4. **Add `packages/type-ir/src/<lang>-<library>.test.ts`.** Cover primitives, the
   subtyping-fallback cases (widths, semantic strings degrading to their base kind),
   objects/unions/enums, and any library-specific annotation behavior. Use an existing
   sibling test file as the template for coverage shape, not just syntax.
5. **Wire real compile-checking if the toolchain is a single nixpkgs derivation.** Add the
   package to `flake.nix` if missing, then add a case to
   `packages/type-ir/src/compile-check.test.ts` that actually invokes the compiler/checker
   against generated output. If the library can't be vendored this way (Maven/Gradle/NuGet/
   pub.dev-resolved, no nixpkgs derivation), add `test.skip` with a comment explaining why —
   follow the existing skip comments for the pattern.
6. **Add to `cross-projector.test.ts`** if the new projector should participate in the
   fixture-driven smoke matrix (`packages/type-ir/src/__fixtures__`) alongside its peers.
7. Run `bun test` and `bun run typecheck` in `packages/type-ir` before committing.

A framework projector (new transport surface, e.g. a new `packages/*-api-projector`) is a
bigger addition — start from the closest existing one (`cli-api-projector` is the smallest)
and read `docs/design/design-philosophy.md`'s "routing is the API structure" section first.

## Code style

- Comments are for *why*, not *what* — rationale, spec citations, and cross-references to
  sibling projectors, not restating what the next line of code does. Every projector cites
  the relevant spec section(s) it implements, inline, near the top of the file: projector
  output needs to be auditable against the standard without hunting for the section, which
  matters especially when the code was written or modified by an LLM.
  See `packages/type-ir/src/kotlin-jackson.ts` for the header-comment shape to follow.
- Conventions over contracts: don't add enforcement machinery for a metadata-bag key just
  because one exists — document the convention, write tests that exercise it, leave the IR
  itself unopinionated. See `docs/design/design-philosophy.md`.
- Prefer extending the open `TypeKinds`/`meta` surface over widening a closed union or
  adding a new required field.
- No taxonomic supertypes (`Scalar`, `Composite`, ...) in the subtyping hierarchy unless a
  concrete projection actually uses one as a fallback target.

## CI

`.github/workflows/ci.yml` runs on every push/PR to `master`, entirely inside
`nix develop` (via `DeterminateSystems/nix-installer-action`), in this order:

1. `bun install`
2. `bun run typecheck` (all workspaces)
3. `bun run test` (all workspaces)
4. `bun test src/compile-check.test.ts` in `packages/type-ir` — broken out as its own step
   (even though step 3 already runs it) so a real-compiler regression is visible on its own
   rather than buried in the general test step
5. `bun run build` in `packages/playground`

To reproduce the whole pipeline locally:

```sh
nix develop --command bun install
nix develop --command bun run typecheck
nix develop --command bun run test
(cd packages/type-ir && nix develop --command bun test src/compile-check.test.ts)
(cd packages/playground && nix develop --command bun run build)
```

If you're already inside the dev shell (direnv), drop the `nix develop --command` prefix.
