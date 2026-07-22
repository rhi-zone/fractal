// packages/api-tree/src/__fixtures__/typeref.fixture.ts
//
// Standalone functions used to exercise typeRefFromType / typeRefFromFunctionNode
// / typeRefFromReturnType directly (not through the tree walker).

import type { Result } from "../index.ts"
import type { CursorPage, OffsetPage, Page } from "../page.ts"
import type { Maximum, MaxLength, Minimum, MinLength, Pattern } from "@rhi-zone/fractal-type-ir/kinds/refinements"
import type { Email, Uuid } from "@rhi-zone/fractal-type-ir/kinds/semantic-strings"

export const sample = (input: {
  name: string
  age?: number
  tags: string[]
}): Result<{ total: number }, string> => ({
  kind: "ok",
  value: { total: input.tags.length },
})

// ── Gap-fix fixtures ─────────────────────────────────────────────────────────

/** Tuple type — must not fall through to the object branch. */
export type TupleType = [string, number, boolean]

/** `Record<K,V>` — pure index signature, no own properties. */
export type RecordType = Record<string, number>

/** Explicit index-signature syntax, same shape concern as Record. */
export type IndexSigType = { [key: string]: boolean }

/** Union of string literals — each member must stay a literal, not widen. */
export type LiteralType = "active" | "inactive"

/** A single string literal (no union) — must not widen to plain string. */
export type SingleLiteral = "active"

/** A single numeric literal. */
export type NumericLiteral = 42

/** A single boolean literal. */
export type BooleanLiteral = true

/** Recursive via an array of self — the common object-tree shape. */
export type RecursiveType = { name: string; children: RecursiveType[] }

/** Directly self-referential (no array indirection). */
export type DirectRecursive = { self: DirectRecursive }

/** A field whose type is a Promise — must unwrap like the return-type path. */
export type PromiseField = { data: Promise<string> }

/** A `readonly` field alongside a plain one — must set `meta.readonly` only on the former. */
export type ReadonlyField = { readonly id: string; name: string }

/** A field that is both optional and `readonly`. */
export type ReadonlyOptionalField = { readonly id?: string }

/** A class with mixed visibility + a method — lowers to a purely nominal types.instance. */
export class SampleClass {
  public name: string = ""
  private secret: string = ""
  protected internal: number = 0
  greet(): string {
    return this.name
  }
}

/** Class instance type, used as a field to exercise the object branch on it. */
export type ClassInstanceField = { owner: SampleClass }

/** A class with fields only, no methods — meta.interface should be absent. */
export class NoMethodClass {
  public name: string = ""
}

// ── Callable/function type fixtures ─────────────────────────────────────────

/** A field whose type is a callback — lowers to types.function, not punted. */
export type CallbackField = { onChange: (value: number) => void }

/** A bare arrow-function type alias, exercised directly (not just as a field). */
export type ArrowFnType = (x: number, label: string) => boolean

/** A class whose method surfaces via a call-signature-only interface, so
 * `thisType` on the extracted function carries the class's own instance type. */
export class MethodOwner {
  deposit(amount: number): void {}
}

/** The method's call signature lifted to a standalone function type, `this`
 * bound explicitly to `MethodOwner` — mirrors what the checker resolves for
 * `MethodOwner.prototype.deposit` accessed as a value. */
export type BoundMethodType = (this: MethodOwner, amount: number) => void

// ── Overloaded-function fixtures ────────────────────────────────────────────
// TypeScript lowers an overloaded function to an intersection of its call
// signatures: `((A) => X) & ((B) => Y)`. The extractor mirrors that with
// `types.intersection([types.function(...), types.function(...)])`. The
// implementation signature (the final, widest signature that backs the
// overloads) is never visible to callers and must NOT appear in the
// extracted set — `checker.getSignaturesOfType` already excludes it.

/** Overloaded free function: different param + return type per overload. */
export function overloadedFn(a: string): number
export function overloadedFn(a: number): string
export function overloadedFn(a: string | number): number | string {
  return typeof a === "string" ? a.length : String(a)
}

/** A field whose type is the overloaded function, to exercise the callable
 * branch of the object-field walk (not just a top-level function type). */
export type OverloadedFnField = { handler: typeof overloadedFn }

/** A class whose method is overloaded — same intersection-of-signatures
 * shape, but lowered through `methodsFromClassType` to `types.method`
 * members instead of `types.function`. */
export class OverloadedMethodClass {
  process(a: string): number
  process(a: number): string
  process(a: string | number): number | string {
    return typeof a === "string" ? a.length : String(a)
  }
}

/** Each overload returns a distinct `Result<T, string>` — the per-signature
 * `functionRefFromSignature` call independently lowers each return type, so
 * the two overloads' return shapes stay distinct rather than collapsing to
 * one. (`Result<T,E>` unwrapping to `T` is a return-type-of-the-op-itself
 * concern (`typeRefFromReturnType`'s syntax/structural paths) — a signature's
 * return type reached via plain `typeRefFromType` lowers the alias
 * structurally, same as any other field/param position.) */
export function overloadedResultFn(a: string): Result<{ text: string }, string>
export function overloadedResultFn(a: number): Result<{ num: number }, string>
export function overloadedResultFn(a: string | number): Result<{ text: string } | { num: number }, string> {
  return typeof a === "string"
    ? { kind: "ok", value: { text: a } }
    : { kind: "ok", value: { num: a } }
}

export type OverloadedResultFnField = { handler: typeof overloadedResultFn }

/** Single-signature function, named the same shape as the overloaded one
 * above, minus the overloads — regression check that a plain (non-overloaded)
 * function still lowers to a bare `types.function`, no intersection wrapper. */
export function singleSignatureFn(a: string): number {
  return a.length
}

export type SingleSignatureFnField = { handler: typeof singleSignatureFn }

// ── Branded/opaque type fixtures ────────────────────────────────────────────

/** Branded string — the standard nominal-typing pattern over a primitive. */
export type LocationId = string & { readonly __brand: "LocationId" }

/** A second branded string, to confirm brand values aren't confused. */
export type UserId = string & { readonly __brand: "UserId" }

/** Branded number, using the `__tag` spelling instead of `__brand`. */
export type PositiveInt = number & { readonly __tag: "PositiveInt" }

/** A branded type nested as an object field. */
export type BrandedField = { locationId: LocationId; name: string }

// ── Brand→kind promotion fixtures ───────────────────────────────────────────
//
// A brand tag whose value matches a known type-ir semantic-string kind
// (uuid/uri/email — see kinds/semantic-strings.ts) promotes to that kind
// instead of degrading to `t(types.string, { brand: "..." })`. These mirror
// the canonical `Uuid`/`Uri`/`Email` brand types type-ir exports for this
// exact purpose, but are hand-declared here (rather than imported) so the
// fixture doesn't take a dependency on type-ir's export surface.

/** Brand value matching the "uuid" kind exactly (lowercase, canonical form). */
export type UserIdUuid = string & { readonly __brand: "uuid" }

/** Brand value matching "uuid" case-insensitively (upper). */
export type UppercaseUuidBrand = string & { readonly __brand: "UUID" }

/** Brand value matching "uuid" case-insensitively (mixed case, as a
 * hand-authored type name might read). */
export type MixedCaseUuidBrand = string & { readonly __brand: "Uuid" }

/** Brand value matching the "uri" kind. */
export type UriBrand = string & { readonly __brand: "uri" }

/** Brand value matching the "email" kind. */
export type EmailBrand = string & { readonly __brand: "email" }

/** A known-kind brand nested as an object field. */
export type PromotedBrandField = { id: UserIdUuid; contact: EmailBrand }

/** A brand tag matching a known kind name, but over `number` instead of
 * `string` — every current promotable kind (uuid/uri/email) subtypes
 * `string`, so this must NOT promote; it stays `types.number` with
 * `meta.brand` set, same as any other unrecognized-base brand. */
export type NumberBrandedUuid = number & { readonly __brand: "uuid" }

/** A genuine structural intersection (not a brand pattern) — lowers to
 * `types.intersection`, each constituent extracted recursively. */
export type PlainIntersection = { a: string } & { b: number }

// ── Mixin intersection fixtures ─────────────────────────────────────────────

/** A mixin constituent — merged into other object types via `&`. */
export type HasId = { id: string }

/** A second mixin constituent. */
export type HasTimestamps = { createdAt: string; updatedAt: string }

/** Two named mixins combined — the common "mixin" intersection pattern. */
export type MixinType = HasId & HasTimestamps

/** Three-way intersection: two named mixins plus an inline object literal. */
export type TripleIntersection = HasId & HasTimestamps & { name: string }

// ── Enum / literal-union fixtures ───────────────────────────────────────────

/** A string enum — the checker resolves parameter types of this to a union
 * of its member string literals. */
export enum Status {
  Active = "active",
  Inactive = "inactive",
}

/** A numeric enum — resolves to a union of its member number literals. */
export enum Priority {
  Low = 0,
  Medium = 1,
  High = 2,
}

/** A hand-written string literal union — same shape concern as a string enum. */
export type StringUnion = "a" | "b" | "c"

/** A union of non-literal primitive types — must still punt. */
export type MixedUnion = string | number

/** A union mixing literal types of different kinds — union of literals. */
export type LiteralMixedUnion = "a" | 1 | true

/** A boolean parameter — TS represents `boolean` as `true | false` internally;
 * must NOT be extracted as `enum(["true", "false"])`. */
export type BooleanParam = boolean

// Standalone functions, one per fixture type above, so tests can drive them
// through `typeRefFromFunctionNode` (the checker resolves the parameter type
// as it would for a real op).
export const statusFn = (status: Status): void => {}
export const priorityFn = (priority: Priority): void => {}
export const stringUnionFn = (u: StringUnion): void => {}
export const mixedUnionFn = (u: MixedUnion): void => {}
export const literalMixedUnionFn = (u: LiteralMixedUnion): void => {}
export const booleanParamFn = (b: BooleanParam): void => {}

// ── Discriminated union fixtures ────────────────────────────────────────────

/** A discriminated-union variant — shares the `type` field with `Square`. */
export type Circle = { type: "circle"; radius: number }

/** A second variant — `type` distinguishes it from `Circle`. */
export type Square = { type: "square"; side: number }

/** A union of object types sharing a common literal-typed discriminator field. */
export type ShapeUnion = Circle | Square

/** A union of object types with NO shared literal field — no discriminator. */
export type NonDiscriminated = { a: string } | { b: number }

export const shapeUnionFn = (shape: ShapeUnion): void => {}
export const nonDiscriminatedFn = (u: NonDiscriminated): void => {}

// ── Named top-level parameter type fixtures (import-provenance) ────────────

/** A named object type, used as a handler's own parameter type directly —
 * exercises `typeRefFromFunctionNode`'s `meta.typeName`/`meta.declarationFile`
 * provenance (as opposed to an inline `(input: { … }) => …` parameter, which
 * carries neither). */
export type BookQuery = { q?: string }

export const namedParamFn = (input: BookQuery): void => {}

/** An interface (not a `type` alias) as a handler's parameter type — same
 * provenance capture, different declaration syntax. */
export interface BookIdParam {
  bookId: string
}

export const namedInterfaceParamFn = (input: BookIdParam): void => {}

// ── Symbol-branded type fixtures ────────────────────────────────────────────

declare const LocationIdBrand: unique symbol
/** Branded string via a `unique symbol` key, rather than a string-literal tag. */
export type SymbolBrandedId = string & { readonly [LocationIdBrand]: never }

declare const UserIdBrand: unique symbol
/** A second symbol-branded type, over `number` instead of `string`. */
export type SymbolBrandedUserId = number & { readonly [UserIdBrand]: never }

/** A symbol-branded field nested as an object field. */
export type SymbolBrandedField = { id: SymbolBrandedId; name: string }

// ── Async stream (AsyncIterable/AsyncGenerator) fixtures ────────────────────

/** A field whose type is an AsyncIterable — must lower to types.stream. */
export type AsyncIterableField = { events: AsyncIterable<string> }

/** An AsyncGenerator field — TReturn/TNext are dropped, only the yielded type survives. */
export type AsyncGeneratorField = { events: AsyncGenerator<number, void, never> }

/** A field whose type is an AsyncIterableIterator — the return type of an
 * `async function*` when spelled out explicitly rather than inferred. */
export type AsyncIterableIteratorField = { events: AsyncIterableIterator<boolean> }

/** A function returning `AsyncIterable<T>` directly, `T` a nested object —
 * exercises stream detection at the top-level return-type position, not just
 * field position, with a structural (not primitive) element type. */
export const streamFn = (): AsyncIterable<{ id: string }> => (async function* () {})()

/** An `async function*` — its return type is inferred as
 * `AsyncGenerator<T, void, unknown>`, exercising the extractor's stream
 * detection on a real generator function rather than an annotated field. */
export async function* asyncGenFn(): AsyncGenerator<number, void, unknown> {
  yield 1
}

/** `Promise<AsyncIterable<T>>` — the Promise unwrap must run before the
 * stream detection so both layers resolve correctly. */
export const promiseStreamFn = (): Promise<AsyncIterable<string>> =>
  Promise.resolve((async function* () {})())

/** A function returning `CursorPage<T>` directly — exercises `page` detection
 * (cursor style) at the top-level return-type position. */
export const cursorPageFn = (): CursorPage<{ id: string }> => ({ items: [], hasMore: false })

/** A function returning `OffsetPage<T>` directly — exercises `page` detection
 * (offset style). */
export const offsetPageFn = (): OffsetPage<number> => ({ items: [], offset: 0, total: 0, hasMore: false })

/** A function returning the reader-facing `Page<T>` union — ambiguous between
 * styles, defaults to `"cursor"` (see extract.ts's `pageAliasName` check). */
export const pageUnionFn = (): Page<string> => ({ items: [], hasMore: false })

/** `Promise<CursorPage<T>>` — the Promise unwrap must run before `page`
 * detection so both layers resolve correctly. */
export const promiseCursorPageFn = (): Promise<CursorPage<string>> =>
  Promise.resolve({ items: [], hasMore: false })

// ── Shared-symbol branded type fixtures ─────────────────────────────────────
// A single `unique symbol` key reused across types, with distinct string-literal
// values (rather than `never`) distinguishing the brands — as opposed to the
// per-type-symbol pattern above, where each type declares its own symbol.

declare const BRAND: unique symbol
/** Branded string via a *shared* `unique symbol` key with a literal value. */
export type SharedSymbolLocationId = string & { readonly [BRAND]: "LocationId" }

/** A second type sharing the same `BRAND` symbol key, distinguished by value. */
export type SharedSymbolUserId = string & { readonly [BRAND]: "UserId" }

// ── Property JSDoc refinement-tag fixtures ──────────────────────────────────
// `@minLength`/`@maxLength`/`@pattern`/`@format`/`@minimum`/`@maximum`/
// `@exclusiveMinimum`/`@exclusiveMaximum`/`@multipleOf` on a property's JSDoc
// comment, read the same way `@default` already is (propertyDefaultOf).

/** Object carrying refinement-tagged fields via JSDoc. */
export type RefinedField = {
  /**
   * Display name.
   * @minLength 2
   * @maxLength 100
   */
  name: string
  /**
   * Slug pattern.
   * @pattern "^[a-z][a-z0-9-]*$"
   */
  slug: string
  /**
   * Contact channel.
   * @format email
   */
  contact: string
  /**
   * Percentage.
   * @minimum 0
   * @maximum 100
   */
  percent: number
  /**
   * Strictly positive.
   * @exclusiveMinimum 0
   * @exclusiveMaximum 1000
   */
  strictRange: number
  /**
   * Must land on a multiple of 5.
   * @multipleOf 5
   */
  step: number
  /** No refinement tags at all — must carry no refinement meta. */
  plain: string
}

// ── Branded intersection refinement-tag fixtures ────────────────────────────
// The type-ir-exported refinement tag types (`MinLength`/`MaxLength`/…),
// intersected with a base type — the `RefinementTag`-shared-symbol pattern
// from `@rhi-zone/fractal-type-ir/kinds/refinements`.

/** A single refinement tag intersected with `string`. */
export type ShortCode = string & MinLength<2>

/** Two refinement tags intersected together — their value objects merge. */
export type ValidName = string & MinLength<2> & MaxLength<100>

/** Numeric refinement tags (`Minimum`/`Maximum`) over `number`. */
export type Percent = number & Minimum<0> & Maximum<100>

/** `Pattern` tag over `string`. */
export type SlugPattern = string & Pattern<"^[a-z0-9-]+$">

/** Refinement-tagged field nested inside an object. */
export type RefinedIntersectionField = { code: ShortCode; name: ValidName }

// ── Combined brand + refinement intersection fixtures ───────────────────────
// A canonical semantic-string brand type (`Email`/`Uuid`, imported from
// type-ir's `kinds/semantic-strings`) intersected with one or more
// refinement tags — three constituents total (base + brand tag + refinement
// tag), exercising the unified brand+refinement classification in
// `typeRefFromBrandedIntersection` rather than either pattern alone.

/** Brand + a single refinement tag: `string & { [BrandTag]: "email" } &
 * { [RefinementTag]: { minLength: 5 } }`. */
export type EmailMinLength = Email & MinLength<5>

/** Brand + a differently-shaped refinement tag (`Pattern`, string-valued),
 * over the `uuid` brand instead of `email`. */
export type UuidPattern = Uuid & Pattern<"^[0-9a-f-]{36}$">

/** Brand + more than one refinement tag, confirming all three constituents
 * (base, brand, refinements) merge together. */
export type EmailMinMaxLength = Email & MinLength<3> & MaxLength<254>

// ── Generic type parameter fixtures ─────────────────────────────────────────
// A type parameter unresolved at the extraction site (e.g. a handler's own
// `<T>`) has no concrete type to lower — only its `extends` constraint (if
// any) describes what it's guaranteed to look like.

/** An interface used as a generic constraint's bound. */
export interface Searchable {
  query: string
}

/** `T extends { name: string }` — an inline-object constraint. */
export const inlineConstraintFn = <T extends { name: string }>(input: T): T => input

/** `T extends string` — a primitive constraint. */
export const primitiveConstraintFn = <T extends string>(input: T): T => input

/** `T extends Searchable` — a named-interface constraint. */
export const interfaceConstraintFn = <T extends Searchable>(input: T): T => input

/** Unconstrained `T` — no bound to extract, must stay `types.unknown`. */
export const unconstrainedFn = <T>(input: T): T => input
