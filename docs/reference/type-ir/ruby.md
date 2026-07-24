# Ruby

Three projectors, three distinct conventions for the same shapes: Sorbet
(static-typing annotations checked by a separate tool), dry-types (runtime
composable coercion/validation), and RBS (the separate `.rbs` signature-file
format bundled with Ruby 3+).

## Sorbet

```ts
import { toRuby } from "@rhi-zone/fractal-type-ir/ruby"
// or: import { toRuby } from "@rhi-zone/fractal-type-ir/ruby-sorbet"

toRuby(t(types.object({
  id: t(types.string),
  name: t(types.string),
  email: t(types.string),
  age: opt(t(types.integer)),
})), "User")
```

```ruby
class User < T::Struct
  extend T::Sig

  prop :id, String
  prop :name, String
  prop :email, String
  prop :age, T.nilable(Integer), default: nil

  sig { returns(String) }
  def to_json(*_args)
    serialize.to_json
  end

  sig { params(json: String).returns(User) }
  def self.from_json(json)
    from_hash(JSON.parse(json))
  end
end
```

`toRubyClass(name, ref)` emits just the `T::Struct` class (no
`to_json`/`from_json` wrapper); `toRuby(ref, name?)` is the full entry point
shown above. A shape neither Sorbet nor this projector can express natively
(`interface`, a bare callable) degrades to `T.untyped` rather than fabricating
syntax.

### dry-types

```ts
import { toDry, toDryStruct } from "@rhi-zone/fractal-type-ir/ruby-dry-types"

toDryStruct("Item", t(types.object({ id: t(types.string) })))
```

dry-types is a *runtime* type system (coercion + validation), not a static
annotation layer — `Dry::Struct` classes built from `Types::` constants that
validate at construction time, no external checker involved:

```ruby
class Item < Dry::Struct
  transform_keys(&:to_sym)

  attribute :id, Types::String
end
```

### RBS

```ts
import { toRbsFile } from "@rhi-zone/fractal-type-ir/ruby-rbs"

toRbsFile(t(types.object({ id: t(types.string) })), "Item")
```

RBS lives in a *separate* `.rbs` file next to the `.rb` source — it describes
an existing class's shape rather than defining it, so `toRbsFile` emits both
read accessors and an `initialize` keyword-argument signature (RBS's only way
to express required-vs-defaulted, since there's no default-value syntax in
the signature file itself):

```
class Item
  def initialize: (id: String) -> void
  attr_reader id: String
end
```
