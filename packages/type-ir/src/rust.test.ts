import { describe, expect, test } from "bun:test"
import { t, types, withMeta } from "./index.ts"
import { bytes, int32, int64, uint32, uint64 } from "./kinds/common.ts"
import { toRust, toRustType } from "./rust.ts"

describe("primitives", () => {
  test("boolean -> bool", () => {
    expect(toRustType(t(types.boolean))).toBe("bool")
  })

  test("number -> f64", () => {
    expect(toRustType(t(types.number))).toBe("f64")
  })

  test("integer (bare) -> i64", () => {
    expect(toRustType(t(types.integer))).toBe("i64")
  })

  test("int32 -> i32", () => {
    expect(toRustType(int32())).toBe("i32")
  })

  test("int64 -> i64", () => {
    expect(toRustType(int64())).toBe("i64")
  })

  test("uint32 -> u32", () => {
    expect(toRustType(uint32())).toBe("u32")
  })

  test("uint64 -> u64", () => {
    expect(toRustType(uint64())).toBe("u64")
  })

  test("string -> String", () => {
    expect(toRustType(t(types.string))).toBe("String")
  })

  test("null -> ()", () => {
    expect(toRustType(t(types.null))).toBe("()")
  })

  test("unknown -> serde_json::Value", () => {
    expect(toRustType(t(types.unknown))).toBe("serde_json::Value")
  })

  test("bytes -> Vec<u8>", () => {
    expect(toRustType(bytes())).toBe("Vec<u8>")
  })
})

describe("containers", () => {
  test("array -> Vec<T>", () => {
    expect(toRustType(t(types.array(t(types.string))))).toBe("Vec<String>")
  })

  test("map with string key -> HashMap<String, V>", () => {
    expect(toRustType(t(types.map(t(types.string), t(types.number))))).toBe("HashMap<String, f64>")
  })

  test("map with meta.ordered -> BTreeMap<K, V>", () => {
    const ref = withMeta(t(types.map(t(types.string), t(types.number))), { ordered: true })
    expect(toRustType(ref)).toBe("BTreeMap<String, f64>")
  })

  test("tuple -> (T1, T2, ...)", () => {
    expect(toRustType(t(types.tuple([t(types.string), t(types.number)])))).toBe("(String, f64)")
  })

  test("nullable -> Option<T>", () => {
    const ref = withMeta(t(types.string), { nullable: true })
    expect(toRustType(ref)).toBe("Option<String>")
  })
})

describe("structs", () => {
  test("object -> derived struct with pub fields", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.integer) }))
    const rust = toRust(ref, "Person")
    expect(rust).toBe(
      [
        "#[derive(Debug, Clone, Serialize, Deserialize)]",
        "pub struct Person {",
        "    pub name: String,",
        "    pub age: i64,",
        "}",
      ].join("\n"),
    )
  })

  test("camelCase field -> snake_case + serde rename", () => {
    const ref = t(types.object({ firstName: t(types.string) }))
    const rust = toRust(ref, "Person")
    expect(rust).toContain('#[serde(rename = "firstName")]')
    expect(rust).toContain("pub first_name: String,")
  })

  test("optional field -> Option<T> + skip_serializing_if", () => {
    const ref = t(types.object({ nickname: withMeta(t(types.string), { optional: true }) }))
    const rust = toRust(ref, "Person")
    expect(rust).toContain('#[serde(skip_serializing_if = "Option::is_none")]')
    expect(rust).toContain("pub nickname: Option<String>,")
  })

  test("nested object field hoists a sibling struct", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const rust = toRust(ref, "Person")
    expect(rust).toContain("pub struct Address {")
    expect(rust).toContain("pub city: String,")
    expect(rust).toContain("pub address: Address,")
    // hoisted decl comes before the main struct
    expect(rust.indexOf("pub struct Address {")).toBeLessThan(rust.indexOf("pub struct Person {"))
  })

  test("description -> doc comment", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { description: "A person." })
    expect(toRust(ref, "Person")).toContain("/// A person.")
  })
})

describe("enums", () => {
  test("string enum -> Rust enum with PascalCase variants", () => {
    const ref = t(types.enum(["active", "inactive"]))
    const rust = toRust(ref, "Status")
    expect(rust).toBe(
      [
        "#[derive(Debug, Clone, Serialize, Deserialize)]",
        "pub enum Status {",
        '    #[serde(rename = "active")]',
        "    Active,",
        '    #[serde(rename = "inactive")]',
        "    Inactive,",
        "}",
      ].join("\n"),
    )
  })

  test("nested enum field hoists a sibling enum", () => {
    const ref = t(types.object({ status: t(types.enum(["active", "inactive"])) }))
    const rust = toRust(ref, "Person")
    expect(rust).toContain("pub enum Status {")
    expect(rust).toContain("pub status: Status,")
  })
})

describe("discriminated unions", () => {
  test("union with meta.discriminator -> internally-tagged enum", () => {
    const dog = t(types.object({ kind: t(types.literal("dog")), bark: t(types.boolean) }))
    const cat = t(types.object({ kind: t(types.literal("cat")), meow: t(types.boolean) }))
    const ref = withMeta(t(types.union([dog, cat])), { discriminator: "kind" })
    const rust = toRust(ref, "Pet")

    expect(rust).toContain('#[serde(tag = "kind")]')
    expect(rust).toContain("pub enum Pet {")
    expect(rust).toContain("Dog {")
    expect(rust).toContain("bark: bool,")
    expect(rust).toContain("Cat {")
    expect(rust).toContain("meow: bool,")
    // discriminator field itself is not rendered as a struct field
    expect(rust).not.toContain("kind:")
  })

  test("union without discriminator -> untagged enum", () => {
    const ref = t(types.union([t(types.string), t(types.number)]))
    const rust = toRust(ref, "StringOrNumber")
    expect(rust).toContain("#[serde(untagged)]")
    expect(rust).toContain("pub enum StringOrNumber {")
    expect(rust).toContain("Variant0(String),")
    expect(rust).toContain("Variant1(f64),")
  })
})

describe("toRust without a name", () => {
  test("returns just the inline type expression", () => {
    expect(toRust(t(types.string))).toBe("String")
    expect(toRust(t(types.array(t(types.integer))))).toBe("Vec<i64>")
  })
})

describe("toRust with a name for non-struct/enum kinds", () => {
  test("emits a pub type alias", () => {
    expect(toRust(t(types.string), "Name")).toBe("pub type Name = String;")
  })
})
