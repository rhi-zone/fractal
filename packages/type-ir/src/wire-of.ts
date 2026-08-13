// packages/type-ir/src/wire-of.ts — @rhi-zone/fractal-type-ir
//
// `WireOf<T, Profile>` — the TYPE-LEVEL mirror of `compile.ts`'s RUNTIME
// `wireTypeText`/`WireProfile.leafHandlers`, computed over an ordinary
// TypeScript type `T` rather than a `TypeRef`. See docs/design/
// wire-profiles-and-staged-validation.md's implementation-trace addendum
// (function-form `encodingMap`, decision 3): a custom decoder's declared
// parameter type should type-check as `WireOf<FieldType, Store'sProfile>`,
// the same `ValidWire` shape the design doc's "staged model" section
// describes — a REAL emitted type, not a phantom brand, so an author writing
// `(w: WireOf<number, "query">) => number` gets `w: string`, exactly the
// numeric-string shape `numericStringLeaf` actually enforces before this
// decoder ever runs.
//
// This is authoring-site machinery ONLY — it is never read by codegen
// (`apply-validation-build.ts` only detects a decoder's EXISTENCE via
// `readMetaEncodingMapFunctionFields`, never its type) and it never runs at
// runtime. Its only consumer is `op()`'s own contributions check
// (api-tree's node.ts), the same "phantom-property-based static check folded
// into `op()`'s contributions parameter type" family `UncoveredSourceParams`
// (api-tree's input.ts) already belongs to.
//
// PROFILE NAMES, not `WireProfile` VALUES: `WireOf` is generic over the four
// profile identities `compile.ts`'s own leaf handlers actually distinguish
// (`"identity" | "json" | "query" | "argv"`) rather than being parameterized
// by a `WireProfile` object — there is no type-level way to pattern-match a
// VALUE's identity, only a type's, and every existing `WireProfile` these
// four names correspond to (`identityProfile`/`jsonProfile`/`queryProfile`/
// `argvProfile`, compile.ts) is exactly one of these four in practice (no
// other profile is constructed anywhere in this codebase).
export type WireProfileName = "identity" | "json" | "query" | "argv";

/**
 * A single leaf VALUE's wire shape under `P` — the type-level counterpart of
 * `numericStringLeaf`/`strictBoolFromStringLeaf`/`argvBoolLeaf`/
 * `isoDateStringLeaf`/`defaultWireLeaf` (compile.ts). Dispatches on `T`'s own
 * shape, mirroring `wireTypeTextShape`'s fallback order (leaf kinds only —
 * the structural kinds this file's `WireOf` handles above never reach here):
 *
 * - `Date` — every non-`identity` profile requires an ISO-ish STRING (JSON
 *   has no date literal, and query/argv are string-only wires);
 *   `identity` requires an already-real `Date` (no coercion at all).
 * - `number` (or a numeric literal, e.g. `3`) — `identity`/`json` leave it a
 *   `number` (typed JSON, or an in-process value); `query`/`argv` require a
 *   numeric STRING (`numericStringLeaf`).
 * - `boolean` (or `true`/`false` literal) — `identity`/`json` leave it a
 *   `boolean`; `query` requires the strict `"true" | "false"` STRING
 *   (`strictBoolFromStringLeaf` — see the design doc's "(c)" decision,
 *   strict chosen over loose); `argv` additionally accepts a real `boolean`
 *   alongside those two strings (`argvBoolLeaf`, argv's bare-flag-presence
 *   sentinel).
 * - `string` — every profile's wire IS already a string for a `string`
 *   field (`defaultWireLeaf`'s fallback, unmodified by any profile's
 *   `leafHandlers` table — none of `queryProfile`/`argvProfile`/
 *   `jsonProfile` override the `string` kind).
 * - anything else (an object/array/union member fell through to here only
 *   if `T` doesn't structurally match any of `WireOf`'s own recursion
 *   cases below, e.g. a branded/opaque type, `bigint`, a class instance) —
 *   `defaultWireLeaf`'s posture: no coercion, the wire value must already
 *   BE `T`. Widening a branded/literal type to its base primitive first
 *   (matching `defaultWireType`'s own `toTypeScript` rendering, which
 *   likewise has no notion of a caller's brand) is deliberately NOT
 *   attempted here — `T` itself, unchanged, is exactly `defaultWireLeaf`'s
 *   "must already be valid" contract.
 */
type WireOfLeaf<T, P extends WireProfileName> = T extends Date
  ? P extends "identity"
    ? Date
    : string
  : T extends number
    ? P extends "identity" | "json"
      ? T
      : string
    : T extends boolean
      ? P extends "identity" | "json"
        ? T
        : P extends "argv"
          ? boolean | "true" | "false"
          : "true" | "false"
      : T extends string
        ? string
        : T;

/**
 * `WireOf<T, P>` — `T`'s wire representation under wire profile `P`,
 * structurally recursive over `T` the same way `wireTypeTextShape`
 * recurses over a `TypeRef`'s structural kinds (object/array/tuple/union) —
 * only the STRUCTURE is profile-independent; every leaf bottoms out in
 * `WireOfLeaf` above.
 *
 * Handled, in dispatch order (mirroring `wireTypeTextShape`'s own kind
 * checks, adapted to TS's structural type system rather than a `TypeRef`
 * DU):
 *   - `null`/`undefined` — an optional/nullable field decodes exactly like
 *     its non-null members (`genWireEncodeDecode`'s own `meta.nullable`
 *     branch: `wire === null` short-circuits to `null` without running any
 *     leaf handler at all, so `null`/`undefined` pass through `WireOf`
 *     unchanged rather than being profile-mapped themselves).
 *   - `Date` — checked BEFORE the generic `object` case below, since `Date`
 *     otherwise structurally matches `object` too and would wrongly
 *     recurse into ITS OWN properties instead of being treated as one
 *     opaque leaf value.
 *   - `readonly (infer E)[]` — `wireArray`'s own per-element recursion:
 *     `WireOf<E, P>[]`, always a real array on the wire (no
 *     nullable-array special case beyond the top-level one above).
 *   - a plain object (anything left that extends `object`) — `wireObject`'s
 *     own per-field recursion: every field mapped through `WireOf`
 *     recursively, and — matching `wireObject`'s own "a field absent from
 *     the wire is left absent in the decoded output, never a `missing`
 *     error here" contract (see compile.ts's `genWireEncodeDecode` doc
 *     comment) — every field rendered OPTIONAL (`?:`), regardless of
 *     whether `T` itself declares it required, mirroring `wireTypeTextShape`'s
 *     own object-field rendering exactly.
 *   - anything else — `WireOfLeaf` above.
 *
 * NOT handled (deliberate scope cuts, matching this phase's own mandate —
 * function-form `encodingMap` fields are always object properties one level
 * under a leaf's top-level input object, per `compileWireEntryFragmentComposite`'s
 * own "a composite profile only ever varies dispatch at the leaf's own
 * direct fields" scope): tuples (`wireTuple`), maps/index signatures
 * (`wireMap`), unions of structurally-different shapes beyond what TS's own
 * distributive conditional gives for free, and `defs`/`ref` recursion
 * (`WireDefsRegistry`) — none of these are exercised by a field's own
 * (non-recursive, in every existing fixture) domain type, and adding them
 * widens this type's own recursion depth/complexity for a case this phase
 * has no concrete need to cover. Revisit if a real field type needs one.
 */
// Deliberately a NAKED conditional (`T extends ...`, not `[T] extends
// [...]`) — a bare type-parameter check distributes over a union `T`
// automatically (TypeScript's own distributive-conditional-type rule), which
// is exactly what a nullable/optional field's `T | null` / `T | undefined`
// needs: the `null`/`undefined` member matches the first branch UNCHANGED
// (mirroring `genWireEncodeDecode`'s own `meta.nullable` short-circuit —
// `wire === null` never runs a leaf handler at all) while the OTHER member
// recurses normally, and the two results re-unite via `|` — precisely
// `wireTypeText`'s own `${base} | null` suffix, computed distributively
// instead of by string-concatenation. Wrapping in `[T]` (the usual trick for
// SUPPRESSING distribution) would instead send the WHOLE union into
// `WireOfLeaf`, which has no member-shaped case to match and would return
// `T` unchanged — silently wrong for exactly the nullable-field case this
// type exists to handle correctly.
export type WireOf<T, P extends WireProfileName> = T extends null | undefined
  ? T
  : T extends Date
    ? WireOfLeaf<T, P>
    : T extends readonly (infer E)[]
      ? readonly WireOf<E, P>[]
      : T extends object
        ? { readonly [K in keyof T]?: WireOf<T[K], P> }
        : WireOfLeaf<T, P>;
