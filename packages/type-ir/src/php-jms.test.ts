import { describe, expect, test } from "bun:test"
import { t, types, withMeta } from "./index.ts"
import { toJms, toJmsClass, toJmsDiscriminatedUnion, toJmsEnum, toPhpType } from "./php-jms.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toPhpType(t(types.boolean))).toEqual({ type: "bool" })
  })

  test("string", () => {
    expect(toPhpType(t(types.string))).toEqual({ type: "string" })
  })

  test("number maps to float", () => {
    expect(toPhpType(t(types.number))).toEqual({ type: "float" })
  })

  test("integer maps to int", () => {
    expect(toPhpType(t(types.integer))).toEqual({ type: "int" })
  })

  test("unknown maps to mixed", () => {
    expect(toPhpType(t(types.unknown))).toEqual({ type: "mixed" })
  })
})

describe("nullable", () => {
  test("single type uses ?T shorthand", () => {
    expect(toPhpType(t(types.string, { nullable: true }))).toEqual({ type: "?string" })
  })

  test("optional meta also renders as nullable", () => {
    expect(toPhpType(t(types.integer, { optional: true }))).toEqual({ type: "?int" })
  })
})

describe("arrays and maps", () => {
  test("array of scalars", () => {
    expect(toPhpType(t(types.array(t(types.string))))).toEqual({ type: "array", doc: "array<string>" })
  })

  test("map with string key", () => {
    const ref = t(types.map(t(types.string), t(types.integer)))
    expect(toPhpType(ref)).toEqual({ type: "array", doc: "array<string, int>" })
  })
})

describe("enum", () => {
  test("backed enum with PascalCased case names", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toJmsEnum("Status", ref)).toBe(
      ["enum Status: string", "{", '    case Active = "active";', '    case Inactive = "inactive";', "}"].join("\n"),
    )
  })

  test("member value is preserved verbatim even when case name is sanitized", () => {
    const ref = t(types.enum(["in-progress"]))
    expect(toJmsEnum("Status", ref)).toContain('case In_progress = "in-progress";')
  })

  test("toJms dispatches enum TypeRefs to toJmsEnum", () => {
    const ref = t(types.enum(["a", "b"]))
    expect(toJms(ref, "Letter")).toBe(toJmsEnum("Letter", ref))
  })
})

describe("readonly class with JMS attributes", () => {
  test("simple object becomes an ExclusionPolicy('all') class with Type/SerializedName/Expose per property", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    expect(toJmsClass("User", ref)).toBe(
      [
        "#[ExclusionPolicy('all')]",
        "final readonly class User",
        "{",
        "    public function __construct(",
        '        #[Type("string")] #[SerializedName("id")] #[Expose]',
        "        public string $id,",
        '        #[Type("int")] #[SerializedName("age")] #[Expose]',
        "        public int $age",
        "    ) {}",
        "}",
      ].join("\n"),
    )
  })

  test("array field's #[Type] uses the richer array<T> hint, matching the PHPDoc", () => {
    const ref = t(types.object({ tags: t(types.array(t(types.string))) }))
    const out = toJmsClass("Post", ref)
    expect(out).toContain('#[Type("array<string>")]')
    expect(out).toContain(" * @param array<string> $tags")
    expect(out).toContain("public array $tags")
  })

  test("optional field gets a nullable type and a null constructor default", () => {
    const ref = t(types.object({ nickname: t(types.string, { optional: true }) }))
    expect(toJmsClass("Profile", ref)).toContain("public ?string $nickname = null")
  })

  test("does not implement JsonSerializable (JMS walks properties reflectively)", () => {
    const ref = t(types.object({ id: t(types.string) }))
    expect(toJmsClass("User", ref)).not.toContain("JsonSerializable")
  })

  test("toJms dispatches object TypeRefs to toJmsClass", () => {
    const ref = t(types.object({ id: t(types.string) }))
    expect(toJms(ref, "User")).toBe(toJmsClass("User", ref))
  })
})

describe("doc comments and deprecation", () => {
  test("meta.description -> PHPDoc block above #[ExclusionPolicy('all')]", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { description: "A user." })
    const out = toJmsClass("User", ref)
    expect(out.startsWith("/**\n * A user.\n */\n#[ExclusionPolicy('all')]\nfinal readonly class User")).toBe(true)
  })

  test("meta.deprecated true -> bare @deprecated tag", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { deprecated: true })
    const out = toJmsClass("User", ref)
    expect(out.startsWith("/**\n * @deprecated\n */\n#[ExclusionPolicy('all')]")).toBe(true)
  })
})

describe("discriminated union -> #[Discriminator] hierarchy", () => {
  test("discriminated union emits an abstract base with #[Discriminator] + one subclass per variant", () => {
    const cat = withMeta(t(types.object({ type: t(types.literal("cat")), livesLeft: t(types.integer) })), {
      typeName: "Cat",
    })
    const dog = withMeta(t(types.object({ type: t(types.literal("dog")), breed: t(types.string) })), {
      typeName: "Dog",
    })
    const ref = withMeta(t(types.union([cat, dog])), { discriminator: "type" })
    const out = toJmsDiscriminatedUnion("Pet", ref)

    expect(out).toContain('#[Discriminator(field: "type", map: [')
    expect(out).toContain('"cat": Cat::class')
    expect(out).toContain('"dog": Dog::class')
    expect(out).toContain("abstract class Pet")
    expect(out).toContain("final readonly class Cat extends Pet")
    expect(out).toContain("final readonly class Dog extends Pet")
    // discriminator field itself is not re-declared as a constructor property.
    expect(out).not.toContain('#[SerializedName("type")]')
    expect(out).toContain('#[SerializedName("livesLeft")]')
    expect(out).toContain('#[SerializedName("breed")]')
  })

  test("plain (non-discriminated) union degrades to a @phpstan-type alias", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toJmsDiscriminatedUnion("StringOrInt", ref)).toBe("/** @phpstan-type StringOrInt string|int */")
  })

  test("toJms dispatches union TypeRefs to toJmsDiscriminatedUnion", () => {
    const ref = withMeta(
      t(types.union([withMeta(t(types.object({ type: t(types.literal("a")) })), { typeName: "A" })])),
      { discriminator: "type" },
    )
    expect(toJms(ref, "Foo")).toBe(toJmsDiscriminatedUnion("Foo", ref))
  })
})

describe("toJms for non-object/enum/union roots", () => {
  test("returns a bare type expression when no name is given", () => {
    expect(toJms(t(types.string))).toBe("string")
  })

  test("wraps a named non-object/enum/union in a @phpstan-type alias annotation", () => {
    expect(toJms(t(types.string), "Name")).toBe("/** @phpstan-type Name string */")
  })
})

describe("instance and ref", () => {
  test("instance renders as its class name", () => {
    expect(toPhpType(t(types.instance("Account", "src/account.ts")))).toEqual({ type: "Account" })
  })

  test("ref renders as its target name", () => {
    expect(toPhpType(t(types.ref("User")))).toEqual({ type: "User" })
  })
})
