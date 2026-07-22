import { describe, expect, test } from "bun:test"
import { t, types, withMeta } from "./index.ts"
import { bytes, int32, int64, uuid } from "./kinds/common.ts"
import { toGson, toGsonDeclaration } from "./java-gson.ts"

describe("primitives — bare type expressions", () => {
  test("boolean -> boolean (non-nullable, primitive)", () => {
    expect(toGson(t(types.boolean))).toBe("boolean")
  })

  test("string -> String", () => {
    expect(toGson(t(types.string))).toBe("String")
  })

  test("number -> double", () => {
    expect(toGson(t(types.number))).toBe("double")
  })

  test("integer -> int", () => {
    expect(toGson(t(types.integer))).toBe("int")
  })

  test("int32 -> int, int64 -> long", () => {
    expect(toGson(int32())).toBe("int")
    expect(toGson(int64())).toBe("long")
  })

  test("null -> Void, unknown -> Object", () => {
    expect(toGson(t(types.null))).toBe("Void")
    expect(toGson(t(types.unknown))).toBe("Object")
  })

  test("bytes -> byte[]", () => {
    expect(toGson(bytes())).toBe("byte[]")
  })

  test("uuid -> java.util.UUID", () => {
    expect(toGson(uuid())).toBe("java.util.UUID")
  })

  test("nullable boolean boxes to Boolean (primitives can't be null)", () => {
    expect(toGson(withMeta(t(types.boolean), { nullable: true }))).toBe("Boolean")
  })

  test("optional integer with optionalStyle: optional wraps in Optional<Integer>", () => {
    expect(toGson(withMeta(t(types.integer), { optional: true }), undefined, { optionalStyle: "optional" })).toBe(
      "Optional<Integer>",
    )
  })
})

describe("collections", () => {
  test("array -> List<T>", () => {
    expect(toGson(t(types.array(t(types.string))))).toBe("List<String>")
  })

  test("map with string keys -> Map<String, V>", () => {
    expect(toGson(t(types.map(t(types.string), t(types.integer))))).toBe("Map<String, Integer>")
  })

  test("array element uses boxed type even though it's non-nullable (generics can't hold primitives)", () => {
    expect(toGson(t(types.array(t(types.integer))))).toBe("List<Integer>")
  })

  test("stream degrades to List<T>", () => {
    expect(toGson(t(types.stream(t(types.string))))).toBe("List<String>")
  })

  test("page degrades to List<T>", () => {
    expect(toGson(t(types.page(t(types.string), "cursor")))).toBe("List<String>")
  })
})

describe("record declaration", () => {
  test("object -> public record with components", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    const out = toGsonDeclaration("Person", ref)
    expect(out).toContain("public record Person(")
    expect(out).toContain("String id")
    expect(out).toContain("int age")
    expect(out).toContain("{}")
  })

  test("optional field renders boxed type with @Nullable and imports jspecify", () => {
    const ref = t(types.object({ nickname: withMeta(t(types.string), { optional: true }) }))
    const out = toGsonDeclaration("Person", ref)
    expect(out).toContain("import org.jspecify.annotations.Nullable;")
    expect(out).toContain("@Nullable String nickname")
  })

  test("non-camelCase field name gets sanitized identifier + @SerializedName", () => {
    const ref = t(types.object({ "user-id": t(types.string) }))
    const out = toGsonDeclaration("Account", ref)
    expect(out).toContain("String userId")
    expect(out).toContain('@SerializedName("user-id")')
  })

  test("always imports com.google.gson.annotations.SerializedName", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const out = toGsonDeclaration("Account", ref)
    expect(out).toContain("import com.google.gson.annotations.SerializedName;")
  })

  test("field name that's already a valid identifier gets no @SerializedName", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const out = toGsonDeclaration("Account", ref)
    expect(out).not.toContain("@SerializedName")
  })

  test("description meta renders as a javadoc comment", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { description: "A person." })
    const out = toGsonDeclaration("Person", ref)
    expect(out).toContain("/**")
    expect(out).toContain(" * A person.")
  })
})

describe("pojo style", () => {
  test("object -> final class with private fields, canonical constructor, getters", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    const out = toGsonDeclaration("Person", ref, { style: "pojo" })
    expect(out).toContain("public final class Person {")
    expect(out).toContain("private final String id;")
    expect(out).toContain("private final int age;")
    expect(out).toContain("public Person(String id, int age) {")
    expect(out).toContain("public String getId() {")
    expect(out).toContain("public int getAge() {")
    // No Jackson creator annotation — Gson's default field-naming policy
    // reads the field itself, no constructor annotation needed.
    expect(out).not.toContain("@JsonCreator")
  })

  test("non-camelCase field in pojo style gets @SerializedName on the field", () => {
    const ref = t(types.object({ "user-id": t(types.string) }))
    const out = toGsonDeclaration("Account", ref, { style: "pojo" })
    expect(out).toContain('@SerializedName("user-id")')
    expect(out).toContain("private final String userId;")
  })
})

describe("enum", () => {
  test("clean members render as a plain enum with no annotations", () => {
    const ref = t(types.enum(["ACTIVE", "INACTIVE"]))
    const out = toGsonDeclaration("Status", ref)
    expect(out).toBe(
      "import com.google.gson.annotations.SerializedName;\n\npublic enum Status {\n  ACTIVE, INACTIVE\n}\n",
    )
  })

  test("members needing sanitization get @SerializedName per constant with original wire value", () => {
    const ref = t(types.enum(["active", "inactive"]))
    const out = toGsonDeclaration("Status", ref)
    expect(out).toContain("public enum Status {")
    expect(out).toContain('@SerializedName("active")')
    expect(out).toContain("ACTIVE")
    expect(out).toContain('@SerializedName("inactive")')
    expect(out).toContain("INACTIVE")
    // Gson has no separate backing-value/creator pattern the way Jackson does.
    expect(out).not.toContain("@JsonValue")
    expect(out).not.toContain("@JsonCreator")
  })
})

describe("union -> sealed interface", () => {
  test("plain union of objects renders sealed interface + record per variant, with RuntimeTypeAdapterFactory comment", () => {
    const a = withMeta(t(types.object({ code: t(types.string) })), { typeName: "NotFound" })
    const b = withMeta(t(types.object({ message: t(types.string) })), { typeName: "ServerError" })
    const ref = t(types.union([a, b]))
    const out = toGsonDeclaration("ApiError", ref)
    expect(out).toContain("public sealed interface ApiError permits NotFound, ServerError {}")
    expect(out).toContain("public record NotFound(String code) implements ApiError {}")
    expect(out).toContain("public record ServerError(String message) implements ApiError {}")
    expect(out).toContain("RuntimeTypeAdapterFactory")
    expect(out).toContain(".registerSubtype(NotFound.class, \"NotFound\")")
    expect(out).toContain(".registerSubtype(ServerError.class, \"ServerError\")")
    expect(out).not.toContain("@JsonTypeInfo")
  })

  test("discriminated union (meta.discriminator) names the discriminant field in the registration comment", () => {
    const cat = withMeta(t(types.object({ type: t(types.literal("cat")), livesLeft: t(types.integer) })), {
      typeName: "Cat",
    })
    const dog = withMeta(t(types.object({ type: t(types.literal("dog")), breed: t(types.string) })), {
      typeName: "Dog",
    })
    const ref = withMeta(t(types.union([cat, dog])), { discriminator: "type" })
    const out = toGsonDeclaration("Pet", ref)
    expect(out).toContain('RuntimeTypeAdapterFactory\n//       .of(Pet.class, "type")')
    expect(out).toContain(".registerSubtype(Cat.class, \"Cat\")")
    expect(out).toContain(".registerSubtype(Dog.class, \"Dog\")")
    expect(out).toContain("public sealed interface Pet permits Cat, Dog {}")
    expect(out).not.toContain("@JsonTypeInfo")
    expect(out).not.toContain("@JsonSubTypes")
  })

  test("variant without meta.typeName synthesizes a name from the union", () => {
    const a = t(types.object({ code: t(types.string) }))
    const b = t(types.object({ message: t(types.string) }))
    const ref = t(types.union([a, b]))
    const out = toGsonDeclaration("ApiError", ref)
    expect(out).toContain("permits ApiErrorVariant1, ApiErrorVariant2")
  })

  test("scalar variant wraps in a single-field value record", () => {
    const a = withMeta(t(types.object({ code: t(types.string) })), { typeName: "Known" })
    const b = t(types.string)
    const ref = t(types.union([a, b]))
    const out = toGsonDeclaration("MaybeKnown", ref)
    expect(out).toMatch(/public record MaybeKnownVariant2\(String value\) implements MaybeKnown \{\}/)
  })
})

describe("full declaration assembly", () => {
  test("includes package declaration when packageName is set", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const out = toGsonDeclaration("Person", ref, { packageName: "com.example.model" })
    expect(out.startsWith("package com.example.model;\n\n")).toBe(true)
  })

  test("imports are sorted and deduplicated", () => {
    const ref = t(
      types.object({
        tags: t(types.array(t(types.string))),
        metadata: t(types.map(t(types.string), t(types.string))),
      }),
    )
    const out = toGsonDeclaration("Doc", ref)
    const importLines = out.split("\n").filter((l) => l.startsWith("import "))
    expect(importLines).toEqual([...importLines].sort())
    expect(new Set(importLines).size).toBe(importLines.length)
    expect(out).toContain("import java.util.List;")
    expect(out).toContain("import java.util.Map;")
    expect(out).toContain("import com.google.gson.annotations.SerializedName;")
  })
})

describe("tuple", () => {
  test("nested tuple type expression references conventional TupleN<...>", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toGson(ref)).toBe("Tuple2<String, Integer>")
  })

  test("top-level tuple declaration renders a record with ordinal component names", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    const out = toGsonDeclaration("Pair", ref)
    expect(out).toContain("public record Pair(String first, int second) {}")
  })
})

describe("function", () => {
  test("0-arg non-void -> Supplier<R>", () => {
    expect(toGson(t(types.function([], t(types.string))))).toBe("java.util.function.Supplier<String>")
  })

  test("1-arg non-void -> Function<A, R>", () => {
    expect(toGson(t(types.function([{ name: "x", type: t(types.string) }], t(types.integer))))).toBe(
      "java.util.function.Function<String, Integer>",
    )
  })

  test("3+ args degrades to Object", () => {
    const params = [
      { name: "a", type: t(types.string) },
      { name: "b", type: t(types.string) },
      { name: "c", type: t(types.string) },
    ]
    expect(toGson(t(types.function(params, t(types.string))))).toBe("Object")
  })
})
