import { describe, expect, test } from "bun:test"
import { t, types, withMeta } from "./index.ts"
import { toPhpType, toSymfony, toSymfonyClass, toSymfonyDiscriminatedUnion, toSymfonyEnum } from "./php-symfony.ts"

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
    expect(toSymfonyEnum("Status", ref)).toBe(
      ["enum Status: string", "{", '    case Active = "active";', '    case Inactive = "inactive";', "}"].join("\n"),
    )
  })

  test("member value is preserved verbatim even when case name is sanitized", () => {
    const ref = t(types.enum(["in-progress"]))
    expect(toSymfonyEnum("Status", ref)).toContain('case In_progress = "in-progress";')
  })

  test("toSymfony dispatches enum TypeRefs to toSymfonyEnum", () => {
    const ref = t(types.enum(["a", "b"]))
    expect(toSymfony(ref, "Letter")).toBe(toSymfonyEnum("Letter", ref))
  })
})

describe("readonly class with Symfony attributes", () => {
  test("simple object becomes a final readonly class with #[SerializedName] per property", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    expect(toSymfonyClass("User", ref)).toBe(
      [
        "final readonly class User",
        "{",
        "    public function __construct(",
        "        #[SerializedName(\"id\")]",
        "        public string $id,",
        "        #[SerializedName(\"age\")]",
        "        public int $age",
        "    ) {}",
        "}",
      ].join("\n"),
    )
  })

  test("field name is preserved verbatim in #[SerializedName] regardless of wire spelling", () => {
    const ref = t(types.object({ user_id: t(types.string) }))
    const out = toSymfonyClass("Account", ref)
    expect(out).toContain('#[SerializedName("user_id")]')
    expect(out).toContain("public string $user_id")
  })

  test("meta.serializationGroups adds a #[Groups] attribute alongside #[SerializedName]", () => {
    const ref = t(
      types.object({
        id: withMeta(t(types.string), { serializationGroups: ["read", "write"] }),
      }),
    )
    const out = toSymfonyClass("User", ref)
    expect(out).toContain('#[SerializedName("id")] #[Groups(["read", "write"])]')
  })

  test("field without serializationGroups gets no #[Groups] attribute", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const out = toSymfonyClass("User", ref)
    expect(out).not.toContain("#[Groups")
  })

  test("optional field gets a nullable type and a null constructor default", () => {
    const ref = t(types.object({ nickname: t(types.string, { optional: true }) }))
    expect(toSymfonyClass("Profile", ref)).toContain("public ?string $nickname = null")
  })

  test("array field gets a @param PHPDoc line above the constructor", () => {
    const ref = t(types.object({ tags: t(types.array(t(types.string))) }))
    const out = toSymfonyClass("Post", ref)
    expect(out).toContain("/**")
    expect(out).toContain(" * @param array<string> $tags")
    expect(out).toContain("public array $tags")
  })

  test("does not implement JsonSerializable (Symfony walks properties reflectively)", () => {
    const ref = t(types.object({ id: t(types.string) }))
    expect(toSymfonyClass("User", ref)).not.toContain("JsonSerializable")
  })

  test("toSymfony dispatches object TypeRefs to toSymfonyClass", () => {
    const ref = t(types.object({ id: t(types.string) }))
    expect(toSymfony(ref, "User")).toBe(toSymfonyClass("User", ref))
  })
})

describe("doc comments and deprecation", () => {
  test("meta.description -> PHPDoc block above the class", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { description: "A user." })
    const out = toSymfonyClass("User", ref)
    expect(out.startsWith("/**\n * A user.\n */\nfinal readonly class User")).toBe(true)
  })

  test("meta.deprecated true -> bare @deprecated tag", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { deprecated: true })
    const out = toSymfonyClass("User", ref)
    expect(out.startsWith("/**\n * @deprecated\n */\nfinal readonly class User")).toBe(true)
  })
})

describe("discriminated union -> #[DiscriminatorMap] hierarchy", () => {
  test("discriminated union emits an abstract base with #[DiscriminatorMap] + one subclass per variant", () => {
    const cat = withMeta(t(types.object({ type: t(types.literal("cat")), livesLeft: t(types.integer) })), {
      typeName: "Cat",
    })
    const dog = withMeta(t(types.object({ type: t(types.literal("dog")), breed: t(types.string) })), {
      typeName: "Dog",
    })
    const ref = withMeta(t(types.union([cat, dog])), { discriminator: "type" })
    const out = toSymfonyDiscriminatedUnion("Pet", ref)

    expect(out).toContain('#[DiscriminatorMap(typeProperty: "type", mapping: [')
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
    expect(toSymfonyDiscriminatedUnion("StringOrInt", ref)).toBe("/** @phpstan-type StringOrInt string|int */")
  })

  test("toSymfony dispatches union TypeRefs to toSymfonyDiscriminatedUnion", () => {
    const ref = withMeta(
      t(types.union([withMeta(t(types.object({ type: t(types.literal("a")) })), { typeName: "A" })])),
      { discriminator: "type" },
    )
    expect(toSymfony(ref, "Foo")).toBe(toSymfonyDiscriminatedUnion("Foo", ref))
  })
})

describe("toSymfony for non-object/enum/union roots", () => {
  test("returns a bare type expression when no name is given", () => {
    expect(toSymfony(t(types.string))).toBe("string")
  })

  test("wraps a named non-object/enum/union in a @phpstan-type alias annotation", () => {
    expect(toSymfony(t(types.string), "Name")).toBe("/** @phpstan-type Name string */")
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
