import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { int32, int64, uint8 } from "./kinds/int-widths.ts"
import { float32 } from "./kinds/float-widths.ts"
import { toCSharpServiceStack } from "./csharp-servicestack.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toCSharpServiceStack(t(types.boolean), "X")).toContain("using X = bool;")
  })

  test("string", () => {
    expect(toCSharpServiceStack(t(types.string), "X")).toContain("using X = string;")
  })

  test("number defaults to double", () => {
    expect(toCSharpServiceStack(t(types.number), "X")).toContain("using X = double;")
  })

  test("integer widths", () => {
    expect(toCSharpServiceStack(int32(), "X")).toContain("using X = int;")
    expect(toCSharpServiceStack(int64(), "X")).toContain("using X = long;")
    expect(toCSharpServiceStack(uint8(), "X")).toContain("using X = byte;")
    expect(toCSharpServiceStack(float32(), "X")).toContain("using X = float;")
  })

  test("null", () => {
    expect(toCSharpServiceStack(t(types.null), "X")).toContain("using X = object?;")
  })

  test("unknown", () => {
    expect(toCSharpServiceStack(t(types.unknown), "X")).toContain("using X = object;")
  })
})

describe("records", () => {
  test("simple object -> [DataContract] record with [DataMember] properties", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.integer) }))
    const out = toCSharpServiceStack(ref, "Person")
    expect(out).toContain("[DataContract]\npublic record Person")
    expect(out).toContain('[DataMember(Name = "name", IsRequired = true)]')
    expect(out).toContain("public string Name { get; init; }")
    expect(out).toContain('[DataMember(Name = "age", IsRequired = true)]')
    expect(out).toContain("public int Age { get; init; }")
    expect(out).toContain("using System.Runtime.Serialization;")
  })

  test("optional field becomes nullable and drops IsRequired", () => {
    const ref = t(types.object({ nickname: t(types.string, { optional: true }) }))
    const out = toCSharpServiceStack(ref, "Person")
    expect(out).toContain("public string? Nickname { get; init; }")
    expect(out).toContain('[DataMember(Name = "nickname")]')
    expect(out).not.toContain('[DataMember(Name = "nickname", IsRequired = true)]')
  })

  test("nullable meta becomes nullable", () => {
    const ref = t(types.object({ bio: t(types.string, { nullable: true }) }))
    const out = toCSharpServiceStack(ref, "Person")
    expect(out).toContain("public string? Bio { get; init; }")
  })

  test("snake_case field name gets PascalCase property + DataMember Name", () => {
    const ref = t(types.object({ first_name: t(types.string) }))
    const out = toCSharpServiceStack(ref, "Person")
    expect(out).toContain('[DataMember(Name = "first_name", IsRequired = true)]')
    expect(out).toContain("public string FirstName { get; init; }")
  })

  test("every property gets [DataMember] even with a clean name (opt-in contract)", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const out = toCSharpServiceStack(ref, "Widget")
    expect(out).toContain('[DataMember(Name = "id", IsRequired = true)]')
  })

  test("nested object field spawns its own named [DataContract] record", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const out = toCSharpServiceStack(ref, "Person")
    expect(out).toContain("[DataContract]\npublic record Person")
    expect(out).toContain("[DataContract]\npublic record PersonAddress")
    expect(out).toContain("public PersonAddress Address { get; init; }")
    expect(out).toContain("public string City { get; init; }")
  })

  test("description renders as an XML <summary> doc comment", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "A person record." })
    const out = toCSharpServiceStack(ref, "Person")
    expect(out).toContain("/// <summary>\n/// A person record.\n/// </summary>\n[DataContract]\npublic record Person")
  })

  test("deprecated true renders a bare [Obsolete] attribute", () => {
    const ref = t(types.object({ id: t(types.string) }), { deprecated: true })
    const out = toCSharpServiceStack(ref, "Person")
    expect(out).toContain("[Obsolete]\n[DataContract]\npublic record Person")
  })

  test("deprecated string message renders [Obsolete(\"...\")]", () => {
    const ref = t(types.object({ id: t(types.string) }), { deprecated: "Use NewPerson instead." })
    const out = toCSharpServiceStack(ref, "Person")
    expect(out).toContain('[Obsolete("Use NewPerson instead.")]\n[DataContract]\npublic record Person')
  })
})

describe("collections", () => {
  test("array of primitive -> List<T>", () => {
    const ref = t(types.array(t(types.string)))
    expect(toCSharpServiceStack(ref, "Names")).toContain("using Names = List<string>;")
  })

  test("array of object -> List<NamedRecord>, nested record still named after suggestion", () => {
    const ref = t(types.array(t(types.object({ id: t(types.string) }))))
    const out = toCSharpServiceStack(ref, "Items")
    expect(out).toContain("using Items = List<ItemsItem>;")
    expect(out).toContain("[DataContract]\npublic record ItemsItem")
  })

  test("map -> Dictionary<K, V>", () => {
    const ref = t(types.map(t(types.string), t(types.integer)))
    expect(toCSharpServiceStack(ref, "Counts")).toContain("using Counts = Dictionary<string, int>;")
  })

  test("tuple -> value tuple", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toCSharpServiceStack(ref, "Pair")).toContain("using Pair = (string, int);")
  })
})

describe("enum", () => {
  test("plain enum, no converter attribute needed", () => {
    const ref = t(types.enum(["small", "medium", "large"]))
    const out = toCSharpServiceStack(ref, "Size")
    expect(out).not.toContain("JsonConverter")
    expect(out).toContain("public enum Size")
    expect(out).toContain("Small")
    expect(out).toContain("Medium")
    expect(out).toContain("Large")
  })

  test("description and deprecated render doc comment + [Obsolete] above the enum", () => {
    const ref = t(types.enum(["small", "large"]), { description: "A size tier.", deprecated: true })
    const out = toCSharpServiceStack(ref, "Size")
    expect(out).toContain("/// <summary>\n/// A size tier.\n/// </summary>\n[Obsolete]\npublic enum Size")
  })
})

describe("discriminated unions", () => {
  test("emits [DataContract] hierarchy with a JsConfig wiring comment", () => {
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
    const out = toCSharpServiceStack(ref, "Animal")

    expect(out).toContain("// ServiceStack.Text has no declarative polymorphism attribute")
    expect(out).toContain('JsConfig.TypeAttr = "kind";')
    expect(out).toContain("JsConfig<Cat>.ExcludeTypeInfo = false;")
    expect(out).toContain("JsConfig<Dog>.ExcludeTypeInfo = false;")
    expect(out).toContain("[DataContract]\npublic abstract record Animal;")
    expect(out).toContain("[DataContract]\npublic record Cat : Animal")
    expect(out).toContain("[DataContract]\npublic record Dog : Animal")
    // discriminator field itself is not re-declared as a property.
    expect(out).not.toContain("public string Kind { get; init; }")
    expect(out).toContain("public int Lives { get; init; }")
    expect(out).toContain("public bool GoodBoy { get; init; }")
  })

  test("plain union (no discriminator) still gets a [DataContract] hierarchy", () => {
    const a = t(types.object({ value: t(types.string) }), { typeName: "TextValue" })
    const b = t(types.object({ value: t(types.integer) }), { typeName: "NumberValue" })
    const ref = t(types.union([a, b]))
    const out = toCSharpServiceStack(ref, "Value")

    expect(out).not.toContain("JsConfig.TypeAttr")
    expect(out).toContain("[DataContract]\npublic record TextValue : Value")
    expect(out).toContain("[DataContract]\npublic record NumberValue : Value")
  })

  test("scalar variant wraps in a [DataContract] single-property record", () => {
    const a = t(types.object({ code: t(types.string) }), { typeName: "Known" })
    const b = t(types.string)
    const ref = t(types.union([a, b]))
    const out = toCSharpServiceStack(ref, "MaybeKnown")
    expect(out).toContain('[DataContract]\npublic record MaybeKnownVariant2([property: DataMember(Name = "value")] string Value) : MaybeKnown;')
  })
})

describe("namespace", () => {
  test("wraps declarations in namespace block", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const out = toCSharpServiceStack(ref, "Widget", { namespace: "Acme.Models" })
    expect(out).toContain("namespace Acme.Models")
    expect(out).toContain("    public record Widget")
  })
})
