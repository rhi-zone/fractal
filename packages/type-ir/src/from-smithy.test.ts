import { describe, expect, test } from "bun:test";
import { t, types } from "./index.ts";
import { bytes, datetime, float32, int32, int64 } from "./kinds/common.ts";
import { fromSmithy, type SmithyModel } from "./from-smithy.ts";

const P = "smithy.api#";

const model: SmithyModel = {
  smithy: "2.0",
  shapes: {
    "ex#Mixin": {
      type: "structure",
      traits: { [`${P}mixin`]: {} },
      members: { id: { target: `${P}String`, traits: { [`${P}required`]: {} } } },
    },
    "ex#Widget": {
      type: "structure",
      traits: { [`${P}documentation`]: "a widget" },
      mixins: [{ target: "ex#Mixin" }],
      members: {
        id: { target: `${P}String`, traits: { [`${P}documentation`]: "the id" } },
        name: {
          target: `${P}String`,
          traits: {
            [`${P}required`]: {},
            [`${P}length`]: { min: 1, max: 20 },
            [`${P}pattern`]: "^[a-z]+$",
            [`${P}jsonName`]: "Name",
          },
        },
        count: {
          target: `${P}Integer`,
          traits: { [`${P}default`]: 3, [`${P}range`]: { min: 0, max: 10 } },
        },
        size: { target: `${P}Long` },
        ratio: {
          target: `${P}Float`,
          traits: { [`${P}deprecated`]: { message: "use size", since: "2" } },
        },
        born: { target: `${P}Timestamp`, traits: { [`${P}timestampFormat`]: "epoch-seconds" } },
        blob: { target: `${P}Blob` },
        color: { target: "ex#Color" },
        level: { target: "ex#Level" },
        tags: { target: "ex#Tags" },
        attrs: { target: "ex#Attrs" },
        shape: { target: "ex#Shape" },
        friends: { target: "ex#Widget" },
        secret: { target: `${P}String`, traits: { [`${P}sensitive`]: {} } },
      },
    },
    "ex#Color": {
      type: "enum",
      members: {
        RED: { target: `${P}Unit`, traits: { [`${P}enumValue`]: "red" } },
        BLUE: { target: `${P}Unit`, traits: { [`${P}documentation`]: "cool" } },
      },
    },
    "ex#Level": {
      type: "intEnum",
      members: {
        LOW: { target: `${P}Unit`, traits: { [`${P}enumValue`]: 1 } },
        HIGH: { target: `${P}Unit`, traits: { [`${P}enumValue`]: 2 } },
      },
    },
    "ex#Tags": {
      type: "list",
      traits: { [`${P}sparse`]: {}, [`${P}uniqueItems`]: {} },
      member: { target: `${P}String` },
    },
    "ex#Attrs": {
      type: "map",
      key: { target: `${P}String` },
      value: { target: "ex#Widget" },
    },
    "ex#Shape": {
      type: "union",
      members: {
        circle: { target: "ex#Widget" },
        none: { target: `${P}Unit` },
      },
    },
    "ex#Name": {
      type: "string",
      traits: { [`${P}length`]: { min: 2 } },
    },
    "ex#LegacyEnum": {
      type: "string",
      traits: { [`${P}enum`]: [{ value: "a", name: "A" }, { value: "b" }] },
    },
    "other#Name": { type: "boolean" },
    "ex#MyTrait": { type: "structure", traits: { [`${P}trait`]: {} } },
    "ex#Service": { type: "service", version: "1" },
  },
};

describe("fromSmithy", () => {
  const conv = fromSmithy(model);
  const fields = (id: string) =>
    (conv.defs[id]!.shape as { fields: Record<string, ReturnType<typeof t>> }).fields;

  test("every data shape is a def; services and trait definitions are not", () => {
    expect(Object.keys(conv.defs).sort()).toEqual(
      [
        "Attrs",
        "Color",
        "LegacyEnum",
        "Level",
        "Mixin",
        "Shape",
        "Tags",
        "Widget",
        "ex.Name",
        "other.Name",
      ].sort(),
    );
    expect(conv.keys["ex#Widget"]).toBe("Widget");
    expect(conv.keys["ex#Name"]).toBe("ex.Name");
  });

  test("the result is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(conv.defs))).toEqual(conv.defs);
  });

  test("simple shapes map to type-ir kinds", () => {
    const f = fields("Widget");
    expect(f.size!.shape).toEqual(int64().shape);
    expect(f.ratio!.shape).toEqual(float32().shape);
    expect(f.blob!.shape).toEqual(bytes().shape);
    expect(f.born!.shape).toEqual(datetime().shape);
    expect(f.count!.shape).toEqual(int32().shape);
  });

  test("required decides optional; mixin members come first", () => {
    const f = fields("Widget");
    expect(Object.keys(f).slice(0, 2)).toEqual(["id", "name"]);
    expect(f.id!.meta.optional).toBeUndefined();
    expect(f.id!.meta.description).toBe("the id");
    expect(f.name!.meta.optional).toBeUndefined();
    expect(f.count!.meta.optional).toBe(true);
  });

  test("member traits become meta", () => {
    const f = fields("Widget");
    expect(f.name!.meta).toMatchObject({
      minLength: 1,
      maxLength: 20,
      pattern: "^[a-z]+$",
      jsonName: "Name",
    });
    expect(f.count!.meta).toMatchObject({ default: 3, minimum: 0, maximum: 10 });
    expect(f.ratio!.meta).toMatchObject({
      deprecated: true,
      deprecatedReason: "use size",
      smithy: { deprecatedSince: "2" },
    });
    expect(conv.defs.Widget!.meta.description).toBe("a widget");
  });

  test("unmapped traits are kept verbatim", () => {
    const f = fields("Widget");
    expect(f.secret!.meta.smithy).toEqual({ traits: { [`${P}sensitive`]: {} } });
    expect(f.born!.meta.smithy).toEqual({ traits: { [`${P}timestampFormat`]: "epoch-seconds" } });
    expect(conv.defs.Widget!.meta.smithy).toEqual({ id: "ex#Widget" });
  });

  test("references become refs; recursion stays a ref", () => {
    const f = fields("Widget");
    expect(f.color!.shape).toEqual(types.ref("Color"));
    expect(f.friends!.shape).toEqual(types.ref("Widget"));
  });

  test("enum, intEnum and the 1.0 enum trait", () => {
    expect(conv.defs.Color!.shape).toEqual(types.enum(["red", "BLUE"]));
    expect(conv.defs.Color!.meta.smithy).toMatchObject({
      enumMembers: { RED: { value: "red" }, BLUE: { value: "BLUE", description: "cool" } },
    });
    expect(conv.defs.Level!.shape.kind).toBe("union");
    expect(
      (conv.defs.Level!.shape as unknown as { variants: { shape: unknown }[] }).variants.map(
        (v) => v.shape,
      ),
    ).toEqual([types.literal(1), types.literal(2)]);
    expect(conv.defs.LegacyEnum!.shape).toEqual(types.enum(["a", "b"]));
  });

  test("list, sparse list and map", () => {
    const tags = conv.defs.Tags!;
    expect(tags.shape.kind).toBe("array");
    expect(tags.meta.smithy).toEqual({ id: "ex#Tags" });
    expect((tags.shape as { element: { meta: unknown } }).element.meta).toEqual({ nullable: true });
    expect(conv.defs.Attrs!.shape).toEqual(types.map(t(types.string), t(types.ref("Widget"))));
  });

  test("a union is tagged: each variant is a single-field object", () => {
    expect(conv.defs.Shape!.shape).toEqual(
      types.union([
        t(types.object({ circle: t(types.ref("Widget")) })),
        t(types.object({ none: t(types.object({})) })),
      ]),
    );
  });

  test("length on a shape uses the shape's kind", () => {
    expect(conv.defs["ex.Name"]!.meta.minLength).toBe(2);
  });

  test("a dangling target is reported and still a ref", () => {
    const c = fromSmithy({
      shapes: { "a#S": { type: "structure", members: { x: { target: "a#Missing" } } } },
    });
    expect(c.fields("a#S").x!.shape).toEqual(types.ref("Missing"));
    expect(c.diagnostics.map((d) => d.at)).toContain("a#S$x");
  });
});
