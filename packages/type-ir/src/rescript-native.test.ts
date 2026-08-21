import { describe, expect, test } from "bun:test";
import { t, types } from "./index.ts";
import { toReScript, toReScriptType } from "./rescript-native.ts";

describe("primitive types", () => {
  test("boolean", () => {
    expect(toReScriptType(t(types.boolean))).toBe("bool");
  });

  test("number -> float", () => {
    expect(toReScriptType(t(types.number))).toBe("float");
  });

  test("integer -> int", () => {
    expect(toReScriptType(t(types.integer))).toBe("int");
  });

  test("string", () => {
    expect(toReScriptType(t(types.string))).toBe("string");
  });

  test("null -> unit", () => {
    expect(toReScriptType(t(types.null))).toBe("unit");
  });

  test("void -> unit", () => {
    expect(toReScriptType(t(types.void))).toBe("unit");
  });

  test("unknown -> Js.Json.t", () => {
    expect(toReScriptType(t(types.unknown))).toBe("Js.Json.t");
  });

  test("never degrades to Js.Json.t (no inline bottom-type construct)", () => {
    expect(toReScriptType(t(types.never))).toBe("Js.Json.t");
  });
});

describe("mixed fallback", () => {
  test("unrecognized kind falls back to Js.Json.t", () => {
    const ref = { shape: { kind: "bogus" } as never, meta: {} };
    expect(toReScriptType(ref)).toBe("Js.Json.t");
  });
});

describe("containers", () => {
  test("array -> array<T>", () => {
    expect(toReScriptType(t(types.array(t(types.string))))).toBe("array<string>");
  });

  test("2-tuple -> native tuple", () => {
    expect(toReScriptType(t(types.tuple([t(types.string), t(types.number)])))).toBe(
      "(string, float)",
    );
  });

  test("4-tuple stays a native tuple (arbitrary arity, unlike Elm's 3-max)", () => {
    const ref = t(
      types.tuple([t(types.string), t(types.number), t(types.boolean), t(types.string)]),
    );
    expect(toReScriptType(ref)).toBe("(string, float, bool, string)");
  });

  test("string-keyed map -> Js.Dict.t<V>", () => {
    expect(toReScriptType(t(types.map(t(types.string), t(types.number))))).toBe("Js.Dict.t<float>");
  });

  test("non-string-keyed map degrades to an array of key/value tuples", () => {
    const ref = t(types.map(t(types.integer), t(types.string)));
    expect(toReScriptType(ref)).toBe("array<(int, string)>");
  });
});

describe("optional and nullable", () => {
  test("nullable wraps in option<T>", () => {
    expect(toReScriptType(t(types.string, { nullable: true }))).toBe("option<string>");
  });

  test("optional object field wraps in option<T> (hoisted record)", () => {
    const ref = t(types.object({ age: t(types.number, { optional: true }) }));
    const out = toReScript(ref, "User");
    expect(out).toContain("age: option<float>");
  });
});

describe("records", () => {
  test("required + optional fields", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.number, { optional: true }) }));
    const out = toReScript(ref, "User");
    expect(out).toBe(["type user = {", "  id: string,", "  age: option<float>,", "}"].join("\n"));
  });

  test("field name that isn't a valid ReScript label gets @as", () => {
    const ref = t(types.object({ "user-id": t(types.string) }));
    const out = toReScript(ref, "Account");
    expect(out).toContain('@as("user-id") user_id: string');
  });

  test("field names untouched when already valid identifiers", () => {
    const ref = t(types.object({ userId: t(types.string) }));
    const out = toReScript(ref, "Account");
    expect(out).toContain("userId: string");
    expect(out).not.toContain("@as");
  });

  test("type name camelCased from a snake/kebab hint (ReScript type identifiers must start lowercase)", () => {
    const ref = t(types.object({ id: t(types.string) }));
    const out = toReScript(ref, "account_summary");
    expect(out).toContain("type accountSummary = {");
  });

  test("fields-less object degrades to unit, not an invalid empty record", () => {
    const ref = t(types.object({}));
    expect(toReScript(ref, "Empty")).toBe("type empty = unit");
  });

  test("nested object field is hoisted to its own named record", () => {
    const ref = t(types.object({ address: t(types.object({ city: t(types.string) })) }));
    const out = toReScript(ref, "Person");
    expect(out).toContain("type person = {");
    expect(out).toContain("address: personAddress,");
    expect(out).toContain("type personAddress = {");
    expect(out).toContain("city: string,");
  });
});

describe("enum -> nominal variant", () => {
  test("no-payload constructors, one per member", () => {
    const ref = t(types.enum(["active", "inactive"]));
    const out = toReScript(ref, "Status");
    expect(out).toBe(["type status =", "  | Active", "  | Inactive"].join("\n"));
  });

  test("member that doesn't round-trip through PascalCase gets @as on the constructor", () => {
    const ref = t(types.enum(["in-progress"]));
    const out = toReScript(ref, "Status");
    expect(out).toContain('@as("in-progress") InProgress');
  });
});

describe("string-literal unions render like enums", () => {
  test("union of string literals", () => {
    const ref = t(types.union([t(types.literal("a")), t(types.literal("b"))]));
    const out = toReScript(ref, "Letter");
    expect(out).toBe(["type letter =", "  | A", "  | B"].join("\n"));
  });
});

describe("discriminated union -> tagged variant with inline-record payloads", () => {
  test("one constructor per variant, named from the discriminant literal", () => {
    const ref = t(
      types.union([
        t(types.object({ type: t(types.literal("circle")), radius: t(types.number) })),
        t(types.object({ type: t(types.literal("square")), side: t(types.number) })),
      ]),
      { discriminator: "type" },
    );
    const out = toReScript(ref, "Shape");
    expect(out).toContain("type shape =");
    expect(out).toContain("Circle({radius: float})");
    expect(out).toContain("Square({side: float})");
    // The discriminator field itself is dropped from the payload — it's
    // recovered by pattern-matching the constructor, not carried as data.
    expect(out).not.toContain("type:");
  });

  test("payload-less variant when the tag is the only field", () => {
    const ref = t(types.union([t(types.object({ type: t(types.literal("empty")) }))]), {
      discriminator: "type",
    });
    const out = toReScript(ref, "Shape");
    expect(out).toContain("| Empty");
    expect(out).not.toContain("Empty(");
  });
});

describe("untagged union -> positional variant fallback", () => {
  test("one Variant1/Variant2/... constructor per member", () => {
    const ref = t(types.union([t(types.string), t(types.number)]));
    const out = toReScript(ref, "StringOrNumber");
    expect(out).toContain("type stringOrNumber =");
    expect(out).toContain("Variant1(string)");
    expect(out).toContain("Variant2(float)");
  });
});

describe("recursive types via ref", () => {
  test("ref renders as a camelCased type reference (ReScript type identifiers must start lowercase)", () => {
    expect(toReScriptType(t(types.ref("tree_node")))).toBe("treeNode");
  });

  test("self-referential field renders through array<T>/ref without infinite recursion", () => {
    const ref = t(
      types.object({ value: t(types.integer), children: t(types.array(t(types.ref("Tree")))) }),
    );
    const out = toReScript(ref, "Tree");
    expect(out).toContain("children: array<tree>");
  });
});

describe("doc comments and deprecation", () => {
  test("meta.description renders as a doc comment", () => {
    const ref = t(types.string, { description: "A display name" });
    expect(toReScript(ref, "DisplayName")).toBe("/** A display name */\ntype displayName = string");
  });

  test("meta.deprecated: true renders a @deprecated attribute", () => {
    const ref = t(types.string, { deprecated: true });
    expect(toReScript(ref, "Old")).toBe("@deprecated\ntype old = string");
  });

  test("meta.deprecated with a reason string carries the reason", () => {
    const ref = t(types.string, { deprecated: "use New instead" });
    expect(toReScript(ref, "Old")).toContain('@deprecated("use New instead")');
  });
});

describe("toReScript with a default name", () => {
  test("defaults to Value when no name is given", () => {
    expect(toReScript(t(types.string))).toBe("type value = string");
  });
});

describe("toReScriptType standalone", () => {
  test("an object ref itself hoists and returns just the reference name, no declaration text", () => {
    const ref = t(types.object({ tag: t(types.enum(["a", "b"])) }));
    expect(toReScriptType(ref)).toBe("anonymous");
  });
});
