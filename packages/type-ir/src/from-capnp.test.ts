import { describe, expect, test } from "bun:test";
import { fromCapnp, fromCapnpField, parseCapnpSchema } from "./from-capnp.ts";
import { renderCapnp, toCapnpStruct } from "./capnp.ts";
import type { TypeRef } from "./index.ts";

function field(struct: Record<string, TypeRef>, name: string): TypeRef {
  const f = struct[name];
  if (f === undefined) throw new Error(`missing field ${name}`);
  return f;
}

function fields(ref: TypeRef): Record<string, TypeRef> {
  return (ref.shape as { fields: Record<string, TypeRef> }).fields;
}

describe("scalar types", () => {
  test.each([
    ["Void", "void"],
    ["Bool", "boolean"],
    ["Int8", "int8"],
    ["Int16", "int16"],
    ["Int32", "int32"],
    ["Int64", "int64"],
    ["UInt8", "uint8"],
    ["UInt16", "uint16"],
    ["UInt32", "uint32"],
    ["UInt64", "uint64"],
    ["Float32", "float32"],
    ["Float64", "float64"],
    ["Text", "string"],
    ["Data", "bytes"],
    ["AnyPointer", "unknown"],
    ["AnyStruct", "unknown"],
    ["AnyList", "unknown"],
    ["Capability", "unknown"],
  ] as const)("%s -> %s", (capnpType, kind) => {
    const defs = fromCapnp(`struct S { f @0 :${capnpType}; }`);
    expect(field(fields(defs.S!), "f").shape.kind).toBe(kind);
  });
});

describe("basic struct", () => {
  const schema = `
    @0x1234567890abcdef;
    struct Person {
      name @0 :Text;
      age @1 :Int32;
      active @2 :Bool;
    }
  `;

  test("parses all fields with correct kinds", () => {
    const defs = fromCapnp(schema);
    const s = fields(defs.Person!);
    expect(field(s, "name").shape.kind).toBe("string");
    expect(field(s, "age").shape.kind).toBe("int32");
    expect(field(s, "active").shape.kind).toBe("boolean");
  });

  test("preserves field ordinals in meta", () => {
    const defs = fromCapnp(schema);
    const s = fields(defs.Person!);
    expect(field(s, "name").meta.ordinal).toBe(0);
    expect(field(s, "age").meta.ordinal).toBe(1);
    expect(field(s, "active").meta.ordinal).toBe(2);
  });
});

describe("nested structs", () => {
  const schema = `
    struct Person {
      name @0 :Text;
      address @1 :Address;

      struct Address {
        street @0 :Text;
        city @1 :Text;
      }
    }
  `;

  test("nested struct is registered under a dotted path", () => {
    const defs = fromCapnp(schema);
    expect(defs["Person.Address"]).toBeDefined();
    expect(fields(defs["Person.Address"]!).street?.shape.kind).toBe("string");
  });

  test("referencing field resolves to a ref pointing at the dotted path", () => {
    const defs = fromCapnp(schema);
    const addressField = field(fields(defs.Person!), "address");
    expect(addressField.shape.kind).toBe("ref");
    expect((addressField.shape as { target: string }).target).toBe("Person.Address");
  });
});

describe("enums", () => {
  const schema = `
    enum Color {
      red @0;
      green @1;
      blue @2;
    }
  `;

  test("becomes an enum TypeRef with members in ordinal order", () => {
    const defs = fromCapnp(schema);
    expect(defs.Color!.shape.kind).toBe("enum");
    expect((defs.Color!.shape as { members: readonly string[] }).members).toEqual([
      "red",
      "green",
      "blue",
    ]);
  });

  test("preserves exact ordinals in meta even when out of declaration order", () => {
    const defs = fromCapnp(`
      enum Status {
        active @1;
        inactive @0;
      }
    `);
    expect((defs.Status!.shape as { members: readonly string[] }).members).toEqual([
      "inactive",
      "active",
    ]);
    expect(defs.Status!.meta.ordinals).toEqual({ inactive: 0, active: 1 });
  });

  test("enum field reference resolves via ref", () => {
    const defs = fromCapnp(`
      struct Widget {
        color @0 :Color;
      }
      enum Color {
        red @0;
        blue @1;
      }
    `);
    const colorField = field(fields(defs.Widget!), "color");
    expect(colorField.shape.kind).toBe("ref");
    expect((colorField.shape as { target: string }).target).toBe("Color");
  });
});

describe("named unions", () => {
  const schema = `
    struct Shape {
      area @0 :Float64;
      variant :union {
        circleRadius @1 :Float64;
        squareSide @2 :Float64;
      }
    }
  `;

  test("named union becomes a union-kind field keyed by the union's name", () => {
    const defs = fromCapnp(schema);
    const s = fields(defs.Shape!);
    expect(field(s, "variant").shape.kind).toBe("union");
  });

  test("each variant is tagged with its original field name in meta", () => {
    const defs = fromCapnp(schema);
    const variant = field(fields(defs.Shape!), "variant");
    const variants = (variant.shape as { variants: readonly TypeRef[] }).variants;
    expect(variants.map((v) => v.meta.capnpFieldName)).toEqual(["circleRadius", "squareSide"]);
    expect(variants.every((v) => v.shape.kind === "float64")).toBe(true);
  });
});

describe("anonymous unions", () => {
  const schema = `
    struct Shape {
      union {
        circle @0 :Float64;
        square @1 :Float64;
      }
      area @2 :Float64;
    }
  `;

  test("anonymous union is synthesized under a generated key and marked anonymous", () => {
    const defs = fromCapnp(schema);
    const s = fields(defs.Shape!);
    const key = Object.keys(s).find((k) => s[k]!.shape.kind === "union");
    expect(key).toBeDefined();
    expect(s[key!]!.meta.anonymous).toBe(true);
    const variants = (s[key!]!.shape as { variants: readonly TypeRef[] }).variants;
    expect(variants.map((v) => v.meta.capnpFieldName)).toEqual(["circle", "square"]);
  });

  test("plain sibling fields remain ordinary fields", () => {
    const defs = fromCapnp(schema);
    expect(field(fields(defs.Shape!), "area").shape.kind).toBe("float64");
  });
});

describe("groups", () => {
  const schema = `
    struct Person {
      name @0 :Text;
      address :group {
        street @0 :Text;
        city @1 :Text;
      }
    }
  `;

  test("group becomes a nested object field", () => {
    const defs = fromCapnp(schema);
    const addr = field(fields(defs.Person!), "address");
    expect(addr.shape.kind).toBe("object");
    const inner = fields(addr);
    expect(inner.street?.shape.kind).toBe("string");
    expect(inner.city?.shape.kind).toBe("string");
  });

  // Regression: a struct/enum declared directly inside a group's body (a
  // group is structurally just an inline, unnamed struct, so it can carry
  // the same nested-type declarations a struct body can) must get
  // registered under the enclosing struct's dotted path, the same as a
  // struct declared directly inside a struct — see "nested structs" above.
  test("struct declared inside a group is registered and resolvable via ref", () => {
    const defs = fromCapnp(`
      struct Person {
        contact :group {
          method @0 :Method;

          struct Method {
            kind @0 :Text;
          }
        }
      }
    `);
    expect(defs["Person.Method"]).toBeDefined();
    expect(fields(defs["Person.Method"]!).kind?.shape.kind).toBe("string");
    const contact = field(fields(defs.Person!), "contact");
    const methodField = field(fields(contact), "method");
    expect(methodField.shape.kind).toBe("ref");
    expect((methodField.shape as { target: string }).target).toBe("Person.Method");
  });
});

describe("lists", () => {
  test("List(T) -> array", () => {
    const defs = fromCapnp(`struct S { tags @0 :List(Text); }`);
    const f = field(fields(defs.S!), "tags");
    expect(f.shape.kind).toBe("array");
    expect((f.shape as { element: TypeRef }).element.shape.kind).toBe("string");
  });

  test("nested List(List(T))", () => {
    const defs = fromCapnp(`struct S { matrix @0 :List(List(Int32)); }`);
    const f = field(fields(defs.S!), "matrix");
    expect(f.shape.kind).toBe("array");
    const inner = (f.shape as { element: TypeRef }).element;
    expect(inner.shape.kind).toBe("array");
    expect((inner.shape as { element: TypeRef }).element.shape.kind).toBe("int32");
  });

  test("List of a struct type resolves via ref", () => {
    const defs = fromCapnp(`
      struct Team {
        members @0 :List(Person);
      }
      struct Person {
        name @0 :Text;
      }
    `);
    const f = field(fields(defs.Team!), "members");
    expect(f.shape.kind).toBe("array");
    const element = (f.shape as { element: TypeRef }).element;
    expect(element.shape.kind).toBe("ref");
    expect((element.shape as { target: string }).target).toBe("Person");
  });
});

describe("default values", () => {
  test("numeric default", () => {
    const defs = fromCapnp(`struct S { count @0 :Int32 = 42; }`);
    expect(field(fields(defs.S!), "count").meta.default).toBe(42);
  });

  test("string default", () => {
    const defs = fromCapnp(`struct S { name @0 :Text = "hello"; }`);
    expect(field(fields(defs.S!), "name").meta.default).toBe("hello");
  });

  test("boolean default", () => {
    const defs = fromCapnp(`struct S { flag @0 :Bool = true; }`);
    expect(field(fields(defs.S!), "flag").meta.default).toBe(true);
  });
});

describe("annotations", () => {
  test("field annotation preserved in meta", () => {
    const defs = fromCapnp(`struct S { name @0 :Text $myAnnotation("hi"); }`);
    const annotations = field(fields(defs.S!), "name").meta.annotations as Array<{
      name: string;
      value?: unknown;
    }>;
    expect(annotations).toEqual([{ name: "myAnnotation", value: "hi" }]);
  });

  test("bare annotation with no value", () => {
    const defs = fromCapnp(`struct S { name @0 :Text $deprecated; }`);
    const annotations = field(fields(defs.S!), "name").meta.annotations as Array<{ name: string }>;
    expect(annotations).toEqual([{ name: "deprecated" }]);
  });

  test("struct-level annotation preserved", () => {
    const defs = fromCapnp(`struct S $myAnno("x") { name @0 :Text; }`);
    expect(defs.S!.meta.annotations).toEqual([{ name: "myAnno", value: "x" }]);
  });
});

describe("doc comments -> description", () => {
  test("struct description from a leading # comment", () => {
    const defs = fromCapnp(`
      # A person record.
      struct Person {
        # The person's name.
        name @0 :Text;
      }
    `);
    expect(defs.Person!.meta.description).toBe("A person record.");
    expect(field(fields(defs.Person!), "name").meta.description).toBe("The person's name.");
  });
});

describe("imports and using", () => {
  test("using import declarations are recognized and skipped without error", () => {
    const defs = fromCapnp(`
      using import "other.capnp".Foo;
      using Bar = import "other.capnp".Baz;
      struct S {
        name @0 :Text;
      }
    `);
    expect(defs.S).toBeDefined();
    expect(field(fields(defs.S!), "name").shape.kind).toBe("string");
  });
});

describe("fromCapnpField standalone", () => {
  test("converts a single field descriptor", () => {
    const parsed = parseCapnpSchema(`struct S { n @0 :Int32; }`);
    const field0 = parsed.structs[0]!.members[0];
    if (field0 === undefined || field0.kind !== "field") throw new Error("expected a field member");
    expect(fromCapnpField(field0).shape.kind).toBe("int32");
  });
});

describe("round-trip against capnp.ts's projector", () => {
  test("a struct rendered by toCapnpStruct/renderCapnp parses back with matching field kinds", () => {
    const original = fromCapnp(`
      struct Widget {
        name @0 :Text;
        count @1 :Int64;
        active @2 :Bool;
      }
    `);
    const rendered = renderCapnp([toCapnpStruct("Widget", original.Widget!)], "0x1234567890abcdef");
    const reparsed = fromCapnp(rendered);
    expect(fields(reparsed.Widget!).name?.shape.kind).toBe("string");
    expect(fields(reparsed.Widget!).count?.shape.kind).toBe("int64");
    expect(fields(reparsed.Widget!).active?.shape.kind).toBe("boolean");
  });

  test("a nested-struct field round-trips through toCapnpStruct's synthesized nested struct", () => {
    const original = fromCapnp(`
      struct Outer {
        inner :group {
          value @0 :Int32;
        }
      }
    `);
    const rendered = renderCapnp([toCapnpStruct("Outer", original.Outer!)]);
    const reparsed = fromCapnp(rendered);
    // toCapnpStruct promotes an object field to a named nested struct + a ref
    // field (see capnp.ts's toCapnpStruct), so the round-tripped shape is a
    // `ref` to that nested struct rather than an inline object — still
    // structurally equivalent (same fields, one level of indirection later).
    const innerField = fields(reparsed.Outer!).inner!;
    expect(innerField.shape.kind).toBe("ref");
    const target = (innerField.shape as { target: string }).target;
    expect(fields(reparsed[target]!).value?.shape.kind).toBe("int32");
  });
});

describe("interfaces", () => {
  const source = `
    @0xdbb9ad1f14bf0b36;

    # A key-value store.
    interface Store @0xabcdef0123456789 {
      # Fetch a value.
      get @0 (key :Text, fallback :Int32 = -1 $note("n")) -> (value :Text, found :Bool) $deprecatedish;
      put @1 (key :Text, value :Text);
      clear @2 () -> ();
      watch @3 (key :Text) -> stream;
      lookup @4 Store.LookupParams -> Store.LookupResults;

      struct LookupParams { key @0 :Text; }
      struct LookupResults { hits @0 :List(Text); }
      enum Mode { fast @0; slow @1; }
    }
  `;

  test("parses methods with ordinals, params, results, defaults and descriptions", () => {
    const file = parseCapnpSchema(source);
    expect(file.id).toBe("0xdbb9ad1f14bf0b36");
    const store = file.interfaces[0]!;
    expect(store.name).toBe("Store");
    expect(store.id).toBe("0xabcdef0123456789");
    expect(store.description).toBe("A key-value store.");
    expect(store.methods.map((m) => [m.name, m.ordinal])).toEqual([
      ["get", 0],
      ["put", 1],
      ["clear", 2],
      ["watch", 3],
      ["lookup", 4],
    ]);
    const get = store.methods[0]!;
    expect(get.description).toBe("Fetch a value.");
    expect(get.annotations).toEqual([{ name: "deprecatedish" }]);
    if (get.params.kind !== "list" || get.results.kind !== "list") throw new Error("lists");
    expect(get.params.params.map((p) => p.name)).toEqual(["key", "fallback"]);
    expect(get.params.params[1]!.default).toBe(-1);
    expect(get.params.params[1]!.annotations).toEqual([{ name: "note", value: "n" }]);
    expect(get.results.params.map((p) => p.type.name)).toEqual(["Text", "Bool"]);
  });

  test("an omitted `->` is an empty result list; `-> stream` is its own result kind", () => {
    const methods = parseCapnpSchema(source).interfaces[0]!.methods;
    expect(methods[1]!.results).toEqual({ kind: "list", params: [] });
    expect(methods[3]!.results).toEqual({ kind: "stream" });
  });

  test("a method side may name a struct type", () => {
    const lookup = parseCapnpSchema(source).interfaces[0]!.methods[4]!;
    expect(lookup.params).toEqual({ kind: "type", type: { name: "Store.LookupParams" } });
    expect(lookup.results).toEqual({ kind: "type", type: { name: "Store.LookupResults" } });
  });

  test("nested structs and enums are registered under the interface path", () => {
    const defs = fromCapnp(source);
    expect(Object.keys(defs).sort()).toEqual([
      "Store.LookupParams",
      "Store.LookupResults",
      "Store.Mode",
    ]);
  });

  test("extends, generic parameters and method generics", () => {
    const store = parseCapnpSchema(`
      interface Box(T) extends(Base, Other(Text)) {
        take @0 [U] (a :T, b :U) -> (c :U);
      }
    `).interfaces[0]!;
    expect(store.typeParams).toEqual(["T"]);
    expect(store.extends).toEqual([{ name: "Base" }, { name: "Other", args: [{ name: "Text" }] }]);
    expect(store.methods[0]!.typeParams).toEqual(["U"]);
  });

  test("nested interfaces, inside interfaces and inside structs", () => {
    const file = parseCapnpSchema(`
      interface Outer { interface Inner { ping @0 (); } make @0 () -> (inner :Inner); }
      struct Holder { interface Held { pong @0 (); } n @0 :Int32; }
    `);
    expect(file.interfaces[0]!.nestedInterfaces[0]!.name).toBe("Inner");
    expect(file.structs[0]!.nestedInterfaces[0]!.name).toBe("Held");
    expect(file.structs[0]!.members).toHaveLength(1);
  });

  test("struct and enum ids and generic parameters are parsed", () => {
    const file = parseCapnpSchema(`
      struct Pair(A, B) @0x1234 { a @0 :A; b @1 :B; }
      enum E @0x99 { x @0; }
    `);
    expect(file.structs[0]!.typeParams).toEqual(["A", "B"]);
    expect(file.structs[0]!.id).toBe("0x1234");
    expect(file.enums[0]!.id).toBe("0x99");
  });

  test("a malformed method throws unless onError is given, and only that method is lost", () => {
    const bad = `interface S { good @0 (a :Int32); broken @1 (a Int32); other @2 (); }`;
    expect(() => parseCapnpSchema(bad)).toThrow();
    const errors: string[] = [];
    const file = parseCapnpSchema(bad, { onError: (m) => errors.push(m) });
    expect(file.interfaces[0]!.methods.map((m) => m.name)).toEqual(["good", "other"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("interface S");
  });

  test("a malformed top-level declaration is skipped with onError", () => {
    const errors: string[] = [];
    const file = parseCapnpSchema(`struct Bad { x @0 Int32; } struct Good { y @0 :Int32; }`, {
      onError: (m) => errors.push(m),
    });
    expect(file.structs.map((s) => s.name)).toEqual(["Good"]);
    expect(errors).toHaveLength(1);
  });

  test("interface-typed fields, generic parameters and generic arguments convert honestly", () => {
    const defs = fromCapnp(`
      interface Callback { call @0 (); }
      struct Pair(A) { a @0 :A; cb @1 :Callback; list @2 :List(Callback); }
      struct User { pair @0 :Pair(Text); }
    `);
    expect(Object.keys(defs).sort()).toEqual(["Pair", "User"]);
    const pair = fields(defs.Pair!);
    expect(defs.Pair!.meta.typeParams).toEqual(["A"]);
    expect(pair.a!.shape.kind).toBe("unknown");
    expect(pair.a!.meta.capnpTypeParam).toBe("A");
    expect(pair.cb!.shape.kind).toBe("unknown");
    expect(pair.cb!.meta.capnpInterface).toBe("Callback");
    const list = pair.list!.shape as { element: TypeRef };
    expect(list.element.meta.capnpInterface).toBe("Callback");
    const user = fields(defs.User!).pair!;
    expect(user.shape).toEqual({ kind: "ref", target: "Pair" });
    expect((user.meta.typeArgs as TypeRef[])[0]!.shape.kind).toBe("string");
  });

  test("using, const and annotation declarations are recorded as skipped", () => {
    const file = parseCapnpSchema(`
      using Other = import "other.capnp";
      using import "third.capnp".Foo;
      const answer :Int32 = 42;
      annotation note(struct) :Text;
      interface I { const limit :Int32 = 3; ping @0 (); }
    `);
    expect(file.skipped).toEqual([
      { kind: "using", name: "Other", line: 2 },
      { kind: "using", line: 3 },
      { kind: "const", name: "answer", line: 4 },
      { kind: "annotation", name: "note", line: 5 },
      { kind: "const", name: "limit", scope: "I", line: 6 },
    ]);
  });

  test("a struct field named `interface` is still a field", () => {
    const defs = fromCapnp(`struct S { interface @0 :Text; }`);
    expect(field(fields(defs.S!), "interface").shape.kind).toBe("string");
  });
});
