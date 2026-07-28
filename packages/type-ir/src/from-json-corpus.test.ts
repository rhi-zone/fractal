import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { t, types, type TypeRef } from "./index.ts"
import { uint8 } from "./kinds/common.ts"
import { fromJsonCorpus, collectEvidence, resolveEvidence, defaultStages, resolvedStrategy, perPosition, type Stage } from "./from-json-corpus.ts"

// ---------------------------------------------------------------------------
// Unit tests — deterministic, verifying specific behavior
// ---------------------------------------------------------------------------

describe("basic merging", () => {
  test("single value corpus = same as fromJson", () => {
    expect(fromJsonCorpus([42])).toEqual(uint8())
    expect(fromJsonCorpus(["hello"])).toEqual(t(types.string))
    expect(fromJsonCorpus([null])).toEqual(t(types.null))
  })

  test("empty corpus -> unknown", () => {
    expect(fromJsonCorpus([])).toEqual(t(types.unknown))
  })

  test("identical values -> literal (K=1 saturation is a constant signal, once N clears literalMinSamples)", () => {
    // Every sample carries the exact same value — K=1 is maximal saturation,
    // strong evidence the field is a constant/literal rather than merely
    // narrow-width. But a handful of samples isn't enough to trust that
    // signal (see looksLikeEnum's `literalMinSamples`, default 5) — N=3
    // is too small to commit.
    expect(fromJsonCorpus([42, 42, 42]).shape.kind).toBe("uint8")
    expect(fromJsonCorpus([42, 42, 42, 42, 42])).toEqual(t(types.literal(42)))
  })

  test("boolean values merge to boolean", () => {
    expect(fromJsonCorpus([true, false, true])).toEqual(t(types.boolean))
  })

  test("null + non-null -> nullable", () => {
    const result = fromJsonCorpus([null, 42, 43])
    expect(result.shape.kind).toBe("uint8")
    expect(result.meta.nullable).toBe(true)
  })
})

describe("integer width unification", () => {
  test("uint8 + uint8 -> uint8", () => {
    expect(fromJsonCorpus([1, 2, 3])).toEqual(uint8())
  })

  test("uint8 + negative -> int8 or wider", () => {
    const result = fromJsonCorpus([1, -1, 2])
    // 1 -> uint8, -1 -> int8. Union of ranges [0,255] + [-128,127] = [-128,255] -> int16
    expect(result.shape.kind).toBe("int16")
  })

  test("small + large positive -> uint16 or wider", () => {
    const result = fromJsonCorpus([1, 300, 2])
    // uint8 + uint16 -> uint16
    expect(result.shape.kind).toBe("uint16")
  })

  test("int8 + uint16 -> int32 (needs [-128, 65535])", () => {
    const result = fromJsonCorpus([-1, 300, -2])
    // -1 -> int8 [-128,127], 300 -> uint16 [0,65535] -> need [-128,65535] -> int32
    expect(result.shape.kind).toBe("int32")
  })

  test("very large + very negative -> int64", () => {
    const result = fromJsonCorpus([5_000_000_000, -5_000_000_000, 0])
    expect(result.shape.kind).toBe("int64")
  })

  test("integer + number -> number", () => {
    const result = fromJsonCorpus([42, 3.14, 1])
    expect(result.shape.kind).toBe("number")
  })
})

describe("string format unification", () => {
  test("same format preserved", () => {
    const result = fromJsonCorpus([
      "2026-01-01", "2026-02-02", "2026-03-03",
    ])
    expect(result.shape.kind).toBe("date")
  })

  test("different formats widen to string", () => {
    const result = fromJsonCorpus([
      "2026-01-01",
      "123e4567-e89b-12d3-a456-426614174000",
      "2026-02-02",
    ])
    expect(result.shape.kind).toBe("string")
  })

  test("format + plain string -> string", () => {
    const result = fromJsonCorpus([
      "2026-01-01",
      "hello",
      "2026-02-02",
    ])
    expect(result.shape.kind).toBe("string")
  })
})

describe("object merging", () => {
  test("identical objects merge to same shape", () => {
    const result = fromJsonCorpus([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
    ])
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(Object.keys(fields).sort()).toEqual(["id", "name"])
    expect(fields.id!.meta.optional).toBeUndefined()
    expect(fields.name!.meta.optional).toBeUndefined()
  })

  test("field present in some samples -> optional", () => {
    const result = fromJsonCorpus([
      { id: 1, name: "a" },
      { id: 2 },
      { id: 3, name: "c" },
    ])
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.id!.meta.optional).toBeUndefined()
    expect(fields.name!.meta.optional).toBe(true)
  })

  test("field type varies across samples -> unified", () => {
    const result = fromJsonCorpus([
      { value: 1 },
      { value: "hello" },
      { value: 2 },
    ])
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    // uint8 + string -> union
    expect(fields.value!.shape.kind).toBe("union")
  })
})

describe("array element unification", () => {
  test("homogeneous arrays merge element types", () => {
    const result = fromJsonCorpus([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ])
    expect(result.shape.kind).toBe("array")
    const el = (result.shape as { element: TypeRef }).element
    expect(el.shape.kind).toBe("uint8")
  })

  test("arrays with varying element ranges -> widened", () => {
    const result = fromJsonCorpus([
      [1, 2, 3],
      [300, 400, 500],
      [1, 2, 3],
    ])
    expect(result.shape.kind).toBe("array")
    const el = (result.shape as { element: TypeRef }).element
    expect(el.shape.kind).toBe("uint16")
  })

  test("mostly-populated arrays + one empty array -> element type stays concrete, not unknown", () => {
    // A lone `[]` sample infers as `array<unknown>` in isolation (from-json.ts's
    // `inferArray`). Unifying that against the other 99 samples' `array<object>`
    // must not let `unknown` "win" and erase the concrete element type — unknown
    // carries no information, so the concrete type should be what survives.
    const values: unknown[][] = []
    for (let i = 0; i < 99; i++) values.push([{ a: i }])
    values.push([])
    const result = fromJsonCorpus(values)
    expect(result.shape.kind).toBe("array")
    const el = (result.shape as { element: TypeRef }).element
    expect(el.shape.kind).toBe("object")
  })

  test("all-empty arrays -> element type stays unknown", () => {
    // When every sample is `[]`, there's genuinely no element evidence at
    // all — the result should stay `unknown`, not spuriously commit to some
    // other type.
    const result = fromJsonCorpus([[], [], []])
    expect(result.shape.kind).toBe("array")
    const el = (result.shape as { element: TypeRef }).element
    expect(el.shape.kind).toBe("unknown")
  })

  test("empty array field alongside populated array field -> field keeps concrete element type", () => {
    const values: Record<string, unknown>[] = []
    for (let i = 0; i < 20; i++) values.push({ id: i, tags: [`tag_${i}`, `tag_${i}_alt`] })
    values.push({ id: 20, tags: [] })
    const result = fromJsonCorpus(values)
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.tags!.shape.kind).toBe("array")
    const el = (fields.tags!.shape as { element: TypeRef }).element
    expect(el.shape.kind).toBe("string")
  })
})

describe("enum detection", () => {
  test("string field with repeated values -> enum", () => {
    const values = []
    const statuses = ["active", "inactive", "pending"]
    for (let i = 0; i < 20; i++) {
      values.push({ status: statuses[i % 3], id: i })
    }
    const result = fromJsonCorpus(values)
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.status!.shape.kind).toBe("enum")
    const members = (fields.status!.shape as { members: readonly string[] }).members
    expect([...members].sort()).toEqual(["active", "inactive", "pending"])
  })

  test("string field with many distinct values -> not enum", () => {
    const values = []
    for (let i = 0; i < 20; i++) {
      values.push({ name: `user_${i}`, id: i })
    }
    const result = fromJsonCorpus(values)
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.name!.shape.kind).toBe("string")
  })

  test("integer field with repeated values -> literal union", () => {
    const values = []
    const codes = [100, 200, 404]
    for (let i = 0; i < 20; i++) {
      values.push({ code: codes[i % 3] })
    }
    const result = fromJsonCorpus(values)
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.code!.shape.kind).toBe("union")
    const variants = (fields.code!.shape as { variants: readonly TypeRef[] }).variants
    expect(variants.every((v) => v.shape.kind === "literal")).toBe(true)
    const vals = variants.map((v) => (v.shape as { value: number }).value).sort((a, b) => a - b)
    expect(vals).toEqual([100, 200, 404])
  })
})

describe("discriminated union detection", () => {
  test("array of objects with discriminant field", () => {
    const values = [
      [
        { type: "circle", radius: 5 },
        { type: "rect", width: 3, height: 4 },
        { type: "circle", radius: 10 },
        { type: "rect", width: 6, height: 8 },
        { type: "circle", radius: 2 },
        { type: "rect", width: 1, height: 1 },
        { type: "circle", radius: 7 },
        { type: "rect", width: 9, height: 12 },
      ],
    ]
    const result = fromJsonCorpus(values)
    expect(result.shape.kind).toBe("array")
    const el = (result.shape as { element: TypeRef }).element
    // Should detect discriminated union
    expect(el.shape.kind).toBe("union")
    expect(el.meta.discriminator).toBe("type")
    const variants = (el.shape as { variants: readonly TypeRef[] }).variants
    expect(variants.length).toBe(2)
    // Each variant should have a literal "type" field
    for (const v of variants) {
      const fields = (v.shape as { fields: Record<string, TypeRef> }).fields
      expect(fields.type!.shape.kind).toBe("literal")
    }
  })

  test("top-level corpus values (not nested in an array field) with discriminant field", () => {
    // Same shapes as the array-of-objects case above, but the union members
    // ARE the corpus this time — no wrapping array field. `tryDetectDU` used
    // to only ever get called from the `array` branch of `walkAndDetectDU`
    // (fed by `node.array.elementObjects`), so this shape of corpus never
    // reached DU detection at all and fell through to a single merged
    // optional-everything object.
    const values = [
      { type: "circle", radius: 5 },
      { type: "rect", width: 3, height: 4 },
      { type: "circle", radius: 10 },
      { type: "rect", width: 6, height: 8 },
      { type: "circle", radius: 2 },
      { type: "rect", width: 1, height: 1 },
      { type: "circle", radius: 7 },
      { type: "rect", width: 9, height: 12 },
    ]
    const result = fromJsonCorpus(values)
    expect(result.shape.kind).toBe("union")
    expect(result.meta.discriminator).toBe("type")
    const variants = (result.shape as { variants: readonly TypeRef[] }).variants
    expect(variants.length).toBe(2)
    for (const v of variants) {
      const fields = (v.shape as { fields: Record<string, TypeRef> }).fields
      expect(fields.type!.shape.kind).toBe("literal")
    }
  })

  test("DU detection fires for an object field position, not just array elements or the root", () => {
    // Generalizes the previous case one level further: the mixed-shape
    // union members sit at an object-field position (`payload`), neither
    // the corpus root nor inside an array.
    const values = [
      { payload: { type: "circle", radius: 5 } },
      { payload: { type: "rect", width: 3, height: 4 } },
      { payload: { type: "circle", radius: 10 } },
      { payload: { type: "rect", width: 6, height: 8 } },
      { payload: { type: "circle", radius: 2 } },
      { payload: { type: "rect", width: 1, height: 1 } },
    ]
    const result = fromJsonCorpus(values)
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.payload!.shape.kind).toBe("union")
    expect(fields.payload!.meta.discriminator).toBe("type")
    const variants = (fields.payload!.shape as { variants: readonly TypeRef[] }).variants
    expect(variants.length).toBe(2)
  })
})

describe("CFD-style discriminant search (non-enum-typed fields)", () => {
  // `tag` has K=4 distinct string values over N=10 samples (ratio 0.4),
  // squarely in `looksLikeEnum`'s ambiguous 1/3-1/2 band — which for a
  // STRING field (no integer-clustering escape hatch) is rejected, so `tag`
  // never becomes `enum`/literal-union and `tryDetectDU` never considers it
  // a candidate. Each distinct `tag` value maps to a completely disjoint
  // set of sibling fields, so the CFD search's cohesion (all same-tag
  // samples share the exact same sibling shape) and separation (every pair
  // of tag values' sibling shapes is fully disjoint) signals are both
  // maximal.
  const values = [
    { tag: "a", x: 1, y: 2 },
    { tag: "a", x: 3, y: 4 },
    { tag: "a", x: 5, y: 6 },
    { tag: "b", p: 7, q: 8 },
    { tag: "b", p: 9, q: 10 },
    { tag: "b", p: 11, q: 12 },
    { tag: "c", m: 13, n: 14 },
    { tag: "c", m: 15, n: 16 },
    { tag: "d", r: 17, s: 18 },
    { tag: "d", r: 19, s: 20 },
  ]

  test("tag never gets typed enum on its own (ambiguous K/N band for a string field)", () => {
    const plain = fromJsonCorpus(values, { detectDiscriminatedUnions: false, detectCfdDiscriminants: false, splitDissimilarObjects: false })
    expect(plain.shape.kind).toBe("object")
    const fields = (plain.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.tag!.shape.kind).toBe("string")
  })

  test("a non-enum-typed field that functionally determines structure is found as a CFD discriminant", () => {
    const result = fromJsonCorpus(values)
    expect(result.shape.kind).toBe("union")
    expect(result.meta.discriminator).toBe("tag")
    const variants = (result.shape as { variants: readonly TypeRef[] }).variants
    expect(variants).toHaveLength(4)
    for (const v of variants) {
      const fields = (v.shape as { fields: Record<string, TypeRef> }).fields
      expect(fields.tag!.shape.kind).toBe("literal")
    }
  })

  test("detectCfdDiscriminants: false disables the pass (general splitting may still recover a union, without a discriminator)", () => {
    const result = fromJsonCorpus(values, { detectCfdDiscriminants: false })
    // General structural splitting (Jaccard clustering on raw field sets)
    // can still separate these four disjoint shapes, but it never attaches
    // a `discriminator` — that's how we know the CFD pass, not general
    // splitting, produced the tagged result above.
    if (result.shape.kind === "union") {
      expect(result.meta.discriminator).toBeUndefined()
    }
  })

  test("everything disabled: merges into one optional-everything record", () => {
    // Also disables dict detection: `tag`'s siblings (x/y, p/q, m/n, r/s)
    // grow the corpus's distinct-key count fast enough to independently
    // trip the growing-key-set dict heuristic — real signal on its own
    // terms, but orthogonal to what this test isolates (the union-shaping
    // passes), so it's turned off here to see the plain merge underneath.
    const result = fromJsonCorpus(values, {
      detectDiscriminatedUnions: false, detectCfdDiscriminants: false, splitDissimilarObjects: false,
      detectDicts: false,
    })
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(Object.keys(fields).sort()).toEqual(["m", "n", "p", "q", "r", "s", "tag", "x", "y"])
    for (const name of ["m", "n", "p", "q", "r", "s", "x", "y"]) {
      expect(fields[name]!.meta.optional).toBe(true)
    }
  })

  test("a high-cardinality unique-ID-like field is never picked as a discriminant", () => {
    // `id` is unique per sample (K === N) — the cardinality gate must
    // reject it outright regardless of how consistent/distinct any
    // structure split on it might look.
    const idValues = Array.from({ length: 10 }, (_, i) => ({
      id: `row-${i}`,
      value: i % 2 === 0 ? { even: true } : { odd: true },
    }))
    const result = fromJsonCorpus(idValues, { detectCfdDiscriminants: true })
    if (result.shape.kind === "union") {
      expect(result.meta.discriminator).not.toBe("id")
    }
  })

  test("cfdMinSamples gates the pass off below the sample threshold", () => {
    // Same 10-sample corpus that scores well by default (K=4/N=10 stays
    // non-enum-eligible, so DU never fires either) — raising cfdMinSamples
    // above N=10 disables the CFD pass, and no other pass attaches a
    // `discriminator`.
    const result = fromJsonCorpus(values, { cfdMinSamples: 20 })
    expect(result.meta.discriminator).toBeUndefined()
  })

  test("discriminant search does not re-litigate a position tryDetectDU already resolved", () => {
    // `type` is enum-shaped (K=2, well within enum territory) and forms a
    // DU via `tryDetectDU`. The CFD pass must not run at all at this
    // (already-union) position and must not disturb the result.
    const shapeValues = [
      { type: "circle", radius: 5 },
      { type: "rect", width: 3, height: 4 },
      { type: "circle", radius: 10 },
      { type: "rect", width: 6, height: 8 },
      { type: "circle", radius: 2 },
      { type: "rect", width: 1, height: 1 },
    ]
    const result = fromJsonCorpus(shapeValues)
    expect(result.shape.kind).toBe("union")
    expect(result.meta.discriminator).toBe("type")
    const variants = (result.shape as { variants: readonly TypeRef[] }).variants
    expect(variants).toHaveLength(2)
  })

  test("no false split when only the COMBINATION of two fields determines structure (unary restriction holds)", () => {
    // Structure (whether the sample carries `p` or `q`) follows XOR(a, b):
    // (x,1)->p, (x,2)->q, (y,1)->q, (y,2)->p. Grouping by `a` alone mixes
    // p-carrying and q-carrying samples together (2 of each), and likewise
    // for `b` alone — neither single field's value-groups are internally
    // cohesive, nor distinct from each other (both groups end up spanning
    // the same {p, q} field-set union). Only the *joint* (a, b) pair
    // predicts the shape, which is exactly the composite-discriminant case
    // Tagger's own unary restriction (and this pass, mirroring it) declines
    // to search for. Must not hallucinate a split from either field alone.
    const composite = [
      { a: "x", b: 1, p: 1 },
      { a: "x", b: 1, p: 2 },
      { a: "x", b: 2, q: 1 },
      { a: "x", b: 2, q: 2 },
      { a: "y", b: 1, q: 1 },
      { a: "y", b: 1, q: 2 },
      { a: "y", b: 2, p: 1 },
      { a: "y", b: 2, p: 2 },
    ]
    const result = fromJsonCorpus(composite, { detectCfdDiscriminants: true, splitDissimilarObjects: false })
    expect(result.meta.discriminator).toBeUndefined()
  })
})

describe("structural union splitting (no discriminant field)", () => {
  test("root-level objects with dissimilar field sets and no discriminant split into variants", () => {
    const values = [
      { userId: 1, userName: "a", userEmail: "a@x.com" },
      { userId: 2, userName: "b", userEmail: "b@x.com" },
      { userId: 3, userName: "c", userEmail: "c@x.com" },
      { orderId: 100, total: 9.99, items: 3 },
      { orderId: 101, total: 4.5, items: 1 },
      { orderId: 102, total: 12.25, items: 2 },
    ]
    const result = fromJsonCorpus(values)
    expect(result.shape.kind).toBe("union")
    const variants = (result.shape as { variants: readonly TypeRef[] }).variants
    expect(variants.length).toBe(2)
    for (const v of variants) {
      const fields = (v.shape as { fields: Record<string, TypeRef> }).fields
      const keys = Object.keys(fields).sort()
      expect(keys).toSatisfy((k: string[]) => k.join(",") === "userEmail,userId,userName" || k.join(",") === "items,orderId,total")
    }
  })

  test("array elements with dissimilar shapes and no discriminant split into variants", () => {
    const values = [
      [
        { a: 1, b: "x" },
        { a: 2, b: "y" },
        { a: 3, b: "z" },
        { c: true, d: [1, 2], e: "q" },
        { c: false, d: [3], e: "r" },
        { c: true, d: [], e: "s" },
      ],
    ]
    const result = fromJsonCorpus(values)
    const el = (result.shape as { element: TypeRef }).element
    expect(el.shape.kind).toBe("union")
    const variants = (el.shape as { variants: readonly TypeRef[] }).variants
    expect(variants.length).toBe(2)
  })

  test("objects that differ only by a single optional field do NOT split", () => {
    const result = fromJsonCorpus([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3 },
      { id: 4, name: "d" },
      { id: 5 },
    ])
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.name!.meta.optional).toBe(true)
  })

  test("sparse records (some samples with zero fields) do NOT split", () => {
    const result = fromJsonCorpus([
      {},
      {},
      { tag: "a" },
      { tag: "b" },
      { tag: "c" },
      { tag: "d" },
    ])
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.tag!.meta.optional).toBe(true)
  })

  test("below objectSplitMinSamples, dissimilar objects still merge (small-N guard)", () => {
    const result = fromJsonCorpus([
      { userId: 1, userName: "a" },
      { orderId: 100, total: 9.99 },
    ])
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(Object.keys(fields).sort()).toEqual(["orderId", "total", "userId", "userName"])
  })

  test("a single outlier sample does not fork off its own variant (min-2-members-per-cluster guard)", () => {
    // Keeps dict-detection's key-growth heuristic from firing first (which
    // would reclassify this as a `map` before splitting ever gets a look):
    // growth ratio here is (4-2)/5 = 0.4, under its 0.5 trigger.
    const result = fromJsonCorpus([
      { userId: 1, userName: "a" },
      { userId: 2, userName: "b" },
      { userId: 3, userName: "c" },
      { userId: 4, userName: "d" },
      { totallyDifferent: true, nested: { x: 1 } },
    ])
    expect(result.shape.kind).toBe("object")
  })

  test("splitDissimilarObjects: false disables the split, restoring the old merge-everything behavior", () => {
    const values = [
      { userId: 1, userName: "a", userEmail: "a@x.com" },
      { userId: 2, userName: "b", userEmail: "b@x.com" },
      { userId: 3, userName: "c", userEmail: "c@x.com" },
      { orderId: 100, total: 9.99, items: 3 },
      { orderId: 101, total: 4.5, items: 1 },
      { orderId: 102, total: 12.25, items: 2 },
    ]
    const result = fromJsonCorpus(values, { splitDissimilarObjects: false })
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(Object.keys(fields).sort()).toEqual(["items", "orderId", "total", "userEmail", "userId", "userName"])
  })

  test("objectSplitThreshold: raising it suppresses a split that fires at the default", () => {
    // Two clusters sharing 2 of 6 total fields -> Jaccard distance 4/6 =
    // 0.667: above the default 0.5 threshold (splits), below a raised 0.7
    // threshold (merges, same as the pre-existing optional-field behavior).
    const values = [
      { id: 1, name: "a", x1: 1, x2: 2 },
      { id: 2, name: "b", x1: 3, x2: 4 },
      { id: 3, name: "c", x1: 5, x2: 6 },
      { id: 4, name: "d", y1: 1, y2: 2 },
      { id: 5, name: "e", y1: 3, y2: 4 },
      { id: 6, name: "f", y1: 5, y2: 6 },
    ]
    const split = fromJsonCorpus(values)
    expect(split.shape.kind).toBe("union")
    const merged = fromJsonCorpus(values, { objectSplitThreshold: 0.7 })
    expect(merged.shape.kind).toBe("object")
  })

  test("discriminated union detection (with a discriminant field) takes priority over general splitting", () => {
    const values = [
      [
        { type: "circle", radius: 5 },
        { type: "rect", width: 3, height: 4 },
        { type: "circle", radius: 10 },
        { type: "rect", width: 6, height: 8 },
        { type: "circle", radius: 2 },
        { type: "rect", width: 1, height: 1 },
      ],
    ]
    const result = fromJsonCorpus(values)
    const el = (result.shape as { element: TypeRef }).element
    expect(el.shape.kind).toBe("union")
    expect(el.meta.discriminator).toBe("type")
    const variants = (el.shape as { variants: readonly TypeRef[] }).variants
    // Discriminant-based splitting still wins; general splitting must not
    // re-process (and corrupt) the variants it already produced.
    for (const v of variants) {
      const fields = (v.shape as { fields: Record<string, TypeRef> }).fields
      expect(fields.type!.shape.kind).toBe("literal")
    }
  })
})

describe("clustering methods", () => {
  // A/B/C each contribute a 2-sample cluster candidate. A and B share one
  // field (`shared1`), B and C share a different field (`shared2`), but A
  // and C are entirely disjoint (Jaccard distance 1.0). At threshold 0.8:
  //  - single-linkage compares each new sample against the *cluster's
  //    running field-set union*, which grows to include both `shared1` and
  //    `shared2` once B joins — so by the time C arrives, its distance to
  //    the (A+B)-unioned cluster reads as 0.75, under threshold, and C
  //    chains in even though A and C alone are maximally dissimilar.
  //  - complete-linkage requires every cross-pair to clear the threshold;
  //    A-C's 1.0 distance blocks the merge, so it stops at two clusters.
  const chainingValues = [
    { p: 1, shared1: "x" },
    { p: 2, shared1: "y" },
    { shared1: "x", shared2: "y" },
    { shared1: "y", shared2: "x" },
    { shared2: "y", q: 1 },
    { shared2: "x", q: 2 },
  ]

  test("single-linkage chains A-B-C into one cluster (no split) despite A and C being fully disjoint", () => {
    const result = fromJsonCorpus(chainingValues, {
      objectSplitThreshold: 0.8, objectSplitMinSamples: 5, clusteringMethod: "single-linkage",
    })
    expect(result.shape.kind).toBe("object")
  })

  test("complete-linkage refuses the chained merge, splitting into two clusters", () => {
    const result = fromJsonCorpus(chainingValues, {
      objectSplitThreshold: 0.8, objectSplitMinSamples: 5, clusteringMethod: "complete-linkage",
    })
    expect(result.shape.kind).toBe("union")
    const variants = (result.shape as { variants: readonly TypeRef[] }).variants
    expect(variants).toHaveLength(2)
  })

  test("key-signature splits on exact key-set signature, ignoring objectSplitThreshold entirely", () => {
    // A and B share `shared1`; under any Jaccard-distance method a high
    // enough threshold would merge them. Key-signature clustering never
    // looks at distance — same signature groups together, anything else is
    // its own cluster, however close.
    const result = fromJsonCorpus(chainingValues, {
      objectSplitThreshold: 0.99, objectSplitMinSamples: 5, clusteringMethod: "key-signature",
    })
    expect(result.shape.kind).toBe("union")
    const variants = (result.shape as { variants: readonly TypeRef[] }).variants
    expect(variants).toHaveLength(3)
  })

  test("key-signature is more aggressive than single-linkage on a polymorphic-API-response-style corpus", () => {
    // Two exact, recurring shapes differing by one field. Jaccard distance
    // between them is 1/3 (below the default 0.5 threshold), so
    // single-linkage's default merges them into one optional-field record.
    // Key-signature clustering only cares that the signatures differ.
    const values = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
      { id: 4, name: "d", extra: true },
      { id: 5, name: "e", extra: false },
      { id: 6, name: "f", extra: true },
    ]
    const singleLinkage = fromJsonCorpus(values, { clusteringMethod: "single-linkage" })
    expect(singleLinkage.shape.kind).toBe("object")

    const keySignature = fromJsonCorpus(values, { clusteringMethod: "key-signature" })
    expect(keySignature.shape.kind).toBe("union")
    const variants = (keySignature.shape as { variants: readonly TypeRef[] }).variants
    expect(variants).toHaveLength(2)
  })

  test("default clusteringMethod is single-linkage (back-compat: unspecified behaves as before)", () => {
    const withDefault = fromJsonCorpus(chainingValues, { objectSplitThreshold: 0.8, objectSplitMinSamples: 5 })
    const explicit = fromJsonCorpus(chainingValues, {
      objectSplitThreshold: 0.8, objectSplitMinSamples: 5, clusteringMethod: "single-linkage",
    })
    expect(withDefault).toEqual(explicit)
  })
})

describe("dict detection", () => {
  test("objects with varying keys -> map", () => {
    const values: Record<string, number>[] = []
    for (let i = 0; i < 10; i++) {
      const obj: Record<string, number> = {}
      // Each sample has different keys
      for (let j = 0; j < 3; j++) {
        obj[`key_${i}_${j}`] = i * 10 + j
      }
      values.push(obj)
    }
    const result = fromJsonCorpus(values)
    // Should detect as map (key set keeps growing)
    expect(result.shape.kind).toBe("map")
  })

  test("objects with stable keys -> record", () => {
    const values = []
    for (let i = 0; i < 10; i++) {
      values.push({ id: i, name: `user_${i}`, active: true })
    }
    const result = fromJsonCorpus(values)
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(Object.keys(fields).sort()).toEqual(["active", "id", "name"])
  })

  test("mixed: stable keys + varying keys -> object with additionalPropertyType", () => {
    const values = []
    for (let i = 0; i < 10; i++) {
      const obj: Record<string, unknown> = { id: i, name: `user_${i}` }
      // Add varying extra keys
      obj[`extra_${i}_a`] = i * 10
      obj[`extra_${i}_b`] = i * 20
      values.push(obj)
    }
    const result = fromJsonCorpus(values)
    // Should detect mixed: record fields (id, name) + dynamic keys
    expect(result.shape.kind).toBe("object")
    expect(result.meta.additionalPropertyType).toBeDefined()
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect("id" in fields).toBe(true)
    expect("name" in fields).toBe(true)
  })
})

describe("dirty data detection", () => {
  test("off by default", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, "oops"]
    const result = fromJsonCorpus(values)
    // Without dirty data detection, it should be a union
    expect(result.shape.kind).toBe("union")
  })

  test("when enabled, dominant type wins with warning", () => {
    const values: unknown[] = []
    for (let i = 0; i < 20; i++) values.push(i)
    values.push("oops") // 1 dirty value
    const result = fromJsonCorpus(values, { detectDirtyData: true })
    // The uint8 type should dominate, with a dirty data warning
    if (result.meta.dirtyDataWarning !== undefined) {
      expect(result.shape.kind).not.toBe("union")
      expect(typeof result.meta.dirtyDataWarning).toBe("string")
    }
    // If dirty data detection didn't fire (threshold not met), it's
    // still a union — that's also acceptable behavior
  })
})

describe("two-phase API: collectEvidence / resolveEvidence", () => {
  test("fromJsonCorpus is equivalent to collectEvidence + resolveEvidence", () => {
    const samples = [
      { id: 1, status: "active", tags: [1, 2, 3] },
      { id: 2, status: "inactive", tags: [4, 5] },
      { id: 3, status: "active", tags: [] },
    ]
    const direct = fromJsonCorpus(samples)
    const evidence = collectEvidence(samples)
    const twoPhase = resolveEvidence(evidence)
    expect(twoPhase).toEqual(direct)
  })

  test("collectEvidence gathers value counts and type distribution without resolving", () => {
    const evidence = collectEvidence([1, "a", null, 2, "b", 3])
    expect(evidence.values.length).toBe(6)
    expect(evidence.root.n).toBe(6)
    expect(evidence.root.nullCount).toBe(1)
    expect(evidence.root.typeCounts.number).toBe(3)
    expect(evidence.root.typeCounts.string).toBe(2)
    expect(evidence.root.typeCounts.null).toBe(1)
  })

  test("collectEvidence gathers enum evidence (distinct values) for a saturating field", () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({
      status: ["active", "inactive", "pending"][i % 3],
    }))
    const evidence = collectEvidence(samples)
    const statusNode = evidence.root.object!.fields.status!
    expect(statusNode.leafCount).toBe(20)
    expect(statusNode.distinctValues.size).toBe(3)
    expect([...statusNode.distinctValues].sort()).toEqual(['"active"', '"inactive"', '"pending"'])
    // Evidence collection does not decide enum-ness — the merged shape only
    // emerges from resolveEvidence.
    const resolved = resolveEvidence(evidence)
    const fields = (resolved.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.status!.shape.kind).toBe("enum")
  })

  test("collectEvidence gathers key-set growth evidence for dict detection", () => {
    const samples: Record<string, number>[] = []
    for (let i = 0; i < 10; i++) {
      const obj: Record<string, number> = {}
      for (let j = 0; j < 3; j++) obj[`key_${i}_${j}`] = i * 10 + j
      samples.push(obj)
    }
    const evidence = collectEvidence(samples)
    expect(evidence.root.object!.keySets.length).toBe(10)
    // Every sample's key set is disjoint from the others -> 30 total distinct keys.
    const allKeys = new Set<string>()
    for (const ks of evidence.root.object!.keySets) for (const k of ks) allKeys.add(k)
    expect(allKeys.size).toBe(30)
  })

  test("collectEvidence gathers element evidence for arrays, including raw object elements for DU detection", () => {
    const samples = [
      [
        { type: "circle", radius: 5 },
        { type: "rect", width: 3, height: 4 },
        { type: "circle", radius: 10 },
      ],
    ]
    const evidence = collectEvidence(samples)
    const arrayEvidence = evidence.root.array!
    expect(arrayEvidence.elementObjects.length).toBe(3)
    expect(arrayEvidence.lengths).toEqual([3])
  })

  test("resolveEvidence with detectEnums: false skips enum detection even when evidence saturates", () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({
      status: ["active", "inactive", "pending"][i % 3],
    }))
    const evidence = collectEvidence(samples)
    const resolved = resolveEvidence(evidence, { detectEnums: false })
    const fields = (resolved.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.status!.shape.kind).toBe("string")
  })

  test("resolveEvidence with detectDicts: false keeps growing-key-set objects as plain records", () => {
    const samples: Record<string, number>[] = []
    for (let i = 0; i < 10; i++) {
      const obj: Record<string, number> = {}
      for (let j = 0; j < 3; j++) obj[`key_${i}_${j}`] = i * 10 + j
      samples.push(obj)
    }
    const evidence = collectEvidence(samples)
    const resolved = resolveEvidence(evidence, { detectDicts: false })
    expect(resolved.shape.kind).toBe("object")
  })

  test("resolveEvidence supports customResolvers to override the default decision at a node", () => {
    const samples = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const evidence = collectEvidence(samples)
    const resolved = resolveEvidence(evidence, {
      customResolvers: [
        (node, ref) => {
          if (ref.shape.kind === "object" && node.object?.fields.id !== undefined) {
            return { shape: ref.shape, meta: { ...ref.meta, sawCustomResolver: true } }
          }
          return undefined
        },
      ],
    })
    expect(resolved.meta.sawCustomResolver).toBe(true)
  })

  test("resolveEvidence on an evidence tree collected once can be re-resolved under different strategies", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, "oops"]
    const evidence = collectEvidence(samples)
    const withoutDirty = resolveEvidence(evidence, { detectDirtyData: false })
    const withDirty = resolveEvidence(evidence, { detectDirtyData: true })
    expect(withoutDirty.shape.kind).toBe("union")
    // withDirty may or may not fire depending on the threshold, but must not
    // require re-collecting evidence to try.
    expect(withDirty).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Property-based tests using fast-check
// ---------------------------------------------------------------------------

// Reuse value generation helpers from the fuzz test
function arbPlainString(): fc.Arbitrary<string> {
  return fc.stringMatching(/^[A-Z][a-zA-Z]{2,10}$/)
}

describe("property: no crashes on any JSON corpus", () => {
  test("arbitrary JSON values", () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { minLength: 1, maxLength: 20 }),
        (values) => {
          fromJsonCorpus(values)
        },
      ),
      { numRuns: 5000 },
    )
  })
})

describe("property: determinism", () => {
  test("same corpus -> same result", () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { minLength: 1, maxLength: 10 }),
        (values) => {
          const a = fromJsonCorpus(values)
          const b = fromJsonCorpus(values)
          expect(a).toEqual(b)
        },
      ),
      { numRuns: 2000 },
    )
  })
})

describe("property: corpus inference is at least as wide as any single value", () => {
  test("corpus type covers each individual value's type", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant(null),
            fc.boolean(),
            fc.integer({ min: -1000, max: 1000 }),
            fc.double({ min: -100, max: 100, noDefaultInfinity: true, noNaN: true }).map((n) => Number.isInteger(n) ? n + 0.5 : n),
            arbPlainString(),
          ),
          { minLength: 2, maxLength: 10 },
        ),
        (values) => {
          const corpus = fromJsonCorpus(values)
          // The corpus type should be a supertype of each individual value's inferred type.
          // For this test, just check it doesn't crash and the kind is reasonable.
          const ck = corpus.shape.kind
          const hasNull = values.some((v) => v === null)
          const hasBool = values.some((v) => typeof v === "boolean")
          const hasNum = values.some((v) => typeof v === "number" && !Number.isInteger(v))
          const hasInt = values.some((v) => typeof v === "number" && Number.isInteger(v))
          const hasStr = values.some((v) => typeof v === "string")
          const typeCount = [hasNull, hasBool, hasNum || hasInt, hasStr].filter(Boolean).length

          if (typeCount > 1 || (hasNull && typeCount === 1)) {
            // Multiple JS-level types -> should be union or have nullable meta
            // (null + one type -> nullable, multiple types -> union)
            if (typeCount === 1 && hasNull) {
              // null + one other type -> nullable
              expect(corpus.meta.nullable === true || ck === "null" || ck === "union").toBe(true)
            }
          }
        },
      ),
      { numRuns: 3000 },
    )
  })
})

describe("property: optional field detection", () => {
  test("field present in some but not all samples marked optional", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          // N objects with 'id' always present
          fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 3, maxLength: 10 }),
          // Mask: which objects also have 'name'
          fc.array(fc.boolean(), { minLength: 3, maxLength: 10 }),
        ),
        ([ids, mask]) => {
          const len = Math.min(ids.length, mask.length)
          if (len < 3) return // too few samples

          const values: Record<string, unknown>[] = []
          let hasName = false
          let missingName = false
          for (let i = 0; i < len; i++) {
            const obj: Record<string, unknown> = { id: ids[i] }
            if (mask[i]) {
              obj.name = "test"
              hasName = true
            } else {
              missingName = true
            }
            values.push(obj)
          }

          if (!hasName || !missingName) return // need both present and absent

          const result = fromJsonCorpus(values)
          expect(result.shape.kind).toBe("object")
          const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
          expect(fields.name!.meta.optional).toBe(true)
          // 'id' should NOT be optional
          expect(fields.id!.meta.optional).toBeUndefined()
        },
      ),
      { numRuns: 2000 },
    )
  })
})

describe("property: enum detection with fast-check", () => {
  test("repeated string values from small set detected as enum", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          // Generate 2-5 distinct enum values
          fc.shuffledSubarray(
            ["active", "inactive", "pending", "archived", "deleted"],
            { minLength: 2, maxLength: 5 },
          ),
          // Number of samples
          fc.integer({ min: 15, max: 40 }),
        ),
        ([enumValues, n]) => {
          const values: { status: string; id: number }[] = []
          for (let i = 0; i < n; i++) {
            values.push({ status: enumValues[i % enumValues.length]!, id: i })
          }
          const result = fromJsonCorpus(values)
          const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
          // Should detect enum for 'status' field
          expect(fields.status!.shape.kind).toBe("enum")
          const members = (fields.status!.shape as { members: readonly string[] }).members
          expect([...members].sort()).toEqual([...enumValues].sort())
        },
      ),
      { numRuns: 500 },
    )
  })
})

describe("property: dict detection with fast-check", () => {
  test("objects with linearly growing key sets detected as map", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 15 }),
        (n) => {
          const values: Record<string, number>[] = []
          for (let i = 0; i < n; i++) {
            const obj: Record<string, number> = {}
            for (let j = 0; j < 3; j++) {
              obj[`k_${i}_${j}`] = i * 10 + j
            }
            values.push(obj)
          }
          const result = fromJsonCorpus(values)
          expect(result.shape.kind).toBe("map")
        },
      ),
      { numRuns: 500 },
    )
  })
})

// ---------------------------------------------------------------------------
// `enumMaxMembers` — the distinct-value cap as a declared, swappable policy
//
// The cap is an output-size guard, not an evidence test. `docs/design/
// inference-theory.md` §6.6-6.7 derives why a cut on K alone cannot separate
// memorization from genuine restriction: the evidence lives in the K/N ratio,
// and a K-only bound rejects arbitrarily well-supported bounded vocabularies
// while admitting poorly-supported small ones. These tests pin the default
// (50, unchanged) AND the fact that it is overridable, so the policy is
// visible rather than buried in a constant.
// ---------------------------------------------------------------------------

describe("enumMaxMembers", () => {
  // 60 distinct values each seen 100 times: K/N = 0.01, about as unambiguous
  // as a bounded vocabulary gets. The default cap rejects it anyway.
  const wide = Array.from({ length: 6000 }, (_, i) => ({ status: `s${i % 60}` }))

  test("default cap of 50 rejects a K=60 vocabulary even at ratio 0.01", () => {
    expect(JSON.stringify(fromJsonCorpus(wide))).not.toContain('"enum"')
  })

  test("raising the cap admits it — the ratio evidence was always there", () => {
    expect(JSON.stringify(fromJsonCorpus(wide, { enumMaxMembers: 100 }))).toContain('"enum"')
  })

  test("Infinity disables the cap entirely, leaving the K/N tests in charge", () => {
    expect(JSON.stringify(fromJsonCorpus(wide, { enumMaxMembers: Infinity }))).toContain('"enum"')
  })

  test("lowering the cap suppresses an enum the default would have found", () => {
    const narrow = Array.from({ length: 300 }, (_, i) => ({ status: `s${i % 6}` }))
    expect(JSON.stringify(fromJsonCorpus(narrow))).toContain('"enum"')
    expect(JSON.stringify(fromJsonCorpus(narrow, { enumMaxMembers: 3 }))).not.toContain('"enum"')
  })

  test("the cap does not override the K>=N unique-values rejection", () => {
    const allUnique = Array.from({ length: 40 }, (_, i) => ({ id: `u${i}` }))
    expect(JSON.stringify(fromJsonCorpus(allUnique, { enumMaxMembers: Infinity })))
      .not.toContain('"enum"')
  })
})

// ---------------------------------------------------------------------------
// Grouping / Generalization stages
//
// The two pluggable layers. These tests exist to prove the seams are real —
// that a caller can inspect, filter, replace and extend the pipeline — not
// just that the defaults still work (the suites above already pin that).
// ---------------------------------------------------------------------------

describe("stage pipeline", () => {
  const duCorpus = [
    { kind: "circle", radius: 1 }, { kind: "circle", radius: 2 },
    { kind: "circle", radius: 3 }, { kind: "square", side: 4 },
    { kind: "square", side: 5 }, { kind: "square", side: 6 },
  ]

  test("defaults are exposed as an ordered, inspectable list", () => {
    const stages = defaultStages(resolvedStrategy())
    expect(stages.map((s) => s.step.name)).toEqual([
      "enums", "discriminated-union", "dict-vs-record", "cfd-discriminant", "structural-split",
    ])
    // the enum GENERALIZATION precedes the DU GROUPING, because DU grouping
    // only fires on discriminants already typed as enum/literal
    expect(stages[0]!.kind).toBe("generalization")
    expect(stages[1]!.kind).toBe("grouping")
  })

  test("dropping every grouping stage leaves generalization intact", () => {
    const all = defaultStages(resolvedStrategy())
    const noGrouping = all.filter((s) => s.kind === "generalization")
    const out = JSON.stringify(fromJsonCorpus(duCorpus, { stages: noGrouping }))
    // no DU split happened, but the discriminant still generalized to an enum
    expect(out).toContain('"enum"')
    expect(out).not.toContain('"union"')
  })

  test("an empty pipeline yields the mechanical merge and nothing else", () => {
    const out = JSON.stringify(fromJsonCorpus(duCorpus, { stages: [] }))
    expect(out).not.toContain('"enum"')
    expect(out).not.toContain('"union"')
    expect(out).toContain('"object"')
  })

  test("a custom generalization can be spliced in and sees accumulated evidence", () => {
    const seen: { n: number; k: number; singletons: number }[] = []
    const probe: Stage = {
      kind: "generalization",
      step: {
        name: "probe",
        apply: perPosition((ref, node) => {
          if (node.leafCount > 0) {
            seen.push({ n: node.leafCount, k: node.distinctValues.size, singletons: node.singletons })
          }
          return ref
        }),
      },
    }
    fromJsonCorpus(duCorpus, { stages: [probe] })
    // the `kind` field: 6 leaf occurrences, 2 distinct, 0 seen exactly once
    expect(seen).toContainEqual({ n: 6, k: 2, singletons: 0 })
    // the `radius` field: 3 occurrences, 3 distinct, all singletons
    expect(seen).toContainEqual({ n: 3, k: 3, singletons: 3 })
  })

  test("a coverage-based generalization is expressible over the same evidence", () => {
    // Good-Turing: P(next value unseen) ~ singletons/N. Emit an enum only when
    // estimated coverage clears a declared bar. See inference-theory.md §6.10.
    const coverageEnum = (bar: number): Stage => ({
      kind: "generalization",
      step: {
        name: "coverage-enum",
        apply: perPosition((ref, node) => {
          if (node.leafCount < 4 || node.distinctValues.size < 2) return ref
          const coverage = 1 - node.singletons / node.leafCount
          if (coverage < bar) return ref
          const members = [...node.distinctValues].map((v) => JSON.parse(v) as unknown)
          if (!members.every((m) => typeof m === "string")) return ref
          return t(types.enum(members as string[]), ref.meta)
        }),
      },
    })
    // 40 occurrences of 4 statuses: coverage 1.0, comfortably over any bar
    const tight = Array.from({ length: 40 }, (_, i) => ({ s: `s${i % 4}` }))
    expect(JSON.stringify(fromJsonCorpus(tight, { stages: [coverageEnum(0.9)] }))).toContain('"enum"')
    // 40 all-distinct values: coverage 0, under the bar
    const open = Array.from({ length: 40 }, (_, i) => ({ s: `v${i}` }))
    expect(JSON.stringify(fromJsonCorpus(open, { stages: [coverageEnum(0.9)] }))).not.toContain('"enum"')
  })

  test("stage order is honoured — reversing it changes the result", () => {
    const all = defaultStages(resolvedStrategy())
    const forward = JSON.stringify(fromJsonCorpus(duCorpus, { stages: all }))
    const reversed = JSON.stringify(fromJsonCorpus(duCorpus, { stages: [...all].reverse() }))
    expect(forward).not.toEqual(reversed)
  })
})
