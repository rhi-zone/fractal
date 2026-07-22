import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes } from "./kinds/bytes.ts"
import { toDart } from "./dart.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toDart(t(types.boolean), "Flag")).toBe("typedef Flag = bool;\n")
  })

  test("string", () => {
    expect(toDart(t(types.string), "Name")).toBe("typedef Name = String;\n")
  })

  test("number -> double", () => {
    expect(toDart(t(types.number), "Amount")).toBe("typedef Amount = double;\n")
  })

  test("integer -> int", () => {
    expect(toDart(t(types.integer), "Count")).toBe("typedef Count = int;\n")
  })

  test("null -> Null", () => {
    expect(toDart(t(types.null), "Nothing")).toBe("typedef Nothing = Null;\n")
  })

  test("unknown -> dynamic", () => {
    expect(toDart(t(types.unknown), "Anything")).toBe("typedef Anything = dynamic;\n")
  })
})

describe("bytes", () => {
  test("bytes -> Uint8List with dart:typed_data import", () => {
    const out = toDart(bytes(), "Blob")
    expect(out).toBe("import 'dart:typed_data';\n\ntypedef Blob = Uint8List;\n")
  })
})

describe("collections", () => {
  test("array -> List<T>", () => {
    expect(toDart(t(types.array(t(types.string))), "Names")).toBe("typedef Names = List<String>;\n")
  })

  test("map with string keys -> Map<String, T>", () => {
    expect(toDart(t(types.map(t(types.string), t(types.integer))), "Counts")).toBe(
      "typedef Counts = Map<String, int>;\n",
    )
  })
})

describe("nullable", () => {
  test("meta.nullable adds ?", () => {
    const out = toDart(t(types.string, { nullable: true }), "MaybeName")
    expect(out).toBe("typedef MaybeName = String?;\n")
  })
})

describe("enum", () => {
  test("renders a Dart enum with value slot and fromJson/toJson", () => {
    const out = toDart(t(types.enum(["ACTIVE", "INACTIVE"])), "Status")
    expect(out).toContain("enum Status {")
    expect(out).toContain("active('ACTIVE')")
    expect(out).toContain("inactive('INACTIVE')")
    expect(out).toContain("factory Status.fromJson(String json)")
    expect(out).toContain("String toJson() => value;")
  })
})

describe("object classes", () => {
  const person = t(
    types.object({
      name: t(types.string),
      age: t(types.integer, { optional: true }),
    }),
  )

  test("emits a class with final fields and required/optional constructor params", () => {
    const out = toDart(person, "Person")
    expect(out).toContain("class Person {")
    expect(out).toContain("final String name;")
    expect(out).toContain("final int? age;")
    expect(out).toContain("required this.name")
    expect(out).toContain("this.age")
    expect(out).not.toContain("required this.age")
  })

  test("emits fromJson factory reading the map", () => {
    const out = toDart(person, "Person")
    expect(out).toContain("factory Person.fromJson(Map<String, dynamic> json) => Person(")
    expect(out).toContain(`name: json['name'] as String,`)
    expect(out).toContain(`age: json['age'] == null ? null : json['age'] as int,`)
  })

  test("emits toJson serializing back to a map, omitting null optionals", () => {
    const out = toDart(person, "Person")
    expect(out).toContain("Map<String, dynamic> toJson() => {")
    expect(out).toContain(`'name': name,`)
    expect(out).toContain(`if (age != null) 'age': age,`)
  })

  test("snake_case field names get @JsonKey and a camelCase Dart field", () => {
    const withSnakeCase = t(types.object({ first_name: t(types.string) }))
    const out = toDart(withSnakeCase, "Contact")
    expect(out).toContain("@JsonKey(name: 'first_name')")
    expect(out).toContain("final String firstName;")
    expect(out).toContain("import 'package:json_annotation/json_annotation.dart';")
  })

  test("nested object field becomes its own top-level class", () => {
    const withAddress = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const out = toDart(withAddress, "Customer")
    expect(out).toContain("class Customer {")
    expect(out).toContain("class CustomerAddress {")
    expect(out).toContain("final CustomerAddress address;")
    expect(out).toContain("address: CustomerAddress.fromJson(json['address'] as Map<String, dynamic>),")
    expect(out).toContain("'address': address.toJson(),")
  })

  test("array of objects maps element fromJson/toJson", () => {
    const withItems = t(
      types.object({
        items: t(types.array(t(types.object({ sku: t(types.string) })))),
      }),
    )
    const out = toDart(withItems, "Order")
    expect(out).toContain("class OrderItemsItem {")
    expect(out).toContain("final List<OrderItemsItem> items;")
    expect(out).toContain("items: (json['items'] as List).map((e) => OrderItemsItem.fromJson(e as Map<String, dynamic>)).toList(),")
    expect(out).toContain("'items': items.map((e) => e.toJson()).toList(),")
  })

  test("array of primitives casts directly, no per-element mapping", () => {
    const withTags = t(types.object({ tags: t(types.array(t(types.string))) }))
    const out = toDart(withTags, "Post")
    expect(out).toContain("final List<String> tags;")
    expect(out).toContain(`tags: (json['tags'] as List).cast<String>(),`)
    expect(out).toContain(`'tags': tags,`)
  })
})

describe("sealed class unions", () => {
  test("discriminated union dispatches fromJson by the discriminant field", () => {
    const shape = t(
      types.union([
        t(types.object({ type: t(types.literal("circle")), radius: t(types.number) })),
        t(types.object({ type: t(types.literal("square")), side: t(types.number) })),
      ]),
      { discriminator: "type" },
    )
    const out = toDart(shape, "Shape")
    expect(out).toContain("sealed class Shape {")
    expect(out).toContain("factory Shape.fromJson(Map<String, dynamic> json) {")
    expect(out).toContain(`switch (json['type']) {`)
    expect(out).toContain(`case 'circle': return Circle.fromJson(json);`)
    expect(out).toContain(`case 'square': return Square.fromJson(json);`)
    expect(out).toContain("class Circle extends Shape {")
    expect(out).toContain("class Square extends Shape {")
    expect(out).toContain("final double radius;")
    expect(out).toContain("Map<String, dynamic> toJson();")
  })

  test("undiscriminated union degrades to try-in-order fromJson", () => {
    const shape = t(
      types.union([
        t(types.object({ a: t(types.string) })),
        t(types.object({ b: t(types.integer) })),
      ]),
    )
    const out = toDart(shape, "Either")
    expect(out).toContain("sealed class Either {")
    expect(out).toContain("try {")
    expect(out).toContain("EitherVariant0.fromJson(json)")
    expect(out).toContain("EitherVariant1.fromJson(json)")
  })
})

describe("top-level typedef for non-named kinds", () => {
  test("ref renders the bare target name", () => {
    expect(toDart(t(types.ref("SomeType")), "Alias")).toBe("typedef Alias = SomeType;\n")
  })
})
