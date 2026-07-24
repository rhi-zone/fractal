import { describe, expect, test } from "bun:test"
import { t, types, withMeta } from "./index.ts"
import { bytes } from "./kinds/bytes.ts"
import { toBuiltValue } from "./dart-built-value.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toBuiltValue(t(types.boolean), "Flag")).toBe("typedef Flag = bool;\n")
  })

  test("string", () => {
    expect(toBuiltValue(t(types.string), "Name")).toBe("typedef Name = String;\n")
  })

  test("number -> double", () => {
    expect(toBuiltValue(t(types.number), "Amount")).toBe("typedef Amount = double;\n")
  })

  test("integer -> int", () => {
    expect(toBuiltValue(t(types.integer), "Count")).toBe("typedef Count = int;\n")
  })
})

describe("bytes", () => {
  test("bytes -> Uint8List with dart:typed_data import, no built_value import", () => {
    const out = toBuiltValue(bytes(), "Blob")
    expect(out).toBe("import 'dart:typed_data';\n\ntypedef Blob = Uint8List;\n")
  })
})

describe("collections use built_collection types", () => {
  test("array -> BuiltList<T> with built_collection import", () => {
    const out = toBuiltValue(t(types.array(t(types.string))), "Names")
    expect(out).toContain("import 'package:built_collection/built_collection.dart';")
    expect(out).toContain("typedef Names = BuiltList<String>;")
  })

  test("map -> BuiltMap<K, V>", () => {
    const out = toBuiltValue(t(types.map(t(types.string), t(types.integer))), "Counts")
    expect(out).toContain("typedef Counts = BuiltMap<String, int>;")
  })

  test("page degrades to BuiltList<T>", () => {
    const out = toBuiltValue(t(types.page(t(types.string), "cursor")), "Items")
    expect(out).toContain("typedef Items = BuiltList<String>;")
  })

  test("tuple stays a plain Dart record, no Built* wrapper", () => {
    const out = toBuiltValue(t(types.tuple([t(types.string), t(types.integer)])), "Pair")
    expect(out).toBe("typedef Pair = (String, int);\n")
  })
})

describe("nullable", () => {
  test("meta.nullable adds ?", () => {
    const out = toBuiltValue(t(types.string, { nullable: true }), "MaybeName")
    expect(out).toBe("typedef MaybeName = String?;\n")
  })
})

describe("enum", () => {
  test("renders a plain Dart enum, no built_value import needed", () => {
    const out = toBuiltValue(t(types.enum(["ACTIVE", "INACTIVE"])), "Status")
    expect(out).toContain("enum Status {")
    expect(out).toContain("active('ACTIVE')")
    expect(out).toContain("inactive('INACTIVE')")
    expect(out).toContain("factory Status.fromJson(String json)")
    expect(out).toContain("String toJson() => value;")
    expect(out).not.toContain("built_value")
    expect(out).not.toContain("part '")
  })

  test("enum: description and deprecated", () => {
    const ref = withMeta(t(types.enum(["active", "inactive"])), { description: "Account status.", deprecated: true })
    const out = toBuiltValue(ref, "Status")
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

  test("emits an abstract class implementing Built<Foo, FooBuilder>", () => {
    const out = toBuiltValue(person, "Person")
    expect(out).toContain("abstract class Person implements Built<Person, PersonBuilder> {")
  })

  test("fields are abstract getters, not constructor params", () => {
    const out = toBuiltValue(person, "Person")
    expect(out).toContain("String get name;")
    expect(out).toContain("int? get age;")
  })

  test("includes the private Foo._() constructor and public factory", () => {
    const out = toBuiltValue(person, "Person")
    expect(out).toContain("Person._();")
    expect(out).toContain("factory Person([void Function(PersonBuilder) updates]) = _$Person;")
  })

  test("includes the static Serializer<Foo> hook", () => {
    const out = toBuiltValue(person, "Person")
    expect(out).toContain("static Serializer<Person> get serializer => _$personSerializer;")
  })

  test("imports built_value/serializer and declares a .g.dart part", () => {
    const out = toBuiltValue(person, "Person")
    expect(out).toContain("import 'package:built_value/built_value.dart';")
    expect(out).toContain("import 'package:built_value/serializer.dart';")
    expect(out).toContain("part 'person.g.dart';")
  })

  test("snake_case field names still get a camelCase Dart getter", () => {
    const withSnakeCase = t(types.object({ first_name: t(types.string) }))
    const out = toBuiltValue(withSnakeCase, "Contact")
    expect(out).toContain("String get firstName;")
  })

  test("nested object field becomes its own top-level built_value class", () => {
    const withAddress = t(types.object({ address: t(types.object({ city: t(types.string) })) }))
    const out = toBuiltValue(withAddress, "Customer")
    expect(out).toContain("abstract class Customer implements Built<Customer, CustomerBuilder> {")
    expect(out).toContain("abstract class CustomerAddress implements Built<CustomerAddress, CustomerAddressBuilder> {")
    expect(out).toContain("CustomerAddress get address;")
  })

  test("array of objects: element becomes its own top-level class inside a BuiltList", () => {
    const withItems = t(types.object({ items: t(types.array(t(types.object({ sku: t(types.string) })))) }))
    const out = toBuiltValue(withItems, "Order")
    expect(out).toContain("abstract class OrderItemsItem implements Built<OrderItemsItem, OrderItemsItemBuilder> {")
    expect(out).toContain("BuiltList<OrderItemsItem> get items;")
  })

  test("empty object has no getter block but keeps the constructor/factory/serializer", () => {
    const out = toBuiltValue(t(types.object({})), "Empty")
    expect(out).toContain("abstract class Empty implements Built<Empty, EmptyBuilder> {")
    expect(out).toContain("Empty._();")
    expect(out).toContain("factory Empty([void Function(EmptyBuilder) updates]) = _$Empty;")
  })
})

describe("doc comments and deprecation", () => {
  test("meta.description -> /// doc comment above the class", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { description: "A person." })
    const out = toBuiltValue(ref, "Person")
    expect(out).toContain("/// A person.\nabstract class Person")
  })

  test("meta.deprecated true -> @Deprecated with a generic reason", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { deprecated: true })
    const out = toBuiltValue(ref, "Person")
    expect(out).toContain("@Deprecated('deprecated')\nabstract class Person")
  })

  test("meta.deprecated string -> @Deprecated with the given reason", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { deprecated: "use NewPerson instead" })
    const out = toBuiltValue(ref, "Person")
    expect(out).toContain("@Deprecated('use NewPerson instead')\nabstract class Person")
  })

  test("no description/deprecated -> no doc comment or annotation", () => {
    const out = toBuiltValue(t(types.object({ id: t(types.string) })), "Person")
    expect(out).not.toContain("///")
    expect(out).not.toContain("@Deprecated")
  })
})

describe("unions (no native built_value support)", () => {
  test("discriminated union: variant classes plus a manual-dispatch comment", () => {
    const shape = t(
      types.union([
        t(types.object({ type: t(types.literal("circle")), radius: t(types.number) })),
        t(types.object({ type: t(types.literal("square")), side: t(types.number) })),
      ]),
      { discriminator: "type" },
    )
    const out = toBuiltValue(shape, "Shape")
    expect(out).toContain("abstract class ShapeVariant0 implements Built<ShapeVariant0, ShapeVariant0Builder> {")
    expect(out).toContain("abstract class ShapeVariant1 implements Built<ShapeVariant1, ShapeVariant1Builder> {")
    expect(out).toContain("typedef Shape = Object;")
    expect(out).toContain("discriminated by 'type'")
    expect(out).toContain("built_value has no native sealed-union support")
  })

  test("undiscriminated union carries a generic no-common-supertype comment", () => {
    const shape = t(types.union([t(types.object({ a: t(types.string) })), t(types.object({ b: t(types.integer) }))]))
    const out = toBuiltValue(shape, "Either")
    expect(out).toContain("built_value has no native union support")
  })

  test("union of a single distinct rendering collapses the typedef to that type", () => {
    const shape = t(types.union([t(types.string), t(types.string)]))
    const out = toBuiltValue(shape, "Name")
    expect(out).toContain("typedef Name = String;")
  })
})

describe("top-level typedef for non-named kinds", () => {
  test("ref renders the bare target name", () => {
    expect(toBuiltValue(t(types.ref("SomeType")), "Alias")).toBe("typedef Alias = SomeType;\n")
  })
})
