// FROM-direction ingester: any object implementing the Standard Schema spec
// (https://standardschema.dev/) -> TypeRef. Standard Schema is a thin,
// vendor-neutral validation interface (`~standard.validate`) that Zod,
// Valibot, ArkType, and others implement; a growing subset additionally
// implement StandardJSONSchemaV1 (`~standard.jsonSchema.input`/`.output`),
// which exports a real JSON Schema we can hand straight to
// fromJsonSchema() — the richest of the three paths here, since it is the
// vendor's own structural description rather than a guess. "Richest of
// what is available", not "lossless": see the caveat on tier 1 below.
//
// This module covers the runtime path, bounded by what is observable from a
// live schema object. When compiler context is available — a build step, a
// codegen pass, anything holding a `ts.Program` — `from-standard-schema-type.ts`'s
// `fromStandardSchemaType` is the richer alternative: it resolves
// `~standard.types.output` through the type checker and subsumes all three
// tiers here, recovering optionality, untaken union branches, enum members,
// and nominal/branded identity, none of which any runtime observation can
// supply. It also reads `~standard.types` at all, which is a phantom property
// the spec defines for compile-time inference and implementations typically
// do not populate at runtime — so tier 2 below fires only when a vendor
// happens to leave a real value there.
//
// The tiers below are the fallbacks for when no compiler context exists.
//
// Strategy, in priority order:
//   1. StandardJSONSchemaV1 present -> export JSON Schema (target
//      "draft-2020-12", falling back to "draft-07" if the vendor doesn't
//      support 2020-12 — both are the spec's "strongly recommended"
//      targets) and delegate to fromJsonSchema().
//
//      Best of the three paths, but not lossless. Two different losses,
//      worth separating because only one is inherent:
//
//      (a) Inherent to JSON Schema. Arbitrary `.refine()` predicates and
//          `.transform()` bodies are code; nothing declarative represents
//          them, and they are gone before we see the export.
//
//      (b) Not inherent to JSON Schema itself. TypeRef has a first-class
//          nominal `instance` kind (className/declarationFile), and
//          `json-schema.ts` serializes it as `{type:"object", "x-class-name":
//          Name, "x-declaration-file": File}`. `fromJsonSchema()` reads that
//          convention back, so a vendor exporting `z.instanceof(Date)` under
//          it round-trips to `instance("Date")` exactly. Other `x-`
//          extensions (`x-brand`, OAS `x-*`) are likewise carried into meta
//          rather than dropped.
//
//      Standard keywords do survive: `{type:"string", pattern, minLength}`
//      lands as `string` with `meta.pattern`/`meta.minLength`, and
//      `format: "date-time"` becomes the `datetime` domain kind.
//   2. No JSON Schema export -> fall back to whatever `~standard.types`
//      offers. Per spec this property exists purely to drive TypeScript's
//      `InferInput`/`InferOutput` — implementations are not required to
//      (and typically don't) populate it at runtime — so this path
//      degrades to `unknown` unless a vendor actually attaches a runtime
//      sample value, in which case fromJsonCorpus([sample]) infers a structural TypeRef
//      from that sample the same way it would from any other JSON value.
//
// The originating vendor name (`~standard.vendor`) is always preserved in
// `meta.vendor` on both paths, so downstream consumers can recover which
// library produced the schema even once it's flattened to a TypeRef.

import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
  StandardTypedV1,
} from "@standard-schema/spec";
import { t, types, type TypeRef } from "./index.ts";
import { fromJsonSchema, type JsonSchema } from "./from-json-schema.ts";
import { fromJsonCorpus } from "./from-json-corpus.ts";

export type { StandardJSONSchemaV1, StandardSchemaV1, StandardTypedV1 };

function withMeta(ref: TypeRef, extra: Record<string, unknown>): TypeRef {
  if (Object.keys(extra).length === 0) return ref;
  return { shape: ref.shape, meta: { ...ref.meta, ...extra } };
}

// StandardJSONSchemaV1 isn't distinguishable from plain StandardSchemaV1 by
// `~standard.version`/`vendor` alone — the presence of a callable
// `jsonSchema.input` is the actual discriminator the spec defines for
// "this schema also exports JSON Schema."
function hasJsonSchemaExport(
  props: StandardSchemaV1.Props,
): props is StandardSchemaV1.Props & StandardJSONSchemaV1.Props {
  const jsonSchema = (props as Partial<StandardJSONSchemaV1.Props>).jsonSchema;
  return typeof jsonSchema?.input === "function";
}

function exportJsonSchema(converter: StandardJSONSchemaV1.Converter): JsonSchema {
  try {
    return converter.input({ target: "draft-2020-12" });
  } catch {
    return converter.input({ target: "draft-07" });
  }
}

/**
 * Converts any Standard Schema (https://standardschema.dev/) implementation
 * to a TypeRef.
 *
 * Prefers the schema's own JSON Schema export (StandardJSONSchemaV1) when
 * available, piping it through fromJsonSchema(). When no JSON Schema export
 * exists, falls back to inferring from a runtime `~standard.types` sample
 * if the vendor happens to provide one, and otherwise degrades to
 * `types.unknown` — in every case preserving `~standard.vendor` in
 * `meta.vendor`.
 *
 * The two tiers are mutually exclusive (tier 2 only runs when the vendor
 * exports no JSON Schema), so no runtime comparison between them ever
 * happens — but they differ in what they can recover:
 *
 * A JSON Schema export (tier 1) describes the whole space of allowed values;
 * a `~standard.types` sample (tier 2) is one point in it. A sample alone
 * cannot recover optionality (a `note?: string` the sample omits), enum
 * member sets, untaken union branches, or constraints (`minLength`,
 * `pattern`). It also produces one-sample artifacts a schema wouldn't:
 * `tags: ["a"]` infers a 1-`tuple`, not an `array`, since one observation
 * can't distinguish fixed arity from variable.
 *
 * Nominal identity is the one axis where tier 2 is more reliable: inference
 * reads class identity off a runtime value's prototype, so
 * `z.instanceof(Date)` yields `instance("Date")` directly from the sample,
 * whereas tier 1 only recovers identity if the vendor happens to emit the
 * non-standard `x-class-name` extension.
 *
 * Tier 2 is also the only path that can say anything structural about a
 * vendor construct with no schema-shaped representation at all
 * (`z.custom<T>()`, instanceof-style checks): tier 1 degrades those to a
 * permissive `{}`/`true` (-> `unknown`) or `{type:"object"}` (-> an empty
 * object), while a JSON-serializable sample still yields the real field
 * shape.
 */
export function fromStandardSchema(schema: StandardSchemaV1): TypeRef {
  const props = schema["~standard"];
  const vendor = props.vendor;

  if (hasJsonSchemaExport(props)) {
    const jsonSchema = exportJsonSchema(props.jsonSchema);
    return withMeta(fromJsonSchema(jsonSchema), { vendor });
  }

  const sample = props.types?.output ?? props.types?.input;
  if (sample !== undefined) {
    return withMeta(fromJsonCorpus([sample]), { vendor });
  }

  return withMeta(t(types.unknown), { vendor });
}
