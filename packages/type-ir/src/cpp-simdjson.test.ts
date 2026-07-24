import { describe, expect, test } from "bun:test"
import { toSimdjson } from "./cpp-simdjson.ts"
import { t, types } from "./index.ts"
import { bytes, int32 } from "./kinds/common.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toSimdjson(t(types.boolean), "Flag")).toBe(["", "using Flag = bool;", ""].join("\n"))
  })

  test("string", () => {
    expect(toSimdjson(t(types.string), "Name")).toBe(
      ["#include <string>", "", "using Name = std::string;", ""].join("\n"),
    )
  })

  test("number maps to double", () => {
    expect(toSimdjson(t(types.number), "Amount")).toBe(["", "using Amount = double;", ""].join("\n"))
  })

  test("bare integer defaults to int64_t", () => {
    expect(toSimdjson(t(types.integer), "Count")).toBe(
      ["#include <cstdint>", "", "using Count = int64_t;", ""].join("\n"),
    )
  })

  test("int32 kind maps to int32_t", () => {
    expect(toSimdjson(int32(), "Count")).toBe(["#include <cstdint>", "", "using Count = int32_t;", ""].join("\n"))
  })

  test("bytes maps to std::vector<uint8_t>", () => {
    expect(toSimdjson(bytes(), "Blob")).toBe(
      ["#include <cstdint>", "#include <vector>", "", "using Blob = std::vector<uint8_t>;", ""].join("\n"),
    )
  })

  test("null maps to std::nullptr_t", () => {
    expect(toSimdjson(t(types.null), "Nothing")).toBe(
      ["#include <cstddef>", "", "using Nothing = std::nullptr_t;", ""].join("\n"),
    )
  })

  test("unknown falls back to simdjson::dom::element", () => {
    expect(toSimdjson(t(types.unknown), "Anything")).toBe(
      ["#include <simdjson.h>", "", "using Anything = simdjson::dom::element;", ""].join("\n"),
    )
  })
})

describe("struct", () => {
  test("emits a struct with a read-only fromJson, no toJson counterpart", () => {
    const ref = t(
      types.object({
        id: t(types.string),
        age: t(types.integer, { optional: true }),
      }),
    )
    const out = toSimdjson(ref, "User")
    expect(out).toContain("#include <simdjson.h>")
    expect(out).toContain("struct User {")
    expect(out).toContain("std::string id;")
    expect(out).toContain("std::optional<int64_t> age;")
    expect(out).toContain("static User fromJson(simdjson::dom::element element) {")
    expect(out).toContain('result.id = std::string(element["id"].get_string().value());')
    expect(out).toContain(
      'result.age = element["age"].error() == simdjson::SUCCESS ? std::make_optional(element["age"].value().get_int64().value()) : std::nullopt;',
    )
    expect(out).not.toContain("toJson")
  })

  test("nested object field hoists to its own named struct declared first", () => {
    const ref = t(
      types.object({
        id: t(types.string),
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const out = toSimdjson(ref, "Account")
    expect(out.indexOf("struct Address {")).toBeGreaterThan(-1)
    expect(out.indexOf("struct Address {")).toBeLessThan(out.indexOf("struct Account {"))
    expect(out).toContain("Address address;")
    expect(out).toContain('result.address = Address::fromJson(element["address"]);')
  })

  test("array field deserializes via a get_array() loop", () => {
    const ref = t(types.object({ tags: t(types.array(t(types.string))) }))
    const out = toSimdjson(ref, "Doc")
    expect(out).toContain('for (simdjson::dom::element item : element["tags"].get_array())')
    expect(out).toContain("result.push_back(std::string(item.get_string().value()));")
  })

  test("map field deserializes via a get_object() key_value_pair loop", () => {
    const ref = t(types.object({ scores: t(types.map(t(types.string), t(types.number))) }))
    const out = toSimdjson(ref, "Doc")
    expect(out).toContain('for (simdjson::dom::key_value_pair field : element["scores"].get_object())')
    expect(out).toContain("result.emplace(std::string(field.key), field.value.get_double().value());")
  })
})

test("array maps to std::vector<T>", () => {
  expect(toSimdjson(t(types.array(t(types.string))), "Names")).toBe(
    ["#include <string>", "#include <vector>", "", "using Names = std::vector<std::string>;", ""].join("\n"),
  )
})

describe("map", () => {
  test("maps to std::map<K, V> by default", () => {
    expect(toSimdjson(t(types.map(t(types.string), t(types.number))), "Scores")).toBe(
      ["#include <map>", "#include <string>", "", "using Scores = std::map<std::string, double>;", ""].join("\n"),
    )
  })

  test("meta.unordered switches to std::unordered_map<K, V>", () => {
    const ref = t(types.map(t(types.string), t(types.number)), { unordered: true })
    expect(toSimdjson(ref, "Scores")).toBe(
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
  expect(toSimdjson(ref, "Pair")).toBe(
    ["#include <string>", "#include <tuple>", "", "using Pair = std::tuple<std::string, double>;", ""].join("\n"),
  )
})

describe("enum class", () => {
  test("emits enum class plus fromString/fromJson, no toString/toJson", () => {
    const ref = t(types.enum(["active", "inactive"]))
    const out = toSimdjson(ref, "Status")
    expect(out).toContain("enum class Status {")
    expect(out).toContain("inline Status statusFromString(std::string_view value) {")
    expect(out).toContain("inline Status statusFromJson(simdjson::dom::element element) {")
    expect(out).toContain("return statusFromString(std::string_view(element.get_string().value()));")
    expect(out).not.toContain("toString")
    expect(out).not.toContain("toJson")
  })
})

test("optional wraps in std::optional<T>", () => {
  const ref = t(types.string, { optional: true })
  expect(toSimdjson(ref, "Name")).toBe(
    ["#include <optional>", "#include <string>", "", "using Name = std::optional<std::string>;", ""].join("\n"),
  )
})

test("nullable also wraps in std::optional<T>", () => {
  const ref = t(types.string, { nullable: true })
  expect(toSimdjson(ref, "Name")).toBe(
    ["#include <optional>", "#include <string>", "", "using Name = std::optional<std::string>;", ""].join("\n"),
  )
})

test("union maps to std::variant<...>", () => {
  const ref = t(types.union([t(types.string), t(types.number)]))
  expect(toSimdjson(ref, "Value")).toBe(
    ["#include <string>", "#include <variant>", "", "using Value = std::variant<std::string, double>;", ""].join(
      "\n",
    ),
  )
})

describe("union field deserialization dispatch", () => {
  test("struct field probes with is_string()/is_number() in declaration order", () => {
    const ref = t(types.object({ value: t(types.union([t(types.string), t(types.number)])) }))
    const out = toSimdjson(ref, "Wrapper")
    expect(out).toContain('if (element["value"].is_string()) return')
    expect(out).toContain('if (element["value"].is_number()) return')
  })
})

test("instance renders the class name and expects it to be included by the caller", () => {
  const ref = t(types.instance("Account", "src/account.ts"))
  expect(toSimdjson(ref, "Owner")).toBe(["", "using Owner = Account;", ""].join("\n"))
})

test("ref renders the target name directly", () => {
  const ref = t(types.ref("User"))
  expect(toSimdjson(ref, "Alias")).toBe(["", "using Alias = User;", ""].join("\n"))
})

test("function maps to std::function<Ret(Params...)>", () => {
  const ref = t(types.function([{ name: "amount", type: t(types.number) }], t(types.void)))
  expect(toSimdjson(ref, "Callback")).toBe(
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
    const out = toSimdjson(ref, "Account")
    expect(out).toContain("class Account {")
    expect(out).toContain("virtual ~Account() = default;")
    expect(out).toContain("virtual void deposit(double amount) = 0;")
  })
})

test("unknown/unregistered kind falls back to simdjson::dom::element", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} }
  expect(toSimdjson(ref, "Mystery")).toBe(
    ["#include <simdjson.h>", "", "using Mystery = simdjson::dom::element;", ""].join("\n"),
  )
})
