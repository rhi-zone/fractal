# C++

Five projectors emit C++17/20 struct/enum-class declarations, one per JSON
library — same field-mapping conventions (`array`→`std::vector`, `map`→
`std::map`, optional→`std::optional`), different serialization glue. Nested
`object`/`enum` fields hoist to their own top-level named declaration
(PascalCased from the field name) rather than nested classes, sidestepping
forward-declaration ordering.

## nlohmann/json

```ts
import { toCpp } from "@rhi-zone/fractal-type-ir/cpp"
// or: import { toCpp } from "@rhi-zone/fractal-type-ir/cpp-nlohmann"

toCpp(t(types.object({
  id: t(types.string),
  name: t(types.string),
  email: t(types.string),
  age: opt(t(types.integer)),
})), "User")
```

```cpp
#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

struct User {
  std::string id;
  std::string name;
  std::string email;
  std::optional<int64_t> age;

  NLOHMANN_DEFINE_TYPE_INTRUSIVE(User, id, name, email, age)
};
```

nlohmann's ADL-based `adl_serializer` handles `std::vector`/`std::optional`/
`std::map`/nested structs generically — the intrusive macro only has to name
the fields. `unknown` degrades to `nlohmann::json` itself.

### RapidJSON

```ts
import { toRapidjson } from "@rhi-zone/fractal-type-ir/cpp-rapidjson"

toRapidjson(t(types.object({
  street: t(types.string),
  city: t(types.string),
})), "Address")
```

RapidJSON has no ADL-based generic dispatch, so every conversion is spelled
out by hand against `rapidjson::Document`/`Value`:

```cpp
struct Address {
  std::string street;
  std::string city;

  rapidjson::Value toJson(rapidjson::Document::AllocatorType& allocator) const {
    rapidjson::Value v(rapidjson::kObjectType);
    v.AddMember("street", rapidjson::Value(street.c_str(), allocator), allocator);
    v.AddMember("city", rapidjson::Value(city.c_str(), allocator), allocator);
    return v;
  }

  static Address fromJson(const rapidjson::Value& v) {
    Address result;
    result.street = std::string(v["street"].GetString(), v["street"].GetStringLength());
    result.city = std::string(v["city"].GetString(), v["city"].GetStringLength());
    return result;
  }
};
```

`unknown` degrades to `rapidjson::Document` (not `Value`) specifically
because it owns its own allocator.

### simdjson

```ts
import { toSimdjson } from "@rhi-zone/fractal-type-ir/cpp-simdjson"

toSimdjson(t(types.object({ id: t(types.string) })), "Item")
```

simdjson's `dom` API is read-only by design — only `fromJson`, no `toJson`
counterpart:

```cpp
#include <simdjson.h>
#include <string>

struct Item {
  std::string id;

  static Item fromJson(simdjson::dom::element element) {
    Item result;
    result.id = std::string(element["id"].get_string().value());
    return result;
  }
};
```

### Boost.JSON

```ts
import { toBoostJson } from "@rhi-zone/fractal-type-ir/cpp-boost-json"

toBoostJson(t(types.object({ id: t(types.string) })), "Item")
```

Boost.JSON *does* have ADL-found generic conversion (`value_from`/`value_to`
recurse through containers on their own), so the generated `tag_invoke`
overloads only name the fields, closer to nlohmann's shape than RapidJSON's:

```cpp
inline void tag_invoke(const boost::json::value_from_tag&, boost::json::value& jv, const Item& value) {
  jv = { {"id", value.id} };
}

inline Item tag_invoke(const boost::json::value_to_tag<Item>&, const boost::json::value& jv) {
  const auto& obj = jv.as_object();
  return Item{
    boost::json::value_to<std::string>(obj.at("id")),
  };
}
```

### glaze

```ts
import { toGlaze } from "@rhi-zone/fractal-type-ir/cpp-glaze"

toGlaze(t(types.object({ id: t(types.string) })), "Item")
```

glaze reads the struct's shape through a `glz::meta<T>` specialization —
declare the field list once, get both read and write directions for free:

```cpp
template <>
struct glz::meta<Item> {
  using T = Item;
  static constexpr auto value = glz::object("id", &Item::id);
};
```
