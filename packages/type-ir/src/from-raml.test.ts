import { describe, expect, test } from "bun:test";
import { t, types } from "./index.ts";
import { bytes, date, datetime, float32, int32, int64, time } from "./kinds/common.ts";
import {
  fromRamlProperty,
  fromRamlType,
  fromRamlTypes,
  type RamlTypeContext,
} from "./from-raml.ts";

function context(declarations: Record<string, unknown> = {}): RamlTypeContext {
  return {
    keyOf: (name) => (name in declarations ? name : undefined),
    lookup: (key) =>
      key in declarations ? { decl: declarations[key], scope: context(declarations) } : undefined,
  };
}

describe("built-ins", () => {
  const cases: [string, ReturnType<typeof t>][] = [
    ["string", t(types.string)],
    ["number", t(types.number)],
    ["integer", t(types.integer)],
    ["boolean", t(types.boolean)],
    ["nil", t(types.null)],
    ["any", t(types.unknown)],
    ["object", t(types.object({}))],
    ["date-only", date()],
    ["time-only", time()],
    ["datetime", datetime()],
  ];
  for (const [name, expected] of cases) {
    test(name, () => {
      expect(fromRamlType(name, context()).value).toEqual(expected);
    });
  }

  test("datetime-only and file keep their RAML type", () => {
    expect(fromRamlType("datetime-only", context()).value).toEqual(
      datetime({ raml: { type: "datetime-only" } }),
    );
    expect(fromRamlType("file", context()).value).toEqual(bytes({ raml: { type: "file" } }));
  });

  test("facet meta does not overwrite the built-in's own raml marker", () => {
    const dt = fromRamlType({ type: "datetime-only", "(note)": "x" }, context()).value;
    expect(dt.meta.raml).toEqual({ type: "datetime-only", annotations: { note: "x" } });
    const file = fromRamlType({ type: "file", fileTypes: ["*/*"] }, context()).value;
    expect(file.meta.raml).toEqual({ type: "file", fileTypes: ["*/*"] });
  });

  test("datetime format rfc2616", () => {
    expect(fromRamlType({ type: "datetime", format: "rfc2616" }, context()).value).toEqual(
      datetime({ raml: { format: "rfc2616" } }),
    );
  });

  test("number formats select the width", () => {
    expect(fromRamlType({ type: "number", format: "int32" }, context()).value).toEqual(int32());
    expect(fromRamlType({ type: "integer", format: "long" }, context()).value).toEqual(int64());
    expect(fromRamlType({ type: "number", format: "float" }, context()).value).toEqual(float32());
  });

  test("a declaration with no type is a string, or any for a body", () => {
    expect(fromRamlType(null, context()).value.shape.kind).toBe("string");
    expect(fromRamlType({ description: "d" }, context()).value.shape.kind).toBe("string");
    expect(
      fromRamlType({ description: "d" }, context(), { defaultType: "any" }).value.shape.kind,
    ).toBe("unknown");
  });
});

describe("facets", () => {
  test("scalar facets are same-named meta", () => {
    const { value } = fromRamlType(
      {
        type: "string",
        pattern: "^a",
        minLength: 1,
        maxLength: 5,
        default: "a",
        description: "d",
        displayName: "T",
      },
      context(),
    );
    expect(value.shape.kind).toBe("string");
    expect(value.meta).toEqual({
      pattern: "^a",
      minLength: 1,
      maxLength: 5,
      default: "a",
      description: "d",
      title: "T",
    });
  });

  test("facets pick the default type", () => {
    expect(fromRamlType({ minimum: 1 }, context()).value.shape.kind).toBe("number");
    expect(fromRamlType({ properties: {} }, context()).value.shape.kind).toBe("object");
    expect(fromRamlType({ items: "string" }, context()).value.shape.kind).toBe("array");
  });

  test("examples are values only", () => {
    const { value } = fromRamlType(
      {
        type: "string",
        example: { value: "a", strict: false },
        examples: { x: "b", y: { value: "c" } },
      },
      context(),
    );
    expect(value.meta.examples).toEqual(["a", "b", "c"]);
  });

  test("annotations, xml and facet declarations are kept under raml", () => {
    const { value } = fromRamlType(
      { type: "string", "(pii)": true, xml: { name: "n" }, facets: { unit: "string" } },
      context(),
    );
    expect(value.meta.raml).toEqual({
      annotations: { pii: true },
      xml: { name: "n" },
      facets: { unit: "string" },
    });
  });

  test("user-defined facet values are kept, undeclared ones reported", () => {
    const decls = {
      Base: { type: "date-only", facets: { noHolidays: "boolean" } },
      Meeting: { type: "Base", noHolidays: true },
      Bad: { type: "string", nope: 1 },
    };
    const { value, diagnostics } = fromRamlTypes(decls, context(decls));
    expect(value.Meeting).toEqual(
      t(types.ref("Base"), { typeName: "Meeting", raml: { facetValues: { noHolidays: true } } }),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('"nope"');
  });

  test("enum of strings is an enum, other scalars a literal union", () => {
    expect(fromRamlType({ enum: ["a", "b"] }, context()).value.shape).toEqual({
      kind: "enum",
      members: ["a", "b"],
    });
    const nums = fromRamlType({ type: "number", enum: [1, 2] }, context()).value;
    expect(nums.shape).toEqual({
      kind: "union",
      variants: [t(types.literal(1)), t(types.literal(2))],
    });
  });
});

describe("type expressions", () => {
  test("arrays, nested arrays and unions", () => {
    expect(fromRamlType("string[]", context()).value.shape).toEqual({
      kind: "array",
      element: t(types.string),
    });
    expect(fromRamlType("string[][]", context()).value.shape.kind).toBe("array");
    const u = fromRamlType("string | number", context()).value;
    expect(u.shape).toEqual({ kind: "union", variants: [t(types.string), t(types.number)] });
  });

  test("parentheses bind the array operator", () => {
    const decls = { A: {}, B: {} };
    const grouped = fromRamlType("(A | B)[]", context(decls)).value;
    expect(grouped.shape.kind).toBe("array");
    expect((grouped.shape as { element: { shape: { kind: string } } }).element.shape.kind).toBe(
      "union",
    );
    const ungrouped = fromRamlType("A | B[]", context(decls)).value;
    expect(ungrouped.shape.kind).toBe("union");
  });

  test("nil in a union and a trailing ? are nullable, not a null variant", () => {
    const viaUnion = fromRamlType("string | nil", context()).value;
    const viaQuestion = fromRamlType("string?", context()).value;
    expect(viaUnion).toEqual(t(types.string, { nullable: true }));
    expect(viaQuestion).toEqual(viaUnion);
    const three = fromRamlType("string | number | nil", context()).value;
    expect(three.shape.kind).toBe("union");
    expect(three.meta.nullable).toBe(true);
  });

  test("references resolve through the scope, unknown names are reported", () => {
    const decls = { Person: { properties: { name: "string" } } };
    expect(fromRamlType("Person[]", context(decls)).value.shape).toEqual({
      kind: "array",
      element: t(types.ref("Person")),
    });
    const bad = fromRamlType("Nobody", context(decls));
    expect(bad.value.meta.raml).toEqual({ unresolvedType: "Nobody" });
    expect(bad.diagnostics[0]!.message).toContain("Nobody");
  });

  test("a malformed expression is reported", () => {
    const r = fromRamlType("A | ", context());
    expect(r.diagnostics[0]!.message).toContain("not a valid type expression");
  });
});

describe("objects and properties", () => {
  test("optional properties: ?, required: false, explicit required keeps the ?", () => {
    const { value } = fromRamlType(
      {
        properties: {
          a: "string",
          "b?": "number",
          c: { type: "string", required: false },
          "d?": { type: "string", required: true },
          "e??": "string",
        },
      },
      context(),
    );
    const fields = (value.shape as { fields: Record<string, { meta: Record<string, unknown> }> })
      .fields;
    expect(Object.keys(fields)).toEqual(["a", "b", "c", "d?", "e?"]);
    expect(fields.a!.meta.optional).toBeUndefined();
    expect(fields.b!.meta.optional).toBe(true);
    expect(fields.c!.meta.optional).toBe(true);
    expect(fields["d?"]!.meta.optional).toBeUndefined();
    expect(fields["e?"]!.meta.optional).toBe(true);
  });

  test("a property with no value is a string", () => {
    const r = fromRamlProperty("name", null, context());
    expect(r.value).toEqual({ name: "name", type: t(types.string), optional: false });
  });

  test("requiredByDefault: false makes an undeclared property optional", () => {
    const r = fromRamlProperty("q", "string", context(), { requiredByDefault: false });
    expect(r.value.optional).toBe(true);
    const explicit = fromRamlProperty("q", { type: "string", required: true }, context(), {
      requiredByDefault: false,
    });
    expect(explicit.value.optional).toBe(false);
  });

  test("additionalProperties and object facets are meta", () => {
    const { value } = fromRamlType(
      { properties: { a: "string" }, additionalProperties: false, minProperties: 1 },
      context(),
    );
    expect(value.meta).toMatchObject({ additionalProperties: false, minProperties: 1 });
  });

  test("a // pattern alone is a string-keyed map", () => {
    const { value } = fromRamlType({ properties: { "//": "number" } }, context());
    expect(value.shape).toEqual({ kind: "map", key: t(types.string), value: t(types.number) });
  });

  test("// beside declared properties is additionalPropertyType; other patterns are kept and reported", () => {
    const withAny = fromRamlType({ properties: { a: "string", "//": "number" } }, context()).value;
    expect(withAny.meta.additionalPropertyType).toEqual(t(types.number));
    const withPattern = fromRamlType(
      { properties: { a: "string", "/^n\\d+$/": "string" } },
      context(),
    );
    expect(withPattern.value.meta.raml).toEqual({
      patternProperties: { "^n\\d+$": t(types.string) },
    });
    expect(withPattern.diagnostics).toHaveLength(1);
  });

  test("discriminator and discriminatorValue are kept under raml", () => {
    const decls = {
      Person: { discriminator: "kind", properties: { kind: "string" } },
      Employee: { type: "Person", discriminatorValue: "employee", properties: { id: "integer" } },
    };
    const { value } = fromRamlTypes(decls, context(decls));
    expect(value.Person!.meta.raml).toEqual({ discriminator: "kind" });
    expect(value.Employee!.meta.raml).toEqual({ discriminatorValue: "employee" });
  });
});

describe("inheritance", () => {
  const decls = {
    Person: { properties: { name: "string" } },
    Employee: { type: "Person", properties: { id: "integer" } },
    Alias: { type: "Person", description: "an alias" },
    Teacher: { type: ["Person", "Employee"] },
    Email: { type: "string", pattern: "@" },
    Work: { type: "Email", minLength: 3 },
    Emails: "Email[]",
  };
  const { value, diagnostics } = fromRamlTypes(decls, context(decls));

  test("added properties intersect the parent with the own structure", () => {
    const e = value.Employee!;
    expect(e.shape.kind).toBe("intersection");
    const members = e.shape.kind === "intersection" ? e.shape.members : [];
    expect(members.map((m) => m.shape.kind)).toEqual(["ref", "object"]);
  });

  test("facets only: the parent reference carries them as meta", () => {
    expect(value.Alias).toEqual(
      t(types.ref("Person"), { description: "an alias", typeName: "Alias" }),
    );
    expect(value.Work).toEqual(t(types.ref("Email"), { minLength: 3, typeName: "Work" }));
  });

  test("multiple inheritance intersects the parents", () => {
    expect(value.Teacher!.shape).toEqual({
      kind: "intersection",
      members: [t(types.ref("Person")), t(types.ref("Employee"))],
    });
  });

  test("a declaration that is only a type expression aliases it", () => {
    expect(value.Emails!.shape).toEqual({ kind: "array", element: t(types.ref("Email")) });
  });

  test("nothing in a well-formed set is reported", () => {
    expect(diagnostics).toEqual([]);
  });

  test("every def carries its name", () => {
    expect(Object.values(value).every((d) => typeof d.meta.typeName === "string")).toBe(true);
  });
});

describe("external schemas", () => {
  test("a JSON schema string goes through fromJsonSchema and hoists its definitions", () => {
    const schema = JSON.stringify({
      type: "object",
      properties: { home: { $ref: "#/definitions/Address" } },
      required: ["home"],
      definitions: { Address: { type: "object", properties: { zip: { type: "string" } } } },
    });
    const r = fromRamlType(schema, context());
    const home = (r.value.shape as { fields: Record<string, unknown> }).fields.home;
    expect(home).toEqual(t(types.ref("Address")));
    expect(Object.keys(r.defs)).toEqual(["Address"]);
    expect(r.diagnostics).toEqual([]);
  });

  test("a schema wrapper keeps its description", () => {
    const r = fromRamlType(
      { type: JSON.stringify({ type: "string" }), description: "wrapped" },
      context(),
    );
    expect(r.value).toEqual(t(types.string, { description: "wrapped" }));
  });

  test("an XML schema is reported and kept verbatim", () => {
    const r = fromRamlType("<xs:schema/>", context());
    expect(r.value.meta.raml).toEqual({ xmlSchema: "<xs:schema/>" });
    expect(r.diagnostics[0]!.message).toContain("XML");
  });

  test("broken JSON is reported, not thrown", () => {
    const r = fromRamlType("{ nope", context());
    expect(r.value.shape.kind).toBe("unknown");
    expect(r.diagnostics).toHaveLength(1);
  });
});

describe("plain JSON", () => {
  test("results survive a JSON round trip", () => {
    const decls = {
      A: {
        properties: { "x?": "string | nil", y: "(A | string)[]", "//": "number" },
        "(note)": "hello",
      },
    };
    const { value } = fromRamlTypes(decls, context(decls));
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });
});

describe("enum members that are not scalars", () => {
  test("are kept and reported", () => {
    const r = fromRamlType({ type: "any", enum: [{ a: 1 }] }, context());
    expect(r.value.meta.raml).toEqual({ enum: [{ a: 1 }] });
    expect(r.diagnostics).toHaveLength(1);
  });
});
