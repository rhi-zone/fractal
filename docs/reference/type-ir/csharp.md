# C#

Three projectors emit idiomatic C# 9+ `record`/`enum` declarations — one per
serialization library. C# has no structural/anonymous object type, so every
`object`/`enum`/(discriminated-)`union` `TypeRef` becomes a *named*
declaration; nested object-shaped fields spawn their own nested record
rather than inlining. All three share the same handler/context/entry-point
architecture (`ctx.decls` accumulates every declaration discovered during
the walk); only the attribute vocabulary — and, for Newtonsoft, the
polymorphism strategy — differs.

## System.Text.Json

```ts
import { toCSharp } from "@rhi-zone/fractal-type-ir/csharp"
// or: import { toCSharp } from "@rhi-zone/fractal-type-ir/csharp-systemtextjson"

toCSharp(t(types.object({
  id: t(types.integer),
  name: t(types.string),
  email: t(types.string),
  isActive: t(types.boolean),
  tags: t(types.array(t(types.string))),
})), "User")
```

```csharp
using System.Collections.Generic;
using System.Text.Json.Serialization;

public record User
{
    [JsonPropertyName("id")]
    public int Id { get; init; }

    [JsonPropertyName("name")]
    public string Name { get; init; }

    // ...

    [JsonPropertyName("tags")]
    public List<string> Tags { get; init; }
}
```

### Newtonsoft (Json.NET)

```ts
import { toCSharpNewtonsoft } from "@rhi-zone/fractal-type-ir/csharp-newtonsoft"
```

`[JsonProperty("wire-name")]` in place of STJ's `[JsonPropertyName]`.
Newtonsoft has no `[JsonPolymorphic]`/`[JsonDerivedType]` equivalent, so
unions fall back to a custom-converter encoding instead of STJ's built-in
polymorphism attributes:

```csharp
using Newtonsoft.Json;

public record User
{
    [JsonProperty("id")]
    public int Id { get; init; }
    // ...
}
```

### ServiceStack.Text

```ts
import { toCSharpServiceStack } from "@rhi-zone/fractal-type-ir/csharp-servicestack"
```

Reads the standard WCF `System.Runtime.Serialization` contract attributes —
`[DataContract]` on the type (switching its serializers into opt-in mode)
and `[DataMember(Name = "wire-name", IsRequired = ...)]` on every property,
unconditionally, since `[DataContract]` requires it:

```csharp
using System.Runtime.Serialization;

[DataContract]
public record User
{
    [DataMember(Name = "id", IsRequired = true)]
    public int Id { get; init; }
    // ...
}
```
