# PHP

Three projectors emit readonly, constructor-promoted PHP 8.1+ classes — same
`PhpType` mapping and class shape throughout; only the annotation vocabulary
and (de)serialization mechanism differ.

## Native (JsonSerializable)

```ts
import { toPhp } from "@rhi-zone/fractal-type-ir/php"
// or: import { toPhp } from "@rhi-zone/fractal-type-ir/php-native"

toPhp(t(types.object({
  id: t(types.string),
  name: t(types.string),
  email: t(types.string),
  age: opt(t(types.integer)),
})), "User")
```

```php
final readonly class User implements \JsonSerializable
{
    public function __construct(
        public string $id,
        public string $name,
        public string $email,
        public ?int $age = null
    ) {}

    public function jsonSerialize(): array
    {
        return [
            "id" => $this->id,
            "name" => $this->name,
            "email" => $this->email,
            "age" => $this->age,
        ];
    }
}
```

Arrays/maps/tuples/enums PHP's type system can't fully express get a PHPDoc
annotation (`array<T>`/`array<K, V>`/`array{...}`) alongside the native type,
for PHPStan/Psalm.

### Symfony Serializer

```ts
import { toSymfony } from "@rhi-zone/fractal-type-ir/php-symfony"

toSymfony(t(types.object({ id: t(types.string) })), "Item")
```

No `jsonSerialize()` — Symfony's `ObjectNormalizer` walks the class's
properties reflectively, guided by `#[SerializedName(...)]` attributes:

```php
final readonly class Item
{
    public function __construct(
        #[SerializedName("id")]
        public string $id
    ) {}
}
```

### JMS Serializer

```ts
import { toJms } from "@rhi-zone/fractal-type-ir/php-jms"

toJms(t(types.object({ id: t(types.string) })), "Item")
```

JMS defaults to an "opt out" inclusion model, but the projector emits the
"opt in" idiom explicitly (`#[ExclusionPolicy('all')]` + `#[Expose]` per
property) alongside `#[Type(...)]`/`#[SerializedName(...)]`:

```php
#[ExclusionPolicy('all')]
final readonly class Item
{
    public function __construct(
        #[Type("string")] #[SerializedName("id")] #[Expose]
        public string $id
    ) {}
}
```
