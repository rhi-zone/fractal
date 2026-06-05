// examples/dogfood/src/schema.ts
//
// A tiny StandardSchema-shaped fixture (no external validator dependency, per the
// example-dir convention). Mirrors the helper in examples/todo-api, extended with
// an `enumOf` for picklist-style fields (the reference app uses a valibot picklist
// for the status field; we reproduce the SHAPE with a hand-rolled enum schema).
//
// The load-bearing part for the OpenAPI projection is the `jsonSchema` reflective
// trait (read by @rhi-zone/fractal-openapi to emit real body/response schemas
// rather than degrading to `{}`); the `validate` is a plain runtime check.

import type { StandardSchemaV1 } from "@rhi-zone/fractal-core";

type FieldType = "string" | "boolean" | "number";
type TsOf<T extends FieldType> = T extends "string"
  ? string
  : T extends "boolean"
    ? boolean
    : number;

/** An object schema over named fields of primitive type. All fields required. */
export function object<const F extends Record<string, FieldType>>(
  fields: F,
): StandardSchemaV1<unknown, { [K in keyof F]: TsOf<F[K]> }> {
  type Out = { [K in keyof F]: TsOf<F[K]> };
  const properties: Record<string, { type: string }> = {};
  for (const [k, t] of Object.entries(fields)) properties[k] = { type: t };
  const asJsonSchema = () => ({
    type: "object",
    properties,
    required: Object.keys(fields),
  });
  const std = {
    version: 1 as const,
    vendor: "dogfood-fixture",
    jsonSchema: { input: asJsonSchema, output: asJsonSchema },
    validate(value: unknown) {
      if (typeof value !== "object" || value === null) {
        return { issues: [{ message: "expected an object" }] };
      }
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, t] of Object.entries(fields)) {
        if (typeof obj[k] !== t) {
          return { issues: [{ message: `field "${k}" must be a ${t}` }] };
        }
        out[k] = obj[k];
      }
      return { value: out as Out };
    },
  };
  return { "~standard": std } as StandardSchemaV1<unknown, Out>;
}

/** A picklist / enum schema — the SHAPE of the reference's
 *  `v.picklist([...])` status field, hand-rolled (no validator dep). Validates
 *  the value is one of the literals; types the output as the literal union. */
export function enumOf<const Vs extends readonly string[]>(
  ...values: Vs
): StandardSchemaV1<unknown, Vs[number]> {
  const set = new Set<string>(values);
  const std = {
    version: 1 as const,
    vendor: "dogfood-fixture",
    jsonSchema: {
      input: () => ({ type: "string", enum: [...values] }),
      output: () => ({ type: "string", enum: [...values] }),
    },
    validate(value: unknown) {
      return typeof value === "string" && set.has(value)
        ? { value: value as Vs[number] }
        : { issues: [{ message: `expected one of ${values.join(", ")}` }] };
    },
  };
  return { "~standard": std } as StandardSchemaV1<unknown, Vs[number]>;
}

/** Wrap an object schema as an ARRAY schema (typed list response). The
 *  load-bearing part is the `jsonSchema` trait the OpenAPI projection reads. */
export function arrayOf<O>(
  item: StandardSchemaV1<unknown, O>,
): StandardSchemaV1<unknown, O[]> {
  const itemJson = (
    item as { "~standard": { jsonSchema?: { output?: () => unknown } } }
  )["~standard"].jsonSchema?.output;
  const std = {
    version: 1 as const,
    vendor: "dogfood-fixture",
    jsonSchema: {
      input: () => ({ type: "array", items: itemJson?.() }),
      output: () => ({ type: "array", items: itemJson?.() }),
    },
    validate(value: unknown) {
      return Array.isArray(value)
        ? { value: value as O[] }
        : { issues: [{ message: "expected an array" }] };
    },
  };
  return { "~standard": std } as StandardSchemaV1<unknown, O[]>;
}
