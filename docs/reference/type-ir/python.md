# Python

`@rhi-zone/fractal-type-ir` ships one projector per Python class-definition convention:
stdlib `@dataclass`, Pydantic v2 `BaseModel`, `attrs.define`, `msgspec.Struct`, and cattrs
(an `attrs.define` class paired with a `cattrs.Converter`). Unlike the single-expression
TypeScript projectors, these render a whole *module*: every nested `object`/`enum` field gets
promoted to its own top-level declaration (named from the field), and `toX(ref, name)` returns
the full source text — imports, declarations, and (for cattrs) converter preamble — as one
string.

## Python (dataclass)

```ts
import { t, types } from "@rhi-zone/fractal-type-ir"
import { toPython } from "@rhi-zone/fractal-type-ir/python"

const user = t(types.object({ id: t(types.string), age: t(types.integer) }))
toPython(user, "User")
```

```python
from __future__ import annotations
from dataclasses import dataclass

@dataclass
class User:
    id: str
    age: int
```

Optional fields render as `Optional[T] = None` and are sorted after required fields (a
positional-default constraint dataclass `__init__` imposes that the other four projectors,
which take `**data`/keyword-only init, don't). A nested `object`/`enum` field is promoted to
its own `@dataclass`/`class ...(Enum)` declaration above the parent, named from the field.

### Pydantic

```ts
import { toPydantic } from "@rhi-zone/fractal-type-ir/python-pydantic"

const person = t(types.object({ name: t(types.string), nickname: t(types.string, { optional: true }) }))
toPydantic(person, "Person")
```

```python
from __future__ import annotations
from pydantic import BaseModel

class Person(BaseModel):
    name: str
    nickname: str | None = None
```

Optional fields use PEP 604 `T | None = None` and keep source order (Pydantic's `BaseModel`
takes keyword data, so there's no positional-default reason to reorder). Constraints
(`minLength`/`pattern`/…) become `Annotated[T, Field(...)]`; `meta.discriminator` on a union
becomes `Annotated[Union[...], Discriminator(...)]`.

### attrs

```ts
import { toAttrs } from "@rhi-zone/fractal-type-ir/python-attrs"

toAttrs(person, "Person")
```

```python
from __future__ import annotations
import attrs

@attrs.define()
class Person:
    name: str
    nickname: str | None = None
```

Same `T | None = None` optional convention as Pydantic. Constraints become
`attrs.field(validator=attrs.validators....)` calls instead of an `Annotated[...]` wrapper.

### msgspec

```ts
import { toMsgspec } from "@rhi-zone/fractal-type-ir/python-msgspec"

toMsgspec(person, "Person")
```

```python
from __future__ import annotations
import msgspec

class Person(msgspec.Struct):
    name: str
    nickname: str | None = None
```

`msgspec.Struct` is a plain base class, not decorator-configured — struct-level knobs
(`frozen`, …) are base-class keyword args (`class Foo(msgspec.Struct, frozen=True):`) rather
than a `@msgspec.define(...)` call. Constraints become `Annotated[T, msgspec.Meta(...)]`.

### cattrs

```ts
import { toCattrs } from "@rhi-zone/fractal-type-ir/python-cattrs"

toCattrs(person, "Person")
```

```python
from __future__ import annotations
import attrs
import cattrs

@attrs.define()
class Person:
    name: str
    nickname: str | None = None

converter = cattrs.Converter()
# converter.structure(data, Person) / converter.unstructure(obj) are the (de)serialization entry points
```

cattrs sits on top of attrs rather than defining its own class syntax — the class body is
identical to the `attrs` projector's output; cattrs' own contribution is the module-level
`converter = cattrs.Converter()` plus the `structure`/`unstructure` entry-point comment. A
`meta.discriminator` union additionally emits a `# TODO` stub for
`converter.register_structure_hook(...)`, since wiring subclass discovery needs runtime class
objects this static projector doesn't have.
