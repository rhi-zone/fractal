import { describe, expect, test } from "bun:test"
import { t, types, withMeta } from "./index.ts"
import { bytes, int32, int64, uint32 } from "./kinds/common.ts"
import { toWasmBindgen, toWasmBindgenType } from "./rust-wasm-bindgen.ts"

describe("primitives", () => {
  test("boolean -> bool", () => {
    expect(toWasmBindgenType(t(types.boolean))).toBe("bool")
  })

  test("number -> f64", () => {
    expect(toWasmBindgenType(t(types.number))).toBe("f64")
  })

  test("integer (bare) -> i64", () => {
    expect(toWasmBindgenType(t(types.integer))).toBe("i64")
  })

  test("int32 -> i32", () => {
    expect(toWasmBindgenType(int32())).toBe("i32")
  })

  test("int64 -> i64", () => {
    expect(toWasmBindgenType(int64())).toBe("i64")
  })

  test("uint32 -> u32", () => {
    expect(toWasmBindgenType(uint32())).toBe("u32")
  })

  test("string -> String", () => {
    expect(toWasmBindgenType(t(types.string))).toBe("String")
  })

  test("null -> ()", () => {
    expect(toWasmBindgenType(t(types.null))).toBe("()")
  })

  test("unknown -> JsValue (wasm-bindgen's real 'any JS value' primitive)", () => {
    expect(toWasmBindgenType(t(types.unknown))).toBe("JsValue")
  })

  test("bytes -> Vec<u8>", () => {
    expect(toWasmBindgenType(bytes())).toBe("Vec<u8>")
  })

  test("nullable -> Option<T>", () => {
    const ref = withMeta(t(types.string), { nullable: true })
    expect(toWasmBindgenType(ref)).toBe("Option<String>")
  })

  test("optional -> Option<T>", () => {
    const ref = withMeta(t(types.integer), { optional: true })
    expect(toWasmBindgenType(ref)).toBe("Option<i64>")
  })
})

describe("Vec<T> element restrictions (confirmed against wasm-bindgen's boxed-slices docs)", () => {
  test("array of string -> Vec<String>", () => {
    expect(toWasmBindgenType(t(types.array(t(types.string))))).toBe("Vec<String>")
  })

  test("array of integer -> Vec<i64>", () => {
    expect(toWasmBindgenType(t(types.array(t(types.integer))))).toBe("Vec<i64>")
  })

  test("array of unknown -> Vec<JsValue>", () => {
    expect(toWasmBindgenType(t(types.array(t(types.unknown))))).toBe("Vec<JsValue>")
  })

  test("array of boolean throws — bool is not a documented Vec<T>/Box<[T]> element type", () => {
    expect(() => toWasmBindgenType(t(types.array(t(types.boolean))))).toThrow(/Vec<bool>/)
  })

  test("array of array throws — nested Vec<Vec<T>> needs serde-wasm-bindgen", () => {
    expect(() => toWasmBindgenType(t(types.array(t(types.array(t(types.string))))))).toThrow(/nested Vec/)
  })

  test("array of bytes throws — Vec<Vec<u8>> needs serde-wasm-bindgen", () => {
    expect(() => toWasmBindgenType(t(types.array(bytes())))).toThrow(/Vec<Vec<u8>>/)
  })

  test("stream degrades to Vec<T> (materialized, same convention as rust-serde.ts)", () => {
    expect(toWasmBindgenType(t(types.stream(t(types.string))))).toBe("Vec<String>")
  })

  test("page degrades to Vec<T>", () => {
    expect(toWasmBindgenType(t(types.page(t(types.string), "cursor")))).toBe("Vec<String>")
  })
})

describe("structs", () => {
  test("object -> #[derive(Clone)] #[wasm_bindgen(getter_with_clone)] struct with pub fields", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.integer) }))
    const rust = toWasmBindgen(ref, "Person")
    expect(rust).toBe(
      [
        "#[derive(Clone)]",
        "#[wasm_bindgen(getter_with_clone)]",
        "pub struct Person {",
        "    pub name: String,",
        "    pub age: i64,",
        "}",
      ].join("\n"),
    )
  })

  test("field name needing snake_case conversion gets js_name rename", () => {
    const ref = t(types.object({ firstName: t(types.string) }))
    const rust = toWasmBindgen(ref, "Person")
    expect(rust).toContain('#[wasm_bindgen(js_name = "firstName")]')
    expect(rust).toContain("pub first_name: String,")
  })

  test("meta.readonly -> #[wasm_bindgen(readonly)]", () => {
    const ref = t(types.object({ id: withMeta(t(types.string), { readonly: true }) }))
    const rust = toWasmBindgen(ref, "Entity")
    expect(rust).toContain("#[wasm_bindgen(readonly)]")
  })

  test("optional field -> Option<T>", () => {
    const ref = t(types.object({ nickname: withMeta(t(types.string), { optional: true }) }))
    const rust = toWasmBindgen(ref, "Person")
    expect(rust).toContain("pub nickname: Option<String>,")
  })

  test("nested anonymous object field hoists a named struct declaration", () => {
    const ref = t(types.object({ address: t(types.object({ city: t(types.string) })) }))
    const rust = toWasmBindgen(ref, "Person")
    expect(rust).toContain("pub struct Address {")
    expect(rust).toContain("pub struct Person {")
    expect(rust).toContain("pub address: Address,")
  })

  test("array-of-struct field -> Vec<Name>", () => {
    const ref = t(types.object({ items: t(types.array(t(types.object({ sku: t(types.string) })))) }))
    const rust = toWasmBindgen(ref, "Cart")
    expect(rust).toContain("pub struct Items {")
    expect(rust).toContain("pub items: Vec<Items>,")
  })
})

describe("enums (fieldless / string-discriminant only)", () => {
  test("enum -> #[wasm_bindgen] pub enum with string discriminants", () => {
    const ref = t(types.enum(["active", "inactive"]))
    const rust = toWasmBindgen(ref, "Status")
    expect(rust).toBe(["#[wasm_bindgen]", "pub enum Status {", '    Active = "active",', '    Inactive = "inactive",', "}"].join("\n"))
  })
})

describe("functions", () => {
  test("function (no thisType) -> #[wasm_bindgen] pub fn with todo!() stub body", () => {
    const ref = t(types.function([{ name: "a", type: t(types.integer) }, { name: "b", type: t(types.integer) }], t(types.integer)))
    const rust = toWasmBindgen(ref, "add")
    expect(rust).toBe(["#[wasm_bindgen]", "pub fn add(a: i64, b: i64) -> i64 {", '    todo!("implement add")', "}"].join("\n"))
  })

  test("function with void return omits the arrow", () => {
    const ref = t(types.function([{ name: "msg", type: t(types.string) }], t(types.void)))
    const rust = toWasmBindgen(ref, "log")
    expect(rust).toContain("pub fn log(msg: String) {")
    expect(rust).not.toContain("->")
  })

  test("camelCase function name gets js_name rename and snake_case Rust identifier", () => {
    const ref = t(types.function([], t(types.void)))
    const rust = toWasmBindgen(ref, "doTheThing")
    expect(rust).toContain('#[wasm_bindgen(js_name = "doTheThing")]')
    expect(rust).toContain("pub fn do_the_thing()")
  })

  test("camelCase param name gets a per-parameter js_name rename", () => {
    const ref = t(types.function([{ name: "firstArg", type: t(types.string) }], t(types.void)))
    const rust = toWasmBindgen(ref, "foo")
    expect(rust).toContain('#[wasm_bindgen(js_name = "firstArg")] first_arg: String')
  })

  test("struct-valued param/return hoists a named struct declaration", () => {
    const ref = t(
      types.function(
        [{ name: "input", type: t(types.object({ x: t(types.integer) })) }],
        t(types.object({ y: t(types.integer) })),
      ),
    )
    const rust = toWasmBindgen(ref, "transform")
    expect(rust).toContain("pub struct Input {")
    expect(rust).toContain("pub struct TransformReturn {")
    expect(rust).toContain("pub fn transform(input: Input) -> TransformReturn {")
  })

  test("function requires a name", () => {
    const ref = t(types.function([], t(types.void)))
    expect(() => toWasmBindgen(ref)).toThrow(/requires a name/)
  })

  test("method (thisType present) throws — needs a #[wasm_bindgen] impl block, not a free function", () => {
    const ref = t(types.method([], t(types.void), t(types.instance("Foo", "foo.ts"))))
    expect(() => toWasmBindgen(ref, "bar")).toThrow(/impl block/)
  })
})

describe("genuinely unsupported kinds throw with an explanatory message", () => {
  test("union throws (tagged)", () => {
    const ref = withMeta(
      t(
        types.union([
          t(types.object({ kind: t(types.literal("a")) })),
          t(types.object({ kind: t(types.literal("b")) })),
        ]),
      ),
      { discriminator: "kind" },
    )
    expect(() => toWasmBindgenType(ref)).toThrow(/dynamic union/)
  })

  test("union throws (untagged)", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(() => toWasmBindgenType(ref)).toThrow(/dynamic union/)
  })

  test("map throws — needs serde-wasm-bindgen", () => {
    const ref = t(types.map(t(types.string), t(types.integer)))
    expect(() => toWasmBindgenType(ref)).toThrow(/serde-wasm-bindgen/)
  })

  test("tuple throws", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(() => toWasmBindgenType(ref)).toThrow(/tuple/)
  })

  test("intersection throws", () => {
    const ref = t(types.intersection([t(types.object({ a: t(types.string) })), t(types.object({ b: t(types.string) }))]))
    expect(() => toWasmBindgenType(ref)).toThrow(/struct-merge/)
  })

  test("interface throws", () => {
    const ref = t(types.interface({ foo: t(types.method([], t(types.void))) }))
    expect(() => toWasmBindgenType(ref)).toThrow(/service\/trait-object/)
  })

  test("never throws", () => {
    expect(() => toWasmBindgenType(t(types.never))).toThrow(/bottom\/uninhabited/)
  })

  test("bare function (inline position, not a top-level declaration) throws", () => {
    const ref = t(types.function([], t(types.void)))
    expect(() => toWasmBindgenType(ref)).toThrow(/named top-level declaration/)
  })
})

describe("references (name pass-through, assumes declared elsewhere)", () => {
  test("instance -> className", () => {
    expect(toWasmBindgenType(t(types.instance("Widget", "widget.ts")))).toBe("Widget")
  })

  test("ref -> target", () => {
    expect(toWasmBindgenType(t(types.ref("Widget")))).toBe("Widget")
  })
})
