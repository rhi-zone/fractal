import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { int32, int64, uint8 } from "./kinds/int-widths.ts"
import { float32 } from "./kinds/float-widths.ts"
import { uuid } from "./kinds/semantic-strings.ts"
import { toCSharpNewtonsoft } from "./csharp-newtonsoft.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toCSharpNewtonsoft(t(types.boolean), "X")).toContain("using X = bool;")
  })

  test("string", () => {
    expect(toCSharpNewtonsoft(t(types.string), "X")).toContain("using X = string;")
  })

  test("number defaults to double", () => {
    expect(toCSharpNewtonsoft(t(types.number), "X")).toContain("using X = double;")
  })

  test("integer widths", () => {
    expect(toCSharpNewtonsoft(int32(), "X")).toContain("using X = int;")
    expect(toCSharpNewtonsoft(int64(), "X")).toContain("using X = long;")
    expect(toCSharpNewtonsoft(uint8(), "X")).toContain("using X = byte;")
    expect(toCSharpNewtonsoft(float32(), "X")).toContain("using X = float;")
  })

  test("null", () => {
    expect(toCSharpNewtonsoft(t(types.null), "X")).toContain("using X = object?;")
  })

  test("unknown", () => {
    expect(toCSharpNewtonsoft(t(types.unknown), "X")).toContain("using X = object;")
  })

  test("uuid gets Guid + System using", () => {
    const out = toCSharpNewtonsoft(uuid(), "Id")
    expect(out).toContain("using Id = Guid;")
    expect(out).toContain("using System;")
  })
})

describe("records", () => {
  test("simple object -> record with JsonProperty", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.integer) }))
    const out = toCSharpNewtonsoft(ref, "Person")
    expect(out).toContain("public record Person")
    expect(out).toContain('[JsonProperty("name")]')
    expect(out).toContain("public string Name { get; init; }")
    expect(out).toContain('[JsonProperty("age")]')
    expect(out).toContain("public int Age { get; init; }")
    expect(out).toContain("using Newtonsoft.Json;")
  })

  test("optional field becomes nullable with NullValueHandling.Ignore", () => {
    const ref = t(types.object({ nickname: t(types.string, { optional: true }) }))
    const out = toCSharpNewtonsoft(ref, "Person")
    expect(out).toContain("public string? Nickname { get; init; }")
    expect(out).toContain('[JsonProperty("nickname", NullValueHandling = NullValueHandling.Ignore)]')
  })

  test("nullable meta becomes nullable", () => {
    const ref = t(types.object({ bio: t(types.string, { nullable: true }) }))
    const out = toCSharpNewtonsoft(ref, "Person")
    expect(out).toContain("public string? Bio { get; init; }")
  })

  test("snake_case field name gets PascalCase property + JsonProperty", () => {
    const ref = t(types.object({ first_name: t(types.string) }))
    const out = toCSharpNewtonsoft(ref, "Person")
    expect(out).toContain('[JsonProperty("first_name")]')
    expect(out).toContain("public string FirstName { get; init; }")
  })

  test("nested object field spawns its own named record", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const out = toCSharpNewtonsoft(ref, "Person")
    expect(out).toContain("public record Person")
    expect(out).toContain("public record PersonAddress")
    expect(out).toContain("public PersonAddress Address { get; init; }")
    expect(out).toContain("public string City { get; init; }")
  })

  test("field with meta.default gets DefaultValue + DefaultValueHandling.Populate", () => {
    const ref = t(types.object({ count: t(types.integer, { default: 0 }) }))
    const out = toCSharpNewtonsoft(ref, "Widget")
    expect(out).toContain("[DefaultValue(0)]")
    expect(out).toContain('[JsonProperty("count", DefaultValueHandling = DefaultValueHandling.Populate)]')
    expect(out).toContain("using System.ComponentModel;")
  })
})

describe("collections", () => {
  test("array of primitive -> List<T>", () => {
    const ref = t(types.array(t(types.string)))
    expect(toCSharpNewtonsoft(ref, "Names")).toContain("using Names = List<string>;")
  })

  test("array of object -> List<NamedRecord>, nested record still named after suggestion", () => {
    const ref = t(types.array(t(types.object({ id: t(types.string) }))))
    const out = toCSharpNewtonsoft(ref, "Items")
    expect(out).toContain("using Items = List<ItemsItem>;")
    expect(out).toContain("public record ItemsItem")
  })

  test("map -> Dictionary<K, V>", () => {
    const ref = t(types.map(t(types.string), t(types.integer)))
    expect(toCSharpNewtonsoft(ref, "Counts")).toContain("using Counts = Dictionary<string, int>;")
  })

  test("tuple -> value tuple", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toCSharpNewtonsoft(ref, "Pair")).toContain("using Pair = (string, int);")
  })
})

describe("enum", () => {
  test("string enum with StringEnumConverter", () => {
    const ref = t(types.enum(["small", "medium", "large"]))
    const out = toCSharpNewtonsoft(ref, "Size")
    expect(out).toContain("[JsonConverter(typeof(StringEnumConverter))]")
    expect(out).toContain("public enum Size")
    expect(out).toContain("Small")
    expect(out).toContain("Medium")
    expect(out).toContain("Large")
    expect(out).toContain("using Newtonsoft.Json.Converters;")
  })
})

describe("discriminated unions", () => {
  test("emits abstract base + custom JsonConverter switching on discriminator", () => {
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
    const out = toCSharpNewtonsoft(ref, "Animal")

    expect(out).toContain("[JsonConverter(typeof(AnimalJsonConverter))]")
    expect(out).toContain("public abstract record Animal;")
    expect(out).toContain("public record Cat : Animal")
    expect(out).toContain("public record Dog : Animal")
    // discriminator field itself is not re-declared as a property — read via
    // the JObject-based converter, not a regular field.
    expect(out).not.toContain("public string Kind { get; init; }")
    expect(out).toContain("public int Lives { get; init; }")
    expect(out).toContain("public bool GoodBoy { get; init; }")

    expect(out).toContain("public class AnimalJsonConverter : JsonConverter<Animal>")
    expect(out).toContain('var discriminator = jObject["kind"]?.Value<string>();')
    expect(out).toContain('"cat" => jObject.ToObject<Cat>(serializer),')
    expect(out).toContain('"dog" => jObject.ToObject<Dog>(serializer),')
    expect(out).toContain("using Newtonsoft.Json.Linq;")
  })

  test("plain union (no discriminator) tries each variant in order", () => {
    const a = t(types.object({ value: t(types.string) }), { typeName: "TextValue" })
    const b = t(types.object({ value: t(types.integer) }), { typeName: "NumberValue" })
    const ref = t(types.union([a, b]))
    const out = toCSharpNewtonsoft(ref, "Value")

    expect(out).toContain("[JsonConverter(typeof(ValueJsonConverter))]")
    expect(out).toContain("public record TextValue : Value")
    expect(out).toContain("public record NumberValue : Value")
    expect(out).toContain("try { return jObject.ToObject<TextValue>(serializer); } catch (JsonException) { }")
    expect(out).toContain("try { return jObject.ToObject<NumberValue>(serializer); } catch (JsonException) { }")
  })
})

describe("namespace", () => {
  test("wraps declarations in namespace block", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const out = toCSharpNewtonsoft(ref, "Widget", { namespace: "Acme.Models" })
    expect(out).toContain("namespace Acme.Models")
    expect(out).toContain("    public record Widget")
  })
})
