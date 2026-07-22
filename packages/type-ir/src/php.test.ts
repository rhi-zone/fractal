import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { toPhp, toPhpClass, toPhpEnum, toPhpType } from "./php.ts"

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

  test("null", () => {
    expect(toPhpType(t(types.null))).toEqual({ type: "null" })
  })

  test("unknown maps to mixed", () => {
    expect(toPhpType(t(types.unknown))).toEqual({ type: "mixed" })
  })

  test("unknown kind fallback also maps to mixed", () => {
    const ref = { shape: { kind: "bogus" } as never, meta: {} }
    expect(toPhpType(ref)).toEqual({ type: "mixed" })
  })
})

describe("nullable", () => {
  test("single type uses ?T shorthand", () => {
    expect(toPhpType(t(types.string, { nullable: true }))).toEqual({ type: "?string" })
  })

  test("optional meta also renders as nullable", () => {
    expect(toPhpType(t(types.integer, { optional: true }))).toEqual({ type: "?int" })
  })

  test("union type spells out |null instead of ?", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]), { nullable: true })
    expect(toPhpType(ref)).toEqual({ type: "string|int|null" })
  })

  test("mixed stays mixed under nullable (already nullable)", () => {
    expect(toPhpType(t(types.unknown, { nullable: true }))).toEqual({ type: "mixed" })
  })
})

describe("union", () => {
  test("plain union of natively-expressible types needs no doc", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toPhpType(ref)).toEqual({ type: "string|int" })
  })

  test("dedupes identical PHP types across variants", () => {
    const ref = t(types.union([t(types.integer), t(types.number)]))
    // integer -> int, number -> float: distinct PHP types, kept as-is
    expect(toPhpType(ref)).toEqual({ type: "int|float" })
  })

  test("union containing an array member carries a doc for the array element", () => {
    const ref = t(types.union([t(types.string), t(types.array(t(types.integer)))]))
    expect(toPhpType(ref)).toEqual({ type: "string|array", doc: "string|array<int>" })
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

  test("map with non-string key documents the key type too", () => {
    const ref = t(types.map(t(types.integer), t(types.string)))
    expect(toPhpType(ref)).toEqual({ type: "array", doc: "array<int, string>" })
  })

  test("tuple degrades to an array-shape PHPDoc", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toPhpType(ref)).toEqual({ type: "array", doc: "array{string, int}" })
  })
})

describe("enum", () => {
  test("backed enum with PascalCased case names", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toPhpEnum("Status", ref)).toBe(
      ["enum Status: string", "{", '    case Active = "active";', '    case Inactive = "inactive";', "}"].join("\n"),
    )
  })

  test("member value is preserved verbatim even when case name is sanitized", () => {
    const ref = t(types.enum(["in-progress"]))
    expect(toPhpEnum("Status", ref)).toContain('case In_progress = "in-progress";')
  })

  test("bare enum in field position degrades to string with a doc listing members", () => {
    const ref = t(types.enum(["a", "b"]))
    expect(toPhpType(ref)).toEqual({ type: "string", doc: '"a"|"b"' })
  })

  test("toPhp dispatches enum TypeRefs to toPhpEnum", () => {
    const ref = t(types.enum(["a", "b"]))
    expect(toPhp(ref, "Letter")).toBe(toPhpEnum("Letter", ref))
  })
})

describe("readonly class", () => {
  test("simple object becomes a final readonly class implementing JsonSerializable", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    expect(toPhpClass("User", ref)).toBe(
      [
        "final readonly class User implements \\JsonSerializable",
        "{",
        "    public function __construct(",
        "        public string $id,",
        "        public int $age",
        "    ) {}",
        "",
        "    public function jsonSerialize(): array",
        "    {",
        "        return [",
        '            "id" => $this->id,',
        '            "age" => $this->age,',
        "        ];",
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("optional field gets a nullable type and a null constructor default", () => {
    const ref = t(types.object({ nickname: t(types.string, { optional: true }) }))
    expect(toPhpClass("Profile", ref)).toContain("public ?string $nickname = null")
  })

  test("array field gets a @param PHPDoc line above the constructor", () => {
    const ref = t(types.object({ tags: t(types.array(t(types.string))) }))
    const out = toPhpClass("Post", ref)
    expect(out).toContain("/**")
    expect(out).toContain(" * @param array<string> $tags")
    expect(out).toContain("public array $tags")
  })

  test("toPhp dispatches object TypeRefs to toPhpClass", () => {
    const ref = t(types.object({ id: t(types.string) }))
    expect(toPhp(ref, "User")).toBe(toPhpClass("User", ref))
  })
})

describe("toPhp for non-object/enum roots", () => {
  test("returns a bare type expression when no name is given", () => {
    expect(toPhp(t(types.string))).toBe("string")
  })

  test("wraps a named non-object/enum in a @phpstan-type alias annotation", () => {
    expect(toPhp(t(types.string), "Name")).toBe("/** @phpstan-type Name string */")
  })

  test("named alias uses the richer doc type when available", () => {
    const ref = t(types.array(t(types.string)))
    expect(toPhp(ref, "Tags")).toBe("/** @phpstan-type Tags array<string> */")
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
