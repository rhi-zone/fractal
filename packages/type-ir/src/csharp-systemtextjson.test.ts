import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { int32, int64, uint8 } from "./kinds/int-widths.ts"
import { float32 } from "./kinds/float-widths.ts"
import { toCSharp } from "./csharp-systemtextjson.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toCSharp(t(types.boolean), "X")).toContain("using X = bool;")
  })

  test("string", () => {
    expect(toCSharp(t(types.string), "X")).toContain("using X = string;")
  })

  test("number defaults to double", () => {
    expect(toCSharp(t(types.number), "X")).toContain("using X = double;")
  })

  test("integer widths", () => {
    expect(toCSharp(int32(), "X")).toContain("using X = int;")
    expect(toCSharp(int64(), "X")).toContain("using X = long;")
    expect(toCSharp(uint8(), "X")).toContain("using X = byte;")
    expect(toCSharp(float32(), "X")).toContain("using X = float;")
  })

  test("null", () => {
    expect(toCSharp(t(types.null), "X")).toContain("using X = object?;")
  })

  test("unknown", () => {
    expect(toCSharp(t(types.unknown), "X")).toContain("using X = object;")
  })
})

describe("records", () => {
  test("simple object -> record with JsonPropertyName", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.integer) }))
    const out = toCSharp(ref, "Person")
    expect(out).toContain("public record Person")
    expect(out).toContain('[JsonPropertyName("name")]')
    expect(out).toContain("public string Name { get; init; }")
    expect(out).toContain('[JsonPropertyName("age")]')
    expect(out).toContain("public int Age { get; init; }")
    expect(out).toContain("using System.Text.Json.Serialization;")
  })

  test("optional field becomes nullable", () => {
    const ref = t(types.object({ nickname: t(types.string, { optional: true }) }))
    const out = toCSharp(ref, "Person")
    expect(out).toContain("public string? Nickname { get; init; }")
  })

  test("nullable meta becomes nullable", () => {
    const ref = t(types.object({ bio: t(types.string, { nullable: true }) }))
    const out = toCSharp(ref, "Person")
    expect(out).toContain("public string? Bio { get; init; }")
  })

  test("snake_case field name gets PascalCase property + JsonPropertyName", () => {
    const ref = t(types.object({ first_name: t(types.string) }))
    const out = toCSharp(ref, "Person")
    expect(out).toContain('[JsonPropertyName("first_name")]')
    expect(out).toContain("public string FirstName { get; init; }")
  })

  test("nested object field spawns its own named record", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const out = toCSharp(ref, "Person")
    expect(out).toContain("public record Person")
    expect(out).toContain("public record PersonAddress")
    expect(out).toContain("public PersonAddress Address { get; init; }")
    expect(out).toContain("public string City { get; init; }")
  })

  test("description renders as an XML <summary> doc comment", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "A person record." })
    const out = toCSharp(ref, "Person")
    expect(out).toContain("/// <summary>\n/// A person record.\n/// </summary>\npublic record Person")
  })

  test("deprecated true renders a bare [Obsolete] attribute", () => {
    const ref = t(types.object({ id: t(types.string) }), { deprecated: true })
    const out = toCSharp(ref, "Person")
    expect(out).toContain("[Obsolete]\npublic record Person")
  })

  test("deprecated string message renders [Obsolete(\"...\")]", () => {
    const ref = t(types.object({ id: t(types.string) }), { deprecated: "Use NewPerson instead." })
    const out = toCSharp(ref, "Person")
    expect(out).toContain('[Obsolete("Use NewPerson instead.")]\npublic record Person')
  })
})

describe("collections", () => {
  test("array of primitive -> List<T>", () => {
    const ref = t(types.array(t(types.string)))
    expect(toCSharp(ref, "Names")).toContain("using Names = List<string>;")
  })

  test("array of object -> List<NamedRecord>, nested record still named after suggestion", () => {
    const ref = t(types.array(t(types.object({ id: t(types.string) }))))
    const out = toCSharp(ref, "Items")
    expect(out).toContain("using Items = List<ItemsItem>;")
    expect(out).toContain("public record ItemsItem")
  })

  test("map -> Dictionary<K, V>", () => {
    const ref = t(types.map(t(types.string), t(types.integer)))
    expect(toCSharp(ref, "Counts")).toContain("using Counts = Dictionary<string, int>;")
  })

  test("tuple -> value tuple", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toCSharp(ref, "Pair")).toContain("using Pair = (string, int);")
  })
})

describe("enum", () => {
  test("string enum with JsonConverter", () => {
    const ref = t(types.enum(["small", "medium", "large"]))
    const out = toCSharp(ref, "Size")
    expect(out).toContain("[JsonConverter(typeof(JsonStringEnumConverter))]")
    expect(out).toContain("public enum Size")
    expect(out).toContain("Small")
    expect(out).toContain("Medium")
    expect(out).toContain("Large")
  })

  test("description and deprecated render doc comment + [Obsolete] above the enum", () => {
    const ref = t(types.enum(["small", "large"]), { description: "A size tier.", deprecated: true })
    const out = toCSharp(ref, "Size")
    expect(out).toContain("/// <summary>\n/// A size tier.\n/// </summary>\n[Obsolete]\n[JsonConverter(typeof(JsonStringEnumConverter))]\npublic enum Size")
  })
})

describe("discriminated unions", () => {
  test("emits JsonPolymorphic + JsonDerivedType hierarchy", () => {
    const cat = t(
      types.object({
        kind: t(types.literal("cat")),
        lives: t(types.integer),
      }),
    )
    const dog = t(
      types.object({
        kind: t(types.literal("dog")),
        goodBoy: t(types.boolean),
      }),
    )
    const ref = t(types.union([cat, dog]), { discriminator: "kind" })
    const out = toCSharp(ref, "Animal")

    expect(out).toContain('[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]')
    expect(out).toContain('[JsonDerivedType(typeof(Cat), "cat")]')
    expect(out).toContain('[JsonDerivedType(typeof(Dog), "dog")]')
    expect(out).toContain("public abstract record Animal;")
    expect(out).toContain("public record Cat : Animal")
    expect(out).toContain("public record Dog : Animal")
    // discriminator field itself is not re-declared as a property — STJ
    // reads/writes it via JsonDerivedType, not a regular field.
    expect(out).not.toContain("public string Kind { get; init; }")
    expect(out).toContain("public int Lives { get; init; }")
    expect(out).toContain("public bool GoodBoy { get; init; }")
  })

  test("plain union (no discriminator) still gets a polymorphic hierarchy", () => {
    const a = t(types.object({ value: t(types.string) }), { typeName: "TextValue" })
    const b = t(types.object({ value: t(types.integer) }), { typeName: "NumberValue" })
    const ref = t(types.union([a, b]))
    const out = toCSharp(ref, "Value")

    expect(out).toContain("[JsonPolymorphic]")
    expect(out).toContain("[JsonDerivedType(typeof(TextValue), nameof(TextValue))]")
    expect(out).toContain("[JsonDerivedType(typeof(NumberValue), nameof(NumberValue))]")
    expect(out).toContain("public record TextValue : Value")
    expect(out).toContain("public record NumberValue : Value")
  })
})

describe("namespace", () => {
  test("wraps declarations in namespace block", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const out = toCSharp(ref, "Widget", { namespace: "Acme.Models" })
    expect(out).toContain("namespace Acme.Models")
    expect(out).toContain("    public record Widget")
  })
})
