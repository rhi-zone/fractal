# Java

Four projectors emit idiomatic Java 16+ source — records by default, POJOs
as an opt-in style (`options.style`) — one per JSON (de)serialization
library. All four share the same two-renderer split: a bare type-expression
renderer (`List<String>`, `OrderStatus`, `int`) and a full top-level
declaration renderer; the single exported entry point returns a declaration
when `name` is passed, a type expression otherwise. Only the annotation
vocabulary differs between variants.

## Jackson

```ts
import { toJava } from "@rhi-zone/fractal-type-ir/java"
// or: import { toJava } from "@rhi-zone/fractal-type-ir/java-jackson"

toJava(t(types.object({
  id: t(types.integer),
  name: t(types.string),
  email: t(types.string),
  isActive: t(types.boolean),
  tags: t(types.array(t(types.string))),
})), "User")
```

```java
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.annotation.JsonValue;
import java.util.List;

public record User(int id, String name, String email, @JsonProperty("isActive") boolean isactive, List<String> tags) {}
```

### Gson

```ts
import { toGson } from "@rhi-zone/fractal-type-ir/java-gson"
```

`@SerializedName("wire-name")` in place of Jackson's `@JsonProperty`:

```java
import com.google.gson.annotations.SerializedName;
// ...
public record User(int id, String name, String email, @SerializedName("isActive") boolean isactive, List<String> tags) {}
```

### Moshi

```ts
import { toMoshi } from "@rhi-zone/fractal-type-ir/java-moshi"
```

`@Json(name = "wire-name")` on the field, plus a class-level
`@JsonClass(generateAdapter = true)` Moshi's codegen scans for:

```java
import com.squareup.moshi.Json;
import com.squareup.moshi.JsonClass;
// ...
@JsonClass(generateAdapter = true)
public record User(int id, String name, String email, @Json(name = "isActive") boolean isactive, List<String> tags) {}
```

### JSON-B

```ts
import { toJsonb } from "@rhi-zone/fractal-type-ir/java-jsonb"
```

`@JsonbProperty("wire-name")` (from `jakarta.json.bind.annotation`) in place
of Jackson's `@JsonProperty`:

```java
import jakarta.json.bind.annotation.JsonbCreator;
import jakarta.json.bind.annotation.JsonbProperty;
// ...
public record User(int id, String name, String email, @JsonbProperty("isActive") boolean isactive, List<String> tags) {}
```
