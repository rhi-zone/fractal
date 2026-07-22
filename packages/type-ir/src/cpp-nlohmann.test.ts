import { describe, expect, test } from "bun:test"
import { toCpp } from "./cpp-nlohmann.ts"
import { t, types } from "./index.ts"
import { bytes, int32 } from "./kinds/common.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toCpp(t(types.boolean), "Flag")).toBe(["", "using Flag = bool;", ""].join("\n"))
  })

  test("string", () => {
    expect(toCpp(t(types.string), "Name")).toBe(
      ["#include <string>", "", "using Name = std::string;", ""].join("\n"),
    )
  })

  test("number maps to double", () => {
    expect(toCpp(t(types.number), "Amount")).toBe(["", "using Amount = double;", ""].join("\n"))
  })

  test("bare integer defaults to int64_t", () => {
    expect(toCpp(t(types.integer), "Count")).toBe(
      ["#include <cstdint>", "", "using Count = int64_t;", ""].join("\n"),
    )
  })

  test("int32 kind maps to int32_t", () => {
    expect(toCpp(int32(), "Count")).toBe(["#include <cstdint>", "", "using Count = int32_t;", ""].join("\n"))
  })

  test("bytes maps to std::vector<uint8_t>", () => {
    expect(toCpp(bytes(), "Blob")).toBe(
      [
        "#include <cstdint>",
        "#include <vector>",
        "",
        "using Blob = std::vector<uint8_t>;",
        "",
      ].join("\n"),
    )
  })

  test("null maps to std::nullptr_t", () => {
    expect(toCpp(t(types.null), "Nothing")).toBe(
      ["#include <cstddef>", "", "using Nothing = std::nullptr_t;", ""].join("\n"),
    )
  })

  test("unknown falls back to nlohmann::json", () => {
    expect(toCpp(t(types.unknown), "Anything")).toBe(
      ["#include <nlohmann/json.hpp>", "", "using Anything = nlohmann::json;", ""].join("\n"),
    )
  })
})

describe("struct", () => {
  test("emits a struct with NLOHMANN_DEFINE_TYPE_INTRUSIVE", () => {
    const ref = t(
      types.object({
        id: t(types.string),
        age: t(types.integer, { optional: true }),
      }),
    )
    expect(toCpp(ref, "User")).toBe(
      [
        "#include <cstdint>",
        "#include <nlohmann/json.hpp>",
        "#include <optional>",
        "#include <string>",
        "",
        "struct User {",
        "  std::string id;",
        "  std::optional<int64_t> age;",
        "",
        "  NLOHMANN_DEFINE_TYPE_INTRUSIVE(User, id, age)",
        "};",
      ].join("\n") + "\n",
    )
  })

  test("nested object field hoists to its own named struct declared first", () => {
    const ref = t(
      types.object({
        id: t(types.string),
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const out = toCpp(ref, "Account")
    expect(out.indexOf("struct Address {")).toBeGreaterThan(-1)
    expect(out.indexOf("struct Address {")).toBeLessThan(out.indexOf("struct Account {"))
    expect(out).toContain("Address address;")
    expect(out).toContain("NLOHMANN_DEFINE_TYPE_INTRUSIVE(Account, id, address)")
  })
})

test("array maps to std::vector<T>", () => {
  expect(toCpp(t(types.array(t(types.string))), "Names")).toBe(
    ["#include <string>", "#include <vector>", "", "using Names = std::vector<std::string>;", ""].join("\n"),
  )
})

describe("map", () => {
  test("maps to std::map<K, V> by default", () => {
    expect(toCpp(t(types.map(t(types.string), t(types.number))), "Scores")).toBe(
      ["#include <map>", "#include <string>", "", "using Scores = std::map<std::string, double>;", ""].join(
        "\n",
      ),
    )
  })

  test("meta.unordered switches to std::unordered_map<K, V>", () => {
    const ref = t(types.map(t(types.string), t(types.number)), { unordered: true })
    expect(toCpp(ref, "Scores")).toBe(
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
  expect(toCpp(ref, "Pair")).toBe(
    ["#include <string>", "#include <tuple>", "", "using Pair = std::tuple<std::string, double>;", ""].join(
      "\n",
    ),
  )
})

describe("enum class", () => {
  test("emits enum class plus toString/fromString/to_json/from_json", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toCpp(ref, "Status")).toBe(
      [
        "#include <nlohmann/json.hpp>",
        "#include <stdexcept>",
        "#include <string>",
        "",
        "enum class Status {",
        "  Active,",
        "  Inactive,",
        "};",
        "",
        "inline std::string toString(Status value) {",
        "  switch (value) {",
        '    case Status::Active: return "active";',
        '    case Status::Inactive: return "inactive";',
        "  }",
        '  throw std::invalid_argument("invalid Status");',
        "}",
        "",
        "inline Status statusFromString(const std::string& value) {",
        '  if (value == "active") return Status::Active;',
        '  if (value == "inactive") return Status::Inactive;',
        '  throw std::invalid_argument("invalid Status: " + value);',
        "}",
        "",
        "inline void to_json(nlohmann::json& j, const Status& value) { j = toString(value); }",
        "inline void from_json(const nlohmann::json& j, Status& value) { value = statusFromString(j.get<std::string>()); }",
      ].join("\n") + "\n",
    )
  })
})

test("optional wraps in std::optional<T>", () => {
  const ref = t(types.string, { optional: true })
  expect(toCpp(ref, "Name")).toBe(
    ["#include <optional>", "#include <string>", "", "using Name = std::optional<std::string>;", ""].join(
      "\n",
    ),
  )
})

test("nullable also wraps in std::optional<T>", () => {
  const ref = t(types.string, { nullable: true })
  expect(toCpp(ref, "Name")).toBe(
    ["#include <optional>", "#include <string>", "", "using Name = std::optional<std::string>;", ""].join(
      "\n",
    ),
  )
})

test("union maps to std::variant<...>", () => {
  const ref = t(types.union([t(types.string), t(types.number)]))
  expect(toCpp(ref, "Value")).toBe(
    ["#include <string>", "#include <variant>", "", "using Value = std::variant<std::string, double>;", ""].join(
      "\n",
    ),
  )
})

describe("nlohmann serialization", () => {
  test("struct fields list feeds NLOHMANN_DEFINE_TYPE_INTRUSIVE in declaration order", () => {
    const ref = t(types.object({ b: t(types.string), a: t(types.number) }))
    const out = toCpp(ref, "Pair")
    expect(out).toContain("NLOHMANN_DEFINE_TYPE_INTRUSIVE(Pair, b, a)")
  })

  test("struct with no fields still emits the macro with just the type name", () => {
    const ref = t(types.object({}))
    const out = toCpp(ref, "Empty")
    expect(out).toContain("NLOHMANN_DEFINE_TYPE_INTRUSIVE(Empty)")
  })

  test("enum class serializes via string value, not ordinal", () => {
    const ref = t(types.enum(["a", "b"]))
    const out = toCpp(ref, "Letter")
    expect(out).toContain('j = toString(value)')
    expect(out).toContain("j.get<std::string>()")
  })
})

test("instance renders the class name and expects it to be included by the caller", () => {
  const ref = t(types.instance("Account", "src/account.ts"))
  expect(toCpp(ref, "Owner")).toBe(["", "using Owner = Account;", ""].join("\n"))
})

test("ref renders the target name directly", () => {
  const ref = t(types.ref("User"))
  expect(toCpp(ref, "Alias")).toBe(["", "using Alias = User;", ""].join("\n"))
})

test("function maps to std::function<Ret(Params...)>", () => {
  const ref = t(types.function([{ name: "amount", type: t(types.number) }], t(types.void)))
  expect(toCpp(ref, "Callback")).toBe(
    [
      "#include <functional>",
      "",
      "using Callback = std::function<void(double)>;",
      "",
    ].join("\n"),
  )
})

describe("interface", () => {
  test("emits an abstract class of pure-virtual methods", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
      }),
    )
    const out = toCpp(ref, "Account")
    expect(out).toContain("class Account {")
    expect(out).toContain("virtual ~Account() = default;")
    expect(out).toContain("virtual void deposit(double amount) = 0;")
  })
})

test("unknown/unregistered kind falls back to nlohmann::json", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} }
  expect(toCpp(ref, "Mystery")).toBe(
    ["#include <nlohmann/json.hpp>", "", "using Mystery = nlohmann::json;", ""].join("\n"),
  )
})
