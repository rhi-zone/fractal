// A real Node tree used by extract.test.ts as BOTH the extractor's source input
// (parsed via the compiler API for its leaf handler input types + JSDoc) and the
// runtime tree fed to toTools. Not a test file (no `.test.ts`), so bun test skips it.
//
// Leaf nodes (callables) are stored in `children` as `op(fn, meta?)` calls.
// The codegen walker recognises `op(...)` children as leaves and extracts
// their input schemas.

import { api, op } from "../node.ts";
// (a) Direct import from core's package root.
import type { Result } from "../index.ts";
// (b) Barrel re-export: Result re-exported through a local barrel FILE, name
// unchanged. TypeScript sees the same identifier "Result" — the syntax path
// matches it by name and extracts the first type argument.
import type { Result as ResultFromBarrel } from "./result-reexport.fixture.ts";
// Side-effect import: brings this test suite's own "deployment" augmentation
// (`LeafMeta extends McpLeafMeta`, `BranchMeta extends McpBranchMeta` — see
// that fixture's own doc comment) into this file's compilation, so
// `op(fn, { mcp: { name: … } })` and `api(children, { meta: { mcp: {
// segment: … } } })` below type-check the same way they would in a real
// deployment that uses MCP overrides — see the `mcpOverrides` branch below
// and extract.test.ts's "meta.mcp overrides reflected in the reconstructed
// name" describe block. Per docs/design/meta-role-split-spec.md §2/§3,
// mcp-api-projector itself performs no augmentation — only a deployment's
// own file (this one, for this test suite) does.
import "./deployment-meta.fixture.ts";

// (c) Further-generic alias: a local type alias that wraps Result<T, string>.
// The syntax path recognizes this by walking the local TypeAliasDeclaration —
// its body is a TypeReference named "Result", so the first type arg at the call
// site maps to T.
type ApiResult<T> = Result<T, string>;

// A NAMED parameter type (as opposed to every other op below, whose input is
// an inline object literal) — exercises the import-provenance path:
// `typeRefFromFunctionNode` should carry `meta.typeName`/`meta.declarationFile`
// for this op's input, which `buildValidatorModuleSource` (build.test.ts)
// then turns into a generated `import type { BookQuery } from "…"`.
export type BookQuery = { q?: string };

// Named-constant op — declared separately and referenced by identifier in the
// tree literal below, exercising the walker's identifier-resolution path
// (not just inline `op(...)` calls). Mirrors examples/library-api's
// `const listBooks = op(...); api({ list: listBooks })` pattern.
/** List all widgets in the catalog. */
const listWidgetsOp = op((_input: { limit?: number }) => ({ widgets: [] as string[] }));

// A named-constant branch — an `api(...)` call assigned to a const and
// referenced by identifier, exercising identifier resolution for branch
// children (not just leaves).
const widgetsBranch = api({
  list: listWidgetsOp,
});

export const tree = api({
  // Named-constant branch referenced by identifier.
  widgets: widgetsBranch,
  users: api(
    {
      /** Create a new user account. */
      create: op(
        (_input: {
          /** The user's display name. */
          name: string;
          /**
           * Age in years.
           * @default 18
           */
          age?: number;
          roles: string[];
          address: {
            /** Street address line. */
            street: string;
            zip?: string;
          };
        }) => ({ id: "u1" }),
      ),
    },
    {
      fallback: {
        name: "userId",
        subtree: api({
          get: op((input: { userId: string }) => ({ userId: input.userId })),
        }),
      },
    },
  ),
  // A fallback subtree that is a BARE `op()` leaf, not `api({...})` — the
  // Node model (node.ts's `fallback: { name, subtree: Node }`) explicitly
  // allows this, and build.ts's runtime walks (`collectUnvalidatedLeaves`/
  // `wrapValidatorsUnchecked`) already handle it (they check
  // `node.handler !== undefined` on the subtree itself, before ever
  // looking at `children`). Regression coverage for the extractor side:
  // `walkNodeType` (tree.ts) must visit this leaf too, keyed identically
  // to the runtime walk — extract.test.ts's
  // "bare-leaf fallback.subtree" describe block asserts on it.
  widgetById: api(
    {},
    {
      fallback: {
        name: "widgetId",
        subtree: op((input: { widgetId: string }) => ({ widgetId: input.widgetId })),
      },
    },
  ),
  // Union input → exercises the punt path.
  search: api({
    run: op((_input: { q: string | number }) => ({ hits: 0 })),
  }),
  // Promise<T> return → output schema should unwrap to T's schema.
  async: api({
    fetch: op(async (_input: { id: string }) => ({ value: 42 })),
  }),
  // (a) Direct import: Result<T,E> — syntax path extracts T by name + 2 typeArgs.
  fallible: api({
    compute: op((_input: { x: number }): Result<{ answer: number }, string> => ({
      kind: "ok",
      value: { answer: _input.x },
    })),
  }),
  // (b) Barrel re-export: same "Result" name imported through a local barrel.
  // The syntax path checks the identifier name, not the origin file, so it
  // correctly extracts T from `ResultFromBarrel<{count:number}>`.
  barrel: api({
    query: op((_input: { term: string }): ResultFromBarrel<{ count: number }, string> => ({
      kind: "ok",
      value: { count: 0 },
    })),
  }),
  // (c) Further-generic alias: ApiResult<T> = Result<T, string>.
  // Syntax path walks the local TypeAliasDeclaration and recognizes the pattern.
  generic: api({
    search: op((_input: { q: string }): ApiResult<{ items: string[] }> => ({
      kind: "ok",
      value: { items: [] },
    })),
  }),
  // Promise<Result<T,E>> → syntax path strips Promise first, then unwraps Result.
  promiseResult: api({
    load: op(async (_input: { id: string }): Promise<Result<{ name: string }, string>> => ({
      kind: "ok",
      value: { name: "Alice" },
    })),
  }),
  // A NAMED parameter type (`BookQuery`, declared above) — see its doc
  // comment for what this exercises.
  namedType: api({
    search: op((input: BookQuery) => ({ hits: input.q === undefined ? 0 : 1 })),
  }),
  // meta.mcp.name / meta.mcp.segment overrides — exercises tree.ts's
  // override-aware name reconstruction (walkNodeType's `mcpMetaOverride`)
  // against mcp-api-projector's actual runtime `projectTools` walk. See
  // extract.test.ts's "meta.mcp overrides reflected in the reconstructed
  // name" describe block.
  mcpOverrides: api({
    // Leaf-level meta.mcp.name: full override — the usual
    // underscore-joined prefix ("mcpOverrides_renamed") is NOT used.
    renamed: op((_input: { q: string }) => ({ hits: 0 }), {
      mcp: { name: "custom_search" },
    }),
    // Branch-level meta.mcp.segment: overrides only THIS child's own
    // contribution to the prefix — the outer "mcpOverrides" prefix still
    // applies, so the leaf below reconstructs as "mcpOverrides_products_list".
    catalog: api(
      {
        list: op((_input: { limit?: number }) => ({ items: [] as string[] })),
      },
      { meta: { mcp: { segment: "products" } } },
    ),
  }),
  // A TS BUILTIN/GLOBAL utility type (`Record<K,V>`) used directly as a
  // handler's whole input — exercises `typeProvenanceOf`'s builtin-lib-file
  // exclusion (extract.ts): `Record`'s alias declaration lives in
  // TypeScript's own bundled `lib.es5.d.ts`, which IS nameable
  // (`type.aliasSymbol.name === "Record"`) but is never IMPORTABLE (no
  // module lives at that path) — this must inline structurally instead of
  // producing `import type { Record } from ".../lib.es5.d.ts"` (which
  // fails to compile downstream: `TS2306: File '…' is not a module`).
  // build.test.ts's "given an outFile" describe block asserts on this.
  builtinNamedInput: api({
    merge: op((input: Record<string, string>) => ({ merged: input })),
  }),
  // A leaf whose RETURN type reaches into a TS/DOM builtin's generically
  // self-referential, symbol-keyed-member-bearing structure (`Response`,
  // via `Uint8Array`/`ReadableStream` in its own surface) — regression
  // coverage for two upstream `type-ir` fixes together:
  //   1. The call-budget circuit breaker (`typeRefFromType`'s
  //      `seen`-based cycle detection can't terminate this walk on its
  //      own — see from-typescript.test.ts's own `Response` test).
  //   2. Symbol-keyed member exclusion (`Uint8Array`'s
  //      `[Symbol.iterator]`/`[Symbol.toStringTag]` — TS's synthetic name
  //      for these, e.g. `"__@iterator@8"`, is invalid to emit as a bare
  //      object-type field name; from-typescript.test.ts's "classes"
  //      describe block covers the unit-level case, this fixture leaf is
  //      the end-to-end one: build.test.ts asserts the FULL generated
  //      module — annotation text included — is syntactically valid TS).
  builtinReturnType: api({
    // The body never runs in any test (`toTools`/`runCli --help` never
    // invoke a leaf's handler): it throws immediately instead of calling a
    // real `fetch()`, so this fixture cannot trigger a network call.
    fetchIt: op((_input: { url: string }): Promise<Response> => {
      throw new Error("fixture leaf — never actually invoked");
    }),
  }),
  // A 2-member union without the Result name or DU shape — the negative case
  // for Result-detection: this union must not be mistaken for one.
  differentUnion: api({
    ping: op((_input: { x: number }): { kind: "a"; x: number } | { kind: "b"; y: string } => ({
      kind: "a",
      x: _input.x,
    })),
  }),
});
