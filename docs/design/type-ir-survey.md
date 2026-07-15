# Type IR survey: type concepts across type systems and data models

> Research artifact, not a design decision. Everything below is factual reporting on
> external systems (**[CERTIFIED-EXTERNAL]** — verified against spec text or
> well-established documentation) plus one **SYNTHESIS** section at the end that is
> explicitly the assistant's proposal, not user-ratified. Purpose: build the raw
> material for a fractal type IR that is (a) an extensible hierarchy, not a flat
> closed enum; (b) a superset of all projection targets, so projections narrow rather
> than guess; (c) not organized around any single blessed theory (not "everything is
> a JSON Schema," not "everything is a Rust enum"); (d) resolved by fallback — an
> unknown type walks up to its nearest known ancestor instead of erroring.

---

## 1. JSON Schema (draft 2020-12)

**Concrete type constructors** (the `type` keyword): `null`, `boolean`, `object`,
`array`, `number`, `string`, `integer` (a numeric subtype layered on `number`, not a
distinct wire type — everything is IEEE-754/arbitrary precision JSON number
underneath). `type` may be a single string or an array of strings (implicit union).

**Structural combinators:**
- `object` shape: `properties`, `patternProperties`, `additionalProperties`,
  `propertyNames`, `required`, `minProperties`/`maxProperties`,
  `unevaluatedProperties` (2019-09+; closes the gap left by composition keywords).
- `array` shape: `items` (single schema applied to all elements, 2020-12 merged
  `items`+`additionalItems` from draft-07's dual-keyword split), `prefixItems`
  (tuple-typed leading elements, replacing draft-07 `items: [...]`), `contains`,
  `minContains`/`maxContains`, `minItems`/`maxItems`, `uniqueItems`.
- Composition (boolean algebra over schemas, not a distinct type kind):
  `allOf` (intersection), `anyOf` (union, ≥1 must match), `oneOf` (exclusive union,
  exactly 1 must match), `not` (negation).
- Reference/reuse: `$ref`, `$dynamicRef`/`$dynamicAnchor` (2020-12's generics-like
  mechanism for recursive/extensible schemas, e.g. "extensible base schema" pattern),
  `$defs`, `$anchor`, `$id`, `$schema`.
- Conditional composition: `if`/`then`/`else` — the closest JSON Schema gets to a
  discriminated/dependent type, but it's schema-level branching on validation
  success, not a tagged union primitive.
- `dependentSchemas`, `dependentRequired` — field-presence-conditional shape.

**Refinement/constraint mechanisms:** `format` (semantic annotation, non-normative
by default — `date-time`, `email`, `uuid`, `uri`, `ipv4`, `regex`, etc. — vocabulary
of string subtypes that validators may or may not enforce), `pattern` (regex),
`minLength`/`maxLength`, `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`,
`multipleOf`, `const` (single-value type), `enum` (closed value set), `contentEncoding`
/`contentMediaType`/`contentSchema` (string-encodes-another-document escape hatch).

**Unique to JSON Schema:** the boolean-algebra composition model (`allOf`/`anyOf`
/`not`) is structural set algebra over *schemas as predicates*, not over *types as
sets of constructors* — a schema is fundamentally "a predicate over instances," and
type-ness is one keyword among many. `format` as a soft, unenforced annotation
namespace is a genuinely distinct idea: an open, non-blocking vocabulary of semantic
tags layered on top of a structural type.

**Recursion:** yes, via `$ref` to `$id`/`$anchor`, unbounded.
**Generics/parameterization:** no native generics; `$dynamicRef` approximates
"override a subschema in a derived document," which is closer to inheritance-hook
than parametric polymorphism.
**Sum/product types:** product = `object`+`properties`; sum = `anyOf`/`oneOf`, with
no native tag-field discrimination (that's bolted on via `if`/`const` per-branch, or
externally via OpenAPI's `discriminator` keyword, which JSON Schema itself doesn't
define).
**Nullability/optionality:** no dedicated null-flag; `null` is a full sibling type in
`type: [...]` unions, and optionality is field-absence via `required` (a field not
listed as required may simply be absent, which is different from JS `?:`'s
`| undefined`).
**Extensibility:** wide open — unknown keywords are ignored by default (unless
`unevaluatedProperties`/vocabularies restrict this), and the meta-schema/vocabulary
mechanism (2019-09+) lets you declare custom vocabularies of keywords formally.

---

## 2. JSON Type Definition (RFC 8927 / JTD)

Deliberately the anti-JSON-Schema: **exactly 8 mutually exclusive schema forms**,
no ambiguity, no keyword-combination explosion, designed for trivial cross-language
codegen.

**The 8 forms** (a JTD schema is always exactly one of):
1. **Empty form** — `{}`, accepts anything (top type).
2. **Type form** — `{"type": "..."}` with the value being one of: `boolean`,
   `string`, `timestamp` (RFC 3339 string, the *only* built-in semantic type),
   `float32`, `float64`, `int8`, `uint8`, `int16`, `uint16`, `int32`, `uint32`
   (fixed-width numeric types are a deliberate first-class primitive set, unlike
   JSON Schema's single `number`/`integer`).
3. **Enum form** — `{"enum": [...]}`, closed string value set.
4. **Elements form** — `{"elements": schema}`, homogeneous array (JSON Schema's
   `items` minus tuples).
5. **Properties form** — `{"properties": {...}, "optionalProperties": {...},
   "additionalProperties": bool}` — struct with required vs. optional fields as
   *separate keyword buckets* rather than a `required` name-list (a distinct design
   choice from JSON Schema).
6. **Values form** — `{"values": schema}`, homogeneous string-keyed map/dictionary
   (JSON Schema needs `patternProperties: {".*": schema}` to approximate this; JTD
   makes "map with values of type T" first-class).
7. **Discriminator form** — `{"discriminator": "tag", "mapping": {"a": schema, ...}}`
   — a **first-class tagged union**, unlike JSON Schema. This is the standout
   concept: JTD bakes in exactly the discriminated-union shape most languages'
   codegen wants, keyed by a literal tag field.
8. **Ref form** — `{"ref": "name"}`, referencing a `definitions` map (no arbitrary
   URI `$ref` graph — refs are local-only, which trades JSON Schema's document-graph
   flexibility for guaranteed non-cyclic-across-documents simplicity... though
   self-referential/recursive `definitions` entries are explicitly allowed).

**Refinement/constraint mechanisms:** deliberately none beyond `enum` and the type
list — no regex, no min/max, no format beyond `timestamp`. JTD's stance is that
validation-level refinement is out of scope; it's a *shape* language, not a
*constraint* language. Extension point: `metadata` (a free-form, ignored-by-
validators object every form may carry, explicitly reserved for exactly this kind of
tool-specific annotation).

**Nullability:** every one of the 8 forms may carry `"nullable": true`, uniformly —
a single orthogonal flag rather than a type union member. This is a materially
different design from JSON Schema (`null` as a union member) and from JTD's own
peer, GraphQL (non-null is the marked case, opposite default).
**Optionality:** properties form's split into `properties` (required) vs.
`optionalProperties` (may be absent) — again, no default-null merging; absence and
null are two distinct, orthogonal axes (a field can be optional AND non-nullable, or
required AND nullable, or both, or neither) — this 2×2 is explicit and clean in a
way most systems blur.
**Recursion:** yes, via `definitions` + `ref`, including self-reference.
**Generics:** none.
**Extensibility:** the `metadata` keyword on every form is the *only* sanctioned
extension point — deliberately narrow, in contrast to JSON Schema's "everything
unknown is ignored" laissez-faire approach.

---

## 3. Serde's data model (Rust)

**[CERTIFIED-EXTERNAL, verified against serde.rs/data-model.html]** Serde does not
mirror Rust's type system; it defines a smaller, fixed, canonical data model that
every Rust type's `Serialize`/`Deserialize` impl maps onto, and every format's
`Serializer`/`Deserializer` implements. Exactly **29 types**:

- **14 primitives:** `bool`, `i8`/`i16`/`i32`/`i64`/`i128`, `u8`/`u16`/`u32`/`u64`
  /`u128`, `f32`/`f64`, `char`.
- **String** — UTF-8, len-prefixed, no null terminator (distinguished at
  deserialize-time into transient/owned/borrowed strategies, but that's a
  deserializer-side performance concern, not a data-model type distinction).
- **Byte array** — `[u8]`, deliberately distinct from `Seq<u8>` so formats can pick
  an efficient binary representation instead of a JSON-array-of-numbers.
- **Option** — `None`/`Some(T)`, a dedicated presence type (not folded into a
  2-variant enum).
- **Unit** — Rust's `()`, zero-data marker.
- **Unit struct** — a named zero-field struct, e.g. `struct Marker;` — distinct from
  `Unit` because the *name* is semantically meaningful to some formats (self-
  describing formats can emit it).
- **Unit variant** — a nullary enum variant, e.g. `Enum::Foo`.
- **Newtype struct** — single-field tuple struct, e.g. `struct Meters(f64)` — a
  first-class "wrapper" type distinct from a 1-tuple, because formats may choose to
  serialize it transparently (this is essentially a built-in *branded/nominal
  wrapper* concept, notable because most of the surveyed systems don't have one).
- **Newtype variant** — single-field enum variant, `Enum::Foo(T)`.
- **Seq** — variable-length homogeneous-in-principle (heterogeneous in practice)
  sequence.
- **Tuple** — fixed-size heterogeneous sequence (arity is part of the type).
- **Tuple struct** — named tuple, `struct Rgb(u8, u8, u8)`.
- **Tuple variant** — enum variant carrying a tuple, `Enum::Foo(A, B)`.
- **Map** — arbitrary key→value, keys not required to be strings (unlike JSON/most
  systems here — a key can itself be any serializable type).
- **Struct** — named fields, product type.
- **Struct variant** — enum variant carrying named fields, `Enum::Foo{a: A, b: B}`.

**Unique to serde:** the model is not "what JSON can represent" but "what a Rust enum
+ struct system can represent, decoupled from any wire format" — it's the clearest
example in this survey of a data model designed explicitly as an IR: many Rust
source shapes (all the struct/variant permutations) map onto it, and many wire
formats (JSON, MessagePack, CBOR, Postcard, BSON, ...) map from it, with the 29 types
as the narrow waist. That waist-shape is exactly the structural role fractal's type
IR needs to play, just for a different pair of ends (TS source types ↔ protocol
projections).

Also notable: serde's model has **five separate compound-with-a-name buckets**
(unit/newtype/tuple/struct crossed with plain-vs-variant) purely to preserve
*nominal* information (the type or variant's name) through serialization — most
systems in this survey erase names and keep only structure. That's a second axis
(structural vs. nominal identity) worth carrying into the IR.

**Constraints/refinements:** none — serde is a pure shape/shape-mapping model, no
validation semantics at all (validation is explicitly punted to the type's own
constructor / a separate crate like `validator`).
**Nullability/optionality:** `Option<T>` is the single mechanism for both; serde
doesn't distinguish "absent key" from "present key with null" by default (though a
field can opt in to distinguishing them via `#[serde(default)]`/custom
deserialize logic — that's application-level, not data-model-level).
**Recursion:** yes, ordinary Rust recursive types (`Box`, `Rc`, etc. for indirection).
**Generics:** yes, full Rust generics — but they're monomorphized before hitting the
data model, so the data model itself is not parametric; genericity is a *source*-
level concept that's fully resolved away by the time something is one of the 29
types.
**Extensibility:** closed at exactly 29 — this is deliberate (it's what makes
"one Serializer works with every format" possible). Any new Rust shape maps onto
some combination of the existing 29; the 29 aren't meant to grow.

---

## 4. TypeScript's type system

**Primitives:** `string`, `number`, `boolean`, `bigint`, `symbol`, `undefined`,
`null`, `void` (call-site-only "don't care about return"), `never` (bottom type,
empty set), `unknown` (top type, safe `any`), `any` (top type, unsafe/escape-hatch),
`object` (non-primitive top).

**Structural types:** object type literals (`{a: string, b?: number}` — optional
via `?`, readonly via `readonly`), array types (`T[]`/`Array<T>`), tuple types
(`[A, B, C]`, with optional elements `[A, B?]`, rest elements `[A, ...B[]]`, and
*named* tuple elements as of TS 4.0 purely for DX/labels, no runtime meaning),
function types (as values — call signatures, construct signatures, overloads),
class types (nominal-ish via structural-compatibility-plus-private-field-branding),
index signatures (`{[key: string]: T}`, and since TS 4.4+ `{[key: symbol]: T}` /
template literal key patterns).

**Union/intersection:** `A | B` (union — sum by set-union of allowed values, not a
tagged sum; TS narrows via control flow, `typeof`, `in`, discriminated-literal
fields, or user-defined type guards, but the union itself carries no tag),
`A & B` (intersection — product by set-intersection; for object types this behaves
like structural merge, but for primitives it collapses to `never` since e.g.
`string & number` has no inhabitants).

**Literal types:** string/number/boolean/bigint/enum-member literals as types
(`"GET"`, `42`, `true`) — the mechanism discriminated unions are built from (a union
of object types each with a distinct literal-typed tag field).

**Branded/nominal types:** not native — the community pattern is intersecting a
structural type with a unique symbol/phantom property (`string & { __brand:
"UserId" }`), i.e. nominal typing is *encoded*, not primitive. Worth noting because
if the IR wants a first-class "nominal wrapper" concept (echoing serde's newtype),
TS itself doesn't hand you one — you'd be modeling something TS users simulate, not
something the TS compiler natively tracks in `.d.ts` output... except:

**Template literal types:** `` `prefix-${string}` `` — a genuinely novel-to-this-
survey construct: a *type-level string pattern*, effectively a compile-time regex-
like combinator over literal/primitive string types, with distributive behavior over
unions of its interpolated positions.

**Conditional types (`T extends U ? X : Y`) and mapped types (`{[K in keyof T]: ...}`)
as resolved:** critical scoping note for the IR — these are *source-level type-level
computation*, and the survey only needs their **resolved/reified output**, since
fractal's IR presumably operates on the type-checker's resolved output (what
`ts.TypeChecker` reports), not on unevaluated generic type expressions. Resolved,
they bottom out in the same vocabulary already listed: a resolved conditional type
is just whichever branch's type it became; a resolved mapped type is just an object
type (with per-key optionality/readonly-ness set per the mapping modifiers `+?`/`-?`
/`+readonly`/`-readonly`). The *inputs* to these computations (generics, `infer`,
distributive conditional types over union inputs) are a TS-source-only concern and
don't need IR representation — only their reified results do.

**Enums:** `enum`/`const enum` — nominal, numeric-or-string-backed; structurally
close to a closed literal union but the compiler treats enum members as a distinct
nominal-ish type from the underlying primitive literal.

**Unique to TypeScript (vs. rest of survey):** template literal types (type-level
string patterns); untagged unions with structural narrowing instead of a built-in
discriminant; the `unknown`/`any`/`never` three-way split of "top but safe" / "top
and unsafe" / "bottom."
**Recursion:** yes, including in conditional/mapped type definitions (tail-
recursion-optimized by the compiler within limits) and in ordinary interfaces.
**Generics:** yes, fully parametric, including higher-kinded-ish patterns via
generic type constructors (though no true HKT); resolved output, as above, has
generics substituted away.
**Constraints/refinement:** no runtime validation semantics at all — TS types are
erased at compile time; anything resembling refinement (e.g. `NonEmptyArray<T>`) is
simulated via structural encoding (branding, tuple-with-required-first-element),
never enforced by the type system against real data.
**Nullability/optionality:** `| null` / `| undefined` as ordinary union members
(with `strictNullChecks` making them require explicit opt-in), and `?:` for
optional object/tuple members — three orthogonal knobs (nullable via union,
undefined via union, optional via `?:` which itself implies `| undefined` in the
read type but not the write type since TS 4.4's `exactOptionalPropertyTypes`
distinguishes "missing key" from "present key: undefined").
**Extensibility:** the type system's constructor set is fixed by the language spec
(closed, versioned by TS releases); *values* within it (interfaces, type aliases)
are of course unboundedly user-defined — the analogy for the IR is "the vocabulary
of constructors is what's open in fractal's design, not each system's own
constructor set."

---

## 5. OCaml / ReasonML / ReScript variants, records, tuples

**Variant types (ADTs):** `type t = Foo | Bar of int | Baz of string * bool` — each
constructor may carry zero or more *positional* (tuple-shaped) arguments; this is
the "sum of products" archetype other systems approximate. Constructors are
nominal — `Foo` belongs to exactly one type (barring shadowing), unlike TS's
structural literal-tag unions.

**Polymorphic variants:** `` `Foo | `Bar of int `` — structurally typed sum types;
two polymorphic variant values with overlapping constructor sets are compatible
without sharing a declared common type. This is the standout concept vs. plain
variants: **structural sum types**, i.e. row-polymorphism applied to sums (open rows
via `[> \`Foo]` "at least these constructors" and closed rows via `[< \`Foo]` "at
most these constructors"). No other system surveyed here has a first-class
open-vs-closed-row sum type — this is close in spirit to what "fallback via
hierarchy" wants from unknown-tag handling in a discriminated union.

**Records:** `{ x: int; y: string }` — nominal product type (must be declared,
unlike tuples); OCaml also has record punning, mutable fields (`mutable x: int`),
and (in newer OCaml) inline records as variant-constructor payloads (`Foo of { x:
int }`, avoiding needing a wrapper tuple/record type).

**Tuples:** `int * string * bool` — anonymous fixed-arity product, purely
structural/positional.

**Newtype-equivalent:** `type meters = float` (type alias, no wrapping — erased,
purely a documentation/inference aid) vs. a single-constructor variant `type meters
= Meters of float` (real nominal wrapper with runtime tag, closer to serde's
newtype) — OCaml has *both* an erased alias and a reified wrapper, which is a useful
two-tier model (alias = same type, different name for humans; wrapper variant = a
genuinely distinct type at both compile- and run-time).

**GADTs (Generalized ADTs):** constructors whose return type can be *instantiated*
per-constructor rather than uniformly parametric — e.g. an `_ expr` type where
`IntLit: int -> int expr` and `BoolLit: bool -> bool expr` both build `'a expr` but
pin `'a` differently. Notable because it's a form of *type-indexed* sum where each
branch's associated type isn't simply "the union of all branch payload types" — the
tag determines more than just which fields exist, it determines the whole type
context. Advanced/optional for an IR, but worth flagging since discriminated unions
in most languages assume "tag picks a payload shape," while GADTs show "tag can pick
a whole family of types," a strictly more general idea.

**Constraints/refinement:** none built in; OCaml's type system is a pure static
structural/nominal system, no runtime validation vocabulary (refinement types exist
only via research extensions/other languages, not core OCaml).
**Nullability:** no null; `'a option = None | Some of 'a` is the *only* absence
mechanism, uniformly, for every type — much closer to Rust's `Option<T>` /
serde's `Option` than to TS's ambient nullable unions.
**Recursion:** yes, native (`type tree = Leaf | Node of tree * tree`), including
mutually recursive type groups (`and`).
**Generics:** yes, full parametric polymorphism (`'a list`, `('a, 'b) result`),
including phantom type parameters used purely for compile-time tagging with no
runtime representation (another idea worth carrying: a *phantom*/erased-at-runtime
type parameter, as distinct from a reified one).
**Extensibility:** variant types are closed once declared (adding a constructor is
a breaking change to every match expression, intentionally, for exhaustiveness
checking) — *except* OCaml has **extensible variant types**
(`exception`/`type t = ..` open type definitions) where new constructors can be
added from other modules after the fact, at the cost of losing exhaustiveness
checking. This is a directly relevant prior-art data point for "extensible
hierarchy, not closed enum": OCaml models the open/closed choice as a type-level
opt-in (`type t = ...` closed vs. `type t = ..` open), rather than picking one
globally.

---

## 6. Haskell ADTs

**Sum types:** `data Shape = Circle Double | Rectangle Double Double` — constructors
as functions, exhaustiveness-checked pattern matching, same "sum of products" shape
as OCaml variants but with Haskell's more developed type-class-driven ecosystem
layered on top.

**Product types (records):** `data Person = Person { name :: String, age :: Int }` —
records are sugar for positional-field constructors plus generated accessor
functions; a Haskell record's fields are, notably, *top-level functions* sharing the
module namespace (a real DX pain point Haskell has famously had, addressed later by
`DuplicateRecordFields`/`OverloadedRecordDot`).

**Newtype:** `newtype Meters = Meters Double` — a single-constructor,
single-field wrapper that is *guaranteed by the compiler to have zero runtime
representation cost* (unlike a single-constructor `data`, which still boxes). This
is the cleanest "nominal wrapper, compile-time only, zero-cost" concept in the
survey — a stronger guarantee than OCaml's single-constructor variant (which is a
real `data` allocation) or TS's branded-type encoding (which is purely a type-
checker fiction with no runtime tag at all, so also zero-cost, but *unenforced* —
nothing stops constructing a bad value by casting). Newtype sits at a genuinely
distinct point: compiler-enforced (unlike TS branding) yet zero-cost (unlike a
boxed variant).

**Type classes as they relate to data shapes:** not a data-shape concept per se, but
directly relevant to "extensible hierarchy" — a type class (`Show`, `Eq`,
`Functor`, ...) is an *open, ad-hoc extensible* set of "does this type support
capability X," decoupled entirely from the type's own definition/hierarchy. This is
a different extensibility axis than OCaml's open variants: instead of "add new
*cases* to a sum after the fact," type classes let you "add new *behavior* to an
existing type after the fact," including to types you didn't define
(orphan instances aside). Two structurally different flavors of extensibility worth
distinguishing for the IR: extending the *set of type constructors* vs. extending
the *set of things a projection can compute about* an existing type constructor —
the second maps closely onto "a projection recognizes some types and falls back for
others."

**GADTs, existentials, kind system:** Haskell's kind system (types of types — `*`,
`* -> *`, etc.) is the most developed of any surveyed system; existential types
(`forall a. Show a => T a`) let a sum-type branch hide a type parameter entirely,
another idea beyond "tag picks a fixed payload shape."

**Constraints/refinement:** none in core Haskell (smart constructors / `newtype` +
hidden constructor is the idiomatic pattern for "validated on construction," and
libraries like `refined` add refinement types as a research/library-level feature,
not core language).
**Nullability:** no null; `Maybe a = Nothing | Just a`, same story as OCaml.
**Recursion:** yes, native, including via `Fix`/recursion-schemes patterns for
explicit recursive-structure abstraction (a technique, not core syntax, but a
recognizable idea: *factor recursion itself out as a reusable combinator* rather
than baking it into every recursive type — potentially relevant if the IR wants one
generic "recursive/self-referential node" combinator instead of ad hoc recursion in
every constructor).
**Generics:** yes, full parametric polymorphism plus higher-kinded types
(`Functor f => f a -> f b`), the most expressive of the surveyed systems on this
axis.
**Extensibility:** as above — data constructors closed per-type by default (GADTs
extension aside); behavior/capability extensible via type classes without touching
the original type.

---

## 7. Protobuf

**Scalar types:** `double`, `float`, `int32`, `int64`, `uint32`, `uint64`, `sint32`
/`sint64` (zigzag-encoded, efficient for negative numbers), `fixed32`/`fixed64`,
`sfixed32`/`sfixed64`, `bool`, `string`, `bytes` — a deliberately wire-efficiency-
driven scalar set (three different encodings of "signed 32-bit int" depending on
expected value distribution) unlike any other system here; this is the clearest
example of *encoding concerns leaking into the type vocabulary itself*.

**Messages:** the product type — named, nested messages allowed, fields numbered
(the field number, not the name, is the wire identity — a distinct extensibility
mechanism: renaming a field is compatible, renumbering is not).

**Enums:** closed set of named integer constants; proto3 requires a zero-value
default member (interacts with proto3's "no explicit presence for scalars" default,
see below); enum unknown-value handling (aliasing, reserved ranges) is itself a
mini spec for forward compatibility.

**oneof:** a set of fields that share a single storage slot — exactly one may be
set at a time, and setting one clears any previously-set sibling. This *is*
protobuf's discriminated union, but structured differently than JTD's: the "tag" is
implicit (which field is populated) rather than an explicit separate discriminator
value — the field identity itself is the tag.

**map<K, V>:** built-in homogeneous dictionary (K restricted to integral/string
scalar types — no message-typed keys), sugar over a repeated message of
`{key: K, value: V}` entries under the hood.

**repeated:** the array/list combinator, applicable to any field type.

**Well-known types** (`google/protobuf/*.proto`, a standard library of message
types layered on top of the core language, notable as a real precedent for "a
curated extensible vocabulary of semantic types built from the primitive
constructors" rather than baking them into the grammar): `Timestamp`, `Duration`,
`Any` (a type-erased "this could be any message, with a type-URL tag for downstream
resolution" — protobuf's own escape hatch for open/unknown-at-schema-time data),
`Struct`/`Value`/`ListValue` (dynamically-typed JSON-equivalent structures
re-expressed in protobuf), `FieldMask`, `Empty`, and the wrapper types
(`Int32Value`, `StringValue`, ...) which exist *purely* to recover explicit
optional-presence for scalar fields in proto3 (see below) — a workaround so
notable it's worth flagging as a cautionary precedent: proto3's initial design
removed presence-tracking for scalars, users needed it back, and the fix was a
library-level wrapper-message convention rather than a language feature (later
proto3 added `optional` back as a language feature in 3.15, precisely because the
wrapper-message workaround was unsatisfying).

**Constraints/refinement:** none in core protobuf (validation is delegated to
external tooling — `protoc-gen-validate`, buf's `protovalidate`, etc. — a strong
precedent for "the wire-format layer stays shape-only, refinement lives in a
separate, optional, layered annotation system," directly analogous to what a
fractal IR might want to do with JSON-Schema-style constraint keywords).
**Nullability/optionality:** historically messy — proto2 tracked explicit field
presence for every field; proto3 initially made all scalar fields presence-less
(default-value-on-absence, indistinguishable from "explicitly set to default"),
while message-typed fields kept presence (a `nil`-able pointer); proto3.15+ restored
`optional` as an explicit per-field opt-in for scalars. This is a genuinely
instructive case study: presence/optionality is not one universal default even
within a single evolving spec, and "does this field distinguish absent from
default-value" is worth being an explicit, per-field IR property rather than
inferred from type alone.
**Recursion:** yes, message types may reference themselves/each other.
**Generics:** none (no parametric messages; `Any`/`Struct` are the dynamic-typing
escape valves instead).
**Extensibility:** field numbers reserved for forward-compat (`reserved`),
`Any` for schema-unaware payloads, extensions (proto2) / custom options (proto3) for
attaching arbitrary out-of-band metadata to schema elements themselves — directly
relevant prior art for "arbitrary metadata bag on a type/field," which is exactly
what fractal's own metadata-bag design (per `converged-model.md`) already leans on.

---

## 8. SQL type systems (PostgreSQL / MySQL / SQLite, surveyed together)

**Numeric:** exact (`SMALLINT`/`INTEGER`/`BIGINT`, `DECIMAL(p,s)`/`NUMERIC(p,s)` —
precision+scale as *type parameters*, not constraints — `MONEY` in Postgres) vs.
approximate (`REAL`/`FLOAT`/`DOUBLE PRECISION`); Postgres additionally has
arbitrary-precision `NUMERIC` with no upper bound, plus `SERIAL`/`BIGSERIAL`
(sugar: integer column + auto-incrementing sequence + default — i.e. a type-level
macro that expands to a base type plus generated behavior, an interesting precedent
for "a named type that's really shorthand for base-type-plus-annotations").

**Temporal:** `DATE`, `TIME` (with optional `(p)` fractional-second precision as a
type parameter and optional `WITH/WITHOUT TIME ZONE`), `TIMESTAMP`
[`WITH/WITHOUT TIME ZONE`], `INTERVAL` (Postgres: a genuine duration type, further
qualifiable to `YEAR`/`MONTH`/`DAY`/... field-range subsets — i.e. the *type itself*
can be narrowed to a specific field granularity, another type-parameter axis beyond
precision).

**Binary/text:** `CHAR(n)`/`VARCHAR(n)`/`TEXT` (length as type parameter, with
fixed- vs. variable-length as a genuinely separate type, not just a constraint on
one type), `BYTEA`/`BLOB`/`BINARY`/`VARBINARY`.

**JSON:** `JSON` (text-stored, preserves formatting/whitespace/key order/duplicate
keys) vs. Postgres's `JSONB` (binary-decomposed, canonicalized, indexable, no
duplicate keys/whitespace preserved) — a real precedent for "the same logical type
having multiple *physical representations* with different tradeoffs," which the IR
may want to keep orthogonal to logical type identity.

**Spatial:** PostGIS's `GEOMETRY`/`GEOGRAPHY` (further parameterized by a specific
sub-type — `POINT`/`LINESTRING`/`POLYGON`/`MULTIPOLYGON`/... — and an SRID
coordinate-reference-system tag baked into the type itself); MySQL has a smaller
native spatial type set built in without an extension.

**Network:** Postgres's `INET`/`CIDR` (address-with-prefix vs. exact address as
genuinely distinct types, not just a formatted string), `MACADDR`/`MACADDR8`.

**Array:** Postgres arrays are a first-class, arbitrarily-nestable *type modifier*
applicable to nearly any base type (`INTEGER[]`, `TEXT[][]`) — i.e. array-ness is
orthogonal to element type, applied compositionally, not a fixed enumerated list of
"array of X" types. MySQL/SQLite have no native array type (workaround: JSON column
or a join table) — a useful negative data point: not every system needs every
combinator natively, some fall back to a more general escape hatch (JSON) instead.

**Composite/row types:** Postgres `CREATE TYPE ... AS (...)` — user-defined
*named* product types usable as a column type, i.e. arbitrary struct nesting inside
relational columns (blurs the classic "everything is a flat row" assumption).

**Enum:** Postgres `CREATE TYPE ... AS ENUM (...)` — a genuine closed nominal type;
MySQL's `ENUM(...)` is a column-level (not reusable named-type-level) closed string
set; SQLite has no enum type at all (`CHECK` constraint is the idiomatic
workaround) — another instructive "fall back to a more general constraint mechanism
when a dedicated type doesn't exist" data point.

**Range types:** Postgres `INT4RANGE`/`TSRANGE`/etc. — a *type constructor*
parameterized by an underlying orderable type, producing "a range of T" as a first-
class value (with inclusive/exclusive bound flags per-value, not per-type). Not
present in this form anywhere else in the survey; a genuinely SQL-specific
combinator (range-of-T as a first-class parametric type).

**Constraints/refinement:** `NOT NULL`, `CHECK (expr)` (arbitrary boolean
expression — the most general and least structured constraint mechanism in the
whole survey, since it's literally executable predicate code, not a declarative
keyword vocabulary), `UNIQUE`, `PRIMARY KEY`, `FOREIGN KEY` (referential integrity —
a constraint that reaches *outside* the type/table itself, unlike every other
system's constraints which are local to one value), `DEFAULT`.
**Nullability:** every SQL type is nullable by default; `NOT NULL` is the opt-out —
opposite default polarity from JTD's "not nullable unless flagged," worth flagging
since the IR will need a documented default rather than assuming one direction is
obviously right.
**Recursion:** relationally, via self-referencing foreign keys (structural
recursion lives in the *data*, not the *type* — SQL has no native recursive
composite/row type definition, though recursive CTEs (`WITH RECURSIVE`) let queries
traverse such structures).
**Generics:** none as user-facing type parameters (though domains
`CREATE DOMAIN` add named constrained-subtype aliases — `CREATE DOMAIN us_postal_code
AS TEXT CHECK (...)` — another nominal-wrapper-with-baked-in-constraint precedent,
close in spirit to Haskell's `newtype` + smart-constructor pattern but declared, not
enforced-by-hiding-a-constructor).
**Extensibility:** Postgres is the standout — genuinely extensible at the engine
level (`CREATE TYPE`, extensions like PostGIS/hstore/citext adding wholly new base
types with their own I/O functions, operators, and index support). This is a strong
precedent that "extensible type system" can mean "third parties can add real base
types the core engine didn't know about," not just "compose the existing
constructors differently."

---

## 9. GraphQL's type system

**Scalars:** built-in `Int`, `Float`, `String`, `Boolean`, `ID` (a string-or-int-
serialized opaque-identifier scalar — semantically distinct from `String` despite
identical wire representation, a precedent for "semantic tag on top of an identical
physical type" akin to JSON Schema's `format`); **custom scalars** are fully
user-definable (`scalar DateTime`) with serialize/parse-value/parse-literal
functions supplied by the implementation — the schema only declares the *name*, all
constraint/parsing logic lives outside the type system proper.

**Object types:** named product types with typed fields (each field itself
independently arity-and-null qualified, and fields may take arguments — i.e.
fields are mini-functions, not just typed slots, a genuinely distinct idea:
*field-level parameterization* orthogonal to the type's own generic-ness, which
GraphQL otherwise lacks entirely).

**Interfaces:** a named set of fields that implementing object types must include —
structural-contract nominal typing (an object type must *declare* which interfaces
it implements; satisfying the shape alone isn't enough, unlike TS structural
typing) — this is GraphQL's closest analog to Haskell type classes / OCaml module
signatures, applied to object shapes.

**Unions:** `union SearchResult = Photo | Person` — a union of *object types only*
(not scalars/interfaces), with no explicit tag field; discrimination at query time
happens via `... on Photo` inline fragments and a runtime `__typename` resolver the
server must supply — i.e. the tag is server-computed metadata, not a value the
type definition itself carries, structurally distinct from every discriminated-
union mechanism elsewhere in this survey.

**Enums:** closed named value sets, each member itself a first-class named
identifier (not implicitly backed by a string/int the way most languages' enums
are — a GraphQL enum value has no defined underlying representation at the language
level at all, purely symbolic).

**Input types:** `input` — a parallel, restricted product-type kind usable only for
arguments/variables, notably *cannot* contain interfaces/unions and cannot have
resolver logic — GraphQL is one of very few systems here to draw a hard line
between "types you can send" and "types you can receive," rather than one
type-vocabulary serving both directions symmetrically. Directly relevant precedent
for an IR used across producer/consumer/request/response projections: input-vs-
output shape may need to be trackable as an orthogonal axis on a type, not just
inferred from position.

**List/Non-Null wrapper types:** `[T]`, `T!`, freely composable
(`[T!]!`, `[T]!`, `[T!]`, `[T]`) — nullability is a *wrapper type constructor*
applied per-position, not a flag or union member; `[T]!` (list itself required,
elements may be null) vs `[T!]` (list may be null, elements required) is a real,
frequently-confused distinction that demonstrates nullability-as-wrapper needs to
compose correctly through every other combinator (list, in this case) rather than
being a single global flag.

**Directives:** `@deprecated`, `@skip`, `@include`, and fully custom directives
(`@auth(role: ADMIN)`) — schema- and query-level annotations, GraphQL's own
"arbitrary metadata bag" mechanism, applicable to type/field/argument definitions;
directly analogous to what fractal's metadata-bag-on-operations design already does,
here applied to *type* definitions instead of operations.

**Constraints/refinement:** none built into the core language (validation logic,
if any, lives inside custom scalar parse functions or resolver code) — same
"shape-only core, refinement pushed to a layer outside the type system" pattern
seen in protobuf and JTD.
**Nullability:** as above — nullable is the *default*, `!` opts into required,
matching SQL's default polarity and opposite JTD's.
**Recursion:** yes, object types may reference themselves/each other freely.
**Generics:** none natively (a long-standing, deliberately-unaddressed gap in the
spec — every "generic-like" pattern, e.g. Relay's `Connection`/`Edge` pattern, is
achieved by hand-writing one concrete type per instantiation, or by codegen).
**Extensibility:** custom scalars (new leaf types), directives (new annotations),
and schema extensions (`extend type`) are the three sanctioned extension points —
notably, no mechanism exists to add wholly new *composite*-type *kinds* (you cannot
invent a ninth top-level type kind beyond scalar/object/interface/union/enum/input/
list/non-null) — a clean example of a system that's extensible in its *leaves*
(scalars) and *annotations* (directives) but closed in its *structural vocabulary*
(the kind list itself), a distinction directly relevant to deciding what "extensible
hierarchy" should mean for fractal's IR: extensible at the leaves is much cheaper
to support than extensible in the kind list itself.

---

## 10. Cap'n Proto / FlatBuffers (contrast with Protobuf)

**[CERTIFIED-EXTERNAL, per capnproto.org/language.html]** Surveyed together, in
contrast to protobuf, because both prioritize zero-copy access over protobuf's
wire-efficiency-first scalar zoo.

**Cap'n Proto:**
- Scalars: `Bool`, `Int8`/`16`/`32`/`64`, `UInt8`/`16`/`32`/`64`, `Float32`/`64`,
  `Text`, `Data` (bytes) — a flatter, simpler scalar set than protobuf's (no
  zigzag/fixed-width encoding variants, because the wire format's fixed-width-slot
  layout makes that distinction moot at the schema level).
- **Groups**: fields nested under a named group behave like a struct for the
  *value* constructor (`person.name.first`-style access) but do **not** introduce a
  separate allocated object the way a nested `struct` field would — i.e. groups are
  a zero-cost, purely-organizational sub-namespacing of fields within the same
  physical struct. A distinct idea from every "nested product type" seen elsewhere:
  grouping for *human/API organization* decoupled from grouping for *physical
  layout*.
- **Unions**: must be declared *embedded within* a containing struct (no free-
  standing/top-level union type) specifically so that new fields can be added to
  the enclosing struct later without perturbing the union's layout — a wire-
  evolution constraint shaping the type-system design itself (unions are a field-
  grouping-with-a-tag construct, not an independent type you can name and reuse
  elsewhere).
- **Generics**: real parametric types, but restricted to pointer-typed parameters
  only (structs, lists, blobs/text, interfaces — not scalars), because Cap'n
  Proto's layout model needs a parameter's *size* to be uniform (a pointer) to
  generate one physical layout usable for any instantiation — genuinely
  informative constraint: "generics over reference-shaped things only" is a
  real, load-bearing restriction seen nowhere else in this survey as cleanly.
- **Interfaces**: RPC method definitions attached to a type (Cap'n Proto is a full
  RPC system, not just a serialization format) — out of scope for a data-shape IR
  but worth naming since it shows the same schema vocabulary spans both
  data-shape and behavior-signature concerns in at least one real system.

**FlatBuffers:** structurally close to protobuf's scalar/message/enum/union set,
but the standout FlatBuffers-specific concept is the **schema evolution rule set
baked directly into the type system**: fields are append-only and deprecatable in
place (`deprecated` attribute keeps the wire slot reserved but hides it from
generated code) rather than protobuf's field-number-based scheme; tables (the
product type) default every field to optional-with-explicit-default, structs (a
second, distinct product-type kind, unlike protobuf's single "message" kind) are
fixed-layout, non-evolvable, no optional fields, used purely for tight/nested
non-top-level data — i.e. **two separate product-type kinds with different
evolvability/layout tradeoffs**, a real precedent for the IR distinguishing "an
evolvable, self-describing product type" from "a fixed, dense, non-evolvable
product type" as genuinely different constructors rather than two instances of one.

**Constraints/refinement:** none in either — pure shape/layout languages.
**Nullability/optionality:** Cap'n Proto: pointer-typed fields are inherently
nullable (absent pointer); scalar fields have no absence concept, only their
declared default value (closer to proto3's original scalar-presence-less design).
FlatBuffers: tables give every field an explicit default and an optional
"has this field been set" check via generated accessors; structs have no
optionality at all (every field always present, fixed layout).
**Recursion:** yes in both, via pointer/offset indirection (required for any
self-referential type, since both formats are fundamentally offset-based).
**Extensibility:** both support forward/backward-compatible schema evolution as a
first-class design goal (append fields, deprecate, never remove/renumber) — this
whole survey entry is really about evolution mechanics more than novel type
*shapes*, which is itself a useful signal: some of what "extensibility" needs to
mean for the IR is about *schema versioning discipline*, not just "can I add a new
kind of node."

---

## 11. Apache Avro

**Primitive types:** `null`, `boolean`, `int` (32-bit), `long` (64-bit), `float`,
`double`, `bytes`, `string` — a small, JSON-Schema-scale primitive set, contrasted
with protobuf's wire-efficiency-driven zoo and JTD's fixed-width-everything set.

**Complex types:** `record` (named product type, ordered fields — field order is
part of the schema's binary-encoding identity, unlike most systems here where field
order is irrelevant), `enum` (named closed symbol set, resolution-tolerant: readers
can specify a `default` for symbols they don't recognize — schema-evolution-aware
enum handling baked into the spec itself), `array` (homogeneous, single item type),
`map` (string-keyed only, homogeneous values), `union` (Avro's sum type — encoded
as a JSON array of member schemas, e.g. `["null", "string"]`; **nullability in Avro
is not a dedicated flag at all, it is exactly "a union that includes the `null`
type,"** i.e. Avro folds nullability into the general union mechanism the same way
TS does, unlike JTD/GraphQL/SQL's dedicated-flag approach — and the convention
`["null", T]` with `null` listed first, so the default value (if any) type-checks
against the first branch, is itself a spec-level convention, not a separate
language feature), `fixed` (fixed-length byte sequence, named — used as the storage
type for e.g. the `duration` logical type below).

**Logical types (verified via spec):** an *annotation layered on top of* a
primitive/fixed type, not a new wire-level primitive — exactly analogous to JSON
Schema's `format` in spirit, but Avro's logical types **do** affect in-memory
representation in generated code (unlike JSON Schema's non-normative `format`).
The set: `decimal` (parameterized by `precision`+`scale`, backed by `bytes` or
`fixed`), `uuid` (backed by `string`), `date` (backed by `int`, days since epoch),
`time-millis`/`time-micros` (backed by `int`/`long`), `timestamp-millis`
/`timestamp-micros` (backed by `long`, UTC), `local-timestamp-millis`
/`local-timestamp-micros` (backed by `long`, no implied timezone — added later
specifically to distinguish "UTC instant" from "wall-clock reading" after users hit
exactly that ambiguity, a real-world confirmation that this distinction needs to be
representable), `duration` (backed by `fixed(12)`, three little-endian uint32
fields: months, days, milliseconds — notably *not* reducible to a single scalar
duration the way SQL's `INTERVAL` superficially resembles, because
months/days/milliseconds are not fungible with each other for calendar-aware
arithmetic — a genuinely important structural point: "duration" isn't safely one
number even when a language wants to present it as one type).
**Crucially:** an unrecognized logical-type annotation must be ignored by
readers, falling back to treating the value as its underlying primitive/fixed type
— **this is a real, spec-mandated instance of exactly the "fallback via hierarchy"
behavior the fractal IR wants**: `decimal` unknown to a reader → falls back to
`bytes`; `uuid` unknown → falls back to `string`. Avro is the clearest working
precedent in this entire survey for the fallback-to-nearest-known-ancestor
mechanism fractal's IR design already commits to.

**Constraints/refinement:** none beyond logical-type semantics; no min/max/pattern
vocabulary at all.
**Recursion:** yes, named records/enums/fixed types may be referenced by name from
within their own or another schema.
**Generics:** none.
**Extensibility:** schema evolution is Avro's central design concern — reader and
writer schemas are allowed to differ, with documented resolution rules per type
(missing writer field + reader default → filled in; missing reader field → writer's
value dropped; enum symbol unknown to reader → reader's declared default used;
union member reordering tolerated by matching on type, not position). This is the
most schema-evolution-native system surveyed, and its promotion rules (e.g. `int`
can be read as `long`/`float`/`double`; `string`↔`bytes`) are a concrete precedent
for **type widening as a first-class, spec-defined relation** — directly relevant
to "walk up to nearest known ancestor," since Avro effectively defines a small
promotion lattice among its primitives for exactly this purpose.

---

## 12. Runtime validation libraries: Zod / Valibot / TypeBox

Grouped because they converge on a similar vocabulary while making different
architectural bets (Zod: method-chaining, primary object is the *validator*, TS type
is *derived* via `z.infer`; Valibot: standalone tree-shakeable functions composed by
pipe, otherwise conceptually close to Zod; TypeBox: schemas *are* JSON Schema
objects at runtime, with TS types derived by conditional-type introspection of the
JSON Schema shape — so TypeBox's type vocabulary is deliberately JSON Schema's, not
an independent design).

**Primitive constructors (shared across all three, naming varies slightly):**
string, number, boolean, bigint, date, symbol, undefined, null, void, any, unknown,
never, literal (single-value type), NaN (Zod-specific literal-numeric-edge-case).

**Structural combinators:** object (with strict/strip/passthrough modes for
handling unknown keys — a real three-way policy choice for
`additionalProperties`-equivalent behavior, more granular than JSON Schema's
boolean/schema choice), array, tuple (fixed-arity, plus a rest-element extension),
record (string/enum-keyed homogeneous map, Zod/Valibot's `record`/`map`,
TypeBox's `Record`), union (untagged), **discriminated union** (Zod's
`discriminatedUnion`/Valibot's `variant` — an explicit tagged-union constructor
distinct from plain untagged union, specifically for the parser-performance win of
dispatching on the tag before attempting each branch — a direct runtime-library
echo of JTD's discriminator form and protobuf's `oneof`), intersection, lazy
(explicit recursive-schema thunk, since these are runtime values built eagerly —
recursion needs a deliberate laziness escape hatch unlike a source type system's
inherently lazy name resolution), promise (async-value-typed schema, notable as a
category with no analog anywhere else in this survey — a type describing "this
resolves to a T", relevant only because these libraries also validate at runtime
across async boundaries).

**Refinement/constraint mechanisms:** this is where these libraries earn their
keep relative to TS's type-erasing primitives — `min`/`max`/`length` (string/array/
number), `regex`/`pattern`, `email`/`url`/`uuid`/`ip`/`iso.datetime`/etc. (built-in
*named* format validators, i.e. reified versions of JSON Schema's soft `format`
strings, but *enforced* here rather than advisory), `.refine()`/`.check()` (Zod)
/`custom()` (Valibot) — an arbitrary-predicate escape hatch, structurally the same
role as SQL's `CHECK` — plus `.transform()` (Zod/Valibot: a schema that also
*changes* the value/type during parsing, e.g. string→Date — a genuinely distinct
concept from validation: **the schema is also a coercion/mapping function**, input
type and output type may differ, which none of the wire-format specs surveyed
support since they're pure shape-description, not compute).

**Branded types:** Zod's `.brand<"UserId">()` — the nominal-wrapper concept
appearing again, implemented exactly like the community TS pattern (phantom
property), confirming it's common enough to be a first-class library feature even
though the host language (TS) has no native support.

**Nullability/optionality:** `.optional()` (adds `| undefined` to the *output*
type, and makes the key omittable on objects), `.nullable()` (adds `| null`),
`.nullish()` (Zod: both at once) — three orthogonal composable wrapper
combinators, closer in spirit to GraphQL's `T!`/`[T]` composability than to a single
flag, but layered on TS's own two-flavor (null vs. undefined) absence model rather
than JTD's absence-vs-null 2×2 (there's no library-native way to say "optional key,
but if present must not be null" as a single combinator distinct from
`.nullable().optional()`, though the composition achieves the same effect).
**Default values:** `.default(v)` — a schema-level fallback value used specifically
when input is `undefined`, blurring optionality and value-substitution into one
combinator (yet another axis: presence-with-fallback vs. presence-without).

**Recursion:** via `z.lazy(() => schema)` (explicit thunk) since schema construction
is eager runtime code, not a source-level type declaration.
**Generics:** none of these libraries offer *schema-level* type parameters the way
a source language does — "generic schemas" are achieved by writing a schema-
returning function (`const listOf = <T>(item: Schema<T>) => z.array(item)`), i.e.
genericity is pushed to the host language (function parameterization), not
represented inside the schema IR itself. Directly relevant precedent: it's fine
for an IR's *node vocabulary* to have no native parametric-type node, if
parameterization can instead be handled one level up as "a function that builds a
concrete IR node."
**Extensibility:** all three are designed for exactly this — Zod/Valibot expose a
base `Schema`/`BaseSchema` interface any custom validator can implement to plug
into the ecosystem's combinator functions (`.optional()`, `.array()`, etc.);
TypeBox is extensible by construction since it's just JSON Schema (any keyword
vocabulary JSON Schema allows is available). This trio is the most direct existing
precedent for "a TS-native, hierarchical, extensible type/schema representation,"
since that's literally each library's stated design goal — closest prior art to
fractal's own IR ambition of anything surveyed.

---

## SYNTHESIS

**[SYNTHESIS — assistant's proposal from the above research, not user-ratified.]**
Everything below is offered as raw material and one candidate structuring, not a
decision. Where more than one workable shape exists the tradeoffs are named side by
side rather than picked for the user.

### The union of type concepts, grouped

**A. Primitive/scalar leaves**
- Boolean, and a family of numeric leaves that different systems slice differently:
  a single unbounded `number` (JSON Schema, TS), a fixed-width family
  (`int8`..`uint32`, protobuf/JTD/Avro's `int`/`long`), and precision+scale
  parameterized decimals (SQL `NUMERIC(p,s)`, Avro `decimal`).
- String, with an open sub-vocabulary of semantic string-shapes layered on top as
  *annotations, not new leaf kinds* (JSON Schema `format`, GraphQL `ID`, Avro
  logical types `uuid`/`date`, Zod's named format validators) — this pattern
  recurs so consistently across independently-designed systems that it reads as
  close to load-bearing: **semantic refinement of a primitive should be an
  annotation on the primitive, not a sibling leaf type**, and unknown annotations
  must fall back to the underlying primitive (Avro's spec-mandated behavior is the
  cleanest precedent).
- Byte/binary, distinct from string (serde, protobuf, Avro, SQL `BYTEA`) —
  appears often enough to be core, not domain-specific.
- Null/void/unit/never/unknown/any — the "boundary" leaves. Not every system has
  all of these, but each recurs in ≥3 systems (null: nearly universal; unit:
  serde/Haskell/OCaml/protobuf's `Empty`; never/bottom: TS/Haskell's uninhabited
  types; unknown/top: TS/JSON Schema's empty-schema/JTD's empty-form).
- Timestamp/date/time/duration — present in JTD (minimal, one type), SQL (rich,
  several types + precision + timezone-awareness), Avro (logical types, most
  carefully specified — including the UTC-vs-local distinction and the
  non-scalar-decomposed duration), protobuf (well-known types). Consistently
  hard enough across systems (timezone handling, duration-as-non-scalar) that
  it deserves to be a distinguished branch of the hierarchy, not folded into
  generic "annotated string."

**B. Product combinators**
- Named/nominal product (struct, record, message, table, object-with-a-name) vs.
  anonymous/structural product (tuple, TS object literal, OCaml tuple) — this
  named-vs-anonymous axis is genuinely orthogonal to field-shape and recurs
  everywhere (serde splits it five ways; OCaml/Haskell keep it as two type
  families; SQL's composite types vs. row values; FlatBuffers' table vs. struct
  for a different reason — evolvability, not naming).
- Fixed-arity heterogeneous sequence (tuple) vs. homogeneous variable-length
  sequence (array/list/seq/repeated) vs. homogeneous keyed map (map/values/record-
  as-dict/Postgres hstore) — three genuinely distinct combinators, frequently
  conflated in casual conversation but kept structurally separate by nearly every
  system surveyed (JTD is the cleanest: elements vs. properties vs. values as three
  of its eight forms).

**C. Sum combinators**
- Untagged union (TS `|`, JSON Schema `anyOf`, GraphQL union with server-resolved
  `__typename`, Zod `union`) — a union is a *value-set* union with no dedicated tag
  carried by the type itself; discrimination is push onto the consumer (structural
  narrowing, runtime `typeof` checks, external resolvers).
- Tagged/discriminated union with an explicit literal field (TS discriminated-
  union pattern, JTD's discriminator form, Zod's `discriminatedUnion`) — tag is a
  *named field* whose value selects the branch.
- Implicit-tag union where the tag *is* which slot is populated rather than a
  separate value (protobuf `oneof`, Cap'n Proto embedded unions, Rust/serde's
  enum-variant model, OCaml/Haskell ADTs) — structurally the strongest, most
  information-preserving form (exhaustiveness-checkable, no possibility of a
  present-but-contradicting tag value), and the one closest to "a real sum type"
  in the type-theory sense.
- Open/extensible rows on sums (OCaml polymorphic variants' `[> \`Foo]`/
  `[< \`Foo]`, OCaml's `type t = ..` extensible variants) — the one system in this
  survey to make "can new cases be added later, and by whom" a first-class,
  per-declaration-site type parameter rather than a global policy. This maps
  almost directly onto fractal's own "fallback via hierarchy" requirement for
  unknown-tag handling.
- Boolean-algebra composition (JSON Schema `allOf`/`anyOf`/`not`) — worth keeping
  conceptually distinct from "sum type": this is composition *of schema-
  predicates*, applicable even to non-sum shapes, not a value-carrying tagged
  branch.

**D. Wrapper/modifier combinators (apply to any inner type)**
- Nullable — three observed encodings: (1) dedicated per-type flag, defaulting to
  non-nullable (JTD, SQL's `NOT NULL` opt-out has the *opposite* default polarity
  though — flagging that "which default polarity" is a real, non-obvious choice,
  not something to bake in silently); (2) fold into the general union mechanism
  (TS `| null`, Avro `["null", T]`); (3) dedicated wrapper type constructor,
  composable with other wrappers positionally (GraphQL `T!`/`[T]!`/`[T!]`).
- Optional/presence — genuinely orthogonal to nullable in the most careful systems
  (JTD's explicit properties-vs-optionalProperties 2×2, TS's
  `exactOptionalPropertyTypes`, protobuf's proto2-vs-proto3-vs-3.15 saga is a live
  case study of what goes wrong when this axis is *not* kept explicit).
- Default-value — a further orthogonal axis from optional (Zod's `.default()`,
  SQL `DEFAULT`, protobuf's implicit-zero-value default, Avro's reader-side
  default-on-missing-field) — "has a default" and "is optional" are correlated but
  not identical (a required field can still have a schema-declared default used
  only for backward-compat reading, as in Avro).
- Array/list-of, and (Postgres) arbitrarily nestable, orthogonal to element type.
- Range-of (Postgres range types) — parametric over an orderable base type,
  narrow but real; worth keeping as a possible combinator even if rarely used.

**E. Nominal/branding mechanisms**
- Zero-cost, compiler-enforced wrapper (Haskell `newtype`) vs. real-allocation
  wrapper (OCaml single-constructor variant, serde newtype struct) vs. purely
  type-checker-fiction wrapper with zero runtime enforcement (TS branded types,
  Zod `.brand()`) — three points on a real spectrum (cost × enforcement) that
  recurs independently in every system that has *any* nominal-wrapper concept,
  suggesting the IR should represent "this is a nominal wrapper around X" as one
  concept with an orthogonal enforcement/cost annotation, not three separate node
  kinds.
- SQL `CREATE DOMAIN` — named + constrained alias, a nominal wrapper *with a
  constraint bundled in* at declaration time, one more point on the same spectrum.

**F. Constraint/refinement mechanisms**
- Declarative keyword vocabulary (JSON Schema's `minLength`/`pattern`/etc., Zod's
  `.min()`/`.regex()`) — structured, introspectable, the dominant approach among
  systems that have refinement at all.
- Arbitrary predicate/expression (SQL `CHECK`, Zod `.refine()`) — maximally
  general, but opaque to any projection that isn't "run this code" (can't be
  introspected/translated to e.g. a different language's validator without
  re-implementing the predicate).
- Soft/advisory annotation, unenforced by default (JSON Schema `format`) vs. hard/
  enforced annotation with defined promotion-on-unknown behavior (Avro logical
  types) — the Avro model is the stronger precedent for fractal given the
  fallback-via-hierarchy requirement.
- No refinement at all, pushed entirely to an external layer (protobuf core,
  GraphQL core, JTD, Cap'n Proto, FlatBuffers, Avro core) — notably the *majority*
  position among the wire-format-shaped systems; refinement clusters instead in
  the validation-library and SQL/JSON-Schema camps. This is itself informative:
  "shape" and "refinement" are commonly treated as separable layers, which
  supports keeping them as separable concerns in the IR (a constraint is metadata
  *about* a type node, not a distinct type-node kind).

**G. Extensibility mechanisms observed (as a checklist for the IR itself)**
- Unknown-keyword-ignored, open by default (JSON Schema, GraphQL directives).
- Narrow, single sanctioned extension point (JTD's `metadata` keyword).
- Type-level open/closed choice per declaration (OCaml `type t = ...` vs.
  `type t = ..`).
- Capability-extension decoupled from shape-extension (Haskell type classes —
  "can add behavior for a type after the fact" vs. "can add a new case to a type
  after the fact" are different axes).
- New base types addable at the engine level by third parties (Postgres
  `CREATE TYPE`/extensions) — the strongest form observed, and worth naming as the
  ceiling of what "extensible hierarchy" could mean, even if fractal's IR doesn't
  need to go this far.
- Fallback-to-nearest-known-ancestor on unrecognized annotation, *spec-mandated*
  (Avro logical types) — this is the direct precedent for fractal's own
  fallback-via-hierarchy design; Avro is proof the mechanism works in a widely
  deployed, cross-language system.
- Type-widening/promotion lattice among primitives, spec-defined (Avro: `int` →
  `long`/`float`/`double`; `string` ↔ `bytes`) — a second, complementary
  mechanism to "walk up to nearest ancestor": sometimes the fallback isn't to a
  *stricter supertype* but to a *different leaf the target format already
  understands*, which matters for scalar leaves that don't naturally form an
  inheritance chain (e.g. what does a projection that only knows `string` do
  with `uuid`, vs. what does one that only knows `int32` do with `int64`).

### Core vs. domain-specific

Appearing in most/all systems surveyed (candidates for the hierarchy's upper
levels, close to root):
- boolean, string, some numeric leaf, null/absence-of-value
- product (named and/or anonymous)
- array/list
- some sum mechanism (even if only "untagged union" — every system has at least
  one flavor)
- some map/dictionary mechanism (all but the most minimal — SQLite/MySQL lack a
  native one but reach for JSON as fallback, which itself demonstrates the
  need)
- optional/nullable as a wrapper concept (though *which* default polarity and
  *whether* optional and nullable are unified varies — this variance itself
  belongs in the hierarchy as a documented per-projection difference, not resolved
  away)
- reference/recursion (`$ref`/named-type-reference) — needed by nearly everything
  with any composite type at all
- metadata/annotation bag, open-ended (present independently in JSON Schema
  vocabularies, JTD's `metadata`, protobuf custom options, GraphQL directives,
  Avro's arbitrary schema properties) — strong, repeated, independently-arrived-at
  evidence that "every type node carries an open metadata bag" is close to
  universal need, and directly consonant with fractal's existing operation-
  metadata-bag design.

Appearing in only a few systems (candidates for leaves/branches further out in
the hierarchy, not the spine):
- fixed-width fine-grained numeric families (protobuf, JTD, Avro `int`/`long`) vs.
  systems content with one unbounded number (JSON Schema, TS) — narrow to the
  systems that care about wire efficiency or cross-language codegen precision.
- GADTs / existential types / higher-kinded types — Haskell/advanced-OCaml only;
  real but genuinely rare, probably out of scope for an IR whose consumers are
  TS-shaped projections.
- Spatial/network/range types — SQL-specific (and spatial further gated behind
  PostGIS specifically); clearly domain-specific, not core, but a good test case
  for "can a projection add its own leaf types under the hierarchy" since they're
  exactly the kind of thing that should NOT require changing a shared root.
- Groups-vs-structs-for-layout (Cap'n Proto), table-vs-struct-for-evolvability
  (FlatBuffers) — encoding/layout concerns bleeding into the type vocabulary;
  relevant only if fractal's IR ever needs to reason about wire layout, which its
  stated TS-source-of-truth design (per `converged-model.md`) suggests it doesn't.
- Field-level RPC/interface definitions (Cap'n Proto interfaces, GraphQL field
  arguments as mini-functions) — behavior-shaped, not data-shaped; probably
  belongs to fractal's operation model, not its type IR, but the GraphQL
  field-argument pattern is worth a second look if the IR ever needs to represent
  "a field whose value depends on caller-supplied parameters."
- schema-evolution-specific machinery (Avro reader/writer resolution, protobuf
  field numbers, FlatBuffers deprecation) — real, but a *process/versioning*
  concern layered on top of a type system rather than a type-node kind; likely
  belongs outside the type IR proper, in whatever fractal does for schema
  versioning, if anything.

### A sketch of the hierarchy (starting point, not a decision)

The recurring shape across nearly every system that *does* have a formal
hierarchy-of-generality (JSON Schema's implicit type-in-array unions, Avro's
widening lattice, OCaml's structural-vs-nominal split, GraphQL's wrapper
composability) suggests the IR's spine wants to separate at least four
independent axes rather than one linear "kind" enum:

1. **Shape axis** (the actual tree of constructors, extensible, walked for
   fallback): `Unknown` (root/top) → `Scalar` (→ `Boolean` | `Numeric` (→
   fixed-width leaves, decimal-with-precision, ...) | `String` (→ semantic
   subtypes: timestamp, uuid, ... each an annotation-bearing leaf that falls back
   to plain `String`) | `Binary`) and, in parallel, `Composite` (→ `Product` (→
   `Named` | `Anonymous`/tuple) | `Sum` (→ `Untagged` | `Tagged` (further:
   explicit-field-tag | implicit-slot-tag)) | `Collection` (→ `List` | `Map` |
   `Range`)) | `Reference` (named pointer to another node, for recursion/reuse) |
   `Wrapper` (→ `Nominal`/branded (with an enforcement-level annotation: erased |
   allocated | compiler-enforced-zero-cost) — wraps any other node). Every branch
   is open for a projection or domain package to graft new leaves under the
   nearest fitting ancestor, per the extensibility checklist above — this is
   where "extensible hierarchy, no blessed principle" actually lives structurally.

2. **Presence axis** (orthogonal flags/wrappers on any node, not a fork in the
   shape tree): nullable (yes/no, with a documented default polarity fractal must
   pick explicitly rather than inherit silently from whichever system it read
   last), optional/absent-key-allowed (yes/no, independent of nullable), has-
   default (yes/no + the default value, independent of optional).

3. **Constraint/annotation axis** (an open bag hung off any node, never a new
   shape-tree branch): structured keyword-style refinements (min/max/pattern/...,
   the JSON-Schema/Zod camp), opaque predicate refinements (the CHECK/.refine()
   camp, clearly marked as opaque-to-projections since they can't be
   structurally translated), semantic/format tags with defined fallback
   (the Avro-logical-type camp — this is the piece that makes "projections
   narrow, never guess" concrete: an annotation a projection doesn't recognize is
   *dropped*, not guessed at, and the underlying shape-tree node is still valid).

4. **Direction/role axis** (orthogonal metadata, not a new node kind): input-only
   vs. output-only vs. both (GraphQL's input/output split), needed only where a
   projection genuinely differs by direction (e.g. an HTTP request-body
   projection vs. response-body projection); most nodes will simply not set this
   and be treated as both.

The fallback rule this sketch is built to support: a projection that doesn't
recognize a leaf/branch node walks the **shape axis** up toward `Unknown`/nearest
recognized ancestor (Avro's logical-type-unknown → underlying-primitive behavior,
generalized); a projection that doesn't recognize a **constraint/annotation**
simply drops it and keeps the shape node as-is (JSON Schema's unknown-keyword-
ignored behavior, generalized); the **presence** and **direction** axes are small
enough, closed enough, and universal enough that every projection is expected to
understand them directly rather than fall back — they're closer to "always in
scope" than "part of the open hierarchy."

None of the specific node names above are load-bearing — they're illustrative of
the four-axis separation this survey's evidence points toward
(shape / presence / constraint / direction as independent dimensions rather than
one flattened `type` enum), which is the actual synthesis claim being offered for
review, not the exact tree shown.
