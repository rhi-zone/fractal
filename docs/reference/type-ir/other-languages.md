# Other Languages

Five more single-projector language targets, each with its own honest-degrade
conventions for shapes the target can't express natively.

## Haskell (aeson)

```ts
import { toHaskell } from "@rhi-zone/fractal-type-ir/haskell"
// or: import { toHaskell } from "@rhi-zone/fractal-type-ir/haskell-aeson"

toHaskell(t(types.object({
  id: t(types.string),
  name: t(types.string),
  email: t(types.string),
  age: opt(t(types.integer)),
})), "User")
```

```haskell
data User = User
  { userId :: Text
  , userName :: Text
  , userEmail :: Text
  , userAge :: Maybe Int
  } deriving (Show, Eq, Generic)

userFieldLabel :: String -> String
userFieldLabel s = case drop 4 s of
  (c : rest) -> toLower c : rest
  []         -> []

instance ToJSON User where
  toJSON = genericToJSON defaultOptions { fieldLabelModifier = userFieldLabel }

instance FromJSON User where
  parseJSON = genericParseJSON defaultOptions { fieldLabelModifier = userFieldLabel }
```

Haskell has no anonymous structural type, so record fields are prefixed with
the lowercased type name (`userId`, not `id`) to avoid top-level name clashes
between different records — `fieldLabelModifier` strips the prefix back off
at the JSON boundary. Every nested `object`/`enum`/`union` hoists to its own
named `data` declaration.

## Elm

```ts
import { toElm } from "@rhi-zone/fractal-type-ir/elm"
// or: import { toElm } from "@rhi-zone/fractal-type-ir/elm-json"

toElm(t(types.object({
  id: t(types.string),
  age: opt(t(types.integer)),
})), "User")
```

```elm
type alias User =
    { id : String
    , age : Maybe Int
    }


userDecoder : Decoder User
userDecoder =
    Decode.succeed User
        |> andMap (Decode.field "id" Decode.string)
        |> andMap (Decode.maybe (Decode.field "age" Decode.int))


encodeUser : User -> Encode.Value
encodeUser value =
    Encode.object
        [ ( "id", Encode.string value.id )
        , ( "age", encodeMaybe (\v -> Encode.int v) value.age )
        ]
```

Generated code needs `elm/json` and `elm-community/json-extra` (for
`andMap`) as dependencies. A union/enum encountered as a nested field is
hoisted to a synthetic top-level `type`/decoder/encoder triple; anonymous
record types don't need this since Elm supports inline `{ field : T }`.

## Flow

```ts
import { toFlow } from "@rhi-zone/fractal-type-ir/flow"
// or: import { toFlow } from "@rhi-zone/fractal-type-ir/flow-native"

toFlow(t(types.object({
  id: t(types.string),
  age: opt(t(types.integer)),
})))
```

```js
// @flow
export type User = {| id: string, age?: number |};
```

Structurally close to the TypeScript projector, but `unknown`→`mixed`,
`never`→`empty`, objects default to Flow's *exact* form (`{| ... |}`, opt out
via `meta.exact === false`), and readonly fields use the covariant-property
marker (`+name: T`) instead of a `readonly` keyword.

## Objective-C (Foundation)

```ts
import { toObjC } from "@rhi-zone/fractal-type-ir/objc"
// or: import { toObjC } from "@rhi-zone/fractal-type-ir/objc-foundation"

toObjC(t(types.object({ id: t(types.string) })), "Item")
// => { header: "...", implementation: "..." }
```

`toObjC` returns `{ header, implementation }` — separate `.h`/`.m` content,
not a single string. Every `object` field needs a name to become a class, so
nested objects hoist to `${ParentClassName}${CapitalizedFieldName}` siblings,
the same convention capnp.ts uses:

```objc
// Item.h
NS_ASSUME_NONNULL_BEGIN

@interface Item : NSObject

@property (nonatomic, copy) NSString *id;

- (instancetype)initWithDictionary:(NSDictionary<NSString *, id> *)dictionary;
- (NSDictionary<NSString *, id> *)toDictionary;

@end

NS_ASSUME_NONNULL_END
```

Scalar (non-pointer) properties that are required unbox on read/box on
write; optional scalars are typed `NSNumber *` instead so a missing value can
be `nil`.

## Crystal (JSON::Serializable)

```ts
import { toCrystal } from "@rhi-zone/fractal-type-ir/crystal"
// or: import { toCrystal } from "@rhi-zone/fractal-type-ir/crystal-json-serializable"

toCrystal(t(types.object({
  id: t(types.string),
  name: t(types.string),
  email: t(types.string),
  age: opt(t(types.integer)),
})), "User")
```

```crystal
class User
  include JSON::Serializable

  property id : String
  property name : String
  property email : String
  property age : Int32?
end
```

Like Haskell/Crystal's other structural peers, `object`/`enum` needs a name
to become a declaration; without one, `toCrystal` degrades to the inline
`toCrystalType` expression (`meta.structName` if supplied, else an opaque
degrade) since Crystal has no anonymous struct syntax.
