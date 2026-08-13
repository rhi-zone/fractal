import { describe, expect, test } from "bun:test";
import { t, types, withMeta } from "./index.ts";
import { toGleam, toGleamType } from "./gleam-native.ts";

describe("primitives", () => {
  test("boolean -> Bool", () => {
    expect(toGleamType(t(types.boolean))).toBe("Bool");
  });

  test("number -> Float", () => {
    expect(toGleamType(t(types.number))).toBe("Float");
  });

  test("integer -> Int", () => {
    expect(toGleamType(t(types.integer))).toBe("Int");
  });

  test("string -> String", () => {
    expect(toGleamType(t(types.string))).toBe("String");
  });

  test("null -> Nil", () => {
    expect(toGleamType(t(types.null))).toBe("Nil");
  });

  test("void -> Nil", () => {
    expect(toGleamType(t(types.void))).toBe("Nil");
  });

  test("unknown -> Dynamic", () => {
    expect(toGleamType(t(types.unknown))).toBe("Dynamic");
  });

  test("never -> Nil (lossy: Gleam has no bottom type)", () => {
    expect(toGleamType(t(types.never))).toBe("Nil");
  });
});

describe("containers", () => {
  test("array -> List(T)", () => {
    expect(toGleamType(t(types.array(t(types.string))))).toBe("List(String)");
  });

  test("map -> Dict(K, V)", () => {
    expect(toGleamType(t(types.map(t(types.string), t(types.number))))).toBe("Dict(String, Float)");
  });

  test("2-tuple -> #(a, b)", () => {
    expect(toGleamType(t(types.tuple([t(types.string), t(types.number)])))).toBe(
      "#(String, Float)",
    );
  });

  test("5-tuple has no arity cap", () => {
    const ref = t(types.tuple(Array.from({ length: 5 }, () => t(types.string))));
    expect(toGleamType(ref)).toBe("#(String, String, String, String, String)");
  });

  test("stream degrades to List(T)", () => {
    expect(toGleamType(t(types.stream(t(types.string))))).toBe("List(String)");
  });

  test("page degrades to List(T)", () => {
    expect(toGleamType(t(types.page(t(types.string), "cursor")))).toBe("List(String)");
  });
});

describe("optional and nullable both collapse to Option(T)", () => {
  test("optional -> Option(T)", () => {
    expect(toGleamType(t(types.string, { optional: true }))).toBe("Option(String)");
  });

  test("nullable -> Option(T)", () => {
    expect(toGleamType(t(types.string, { nullable: true }))).toBe("Option(String)");
  });

  test("both optional and nullable still single-wrap (not Option(Option(T)))", () => {
    expect(toGleamType(t(types.string, { optional: true, nullable: true }))).toBe("Option(String)");
  });
});

describe("literal degrades to base type", () => {
  test("string literal -> String", () => {
    expect(toGleamType(t(types.literal("active")))).toBe("String");
  });

  test("number literal -> Float", () => {
    expect(toGleamType(t(types.literal(1.5)))).toBe("Float");
  });

  test("integer-valued number literal -> Int", () => {
    expect(toGleamType(t(types.literal(42)))).toBe("Int");
  });

  test("boolean literal -> Bool", () => {
    expect(toGleamType(t(types.literal(true)))).toBe("Bool");
  });

  test("null literal -> Nil", () => {
    expect(toGleamType(t(types.literal(null)))).toBe("Nil");
  });
});

test("ref -> PascalCase target name", () => {
  expect(toGleamType(t(types.ref("user")))).toBe("User");
});

describe("instance", () => {
  test("renders bare className, ignoring declarationFile", () => {
    expect(toGleamType(t(types.instance("Widget", "/src/widget.ts")))).toBe("Widget");
  });
});

describe("function types", () => {
  test("fn(Params) -> Return with no parameter names", () => {
    const ref = t(types.function([{ name: "x", type: t(types.integer) }], t(types.string)));
    expect(toGleamType(ref)).toBe("fn(Int) -> String");
  });

  test("thisType prepends as a leading parameter", () => {
    const ref = t(
      types.function(
        [{ name: "x", type: t(types.integer) }],
        t(types.string),
        t(types.ref("Account")),
      ),
    );
    expect(toGleamType(ref)).toBe("fn(Account, Int) -> String");
  });

  test("method falls back to the function handler", () => {
    const ref = t(types.method([{ name: "x", type: t(types.integer) }], t(types.boolean)));
    expect(toGleamType(ref)).toBe("fn(Int) -> Bool");
  });
});

describe("records (object)", () => {
  test("object -> single-constructor custom type with labelled fields", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.integer) }));
    expect(toGleam(ref, "Person")).toBe(
      ["pub type Person {", "  Person(name: String, age: Int)", "}"].join("\n"),
    );
  });

  test("empty object -> nullary constructor", () => {
    expect(toGleam(t(types.object({})), "Empty")).toBe(
      ["pub type Empty {", "  Empty", "}"].join("\n"),
    );
  });

  test("camelCase field -> snake_case label", () => {
    const ref = t(types.object({ firstName: t(types.string) }));
    expect(toGleam(ref, "Person")).toContain("first_name: String");
  });

  test("keyword-colliding field name gets a trailing underscore", () => {
    const ref = t(types.object({ type: t(types.string) }));
    expect(toGleam(ref, "Wrapper")).toContain("type_: String");
  });

  test("optional field -> Option(T)", () => {
    const ref = t(types.object({ nickname: withMeta(t(types.string), { optional: true }) }));
    expect(toGleam(ref, "Person")).toContain("nickname: Option(String)");
  });

  test("nested object field hoists a sibling record declaration before the main one", () => {
    const ref = t(types.object({ address: t(types.object({ city: t(types.string) })) }));
    const gleam = toGleam(ref, "Person");
    expect(gleam).toContain("pub type PersonAddress {");
    expect(gleam).toContain("city: String");
    expect(gleam).toContain("address: PersonAddress");
    expect(gleam.indexOf("pub type PersonAddress {")).toBeLessThan(
      gleam.indexOf("pub type Person {"),
    );
  });

  test("description -> /// doc comment", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { description: "A person." });
    expect(toGleam(ref, "Person")).toContain("/// A person.");
  });

  test("deprecated: true -> @deprecated with a placeholder message", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { deprecated: true });
    expect(toGleam(ref, "Person")).toContain('@deprecated("Deprecated.")');
  });

  test("deprecated: string -> @deprecated with that message", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), {
      deprecated: "Use NewPerson instead.",
    });
    expect(toGleam(ref, "Person")).toContain('@deprecated("Use NewPerson instead.")');
  });
});

describe("enum", () => {
  test("closed string set -> custom type of nullary constructors", () => {
    const ref = t(types.enum(["active", "inactive"]));
    expect(toGleam(ref, "Status")).toBe(
      ["pub type Status {", "  Active", "  Inactive", "}"].join("\n"),
    );
  });

  test("nested enum field hoists a sibling declaration", () => {
    const ref = t(types.object({ status: t(types.enum(["active", "inactive"])) }));
    const gleam = toGleam(ref, "Person");
    expect(gleam).toContain("pub type PersonStatus {");
    expect(gleam).toContain("status: PersonStatus");
  });
});

describe("discriminated (tagged) unions", () => {
  test("union with meta.discriminator -> one labelled constructor per variant, tag field dropped", () => {
    const dog = t(types.object({ kind: t(types.literal("dog")), bark: t(types.boolean) }));
    const cat = t(types.object({ kind: t(types.literal("cat")), meow: t(types.boolean) }));
    const ref = withMeta(t(types.union([dog, cat])), { discriminator: "kind" });
    const gleam = toGleam(ref, "Pet");

    expect(gleam).toContain("pub type Pet {");
    expect(gleam).toContain("Dog(bark: Bool)");
    expect(gleam).toContain("Cat(meow: Bool)");
    expect(gleam).not.toContain("kind:");
  });
});

describe("untagged unions", () => {
  test("union without discriminator -> positionally-named constructors", () => {
    const ref = t(types.union([t(types.string), t(types.number)]));
    const gleam = toGleam(ref, "StringOrNumber");
    expect(gleam).toContain("pub type StringOrNumber {");
    expect(gleam).toContain("Variant0(String)");
    expect(gleam).toContain("Variant1(Float)");
  });
});

describe("interface", () => {
  test("renders a record of function-typed fields", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
      }),
    );
    const gleam = toGleam(ref, "Account");
    expect(gleam).toBe(
      ["pub type Account {", "  Account(deposit: fn(Float) -> Nil)", "}"].join("\n"),
    );
  });
});

describe("intersection", () => {
  test("degrades to the first member's own rendering (no merge, no anonymous record to splice into)", () => {
    const ref = t(types.intersection([t(types.string), t(types.integer)]));
    expect(toGleamType(ref)).toBe("String");
  });

  test("first member being an unnamed object still degrades to Dynamic (object has no naming context here)", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
      ]),
    );
    expect(toGleamType(ref)).toBe("Dynamic");
  });
});

describe("toGleam without a name", () => {
  test("returns just the inline type expression", () => {
    expect(toGleam(t(types.string))).toBe("String");
    expect(toGleam(t(types.array(t(types.integer))))).toBe("List(Int)");
  });
});

describe("toGleam with a name for non-record/enum/union kinds", () => {
  test("emits a pub type alias", () => {
    expect(toGleam(t(types.string), "Name")).toBe("pub type Name = String");
  });
});

describe("mixed fallback", () => {
  test("unrecognized kind falls back to Dynamic", () => {
    const ref = { shape: { kind: "bogus" } as never, meta: {} };
    expect(toGleamType(ref)).toBe("Dynamic");
  });
});
