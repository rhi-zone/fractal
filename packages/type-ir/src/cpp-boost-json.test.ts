import { describe, expect, test } from "bun:test"
import { toBoostJson } from "./cpp-boost-json.ts"
import { t, types } from "./index.ts"
import { bytes, int32 } from "./kinds/common.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toBoostJson(t(types.boolean), "Flag")).toBe(["", "using Flag = bool;", ""].join("\n"))
  })

  test("string", () => {
    expect(toBoostJson(t(types.string), "Name")).toBe(
      ["#include <string>", "", "using Name = std::string;", ""].join("\n"),
    )
  })

  test("number maps to double", () => {
    expect(toBoostJson(t(types.number), "Amount")).toBe(["", "using Amount = double;", ""].join("\n"))
  })

  test("bare integer defaults to int64_t", () => {
    expect(toBoostJson(t(types.integer), "Count")).toBe(
      ["#include <cstdint>", "", "using Count = int64_t;", ""].join("\n"),
    )
  })

  test("int32 kind maps to int32_t", () => {
    expect(toBoostJson(int32(), "Count")).toBe(["#include <cstdint>", "", "using Count = int32_t;", ""].join("\n"))
  })

  test("bytes maps to std::vector<uint8_t>", () => {
    expect(toBoostJson(bytes(), "Blob")).toBe(
      ["#include <cstdint>", "#include <vector>", "", "using Blob = std::vector<uint8_t>;", ""].join("\n"),
    )
  })

  test("null maps to std::nullptr_t", () => {
    expect(toBoostJson(t(types.null), "Nothing")).toBe(
      ["#include <cstddef>", "", "using Nothing = std::nullptr_t;", ""].join("\n"),
    )
  })

  test("unknown falls back to boost::json::value", () => {
    expect(toBoostJson(t(types.unknown), "Anything")).toBe(
      ["#include <boost/json.hpp>", "", "using Anything = boost::json::value;", ""].join("\n"),
    )
  })
})

describe("struct", () => {
  test("emits a struct with tag_invoke value_from/value_to overloads", () => {
    const ref = t(
      types.object({
        id: t(types.string),
        age: t(types.integer, { optional: true }),
      }),
    )
    const out = toBoostJson(ref, "User")
    expect(out).toContain("#include <boost/json.hpp>")
    expect(out).toContain("struct User {")
    expect(out).toContain("std::string id;")
    expect(out).toContain("std::optional<int64_t> age;")
    expect(out).toContain(
      "inline void tag_invoke(const boost::json::value_from_tag&, boost::json::value& jv, const User& value) {",
    )
    expect(out).toContain('jv = { {"id", value.id}, {"age", value.age} };')
    expect(out).toContain(
      "inline User tag_invoke(const boost::json::value_to_tag<User>&, const boost::json::value& jv) {",
    )
    expect(out).toContain("const auto& obj = jv.as_object();")
    expect(out).toContain('boost::json::value_to<std::string>(obj.at("id")),')
    expect(out).toContain('boost::json::value_to<std::optional<int64_t>>(obj.at("age")),')
  })

  test("nested object field hoists to its own named struct declared first", () => {
    const ref = t(
      types.object({
        id: t(types.string),
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const out = toBoostJson(ref, "Account")
    expect(out.indexOf("struct Address {")).toBeGreaterThan(-1)
    expect(out.indexOf("struct Address {")).toBeLessThan(out.indexOf("struct Account {"))
    expect(out).toContain("Address address;")
    expect(out).toContain('jv = { {"id", value.id}, {"address", value.address} };')
    expect(out).toContain('boost::json::value_to<Address>(obj.at("address")),')
  })

  test("struct with no fields still emits value_from/value_to with an empty entry list", () => {
    const ref = t(types.object({}))
    const out = toBoostJson(ref, "Empty")
    expect(out).toContain("jv = {  };")
    expect(out).toContain("return Empty{\n\n  };")
  })
})

test("array maps to std::vector<T>", () => {
  expect(toBoostJson(t(types.array(t(types.string))), "Names")).toBe(
    ["#include <string>", "#include <vector>", "", "using Names = std::vector<std::string>;", ""].join("\n"),
  )
})

describe("map", () => {
  test("maps to std::map<K, V> by default", () => {
    expect(toBoostJson(t(types.map(t(types.string), t(types.number))), "Scores")).toBe(
      ["#include <map>", "#include <string>", "", "using Scores = std::map<std::string, double>;", ""].join("\n"),
    )
  })

  test("meta.unordered switches to std::unordered_map<K, V>", () => {
    const ref = t(types.map(t(types.string), t(types.number)), { unordered: true })
    expect(toBoostJson(ref, "Scores")).toBe(
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
  expect(toBoostJson(ref, "Pair")).toBe(
    ["#include <string>", "#include <tuple>", "", "using Pair = std::tuple<std::string, double>;", ""].join("\n"),
  )
})

describe("enum class", () => {
  test("emits enum class plus toString/fromString and tag_invoke overloads", () => {
    const ref = t(types.enum(["active", "inactive"]))
    const out = toBoostJson(ref, "Status")
    expect(out).toContain("enum class Status {")
    expect(out).toContain("inline std::string toString(Status value) {")
    expect(out).toContain("inline Status statusFromString(const std::string& value) {")
    expect(out).toContain(
      "inline void tag_invoke(const boost::json::value_from_tag&, boost::json::value& jv, Status value) {",
    )
    expect(out).toContain("jv = toString(value);")
    expect(out).toContain(
      "inline Status tag_invoke(const boost::json::value_to_tag<Status>&, const boost::json::value& jv) {",
    )
    expect(out).toContain("return statusFromString(std::string(jv.as_string()));")
  })
})

test("optional wraps in std::optional<T>", () => {
  const ref = t(types.string, { optional: true })
  expect(toBoostJson(ref, "Name")).toBe(
    ["#include <optional>", "#include <string>", "", "using Name = std::optional<std::string>;", ""].join("\n"),
  )
})

test("nullable also wraps in std::optional<T>", () => {
  const ref = t(types.string, { nullable: true })
  expect(toBoostJson(ref, "Name")).toBe(
    ["#include <optional>", "#include <string>", "", "using Name = std::optional<std::string>;", ""].join("\n"),
  )
})

test("union maps to std::variant<...>", () => {
  const ref = t(types.union([t(types.string), t(types.number)]))
  expect(toBoostJson(ref, "Value")).toBe(
    ["#include <string>", "#include <variant>", "", "using Value = std::variant<std::string, double>;", ""].join(
      "\n",
    ),
  )
})

test("instance renders the class name and expects it to be included by the caller", () => {
  const ref = t(types.instance("Account", "src/account.ts"))
  expect(toBoostJson(ref, "Owner")).toBe(["", "using Owner = Account;", ""].join("\n"))
})

test("ref renders the target name directly", () => {
  const ref = t(types.ref("User"))
  expect(toBoostJson(ref, "Alias")).toBe(["", "using Alias = User;", ""].join("\n"))
})

test("function maps to std::function<Ret(Params...)>", () => {
  const ref = t(types.function([{ name: "amount", type: t(types.number) }], t(types.void)))
  expect(toBoostJson(ref, "Callback")).toBe(
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
    const out = toBoostJson(ref, "Account")
    expect(out).toContain("class Account {")
    expect(out).toContain("virtual ~Account() = default;")
    expect(out).toContain("virtual void deposit(double amount) = 0;")
  })
})

test("unknown/unregistered kind falls back to boost::json::value", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} }
  expect(toBoostJson(ref, "Mystery")).toBe(
    ["#include <boost/json.hpp>", "", "using Mystery = boost::json::value;", ""].join("\n"),
  )
})
