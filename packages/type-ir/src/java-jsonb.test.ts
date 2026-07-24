import { describe, expect, test } from "bun:test"
import { t, types, withMeta } from "./index.ts"
import { bytes, int32, int64, uuid } from "./kinds/common.ts"
import { toJsonb, toJsonbDeclaration } from "./java-jsonb.ts"

describe("primitives — bare type expressions", () => {
  test("boolean -> boolean (non-nullable, primitive)", () => {
    expect(toJsonb(t(types.boolean))).toBe("boolean")
  })

  test("string -> String", () => {
    expect(toJsonb(t(types.string))).toBe("String")
  })

  test("number -> double", () => {
    expect(toJsonb(t(types.number))).toBe("double")
  })

  test("integer -> int", () => {
    expect(toJsonb(t(types.integer))).toBe("int")
  })

  test("int32 -> int, int64 -> long", () => {
    expect(toJsonb(int32())).toBe("int")
    expect(toJsonb(int64())).toBe("long")
  })

  test("null -> Void, unknown -> Object", () => {
    expect(toJsonb(t(types.null))).toBe("Void")
    expect(toJsonb(t(types.unknown))).toBe("Object")
  })

  test("bytes -> byte[]", () => {
    expect(toJsonb(bytes())).toBe("byte[]")
  })

  test("uuid -> java.util.UUID", () => {
    expect(toJsonb(uuid())).toBe("java.util.UUID")
  })

  test("nullable boolean boxes to Boolean (primitives can't be null)", () => {
    expect(toJsonb(withMeta(t(types.boolean), { nullable: true }))).toBe("Boolean")
  })

  test("optional integer with optionalStyle: optional wraps in Optional<Integer>", () => {
    expect(toJsonb(withMeta(t(types.integer), { optional: true }), undefined, { optionalStyle: "optional" })).toBe(
      "Optional<Integer>",
    )
  })
})

describe("collections", () => {
  test("array -> List<T>", () => {
    expect(toJsonb(t(types.array(t(types.string))))).toBe("List<String>")
  })

  test("map with string keys -> Map<String, V>", () => {
    expect(toJsonb(t(types.map(t(types.string), t(types.integer))))).toBe("Map<String, Integer>")
  })

  test("stream degrades to List<T>", () => {
    expect(toJsonb(t(types.stream(t(types.string))))).toBe("List<String>")
  })

  test("page degrades to List<T>", () => {
    expect(toJsonb(t(types.page(t(types.string), "cursor")))).toBe("List<String>")
  })
})

describe("record declaration", () => {
  test("object -> public record with components", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    const out = toJsonbDeclaration("Person", ref)
    expect(out).toContain("public record Person(")
    expect(out).toContain("String id")
    expect(out).toContain("int age")
    expect(out).toContain("{}")
  })

  test("optional field renders boxed type with @Nullable and imports jspecify", () => {
    const ref = t(types.object({ nickname: withMeta(t(types.string), { optional: true }) }))
    const out = toJsonbDeclaration("Person", ref)
    expect(out).toContain("import org.jspecify.annotations.Nullable;")
    expect(out).toContain("@Nullable String nickname")
  })

  test("non-camelCase field name gets sanitized identifier + @JsonbProperty", () => {
    const ref = t(types.object({ "user-id": t(types.string) }))
    const out = toJsonbDeclaration("Account", ref)
    expect(out).toContain("String userId")
    expect(out).toContain('@JsonbProperty("user-id")')
  })

  test("jsonb: false omits jsonb imports and annotations", () => {
    const ref = t(types.object({ "user-id": t(types.string) }))
    const out = toJsonbDeclaration("Account", ref, { jsonb: false })
    expect(out).not.toContain("jakarta.json.bind")
    expect(out).not.toContain("@JsonbProperty")
  })

  test("imports jakarta.json.bind.annotation.JsonbProperty/JsonbCreator by default", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const out = toJsonbDeclaration("Person", ref)
    expect(out).toContain("import jakarta.json.bind.annotation.JsonbCreator;")
    expect(out).toContain("import jakarta.json.bind.annotation.JsonbProperty;")
  })

  test("description meta renders as a javadoc comment", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { description: "A person." })
    const out = toJsonbDeclaration("Person", ref)
    expect(out).toContain("/**")
    expect(out).toContain(" * A person.")
  })
})

describe("pojo style", () => {
  test("object -> final class with private fields, @JsonbCreator constructor, getters", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    const out = toJsonbDeclaration("Person", ref, { style: "pojo" })
    expect(out).toContain("public final class Person {")
    expect(out).toContain("private final String id;")
    expect(out).toContain("private final int age;")
    expect(out).toContain("@JsonbCreator")
    expect(out).toContain(
      'public Person(@JsonbProperty("id") String id, @JsonbProperty("age") int age) {',
    )
    expect(out).toContain("public String getId() {")
    expect(out).toContain("public int getAge() {")
  })
})

describe("enum", () => {
  test("clean members and jsonb: false render a plain enum with no imports", () => {
    const ref = t(types.enum(["ACTIVE", "INACTIVE"]))
    const out = toJsonbDeclaration("Status", ref, { jsonb: false })
    expect(out).toBe("public enum Status {\n  ACTIVE, INACTIVE\n}\n")
  })

  test("members needing sanitization get a @JsonbTypeAdapter + mapping comment", () => {
    const ref = t(types.enum(["active", "inactive"]))
    const out = toJsonbDeclaration("Status", ref)
    expect(out).toContain("@JsonbTypeAdapter(StatusAdapter.class)")
    expect(out).toContain('//   ACTIVE <-> "active"')
    expect(out).toContain('//   INACTIVE <-> "inactive"')
    expect(out).toContain("import jakarta.json.bind.annotation.JsonbTypeAdapter;")
    expect(out).toContain("public enum Status {")
    expect(out).toContain("ACTIVE, INACTIVE")
  })

  test("jsonb: false and mismatched members still render a plain enum (no adapter)", () => {
    const ref = t(types.enum(["active", "inactive"]))
    const out = toJsonbDeclaration("Status", ref, { jsonb: false })
    expect(out).not.toContain("@JsonbTypeAdapter")
    expect(out).toContain("public enum Status {\n  ACTIVE, INACTIVE\n}")
  })
})

describe("union -> sealed interface", () => {
  test("plain union of objects renders sealed interface + record per variant, no @JsonbTypeInfo", () => {
    const a = withMeta(t(types.object({ code: t(types.string) })), { typeName: "NotFound" })
    const b = withMeta(t(types.object({ message: t(types.string) })), { typeName: "ServerError" })
    const ref = t(types.union([a, b]))
    const out = toJsonbDeclaration("ApiError", ref)
    expect(out).toContain("public sealed interface ApiError permits NotFound, ServerError {}")
    expect(out).toContain("public record NotFound(String code) implements ApiError {}")
    expect(out).toContain("public record ServerError(String message) implements ApiError {}")
    expect(out).not.toContain("@JsonbTypeInfo")
  })

  test("discriminated union (meta.discriminator) adds @JsonbTypeInfo + @JsonbSubtype", () => {
    const cat = withMeta(t(types.object({ type: t(types.literal("cat")), livesLeft: t(types.integer) })), {
      typeName: "Cat",
    })
    const dog = withMeta(t(types.object({ type: t(types.literal("dog")), breed: t(types.string) })), {
      typeName: "Dog",
    })
    const ref = withMeta(t(types.union([cat, dog])), { discriminator: "type" })
    const out = toJsonbDeclaration("Pet", ref)
    expect(out).toContain('@JsonbTypeInfo(key = "type", value = {')
    expect(out).toContain('@JsonbSubtype(alias = "Cat", type = Cat.class)')
    expect(out).toContain('@JsonbSubtype(alias = "Dog", type = Dog.class)')
    expect(out).toContain("public sealed interface Pet permits Cat, Dog {}")
    expect(out).toContain("import jakarta.json.bind.annotation.JsonbTypeInfo;")
    expect(out).toContain("import jakarta.json.bind.annotation.JsonbSubtype;")
  })

  test("variant without meta.typeName synthesizes a name from the union", () => {
    const a = t(types.object({ code: t(types.string) }))
    const b = t(types.object({ message: t(types.string) }))
    const ref = t(types.union([a, b]))
    const out = toJsonbDeclaration("ApiError", ref)
    expect(out).toContain("permits ApiErrorVariant1, ApiErrorVariant2")
  })

  test("scalar variant wraps in a single-field value record", () => {
    const a = withMeta(t(types.object({ code: t(types.string) })), { typeName: "Known" })
    const b = t(types.string)
    const ref = t(types.union([a, b]))
    const out = toJsonbDeclaration("MaybeKnown", ref)
    expect(out).toMatch(/public record MaybeKnownVariant2\(String value\) implements MaybeKnown \{\}/)
  })
})

describe("full declaration assembly", () => {
  test("includes package declaration when packageName is set", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const out = toJsonbDeclaration("Person", ref, { packageName: "com.example.model" })
    expect(out.startsWith("package com.example.model;\n\n")).toBe(true)
  })

  test("imports are sorted and deduplicated", () => {
    const ref = t(
      types.object({
        tags: t(types.array(t(types.string))),
        metadata: t(types.map(t(types.string), t(types.string))),
      }),
    )
    const out = toJsonbDeclaration("Doc", ref)
    const importLines = out.split("\n").filter((l) => l.startsWith("import "))
    expect(importLines).toEqual([...importLines].sort())
    expect(new Set(importLines).size).toBe(importLines.length)
    expect(out).toContain("import java.util.List;")
    expect(out).toContain("import java.util.Map;")
  })
})

describe("tuple", () => {
  test("nested tuple type expression references conventional TupleN<...>", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toJsonb(ref)).toBe("Tuple2<String, Integer>")
  })

  test("top-level tuple declaration renders a record with ordinal component names", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    const out = toJsonbDeclaration("Pair", ref)
    expect(out).toContain("public record Pair(String first, int second) {}")
  })
})

describe("function", () => {
  test("0-arg non-void -> Supplier<R>", () => {
    expect(toJsonb(t(types.function([], t(types.string))))).toBe("java.util.function.Supplier<String>")
  })

  test("1-arg non-void -> Function<A, R>", () => {
    expect(toJsonb(t(types.function([{ name: "x", type: t(types.string) }], t(types.integer))))).toBe(
      "java.util.function.Function<String, Integer>",
    )
  })

  test("3+ args degrades to Object", () => {
    const params = [
      { name: "a", type: t(types.string) },
      { name: "b", type: t(types.string) },
      { name: "c", type: t(types.string) },
    ]
    expect(toJsonb(t(types.function(params, t(types.string))))).toBe("Object")
  })
})
