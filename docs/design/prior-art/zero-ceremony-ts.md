# Prior art: "scale-to-zero" ceremony in TypeScript API frameworks

Question: can a TS framework infer HTTP method/path/input/output/OpenAPI/client from a
plain function, the way Rust proc macros do? Findings below; each option evaluated on how
close it gets and what it costs.

## 1. TS Compiler API / ts-morph (build-time introspection)

Works, with real limits. ts-morph wraps the compiler's AST + type checker; given a
`Program`, you can walk exported functions, read parameter names, and ask the checker
for a resolved type at each parameter — this is the closest TS analog to a proc macro.
It requires loading a full `Program` (not just parsing one file), because resolving an
imported type, a generic, or a conditional type needs the checker to do actual inference.
That means: a build step is mandatory for this path, and it's slow relative to a
single-file transform (full type-checking, not just syntax). Generics resolve only when
instantiated at a call site the checker can see; conditional/mapped/recursive types often
resolve to `any` or an unreadable structural type when serialized. JSDoc is readable as
plain comments but carries no semantic guarantee — it can drift from the real type.
Net: usable for a *restricted* subset of "plain function" signatures (concrete named
types, no generics-over-generics), same restriction Rust's serde-derive effectively
imposes, but here it's an unenforced convention rather than a compile error.

## 2. TC39 (stage-3) decorators

Not a path to type derivation. Standard decorators ship in TS 5.0+ needing no tsconfig
flag, and `context.metadata` gives you a shared object to stash data in — but nothing is
put there automatically. The bridge that legacy decorators had (`emitDecoratorMetadata` +
`reflect-metadata`, exposing `design:type`) is *not* reproduced by the TC39 proposal
(tracked as an open gap, microsoft/TypeScript#57533, #55788). Even where the legacy bridge
exists, it only emits coarse nominal types (`Number`, `String`, `Object`, `Array`) — no
shape, no union, no literal, no generic. Decorators reduce syntactic ceremony (one
annotation vs. a manual registration call) but contribute nothing toward deriving a schema
from a type. They are ceremony, just smaller ceremony, and they don't solve type erasure.

## 3. Runtime reflection (reflect-metadata, TypeBox, Zod)

This is where real frameworks actually land, and it inverts the direction of derivation.
Since TS types don't exist at runtime, TypeBox/Zod make the *schema itself* the runtime
value — you write `z.object({ id: z.number() })`, and the static type is *inferred from
the schema* via `z.infer<>`, not the reverse. The framework introspects the schema object
(a real runtime value) to build OpenAPI/validation/client, never touching an erased type.
This is genuinely zero-build-step and robust — but the schema declaration is exactly the
ceremony the question wants removed. There is no runtime mechanism that derives a Zod
schema from a bare `function(id: number)` signature, because by the time the function
runs, `number` doesn't exist.

## 4. Bun / Deno mechanisms

Bun macros run at bundle/transpile time and inline a function's *return value* into the
bundle — they're a value-substitution mechanism (think `import.meta.env`-style constant
folding), not a type/AST introspection API; they don't receive type-checker information
about the call site. Deno's TS support is likewise a fast transpiler, not an added
reflection surface. Neither runtime offers anything beyond what ts-morph already provides
against plain `tsc`; both strip types before or during execution like every other engine.

## 5. Existing frameworks

- **Zodios / ts-rest**: schema-first contracts (Zod/TypeBox value declares path, method,
  input, output up front); OpenAPI and the typed client fall out of that value. Ceremony
  = writing the contract object, not the function.
- **feTS**: same shape, OpenAPI-spec-first instead of code-first.
- **tRPC**: closest to "just write a function" for the *client-typing* half of the
  problem — the client imports the router's TS *type* (never a runtime value), so
  autocomplete and argument checking come free from structural typing, with no schema
  and no build step. But it never derives HTTP method/path/OpenAPI at all: it collapses
  everything to one RPC endpoint and needs a separate mapping layer (`trpc-openapi`) with
  its own manual `meta()` ceremony to reconstruct REST semantics. It solves the client half
  by *not solving* the HTTP-shape half.

No surveyed framework derives all of {method, path, input parsing, output shape, OpenAPI,
typed client} from an annotation-free plain function. Each picks one of: (a) explicit
schema value as source of truth, (b) explicit RPC ceremony trading away REST shape, or
(c) a build step with a restricted, silently-degrading type subset.

## 6. The fundamental limitation

Type erasure means there are exactly two ways to get a runtime-usable description of a
function's shape: run the checker at build time and serialize what it resolves (ts-morph
et al.), or make the description a runtime value that the static type is inferred *from*
(Zod/TypeBox). Decorators and reflect-metadata sit in between and satisfy neither fully —
they reach the erasure boundary but only for nominal, non-generic types. A build step is
therefore not strictly mandatory (schema-first avoids one), but *true* zero-ceremony —
bare parameters, no schema value, no annotation — is only reachable via a build step, and
even then only for a bounded subset of types; complex/generic/conditional types must
degrade gracefully or be explicitly out of scope, exactly as Rust macros implicitly bound
themselves to serde-derivable types.
