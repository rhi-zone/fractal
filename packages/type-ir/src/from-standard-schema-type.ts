// packages/type-ir/src/from-standard-schema-type.ts — @rhi-zone/fractal-type-ir/from-standard-schema-type
//
// COMPILE-TIME ingester for Standard Schema (https://standardschema.dev/):
// a schema's `ts.Type` -> TypeRef, by resolving `~standard.types.output`
// through the type checker and handing the result to `from-typescript.ts`'s
// `typeRefFromType`.
//
// Why this exists as a separate entry point from `from-standard-schema.ts`.
// That module takes a live schema OBJECT and has three tiers, each bounded by
// what is observable at runtime: the vendor's JSON Schema export (lossy for
// anything JSON Schema cannot say), a runtime `~standard.types` sample (one
// point in the value space), or `unknown`. This module is bounded by nothing
// except the type checker, which is the same source of truth the vendor's own
// `InferOutput<typeof schema>` reads.
//
// Concretely it recovers what no runtime path can:
//
//   - OPTIONALITY. `note?: string` is absent from a sample that happens not to
//     carry it; the checker knows it is optional.
//   - UNION BRANCHES AND ENUM MEMBERS not taken by whatever sample exists.
//   - NOMINAL AND BRANDED TYPES. `typeRefFromType` already maps classes to
//     `types.instance` and the branded/opaque conventions in
//     `kinds/semantic-strings.ts`, with no dependence on a vendor emitting the
//     non-standard `x-class-name` JSON Schema extension.
//   - CONSTRAINTS carried in the type rather than in a JSON Schema export.
//
// And critically, `~standard.types` is a PHANTOM property: the spec defines it
// to drive `InferInput`/`InferOutput` at compile time, and implementations
// typically do not populate it at runtime. So this is usually the only path
// that can read it at all — the runtime tier-2 fallback fires only when a
// vendor happens to leave a real value there.
//
// Separate FILE rather than an addition to either neighbour, for two reasons.
// `typescript` is a PEER dependency of this package: putting this in
// `from-standard-schema.ts` would drag the whole compiler into the dependency
// graph of consumers who only ever use the runtime path. And
// `from-typescript.ts` is a general-purpose TS ingester — Standard Schema is
// one ecosystem convention layered on it, not part of its core.

import ts from "typescript";
import { t, types, type TypeRef } from "./index.ts";
import { typeRefFromType, type SharingRegistry } from "./from-typescript.ts";

export interface StandardSchemaTypeOptions {
  /**
   * Which side of the schema to resolve. `"output"` (the default) is the
   * parsed/validated type — what a consumer receives. `"input"` is what the
   * schema accepts, which differs whenever the schema transforms.
   */
  readonly direction?: "input" | "output";
  /** Forwarded to `typeRefFromType` for structural sharing across extractions. */
  readonly registry?: SharingRegistry;
}

/** Strip `undefined` out of a union — `~standard.types` is declared optional. */
function withoutUndefined(type: ts.Type): ts.Type {
  if (!type.isUnion()) return type;
  const rest = type.types.filter((x) => (x.flags & ts.TypeFlags.Undefined) === 0);
  return rest.length === 1 ? rest[0]! : (rest[0] ?? type);
}

function propertyType(
  type: ts.Type,
  name: string,
  checker: ts.TypeChecker,
  loc: ts.Node,
): ts.Type | undefined {
  const symbol = checker.getPropertyOfType(type, name);
  if (symbol === undefined) return undefined;
  return checker.getTypeOfSymbolAtLocation(symbol, loc);
}

/** `~standard.vendor`, when the vendor declared it as a string LITERAL type. */
function vendorOf(
  standardType: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
): string | undefined {
  const vendor = propertyType(standardType, "vendor", checker, loc);
  if (vendor === undefined || !vendor.isStringLiteral()) return undefined;
  return vendor.value;
}

/**
 * Convert a Standard Schema's `ts.Type` to a `TypeRef`.
 *
 * `loc` is any node in the schema's scope — the checker needs somewhere to
 * resolve symbols from; the schema's own reference site is the natural choice.
 *
 * Degrades to `unknown` with an explanatory `$comment` rather than throwing
 * when the type is not a Standard Schema, or when the vendor omitted the
 * phantom `types` property. `meta.vendor` is preserved when statically known.
 */
export function fromStandardSchemaType(
  schemaType: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
  options?: StandardSchemaTypeOptions,
): TypeRef {
  const standard = propertyType(schemaType, "~standard", checker, loc);
  if (standard === undefined) {
    return t(types.unknown, { $comment: "not a Standard Schema: no `~standard` property" });
  }

  const vendor = vendorOf(standard, checker, loc);
  const withVendor = (ref: TypeRef): TypeRef =>
    vendor === undefined ? ref : { shape: ref.shape, meta: { ...ref.meta, vendor } };

  const typesProp = propertyType(standard, "types", checker, loc);
  if (typesProp === undefined) {
    return withVendor(
      t(types.unknown, {
        $comment: "Standard Schema without `~standard.types`: no inferable type",
      }),
    );
  }

  const direction = options?.direction ?? "output";
  const resolved = propertyType(withoutUndefined(typesProp), direction, checker, loc);
  if (resolved === undefined) {
    return withVendor(
      t(types.unknown, { $comment: `\`~standard.types.${direction}\` is not declared` }),
    );
  }

  return withVendor(typeRefFromType(resolved, checker, loc, new Set(), options?.registry));
}
