import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes } from "./kinds/bytes.ts"
import { int32, int64 } from "./kinds/int-widths.ts"
import { toObjC, toObjCEnum, toObjCInterface, toObjCType } from "./objc.ts"

describe("primitives", () => {
  test("boolean -> BOOL", () => {
    expect(toObjCType(t(types.boolean))).toBe("BOOL")
  })

  test("number -> double", () => {
    expect(toObjCType(t(types.number))).toBe("double")
  })

  test("integer -> NSInteger", () => {
    expect(toObjCType(t(types.integer))).toBe("NSInteger")
  })

  test("int32 -> int32_t", () => {
    expect(toObjCType(int32())).toBe("int32_t")
  })

  test("int64 -> int64_t", () => {
    expect(toObjCType(int64())).toBe("int64_t")
  })

  test("string -> NSString *", () => {
    expect(toObjCType(t(types.string))).toBe("NSString *")
  })

  test("null -> NSNull *", () => {
    expect(toObjCType(t(types.null))).toBe("NSNull *")
  })

  test("unknown -> id", () => {
    expect(toObjCType(t(types.unknown))).toBe("id")
  })

  test("bytes -> NSData *", () => {
    expect(toObjCType(bytes())).toBe("NSData *")
  })
})

describe("collections", () => {
  test("array -> NSArray<T> *", () => {
    expect(toObjCType(t(types.array(t(types.string))))).toBe("NSArray<NSString *> *")
  })

  test("map with string key -> NSDictionary<NSString *, V> *", () => {
    expect(toObjCType(t(types.map(t(types.string), t(types.number))))).toBe("NSDictionary<NSString *, double> *")
  })

  test("nested array of array", () => {
    expect(toObjCType(t(types.array(t(types.array(t(types.integer))))))).toBe("NSArray<NSArray<NSInteger> *> *")
  })
})

describe("enums", () => {
  test("NS_ENUM(NSInteger, ...) is the default style", () => {
    const decl = toObjCEnum("Status", t(types.enum(["active", "inactive"])))
    expect(decl).toBe(["typedef NS_ENUM(NSInteger, Status) {", "    StatusActive = 0,", "    StatusInactive,", "};"].join("\n"))
  })

  test("NS_STRING_ENUM style", () => {
    const decl = toObjCEnum("Status", t(types.enum(["active", "inactive"])), "string")
    expect(decl).toBe(
      ["typedef NSString * Status NS_STRING_ENUM;", "extern Status const StatusActive;", "extern Status const StatusInactive;"].join(
        "\n",
      ),
    )
  })

  test("sanitizes non-identifier characters in members", () => {
    const decl = toObjCEnum("Status", t(types.enum(["in_progress", "on-hold"])))
    expect(decl).toContain("StatusInProgress")
    expect(decl).toContain("StatusOnHold")
  })

  test("toObjC dispatches enum TypeRef to NS_ENUM header, no implementation", () => {
    const out = toObjC(t(types.enum(["a", "b"])), "Status")
    expect(out.header).toContain("NS_ASSUME_NONNULL_BEGIN")
    expect(out.header).toContain("typedef NS_ENUM(NSInteger, Status) {")
    expect(out.implementation).toBe("")
  })
})

describe("@interface / @property generation", () => {
  test("simple object -> @interface with @property per field", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        age: t(types.integer),
        active: t(types.boolean),
      }),
    )
    const { header } = toObjCInterface("Person", ref)
    expect(header).toContain("@interface Person : NSObject")
    expect(header).toContain("@property (nonatomic, copy) NSString *name;")
    expect(header).toContain("@property (nonatomic, assign) NSInteger age;")
    expect(header).toContain("@property (nonatomic, assign) BOOL active;")
    expect(header).toContain("@end")
  })

  test("optional pointer field gets nullable attribute", () => {
    const ref = t(
      types.object({
        nickname: t(types.string, { optional: true }),
      }),
    )
    const { header } = toObjCInterface("Person", ref)
    expect(header).toContain("@property (nonatomic, nullable, copy) NSString *nickname;")
  })

  test("optional scalar field boxes to NSNumber *", () => {
    const ref = t(
      types.object({
        age: t(types.integer, { optional: true }),
      }),
    )
    const { header } = toObjCInterface("Person", ref)
    expect(header).toContain("@property (nonatomic, nullable, strong) NSNumber *age;")
  })

  test("array field -> NSArray<T> * property", () => {
    const ref = t(
      types.object({
        tags: t(types.array(t(types.string))),
      }),
    )
    const { header } = toObjCInterface("Post", ref)
    expect(header).toContain("@property (nonatomic, copy) NSArray<NSString *> *tags;")
  })

  test("map field -> NSDictionary<K, V> * property", () => {
    const ref = t(
      types.object({
        scores: t(types.map(t(types.string), t(types.number))),
      }),
    )
    const { header } = toObjCInterface("Game", ref)
    expect(header).toContain("@property (nonatomic, copy) NSDictionary<NSString *, double> *scores;")
  })

  test("nested object field hoists a named nested class", () => {
    const ref = t(
      types.object({
        address: t(
          types.object({
            street: t(types.string),
          }),
        ),
      }),
    )
    const { header, implementation } = toObjCInterface("Person", ref)
    expect(header).toContain("@interface PersonAddress : NSObject")
    expect(header).toContain("@interface Person : NSObject")
    expect(header).toContain("@property (nonatomic, strong) PersonAddress *address;")
    // nested class declared before the parent that references it
    expect(header.indexOf("@interface PersonAddress")).toBeLessThan(header.indexOf("@interface Person :"))
    expect(implementation).toContain("[[PersonAddress alloc] initWithDictionary:addressDict]")
  })

  test("array of nested object field hoists a named element class", () => {
    const ref = t(
      types.object({
        items: t(types.array(t(types.object({ sku: t(types.string) })))),
      }),
    )
    const { header, implementation } = toObjCInterface("Order", ref)
    expect(header).toContain("@interface OrderItems : NSObject")
    expect(header).toContain("@property (nonatomic, copy) NSArray<OrderItems *> *items;")
    expect(implementation).toContain("[[OrderItems alloc] initWithDictionary:item]")
  })

  test("initWithDictionary and toDictionary are generated", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.integer) }))
    const { implementation } = toObjCInterface("Person", ref)
    expect(implementation).toContain("- (instancetype)initWithDictionary:(NSDictionary<NSString *, id> *)dictionary {")
    expect(implementation).toContain('self.name = dictionary[@"name"];')
    expect(implementation).toContain('self.age = [dictionary[@"age"] integerValue];')
    expect(implementation).toContain("- (NSDictionary<NSString *, id> *)toDictionary {")
    expect(implementation).toContain('dict[@"age"] = @(self.age);')
  })

  test("NS_ASSUME_NONNULL_BEGIN/END wrap the header", () => {
    const ref = t(types.object({ name: t(types.string) }))
    const { header } = toObjCInterface("Person", ref)
    expect(header.startsWith("NS_ASSUME_NONNULL_BEGIN")).toBe(true)
    expect(header.trimEnd().endsWith("NS_ASSUME_NONNULL_END")).toBe(true)
  })

  test("toObjC dispatches object TypeRef to toObjCInterface", () => {
    const ref = t(types.object({ name: t(types.string) }))
    const out = toObjC(ref, "Person")
    expect(out.header).toContain("@interface Person : NSObject")
    expect(out.implementation).toContain("@implementation Person")
  })
})
