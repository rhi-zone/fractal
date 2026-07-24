# Kotlin

Three projectors emit idiomatic Kotlin `data class`/`enum class`/`sealed
class` declarations — one per JSON library. All three share the same
`toKotlinType`/`toKotlin`/`toKotlinDeclarations` split (a bare type
expression, a single declaration, and a whole-registry batch renderer for
recursive/shared types); only the annotation vocabulary and, for Gson, field
inclusion semantics differ.

## kotlinx.serialization

```ts
import { toKotlin } from "@rhi-zone/fractal-type-ir/kotlin"
// or: import { toKotlin } from "@rhi-zone/fractal-type-ir/kotlin-kotlinx"

toKotlin(t(types.object({
  id: t(types.integer),
  name: t(types.string),
  email: t(types.string),
  isActive: t(types.boolean),
  tags: t(types.array(t(types.string))),
})), "User")
```

```kotlin
@Serializable
data class User(
    @SerialName("id") var id: Int,
    @SerialName("name") var name: String,
    @SerialName("email") var email: String,
    @SerialName("isActive") var isActive: Boolean,
    @SerialName("tags") var tags: List<String>
)
```

### Jackson

```ts
import { toKotlin } from "@rhi-zone/fractal-type-ir/kotlin-jackson"
```

`com.fasterxml.jackson.module.kotlin` reads Kotlin constructor parameters
reflectively when their name already matches the wire name, so no
per-field annotation is needed here — only a class-level
`@JsonIgnoreProperties(ignoreUnknown = true)`:

```kotlin
@JsonIgnoreProperties(ignoreUnknown = true)
data class User(
    var id: Int,
    var name: String,
    // ...
)
```

### Gson

```ts
import { toKotlinGson } from "@rhi-zone/fractal-type-ir/kotlin-gson"
```

`@SerializedName("wire-name")` per field (no class-level marker — Gson reads
Kotlin properties reflectively), plus `@Expose` by default since this
projector can't know the caller's `GsonBuilder` configuration:

```kotlin
data class User(
    @SerializedName("id") @Expose var id: Int,
    @SerializedName("name") @Expose var name: String,
    // ...
)
```
