// packages/type-ir/src/objc.ts — @rhi-zone/fractal-type-ir/objc
//
// Objective-C projector: TypeRef -> idiomatic Objective-C header (.h) +
// implementation (.m) content. Follows the same Converter/`resolve` pattern
// as typescript.ts/capnp.ts (see those files for the established shape).
//
// Objective-C has no anonymous struct/record type — every `object` TypeRef
// needs a name to become a class. Nested `object` fields (and arrays of
// `object`) are hoisted into their own named classes the same way capnp.ts
// hoists nested structs (see `collectClasses`/capnp.ts's `nestedStructs`),
// named `${ParentClassName}${Capitalize(fieldName)}`.
//
// JSON-boundary codegen (`initWithDictionary:`/`toDictionary`) follows one
// rule throughout: a scalar (non-pointer) property that is NOT optional is
// unboxed on read (`[dictionary[@"x"] integerValue]`) and boxed on write
// (`@(self.x)`), because `NSDictionary`/JSON values are always `NSNumber`-
// boxed for numeric/boolean fields. A scalar property that IS optional is
// instead typed `NSNumber *` (boxed) so a missing/null value can be
// represented as `nil` — the raw C scalar types (`BOOL`, `NSInteger`, ...)
// have no nil representation.
import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

export interface ObjCOutput {
  readonly header: string
  readonly implementation: string
}

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

/** Turn an arbitrary enum-member string (`"in_progress"`, `"IN-PROGRESS"`, …)
 * into a valid trailing identifier fragment (`InProgress`) for constant names. */
function sanitizeIdentifier(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map(capitalize)
    .join("")
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

// Primitive/collection Objective-C type mapping — mirrors typescript.ts's
// `handlers` table in shape, but every non-scalar type is a pointer type
// (trailing ` *`), following Objective-C convention.
const handlers: Record<string, Converter> = {
  boolean: leaf("BOOL"),
  number: leaf("double"),
  integer: leaf("NSInteger"),
  int8: leaf("int8_t"),
  int16: leaf("int16_t"),
  int32: leaf("int32_t"),
  int64: leaf("int64_t"),
  uint8: leaf("uint8_t"),
  uint16: leaf("uint16_t"),
  uint32: leaf("uint32_t"),
  uint64: leaf("uint64_t"),
  float32: leaf("float"),
  float64: leaf("double"),
  string: leaf("NSString *"),
  uuid: leaf("NSString *"),
  uri: leaf("NSString *"),
  email: leaf("NSString *"),
  datetime: leaf("NSDate *"),
  date: leaf("NSDate *"),
  time: leaf("NSString *"),
  duration: leaf("NSString *"),
  bytes: leaf("NSData *"),
  null: leaf("NSNull *"),
  void: leaf("void"),
  unknown: leaf("id"),
  never: leaf("void"),
  // Bare `object` (no enclosing class-generation context, e.g. reached via
  // `toObjCType` on a standalone field type) degrades to a generic
  // dictionary — `toObjCInterface`/`buildFieldDescriptor` special-case the
  // in-class case to hoist a named class instead of hitting this branch.
  object: (_shape, meta) =>
    typeof meta.className === "string" ? `${meta.className} *` : "NSDictionary<NSString *, id> *",
  // A class instance carries only nominal identity (see type-ir's
  // TypeKinds.instance doc comment) — renders as a pointer to that class,
  // same convention typescript.ts uses for the bare class name.
  instance: (shape) => `${(shape as TypeShape & { kind: "instance" }).className} *`,
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `NSArray<${toObjCType(s.element)}> *`
  },
  // No native async-sequence construct in Objective-C — degrades to the
  // materialized NSArray<T> equivalent, same honest-degrade convention
  // typescript.ts/capnp.ts use for `stream`.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `NSArray<${toObjCType(s.element)}> *`
  },
  page: (shape) => {
    const s = shape as TypeShape & { kind: "page" }
    return `NSArray<${toObjCType(s.element)}> *`
  },
  // No tuple construct — lossy, degrades to an opaque-element array.
  tuple: () => "NSArray<id> *",
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return `NSDictionary<${toObjCType(s.key)}, ${toObjCType(s.value)}> *`
  },
  // No tagged-union construct — lossy, degrades to `id`.
  union: () => "id",
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "NSNull *"
    if (typeof s.value === "string") return "NSString *"
    if (typeof s.value === "boolean") return "BOOL"
    return Number.isInteger(s.value) ? "NSInteger" : "double"
  },
  // Bare reference to an enum type name (set by the in-class field-hoisting
  // path via `meta.enumName`); otherwise degrades to plain NSString*, since a
  // standalone enum TypeRef with no name context has nothing to typedef to.
  enum: (_shape, meta) => (typeof meta.enumName === "string" ? meta.enumName : "NSString *"),
  ref: (shape) => `${(shape as TypeShape & { kind: "ref" }).target} *`,
  // No intersection/mixin construct — lossy: falls back to the first member.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? "id" : toObjCType(first)
  },
  // No first-class callable-type construct in Objective-C's type system
  // (blocks need a full `returnType (^)(paramTypes)` spelling this generic
  // path can't safely reconstruct from `params`/`returnType` alone) —
  // degrades honestly to `id`.
  function: () => "id",
  interface: () => "id",
}

/** Core primitive/collection type mapping — the Objective-C equivalent of
 * typescript.ts's `toTypeScript`. Does not apply nullable/optional handling;
 * see `buildFieldDescriptor` for the property-position wrapping (NSNumber
 * boxing for optional scalars, `nullable` attribute for optional pointers). */
export function toObjCType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  return converter === undefined ? "id" : converter(ref.shape, ref.meta)
}

function isPointerObjCType(type: string): boolean {
  return type.endsWith("*") || type === "id"
}

// NSNumber unboxing accessor per raw scalar ObjC type — used to read a
// required (non-optional) scalar field out of a JSON-sourced NSDictionary,
// where numeric/boolean values always arrive NSNumber-boxed.
const numberAccessors: Record<string, string> = {
  BOOL: "boolValue",
  NSInteger: "integerValue",
  double: "doubleValue",
  float: "floatValue",
  int8_t: "charValue",
  int16_t: "shortValue",
  int32_t: "intValue",
  int64_t: "longLongValue",
  uint8_t: "unsignedCharValue",
  uint16_t: "unsignedShortValue",
  uint32_t: "unsignedIntValue",
  uint64_t: "unsignedLongLongValue",
}

function propertyAttributes(type: string, nullable: boolean): string {
  const nullPart = nullable ? "nullable, " : ""
  // Value-semantic Foundation classes are conventionally `copy`d (defensive
  // against a caller later mutating a passed-in mutable subclass instance);
  // everything else pointer-typed is `strong` (ARC-retained); C scalars are
  // `assign` (no retain/release applies).
  if (type === "NSString *" || type === "NSData *" || type.startsWith("NSArray<") || type.startsWith("NSDictionary<")) {
    return `nonatomic, ${nullPart}copy`
  }
  if (isPointerObjCType(type)) {
    return `nonatomic, ${nullPart}strong`
  }
  return "nonatomic, assign"
}

type FieldDescriptor = {
  readonly name: string
  readonly objcType: string
  readonly attrs: string
  readonly kind: "object" | "arrayOfObject" | "scalar" | "pointer"
  readonly nestedClassName?: string | undefined
  readonly elemClassName?: string | undefined
  readonly numberAccessor?: string | undefined
  readonly boxed: boolean
  readonly description?: string | undefined
}

function buildFieldDescriptor(parentName: string, fieldName: string, fieldRef: TypeRef): FieldDescriptor {
  const kind = fieldRef.shape.kind
  const optional = fieldRef.meta.optional === true || fieldRef.meta.nullable === true
  const description = typeof fieldRef.meta.description === "string" ? fieldRef.meta.description : undefined

  if (isA(kind, "object")) {
    const nestedClassName = `${parentName}${capitalize(fieldName)}`
    const objcType = `${nestedClassName} *`
    return {
      name: fieldName,
      objcType,
      attrs: propertyAttributes(objcType, optional),
      kind: "object",
      nestedClassName,
      boxed: false,
      description,
    }
  }

  if (kind === "array") {
    const elem = (fieldRef.shape as TypeShape & { kind: "array" }).element
    if (isA(elem.shape.kind, "object")) {
      const elemClassName = `${parentName}${capitalize(fieldName)}`
      const objcType = `NSArray<${elemClassName} *> *`
      return {
        name: fieldName,
        objcType,
        attrs: propertyAttributes(objcType, optional),
        kind: "arrayOfObject",
        elemClassName,
        boxed: false,
        description,
      }
    }
  }

  const rawType = toObjCType(fieldRef)
  const isPointer = isPointerObjCType(rawType)
  const boxed = optional && !isPointer && rawType !== "void"
  const finalType = boxed ? "NSNumber *" : rawType
  const nullable = optional && isPointerObjCType(finalType)
  return {
    name: fieldName,
    objcType: finalType,
    attrs: propertyAttributes(finalType, nullable),
    kind: isPointer || boxed ? "pointer" : "scalar",
    numberAccessor: numberAccessors[rawType],
    boxed,
    description,
  }
}

function renderProperty(desc: FieldDescriptor): string {
  const doc = desc.description === undefined ? "" : `/** ${desc.description} */\n`
  const spacer = desc.objcType.endsWith("*") ? "" : " "
  return `${doc}@property (${desc.attrs}) ${desc.objcType}${spacer}${desc.name};`
}

function renderInitField(desc: FieldDescriptor): string {
  const key = `@"${desc.name}"`
  if (desc.kind === "object" && desc.nestedClassName !== undefined) {
    return [
      `    NSDictionary *${desc.name}Dict = dictionary[${key}];`,
      `    self.${desc.name} = ${desc.name}Dict ? [[${desc.nestedClassName} alloc] initWithDictionary:${desc.name}Dict] : nil;`,
    ].join("\n")
  }
  if (desc.kind === "arrayOfObject" && desc.elemClassName !== undefined) {
    return [
      `    NSMutableArray<${desc.elemClassName} *> *${desc.name}Array = [NSMutableArray array];`,
      `    for (NSDictionary *item in dictionary[${key}]) {`,
      `        [${desc.name}Array addObject:[[${desc.elemClassName} alloc] initWithDictionary:item]];`,
      `    }`,
      `    self.${desc.name} = ${desc.name}Array;`,
    ].join("\n")
  }
  if (desc.kind === "scalar" && desc.numberAccessor !== undefined) {
    return `    self.${desc.name} = [dictionary[${key}] ${desc.numberAccessor}];`
  }
  return `    self.${desc.name} = dictionary[${key}];`
}

function renderToDictField(desc: FieldDescriptor): string {
  const key = `@"${desc.name}"`
  if (desc.kind === "object") {
    return `    dict[${key}] = self.${desc.name} ? [self.${desc.name} toDictionary] : [NSNull null];`
  }
  if (desc.kind === "arrayOfObject" && desc.elemClassName !== undefined) {
    return [
      `    NSMutableArray *${desc.name}Array = [NSMutableArray array];`,
      `    for (${desc.elemClassName} *item in self.${desc.name}) {`,
      `        [${desc.name}Array addObject:[item toDictionary]];`,
      `    }`,
      `    dict[${key}] = ${desc.name}Array;`,
    ].join("\n")
  }
  if (desc.kind === "scalar" && !desc.boxed) {
    return `    dict[${key}] = @(self.${desc.name});`
  }
  return `    dict[${key}] = self.${desc.name} ?: [NSNull null];`
}

function renderClass(name: string, ref: TypeRef): ObjCOutput {
  const shape = ref.shape as TypeShape & { kind: "object" }
  const descriptors = Object.entries(shape.fields).map(([fieldName, fieldRef]) =>
    buildFieldDescriptor(name, fieldName, fieldRef),
  )
  const doc = typeof ref.meta.description === "string" ? `/** ${ref.meta.description} */\n` : ""

  const header = [
    `${doc}@interface ${name} : NSObject`,
    "",
    ...descriptors.map(renderProperty),
    "",
    "- (instancetype)initWithDictionary:(NSDictionary<NSString *, id> *)dictionary;",
    "- (NSDictionary<NSString *, id> *)toDictionary;",
    "",
    "@end",
  ].join("\n")

  const implementation = [
    `@implementation ${name}`,
    "",
    "- (instancetype)initWithDictionary:(NSDictionary<NSString *, id> *)dictionary {",
    "    self = [super init];",
    "    if (self) {",
    ...descriptors.map(renderInitField),
    "    }",
    "    return self;",
    "}",
    "",
    "- (NSDictionary<NSString *, id> *)toDictionary {",
    "    NSMutableDictionary *dict = [NSMutableDictionary dictionary];",
    ...descriptors.map(renderToDictField),
    "    return dict;",
    "}",
    "",
    "@end",
  ].join("\n")

  return { header, implementation }
}

type CollectedClass = { readonly name: string; readonly ref: TypeRef }

/** Depth-first, children-before-parent collection of every named class an
 * `object` TypeRef expands to — the root plus one hoisted class per nested
 * `object`/array-of-`object` field (recursively), named
 * `${ParentClassName}${Capitalize(fieldName)}`. Post-order so a class is
 * always emitted after every class it references (Objective-C requires a
 * referenced class's `@interface` to be visible — via prior declaration or
 * `@class` forward-declaration — before use; post-order sidesteps needing
 * forward declarations at all within a single generated file). */
function collectClasses(name: string, ref: TypeRef, out: CollectedClass[]): void {
  const shape = ref.shape as TypeShape & { kind: "object" }
  for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
    if (isA(fieldRef.shape.kind, "object")) {
      collectClasses(`${name}${capitalize(fieldName)}`, fieldRef, out)
    } else if (fieldRef.shape.kind === "array") {
      const elem = (fieldRef.shape as TypeShape & { kind: "array" }).element
      if (isA(elem.shape.kind, "object")) {
        collectClasses(`${name}${capitalize(fieldName)}`, elem, out)
      }
    }
  }
  out.push({ name, ref })
}

/** Lower an `object` TypeRef to a full `.h`/`.m` pair: one `@interface`
 * (+ matching `@implementation`) per class in the tree (root + hoisted
 * nested classes — see `collectClasses`), each with `initWithDictionary:`/
 * `toDictionary` for JSON-boundary (de)serialization, wrapped in
 * `NS_ASSUME_NONNULL_BEGIN`/`END` with explicit `nullable` only where a
 * field's `meta.optional`/`meta.nullable` says so. */
export function toObjCInterface(name: string, ref: TypeRef): ObjCOutput {
  const classes: CollectedClass[] = []
  collectClasses(name, ref, classes)

  const headerParts: string[] = ["NS_ASSUME_NONNULL_BEGIN", ""]
  const implParts: string[] = [`#import "${name}.h"`, ""]

  for (const cls of classes) {
    const rendered = renderClass(cls.name, cls.ref)
    headerParts.push(rendered.header, "")
    implParts.push(rendered.implementation, "")
  }

  headerParts.push("NS_ASSUME_NONNULL_END", "")

  return { header: headerParts.join("\n"), implementation: implParts.join("\n") }
}

export type ObjCEnumStyle = "int" | "string"

/**
 * Lower an `enum` TypeRef (a closed set of string members — see type-ir's
 * TypeKinds.enum doc comment) to an Objective-C enum declaration. Two
 * idiomatic styles, matching the two ways Foundation code expresses this:
 *  - `"int"` (default): `NS_ENUM(NSInteger, Name)` with one constant per
 *    member, `NameMember = 0, NameMember2, ...` — the conventional style for
 *    a closed set consumed as a value type (switch statements, Interface
 *    Builder-bound properties). Requires an explicit string<->enum mapping
 *    at any JSON boundary (not generated here — see `toObjCInterface`, which
 *    keeps enum-typed object fields as plain `NSString *` to avoid needing
 *    one).
 *  - `"string"`: `NS_STRING_ENUM` (https://nshipster.com/ns_string_enum/) —
 *    a set of `NSString *` constants, the idiomatic style when the values
 *    themselves are meaningful strings that should round-trip through JSON
 *    unchanged (or ever cross an Objective-C/Swift bridge, where
 *    `NS_STRING_ENUM` bridges to a Swift `enum` with a `String` raw value).
 */
export function toObjCEnum(name: string, ref: TypeRef, style: ObjCEnumStyle = "int"): string {
  const s = ref.shape as TypeShape & { kind: "enum" }

  if (style === "string") {
    return [
      `typedef NSString * ${name} NS_STRING_ENUM;`,
      ...s.members.map((member) => `extern ${name} const ${name}${sanitizeIdentifier(member)};`),
    ].join("\n")
  }

  const lines = [`typedef NS_ENUM(NSInteger, ${name}) {`]
  s.members.forEach((member, i) => {
    const suffix = i === 0 ? " = 0" : ""
    lines.push(`    ${name}${sanitizeIdentifier(member)}${suffix},`)
  })
  lines.push("};")
  return lines.join("\n")
}

/**
 * Top-level entry point: lower any TypeRef to Objective-C `.h`/`.m` content.
 *  - `object` (or a subtype thereof) -> `toObjCInterface` (full class tree).
 *  - `enum` -> `toObjCEnum` (int-style `NS_ENUM`; use `toObjCEnum` directly
 *    for the `NS_STRING_ENUM` style).
 *  - anything else -> a single `typedef` aliasing the primitive/collection
 *    type mapping (`toObjCType`) to `name`, since Objective-C has no other
 *    top-level declaration form for a bare scalar/array/map/etc type.
 * `implementation` is `""` for the enum and typedef cases — there is no
 * `.m`-side content for either (a `NS_ENUM`/typedef is header-only; unlike
 * `NS_STRING_ENUM`'s `extern` constants, which do need `.m`-side
 * definitions, left to the caller since this function returns a declaration
 * pair, not a build-ready pair of files, and the `"int"` default here never
 * reaches that case).
 */
export function toObjC(ref: TypeRef, name = "GeneratedType"): ObjCOutput {
  if (isA(ref.shape.kind, "object")) return toObjCInterface(name, ref)

  if (ref.shape.kind === "enum") {
    const header = ["NS_ASSUME_NONNULL_BEGIN", "", toObjCEnum(name, ref, "int"), "", "NS_ASSUME_NONNULL_END", ""].join(
      "\n",
    )
    return { header, implementation: "" }
  }

  const type = toObjCType(ref)
  const spacer = type.endsWith("*") ? "" : " "
  const header = [
    "NS_ASSUME_NONNULL_BEGIN",
    "",
    `typedef ${type}${spacer}${name};`,
    "",
    "NS_ASSUME_NONNULL_END",
    "",
  ].join("\n")
  return { header, implementation: "" }
}
