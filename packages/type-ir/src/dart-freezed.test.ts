import { describe, expect, test } from "bun:test"
import { t, types, withMeta } from "./index.ts"
import { bytes } from "./kinds/bytes.ts"
import { toFreezed } from "./dart-freezed.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toFreezed(t(types.boolean), "Flag")).toBe("typedef Flag = bool;\n")
  })

  test("string", () => {
    expect(toFreezed(t(types.string), "Name")).toBe("typedef Name = String;\n")
  })

  test("number -> double", () => {
    expect(toFreezed(t(types.number), "Amount")).toBe("typedef Amount = double;\n")
  })

  test("integer -> int", () => {
    expect(toFreezed(t(types.integer), "Count")).toBe("typedef Count = int;\n")
  })
})

describe("bytes", () => {
  test("bytes -> Uint8List with dart:typed_data import, no freezed import", () => {
    const out = toFreezed(bytes(), "Blob")
    expect(out).toBe("import 'dart:typed_data';\n\ntypedef Blob = Uint8List;\n")
  })
})

describe("collections", () => {
  test("array -> List<T>", () => {
    expect(toFreezed(t(types.array(t(types.string))), "Names")).toBe("typedef Names = List<String>;\n")
  })
})

describe("nullable", () => {
  test("meta.nullable adds ?", () => {
    const out = toFreezed(t(types.string, { nullable: true }), "MaybeName")
    expect(out).toBe("typedef MaybeName = String?;\n")
  })
})

describe("enum", () => {
  test("renders a plain Dart enum, no freezed import needed", () => {
    const out = toFreezed(t(types.enum(["ACTIVE", "INACTIVE"])), "Status")
    expect(out).toContain("enum Status {")
    expect(out).toContain("active('ACTIVE')")
    expect(out).toContain("inactive('INACTIVE')")
    expect(out).toContain("factory Status.fromJson(String json)")
    expect(out).toContain("String toJson() => value;")
    expect(out).not.toContain("freezed_annotation")
    expect(out).not.toContain("part '")
  })

  test("enum: description and deprecated", () => {
    const ref = withMeta(t(types.enum(["active", "inactive"])), { description: "Account status.", deprecated: true })
    const out = toFreezed(ref, "Status")
    expect(out).toContain("/// Account status.\n@Deprecated('deprecated')\nenum Status {")
  })
})

describe("object classes", () => {
  const person = t(
    types.object({
      name: t(types.string),
      age: t(types.integer, { optional: true }),
    }),
  )

  test("emits an abstract freezed class with a const factory constructor", () => {
    const out = toFreezed(person, "Person")
    expect(out).toContain("@freezed")
    expect(out).toContain("abstract class Person with _$Person {")
    expect(out).toContain("const factory Person({")
    expect(out).toContain("required String name,")
    expect(out).toContain("int? age,")
    expect(out).not.toContain("required int? age,")
    expect(out).toContain("}) = _Person;")
  })

  test("emits fromJson delegating to the generated _$PersonFromJson", () => {
    const out = toFreezed(person, "Person")
    expect(out).toContain("factory Person.fromJson(Map<String, dynamic> json) => _$PersonFromJson(json);")
  })

  test("has no hand-written toJson body — freezed's mixin supplies it", () => {
    const out = toFreezed(person, "Person")
    expect(out).not.toContain("Map<String, dynamic> toJson()")
  })

  test("imports freezed_annotation and declares .freezed.dart/.g.dart parts", () => {
    const out = toFreezed(person, "Person")
    expect(out).toContain("import 'package:freezed_annotation/freezed_annotation.dart';")
    expect(out).toContain("part 'person.freezed.dart';")
    expect(out).toContain("part 'person.g.dart';")
  })

  test("snake_case field names get @JsonKey and a camelCase Dart field", () => {
    const withSnakeCase = t(types.object({ first_name: t(types.string) }))
    const out = toFreezed(withSnakeCase, "Contact")
    expect(out).toContain("@JsonKey(name: 'first_name')")
    expect(out).toContain("required String firstName,")
    // @JsonKey comes from freezed_annotation itself, no separate json_annotation import
    expect(out).not.toContain("package:json_annotation")
  })

  test("nested object field becomes its own top-level freezed class", () => {
    const withAddress = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const out = toFreezed(withAddress, "Customer")
    expect(out).toContain("abstract class Customer with _$Customer {")
    expect(out).toContain("abstract class CustomerAddress with _$CustomerAddress {")
    expect(out).toContain("required CustomerAddress address,")
  })

  test("array of objects: element becomes its own top-level class, no manual mapping", () => {
    const withItems = t(
      types.object({
        items: t(types.array(t(types.object({ sku: t(types.string) })))),
      }),
    )
    const out = toFreezed(withItems, "Order")
    expect(out).toContain("abstract class OrderItemsItem with _$OrderItemsItem {")
    expect(out).toContain("required List<OrderItemsItem> items,")
  })
})

describe("doc comments and deprecation", () => {
  test("meta.description -> /// doc comment above the class", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { description: "A person." })
    const out = toFreezed(ref, "Person")
    expect(out).toContain("/// A person.\n@freezed")
  })

  test("meta.deprecated true -> @Deprecated with a generic reason", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { deprecated: true })
    const out = toFreezed(ref, "Person")
    expect(out).toContain("@Deprecated('deprecated')\n@freezed")
  })

  test("meta.deprecated string -> @Deprecated with the given reason", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { deprecated: "use NewPerson instead" })
    const out = toFreezed(ref, "Person")
    expect(out).toContain("@Deprecated('use NewPerson instead')\n@freezed")
  })

  test("no description/deprecated -> no doc comment or annotation", () => {
    const out = toFreezed(t(types.object({ id: t(types.string) })), "Person")
    expect(out).not.toContain("///")
    expect(out).not.toContain("@Deprecated")
  })
})

describe("sealed class unions", () => {
  test("discriminated union: unionKey + named factory constructors per variant", () => {
    const shape = t(
      types.union([
        t(types.object({ type: t(types.literal("circle")), radius: t(types.number) })),
        t(types.object({ type: t(types.literal("square")), side: t(types.number) })),
      ]),
      { discriminator: "type" },
    )
    const out = toFreezed(shape, "Shape")
    expect(out).toContain("@Freezed(unionKey: 'type')")
    expect(out).toContain("sealed class Shape with _$Shape {")
    expect(out).toContain("const factory Shape.circle({")
    expect(out).toContain("required double radius,")
    expect(out).toContain("}) = Circle;")
    expect(out).toContain("const factory Shape.square({")
    expect(out).toContain("}) = Square;")
    expect(out).toContain("factory Shape.fromJson(Map<String, dynamic> json) => _$ShapeFromJson(json);")
    // discriminator field is carried by unionKey, not duplicated as a constructor param
    expect(out).not.toContain("required String type,")
  })

  test("discriminant value matching the constructor name verbatim needs no override", () => {
    const shape = t(
      types.union([t(types.object({ type: t(types.literal("circle")), radius: t(types.number) }))]),
      { discriminator: "type" },
    )
    const out = toFreezed(shape, "Shape")
    expect(out).not.toContain("@FreezedUnionValue")
  })

  test("discriminant value that differs from the constructor name gets @FreezedUnionValue", () => {
    const shape = t(
      types.union([t(types.object({ type: t(types.literal("CIRCLE_SHAPE")), radius: t(types.number) }))]),
      { discriminator: "type" },
    )
    const out = toFreezed(shape, "Shape")
    expect(out).toContain("@FreezedUnionValue('CIRCLE_SHAPE')")
    expect(out).toContain("const factory Shape.circleShape({")
  })

  test("undiscriminated union: bare @freezed, default runtimeType-keyed dispatch", () => {
    const shape = t(types.union([t(types.object({ a: t(types.string) })), t(types.object({ b: t(types.integer) }))]))
    const out = toFreezed(shape, "Either")
    expect(out).toContain("@freezed")
    expect(out).toContain("sealed class Either with _$Either {")
    expect(out).toContain("const factory Either.eitherVariant0({")
    expect(out).toContain("}) = EitherVariant0;")
    expect(out).toContain("const factory Either.eitherVariant1({")
    expect(out).toContain("}) = EitherVariant1;")
  })
})

describe("top-level typedef for non-named kinds", () => {
  test("ref renders the bare target name", () => {
    expect(toFreezed(t(types.ref("SomeType")), "Alias")).toBe("typedef Alias = SomeType;\n")
  })
})
