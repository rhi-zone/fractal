# Swift

Three projectors emit idiomatic Swift types — one per (de)serialization
approach. `swift-codable` leans on the compiler's synthesized
`Codable` conformance; `swift-swiftyjson` and `swift-objectmapper` have no
compiler-driven derivation, so they hand-roll an initializer that reads each
field out of the library's own wrapper/operator API. Nested object/enum/
union fields hoist to sibling declarations (Swift has no anonymous
struct/enum literal syntax), same convention across all three.

## Codable

```ts
import { toSwift } from "@rhi-zone/fractal-type-ir/swift"
// or: import { toSwift } from "@rhi-zone/fractal-type-ir/swift-codable"

toSwift(t(types.object({
  id: t(types.integer),
  name: t(types.string),
  email: t(types.string),
  isActive: t(types.boolean),
  tags: t(types.array(t(types.string))),
})), "User")
```

```swift
struct User: Codable {
    var id: Int
    var name: String
    var email: String
    var isActive: Bool
    var tags: [String]
}
```

### SwiftyJSON

```ts
import { toSwiftyJSON } from "@rhi-zone/fractal-type-ir/swift-swiftyjson"
```

No `Codable` conformance — a plain struct plus a hand-written
`init(json: JSON)` that reads each field via SwiftyJSON's typed, never-throwing
accessors (`.stringValue`, `.intValue`, `.arrayValue`, …):

```swift
struct User {
    var id: Int
    // ...

    init(json: JSON) {
        self.id = json["id"].intValue
        self.name = json["name"].stringValue
        // ...
        self.tags = json["tags"].arrayValue.map { $0.stringValue }
    }
}
```

### ObjectMapper

```ts
import { toObjectMapper } from "@rhi-zone/fractal-type-ir/swift-objectmapper"
```

Conforms to `Mappable`; each property is wired with the `<-` operator inside
`mapping(map:)` instead of a synthesized or hand-written initializer.
Required fields are declared implicitly-unwrapped (`T!`) since `init?(map:)`
must construct something before `mapping(map:)` runs:

```swift
struct User: Mappable {
    var id: Int!
    // ...

    init?(map: Map) {}

    mutating func mapping(map: Map) {
        id <- map["id"]
        // ...
    }
}
```
