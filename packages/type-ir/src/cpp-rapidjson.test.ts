import { describe, expect, test } from "bun:test"
import { toRapidjson } from "./cpp-rapidjson.ts"
import { t, types } from "./index.ts"
import { bytes, int32 } from "./kinds/common.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toRapidjson(t(types.boolean), "Flag")).toBe(["", "using Flag = bool;", ""].join("\n"))
  })

  test("string", () => {
    expect(toRapidjson(t(types.string), "Name")).toBe(
      ["#include <string>", "", "using Name = std::string;", ""].join("\n"),
    )
  })

  test("number maps to double", () => {
    expect(toRapidjson(t(types.number), "Amount")).toBe(["", "using Amount = double;", ""].join("\n"))
  })

  test("bare integer defaults to int64_t", () => {
    expect(toRapidjson(t(types.integer), "Count")).toBe(
      ["#include <cstdint>", "", "using Count = int64_t;", ""].join("\n"),
    )
  })

  test("int32 kind maps to int32_t", () => {
    expect(toRapidjson(int32(), "Count")).toBe(["#include <cstdint>", "", "using Count = int32_t;", ""].join("\n"))
  })

  test("bytes maps to std::vector<uint8_t>", () => {
    expect(toRapidjson(bytes(), "Blob")).toBe(
      ["#include <cstdint>", "#include <vector>", "", "using Blob = std::vector<uint8_t>;", ""].join("\n"),
    )
  })

  test("null maps to std::nullptr_t", () => {
    expect(toRapidjson(t(types.null), "Nothing")).toBe(
      ["#include <cstddef>", "", "using Nothing = std::nullptr_t;", ""].join("\n"),
    )
  })

  test("unknown falls back to rapidjson::Document", () => {
    expect(toRapidjson(t(types.unknown), "Anything")).toBe(
      ["#include <rapidjson/document.h>", "", "using Anything = rapidjson::Document;", ""].join("\n"),
    )
  })
})

describe("struct", () => {
  test("emits a struct with hand-generated toJson/fromJson", () => {
    const ref = t(
      types.object({
        id: t(types.string),
        age: t(types.integer, { optional: true }),
      }),
    )
    const out = toRapidjson(ref, "User")
    expect(out).toContain("#include <rapidjson/document.h>")
    expect(out).toContain("struct User {")
    expect(out).toContain("std::string id;")
    expect(out).toContain("std::optional<int64_t> age;")
    expect(out).toContain("rapidjson::Value toJson(rapidjson::Document::AllocatorType& allocator) const {")
    expect(out).toContain('v.AddMember("id", rapidjson::Value(id.c_str(), allocator), allocator);')
    expect(out).toContain("static User fromJson(const rapidjson::Value& v) {")
    expect(out).toContain('result.id = std::string(v["id"].GetString(), v["id"].GetStringLength());')
    expect(out).toContain(
      'result.age = v.HasMember("age") && !v["age"].IsNull() ? std::make_optional(v["age"].GetInt64()) : std::nullopt;',
    )
  })

  test("nested object field hoists to its own named struct declared first", () => {
    const ref = t(
      types.object({
        id: t(types.string),
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const out = toRapidjson(ref, "Account")
    expect(out.indexOf("struct Address {")).toBeGreaterThan(-1)
    expect(out.indexOf("struct Address {")).toBeLessThan(out.indexOf("struct Account {"))
    expect(out).toContain("Address address;")
    expect(out).toContain('v.AddMember("address", address.toJson(allocator), allocator);')
    expect(out).toContain('result.address = Address::fromJson(v["address"]);')
  })

  test("array field serializes via a PushBack loop, deserializes via GetArray", () => {
    const ref = t(types.object({ tags: t(types.array(t(types.string))) }))
    const out = toRapidjson(ref, "Doc")
    expect(out).toContain("rapidjson::Value arr(rapidjson::kArrayType)")
    expect(out).toContain("arr.PushBack(rapidjson::Value(item.c_str(), allocator), allocator)")
    expect(out).toContain('v["tags"].GetArray()')
  })

  test("map field serializes via AddMember loop, deserializes via MemberBegin/MemberEnd", () => {
    const ref = t(types.object({ scores: t(types.map(t(types.string), t(types.number))) }))
    const out = toRapidjson(ref, "Doc")
    expect(out).toContain("rapidjson::Value obj(rapidjson::kObjectType)")
    expect(out).toContain('for (auto it = v["scores"].MemberBegin(); it != v["scores"].MemberEnd(); ++it)')
  })
})

test("array maps to std::vector<T>", () => {
  expect(toRapidjson(t(types.array(t(types.string))), "Names")).toBe(
    ["#include <string>", "#include <vector>", "", "using Names = std::vector<std::string>;", ""].join("\n"),
  )
})

describe("map", () => {
  test("maps to std::map<K, V> by default", () => {
    expect(toRapidjson(t(types.map(t(types.string), t(types.number))), "Scores")).toBe(
      ["#include <map>", "#include <string>", "", "using Scores = std::map<std::string, double>;", ""].join("\n"),
    )
  })

  test("meta.unordered switches to std::unordered_map<K, V>", () => {
    const ref = t(types.map(t(types.string), t(types.number)), { unordered: true })
    expect(toRapidjson(ref, "Scores")).toBe(
      [
        "#include <string>",
        "#include <unordered_map>",
        "",
        "using Scores = std::unordered_map<std::string, double>;",
        "",
      ].join("\n"),
    )
  })
})

test("tuple maps to std::tuple<...>", () => {
  const ref = t(types.tuple([t(types.string), t(types.number)]))
  expect(toRapidjson(ref, "Pair")).toBe(
    ["#include <string>", "#include <tuple>", "", "using Pair = std::tuple<std::string, double>;", ""].join("\n"),
  )
})

describe("enum class", () => {
  test("emits enum class plus toString/fromString/toJson/fromJson", () => {
    const ref = t(types.enum(["active", "inactive"]))
    const out = toRapidjson(ref, "Status")
    expect(out).toContain("enum class Status {")
    expect(out).toContain("inline std::string toString(Status value) {")
    expect(out).toContain("inline Status statusFromString(const std::string& value) {")
    expect(out).toContain(
      "inline rapidjson::Value toJson(Status value, rapidjson::Document::AllocatorType& allocator) {",
    )
    expect(out).toContain("return rapidjson::Value(toString(value).c_str(), allocator);")
    expect(out).toContain("inline Status statusFromJson(const rapidjson::Value& v) {")
    expect(out).toContain("return statusFromString(std::string(v.GetString(), v.GetStringLength()));")
  })
})

test("optional wraps in std::optional<T>", () => {
  const ref = t(types.string, { optional: true })
  expect(toRapidjson(ref, "Name")).toBe(
    ["#include <optional>", "#include <string>", "", "using Name = std::optional<std::string>;", ""].join("\n"),
  )
})

test("nullable also wraps in std::optional<T>", () => {
  const ref = t(types.string, { nullable: true })
  expect(toRapidjson(ref, "Name")).toBe(
    ["#include <optional>", "#include <string>", "", "using Name = std::optional<std::string>;", ""].join("\n"),
  )
})

test("union maps to std::variant<...>", () => {
  const ref = t(types.union([t(types.string), t(types.number)]))
  expect(toRapidjson(ref, "Value")).toBe(
    ["#include <string>", "#include <variant>", "", "using Value = std::variant<std::string, double>;", ""].join(
      "\n",
    ),
  )
})

describe("union field serialization dispatch", () => {
  test("struct field serializes via std::visit/if-constexpr, deserializes via Is*-check probing", () => {
    const ref = t(types.object({ value: t(types.union([t(types.string), t(types.number)])) }))
    const out = toRapidjson(ref, "Wrapper")
    expect(out).toContain("std::visit([&](const auto& v) -> rapidjson::Value {")
    expect(out).toContain("if constexpr (std::is_same_v<T_, std::string>)")
    expect(out).toContain('if (v["value"].IsString()) return')
    expect(out).toContain('if (v["value"].IsNumber()) return')
  })
})

test("instance renders the class name and expects it to be included by the caller", () => {
  const ref = t(types.instance("Account", "src/account.ts"))
  expect(toRapidjson(ref, "Owner")).toBe(["", "using Owner = Account;", ""].join("\n"))
})

test("ref renders the target name directly", () => {
  const ref = t(types.ref("User"))
  expect(toRapidjson(ref, "Alias")).toBe(["", "using Alias = User;", ""].join("\n"))
})

test("function maps to std::function<Ret(Params...)>", () => {
  const ref = t(types.function([{ name: "amount", type: t(types.number) }], t(types.void)))
  expect(toRapidjson(ref, "Callback")).toBe(
    ["#include <functional>", "", "using Callback = std::function<void(double)>;", ""].join("\n"),
  )
})

describe("interface", () => {
  test("emits an abstract class of pure-virtual methods", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
      }),
    )
    const out = toRapidjson(ref, "Account")
    expect(out).toContain("class Account {")
    expect(out).toContain("virtual ~Account() = default;")
    expect(out).toContain("virtual void deposit(double amount) = 0;")
  })
})

test("unknown/unregistered kind falls back to rapidjson::Document", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} }
  expect(toRapidjson(ref, "Mystery")).toBe(
    ["#include <rapidjson/document.h>", "", "using Mystery = rapidjson::Document;", ""].join("\n"),
  )
})
