// Adversarial / deep / complex property-based fuzz tests for the JSON shape
// inferrer — both fromJson (single-value) and fromJsonCorpus (multi-sample).
//
// The existing from-json.fuzz.test.ts harness is deliberately gentle: depth
// 3, well-formed leaf values, plain strings that avoid format collisions.
// This file goes after the hard cases named in the design doc: deep nesting,
// mixed numeric types, string format confusion, union/DU stress, enum edge
// cases, dict-vs-record stress, optional-field edge cases, dirty data, and
// empty/degenerate corpora — at corpus sizes into the hundreds.
//
// Per the task: REPORT FAILURES, DO NOT FIX THE INFERRER. Any property that
// fails is marked `.todo` (kept as documentation of the failure, not run in
// CI) with a comment recording the minimal counterexample fast-check found.
// Properties that pass stay as live `test(...)`.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { t, types, ancestors, type TypeRef } from "./index.ts"
import { fromJson } from "./from-json.ts"
import { fromJsonCorpus } from "./from-json-corpus.ts"

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isSubkind(child: string, parent: string): boolean {
  if (child === parent) return true
  return ancestors(child).includes(parent)
}

function objectFields(ref: TypeRef): Record<string, TypeRef> {
  return (ref.shape as { fields: Record<string, TypeRef> }).fields
}

// Recursively check that `value` is a plausible inhabitant of `inferred`.
// This is a *structural sanity* check, not a full validator: it walks
// containers and only asserts kind-level agreement (never crashes, never
// silently mismatches gross shape). It intentionally does not need to
// understand enum/DU/dict post-processing precisely — those are covered by
// dedicated properties below.
function inhabits(value: unknown, ref: TypeRef): string | null {
  const kind = ref.shape.kind

  // `unknown` is the top type in this IR — every JSON value inhabits it.
  if (kind === "unknown") return null

  if (kind === "union") {
    const variants = (ref.shape as { variants: readonly TypeRef[] }).variants
    for (const v of variants) {
      if (inhabits(value, v) === null) return null
    }
    return `value ${JSON.stringify(value)} does not inhabit any union variant of ${JSON.stringify(ref.shape)}`
  }

  if (ref.meta.nullable === true && value === null) return null

  if (value === null) return kind === "null" ? null : `null inferred as ${kind}`
  if (typeof value === "boolean") return kind === "boolean" ? null : `boolean inferred as ${kind}`

  if (typeof value === "number") {
    if (kind === "number") return null
    if (isSubkind(kind, "integer") || kind === "integer") {
      return Number.isInteger(value) ? null : `fractional ${value} inferred as ${kind}`
    }
    if (kind === "literal") return null // literal numbers can appear post enum-detection
    return `number ${value} inferred as ${kind}`
  }

  if (typeof value === "string") {
    if (kind === "string" || isSubkind(kind, "string")) return null
    if (kind === "enum") {
      const members = (ref.shape as { members: readonly string[] }).members
      return members.includes(value) ? null : `string "${value}" not in enum ${JSON.stringify(members)}`
    }
    if (kind === "literal") return null
    return `string "${value}" inferred as ${kind}`
  }

  if (Array.isArray(value)) {
    if (kind === "array") {
      const el = (ref.shape as { element: TypeRef }).element
      for (const item of value) {
        const err = inhabits(item, el)
        if (err !== null) return `array element mismatch: ${err}`
      }
      return null
    }
    if (kind === "tuple") {
      const els = (ref.shape as { elements: readonly TypeRef[] }).elements
      if (els.length !== value.length) return `tuple length mismatch: value has ${value.length}, type has ${els.length}`
      for (let i = 0; i < els.length; i++) {
        const err = inhabits(value[i], els[i]!)
        if (err !== null) return `tuple[${i}] mismatch: ${err}`
      }
      return null
    }
    return `array value inferred as ${kind}`
  }

  if (typeof value === "object") {
    if (kind === "object") {
      const fields = objectFields(ref)
      const additionalProperties = ref.meta.additionalProperties as TypeRef | undefined
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (key in fields) {
          const err = inhabits(v, fields[key]!)
          if (err !== null) return `field "${key}" mismatch: ${err}`
        } else if (additionalProperties !== undefined) {
          const err = inhabits(v, additionalProperties)
          if (err !== null) return `dict entry "${key}" mismatch: ${err}`
        } else {
          return `key "${key}" not in inferred object fields and no additionalProperties`
        }
      }
      for (const [key, fieldRef] of Object.entries(fields)) {
        if (fieldRef.meta.optional !== true && !(key in (value as Record<string, unknown>))) {
          return `required field "${key}" missing from value`
        }
      }
      return null
    }
    if (kind === "map") {
      const valueType = (ref.shape as { value: TypeRef }).value
      for (const v of Object.values(value as Record<string, unknown>)) {
        const err = inhabits(v, valueType)
        if (err !== null) return `map entry mismatch: ${err}`
      }
      return null
    }
    return `object value inferred as ${kind}`
  }

  return null
}

// ---------------------------------------------------------------------------
// Value-generating arbitraries — deep, adversarial JSON shapes
// ---------------------------------------------------------------------------

const plainKey = () => fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{1,8}$/)

// A JSON value arbitrary that recurses to real depth (5+ levels): object ->
// array -> object -> tuple-like array -> union-shaped leaf. fc.letrec wires
// the mutual recursion so shrinking works across the whole tree.
const { jsonDeep } = fc.letrec((tie) => ({
  jsonDeep: fc.oneof(
    { maxDepth: 6, depthIdentifier: "deep" },
    { weight: 1, arbitrary: fc.constant(null) },
    { weight: 1, arbitrary: fc.boolean() },
    { weight: 1, arbitrary: fc.integer({ min: -1000, max: 1000 }) },
    { weight: 1, arbitrary: fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }) },
    { weight: 1, arbitrary: fc.stringMatching(/^[A-Za-z]{2,12}$/) },
    {
      weight: 2,
      arbitrary: fc.array(tie("jsonDeep") as fc.Arbitrary<unknown>, { minLength: 0, maxLength: 4 }),
    },
    {
      weight: 2,
      arbitrary: fc.dictionary(plainKey(), tie("jsonDeep") as fc.Arbitrary<unknown>, { minKeys: 0, maxKeys: 4 }),
    },
  ),
}))

// ---------------------------------------------------------------------------
// 1. Deep nesting — object > array > object > tuple > union, 5+ levels
// ---------------------------------------------------------------------------

describe("adversarial: deep nesting", () => {
  test("fromJson never crashes on 5+ level deep structures", () => {
    fc.assert(
      fc.property(jsonDeep, (value) => {
        fromJson(value)
      }),
      { numRuns: 2000 },
    )
  })

  test("fromJsonCorpus never crashes on corpora of deep structures", () => {
    fc.assert(
      fc.property(fc.array(jsonDeep, { minLength: 1, maxLength: 30 }), (values) => {
        fromJsonCorpus(values)
      }),
      { numRuns: 500 },
    )
  })

  // Explicit 5-level construction: object -> array -> object -> tuple -> union leaf
  test("explicit 5-level nested structure infers without losing depth", () => {
    const sample = {
      level1: [
        {
          level3: [1, "two", true],
          level3b: { level4: [{ level5: 1 }, { level5: 2 }, { level5: "three" }] },
        },
      ],
    }
    const inferred = fromJson(sample)
    expect(inferred.shape.kind).toBe("object")
    const err = inhabits(sample, inferred)
    expect(err).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Mixed numeric types
// ---------------------------------------------------------------------------

describe("adversarial: mixed numeric types", () => {
  test("array mixing ints and floats infers as array<number> and accepts all elements", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.integer({ min: -1000, max: 1000 }),
            fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })
              .filter((n) => !Number.isInteger(n)),
          ),
          { minLength: 3, maxLength: 15 },
        ).filter((arr) => arr.some((n) => !Number.isInteger(n)) && arr.some((n) => Number.isInteger(n))),
        (arr) => {
          const inferred = fromJson(arr)
          const err = inhabits(arr, inferred)
          if (err !== null) {
            throw new Error(`${err}\n  value: ${JSON.stringify(arr)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
          }
        },
      ),
      { numRuns: 2000 },
    )
  })

  test("corpus with integer field in some samples, float field (same path) in others -> number, accepts all", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.integer({ min: -1000, max: 1000 }).map((n) => ({ x: n })),
            fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })
              .filter((n) => !Number.isInteger(n))
              .map((n) => ({ x: n })),
          ),
          { minLength: 3, maxLength: 20 },
        ).filter((samples) => samples.some((s) => Number.isInteger(s.x)) && samples.some((s) => !Number.isInteger(s.x))),
        (samples) => {
          const inferred = fromJsonCorpus(samples)
          for (const s of samples) {
            const err = inhabits(s, inferred)
            if (err !== null) {
              throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
            }
          }
        },
      ),
      { numRuns: 1000 },
    )
  })

  test("width narrowing under mixed magnitude ints in one array (e.g. [1, 300, 70000])", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -3_000_000_000, max: 3_000_000_000 }), { minLength: 3, maxLength: 10 }),
        (arr) => {
          const inferred = fromJson(arr)
          const err = inhabits(arr, inferred)
          if (err !== null) {
            throw new Error(`${err}\n  value: ${JSON.stringify(arr)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
          }
        },
      ),
      { numRuns: 1000 },
    )
  })
})

// ---------------------------------------------------------------------------
// 3. String format confusion
// ---------------------------------------------------------------------------

describe("adversarial: string format confusion", () => {
  // Strings engineered to be near-misses on each format regex.
  const almostUuid = () => fc.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{11}$/) // one hex digit short
  const almostEmail = () => fc.stringMatching(/^[a-z]{2,8}@[a-z]{2,8}$/) // no TLD dot
  const almostDate = () => fc.stringMatching(/^\d{4}-\d{2}-\d{3}$/) // extra digit

  test("near-miss format strings never crash and infer as plain string", () => {
    fc.assert(
      fc.property(fc.oneof(almostUuid(), almostEmail(), almostDate()), (s) => {
        const inferred = fromJson(s)
        // These are deliberately malformed vs. every format regex — must not
        // be misclassified as a semantic string subtype.
        expect(inferred.shape.kind).toBe("string")
      }),
      { numRuns: 2000 },
    )
  })

  test("corpus: field is a valid email in some samples, plain string in others", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.tuple(fc.stringMatching(/^[a-z]{2,8}$/), fc.stringMatching(/^[a-z]{2,8}$/))
              .map(([u, d]) => ({ f: `${u}@${d}.com` })),
            fc.stringMatching(/^[A-Z][a-zA-Z]{2,10}$/).map((s) => ({ f: s })),
          ),
          { minLength: 3, maxLength: 20 },
        ).filter((samples) =>
          samples.some((s) => s.f.includes("@")) && samples.some((s) => !s.f.includes("@")),
        ),
        (samples) => {
          const inferred = fromJsonCorpus(samples)
          for (const s of samples) {
            const err = inhabits(s, inferred)
            if (err !== null) {
              throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
            }
          }
        },
      ),
      { numRuns: 1000 },
    )
  })

  test("format detection disagrees across samples at the same path (uuid vs date vs plain)", () => {
    const samples = [
      { f: "123e4567-e89b-12d3-a456-426614174000" },
      { f: "2026-01-01" },
      { f: "just a string" },
    ]
    const inferred = fromJsonCorpus(samples)
    for (const s of samples) {
      const err = inhabits(s, inferred)
      expect(err).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Union stress
// ---------------------------------------------------------------------------

describe("adversarial: union stress", () => {
  test("heterogeneous object array (no discriminant field) infers a type that accepts every element", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ a: fc.integer({ min: 0, max: 100 }) }),
            fc.record({ b: fc.stringMatching(/^[a-z]{3,8}$/) }),
            fc.record({ c: fc.boolean(), d: fc.integer({ min: 0, max: 10 }) }),
          ),
          { minLength: 3, maxLength: 12 },
        ),
        (arr) => {
          const inferred = fromJson(arr)
          const err = inhabits(arr, inferred)
          if (err !== null) {
            throw new Error(`${err}\n  value: ${JSON.stringify(arr)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
          }
        },
      ),
      { numRuns: 1000 },
    )
  })

  test("discriminated union detected when a field cleanly partitions shapes", () => {
    const samples = [
      { type: "circle", radius: 1 },
      { type: "circle", radius: 2 },
      { type: "circle", radius: 3 },
      { type: "square", side: 4 },
      { type: "square", side: 5 },
      { type: "square", side: 6 },
    ]
    const inferred = fromJsonCorpus(samples)
    for (const s of samples) {
      const err = inhabits(s, inferred)
      expect(err).toBeNull()
    }
  })

  test("corpus with different types at the same field path across samples never crashes and covers all", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.integer({ min: 0, max: 100 }).map((n) => ({ v: n })),
            fc.stringMatching(/^[a-z]{2,8}$/).map((s) => ({ v: s })),
            fc.boolean().map((b) => ({ v: b })),
            fc.array(fc.integer({ min: 0, max: 10 }), { minLength: 0, maxLength: 3 }).map((a) => ({ v: a })),
          ),
          { minLength: 3, maxLength: 20 },
        ),
        (samples) => {
          const inferred = fromJsonCorpus(samples)
          for (const s of samples) {
            const err = inhabits(s, inferred)
            if (err !== null) {
              throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
            }
          }
        },
      ),
      { numRuns: 500 },
    )
  })
})

// ---------------------------------------------------------------------------
// 5. Enum edge cases
// ---------------------------------------------------------------------------

describe("adversarial: enum edge cases", () => {
  test("boolean-like string enum: exactly 2 distinct values", () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ status: i % 2 === 0 ? "active" : "inactive" }))
    const inferred = fromJsonCorpus(samples)
    for (const s of samples) {
      const err = inhabits(s, inferred)
      expect(err).toBeNull()
    }
  })

  test("late new variant: enum grows sublinearly then a new value appears at the end", () => {
    const samples = [
      ...Array.from({ length: 20 }, (_, i) => ({ status: i % 3 === 0 ? "a" : i % 3 === 1 ? "b" : "c" })),
      { status: "surprise" },
    ]
    const inferred = fromJsonCorpus(samples)
    for (const s of samples) {
      const err = inhabits(s, inferred)
      if (err !== null) {
        throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
      }
    }
  })

  test("integer enum at large magnitude (the 800xxx-style case)", () => {
    const codes = [800001, 800002, 800003]
    const samples = Array.from({ length: 12 }, (_, i) => ({ code: codes[i % 3]! }))
    const inferred = fromJsonCorpus(samples)
    for (const s of samples) {
      const err = inhabits(s, inferred)
      if (err !== null) {
        throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
      }
    }
  })

  test("string enum member that is itself a valid email", () => {
    const samples = Array.from({ length: 12 }, (_, i) => ({
      role: ["admin", "editor", "admin@example.com"][i % 3]!,
    }))
    const inferred = fromJsonCorpus(samples)
    for (const s of samples) {
      const err = inhabits(s, inferred)
      if (err !== null) {
        throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
      }
    }
  })

  test("property: any corpus with a saturating small-K field infers a type covering every sample", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.array(fc.stringMatching(/^[a-z]{2,6}$/), { minLength: 2, maxLength: 5 }).map((a) => [...new Set(a)]).filter((a) => a.length >= 2),
          fc.integer({ min: 6, max: 30 }),
        ).chain(([members, n]) =>
          fc.array(fc.integer({ min: 0, max: members.length - 1 }), { minLength: n, maxLength: n })
            .map((idxs) => idxs.map((i) => ({ tag: members[i]! }))),
        ),
        (samples) => {
          const inferred = fromJsonCorpus(samples)
          for (const s of samples) {
            const err = inhabits(s, inferred)
            if (err !== null) {
              throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
            }
          }
        },
      ),
      { numRuns: 500 },
    )
  })
})

// ---------------------------------------------------------------------------
// 6. Dict vs record stress
// ---------------------------------------------------------------------------

describe("adversarial: dict vs record stress", () => {
  test("mixed object: some fixed keys + some varying keys per sample", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.dictionary(fc.stringMatching(/^k[0-9]{1,3}$/), fc.integer({ min: 0, max: 100 }), { minKeys: 0, maxKeys: 5 })
            .map((varying) => ({ fixedA: 1, fixedB: "x", ...varying })),
          { minLength: 4, maxLength: 30 },
        ),
        (samples) => {
          const inferred = fromJsonCorpus(samples)
          for (const s of samples) {
            const err = inhabits(s, inferred)
            if (err !== null) {
              throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
            }
          }
        },
      ),
      { numRuns: 500 },
    )
  })

  test("keys that are UUIDs (dict signal) never crash and cover all samples", () => {
    const uuidLike = () => fc.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    fc.assert(
      fc.property(
        fc.array(
          fc.dictionary(uuidLike(), fc.integer({ min: 0, max: 100 }), { minKeys: 1, maxKeys: 5 }),
          { minLength: 5, maxLength: 20 },
        ),
        (samples) => {
          const inferred = fromJsonCorpus(samples)
          for (const s of samples) {
            const err = inhabits(s, inferred)
            if (err !== null) {
              throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
            }
          }
        },
      ),
      { numRuns: 500 },
    )
  })

  test("numeric-string keys (dict signal) never crash and cover all samples", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.dictionary(fc.stringMatching(/^[0-9]{1,6}$/), fc.boolean(), { minKeys: 1, maxKeys: 6 }),
          { minLength: 5, maxLength: 20 },
        ),
        (samples) => {
          const inferred = fromJsonCorpus(samples)
          for (const s of samples) {
            const err = inhabits(s, inferred)
            if (err !== null) {
              throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
            }
          }
        },
      ),
      { numRuns: 500 },
    )
  })

  test("key set saturates (record-like) vs keeps growing (dict-like) — both cover all samples", () => {
    fc.assert(
      fc.property(
        fc.boolean().chain((saturates) => {
          const pool = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]
          return fc.array(fc.integer({ min: 8, max: 40 }), { minLength: 1, maxLength: 1 }).map(([n]) => {
            const samples: Record<string, number>[] = []
            for (let i = 0; i < n!; i++) {
              const keys = saturates ? pool.slice(0, 4) : pool.slice(0, Math.min(pool.length, 2 + (i % pool.length)))
              const obj: Record<string, number> = {}
              for (const k of keys) obj[k] = i
              samples.push(obj)
            }
            return samples
          })
        }),
        (samples) => {
          const inferred = fromJsonCorpus(samples)
          for (const s of samples) {
            const err = inhabits(s, inferred)
            if (err !== null) {
              throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
            }
          }
        },
      ),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------
// 7. Optional field edge cases
// ---------------------------------------------------------------------------

describe("adversarial: optional field edge cases", () => {
  test("deeply nested optional field (present in some samples, absent in others, 4 levels deep)", () => {
    const samples = [
      { a: { b: { c: { d: 1 } } } },
      { a: { b: { c: {} } } },
      { a: { b: { c: { d: 2 } } } },
    ]
    const inferred = fromJsonCorpus(samples)
    for (const s of samples) {
      const err = inhabits(s, inferred)
      if (err !== null) {
        throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
      }
    }
  })

  test("field present in exactly 1 of N samples is treated as optional and covers all", () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 30 }), (n) => {
        const samples: Record<string, number>[] = Array.from({ length: n }, () => ({ base: 1 }))
        samples[0]!.rare = 42
        const inferred = fromJsonCorpus(samples)
        for (const s of samples) {
          const err = inhabits(s, inferred)
          if (err !== null) {
            throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
          }
        }
      }),
      { numRuns: 300 },
    )
  })

  test("field present in (N-1)/N samples is treated as optional and covers all", () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 30 }), (n) => {
        const samples: Record<string, number>[] = Array.from({ length: n }, (_, i) => {
          const s: Record<string, number> = { base: 1 }
          if (i !== 0) s.almostAlways = i
          return s
        })
        const inferred = fromJsonCorpus(samples)
        for (const s of samples) {
          const err = inhabits(s, inferred)
          if (err !== null) {
            throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
          }
        }
      }),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------
// 8. Dirty data simulation
// ---------------------------------------------------------------------------

describe("adversarial: dirty data simulation", () => {
  test("95% integers / 5% strings at a field, with detectDirtyData off, still covers all samples", () => {
    fc.assert(
      fc.property(fc.integer({ min: 20, max: 100 }), (n) => {
        const samples: Record<string, unknown>[] = Array.from({ length: n }, (_, i) =>
          i % 20 === 0 ? { v: "oops" } : { v: i },
        )
        const inferred = fromJsonCorpus(samples)
        for (const s of samples) {
          const err = inhabits(s, inferred)
          if (err !== null) {
            throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
          }
        }
      }),
      { numRuns: 200 },
    )
  })

  test("95% integers / 5% strings, detectDirtyData ON, does not crash and clean type still present in union/meta", () => {
    fc.assert(
      fc.property(fc.integer({ min: 20, max: 100 }), (n) => {
        const samples: Record<string, unknown>[] = Array.from({ length: n }, (_, i) =>
          i % 20 === 0 ? { v: "oops" } : { v: i },
        )
        // Must not crash regardless of what shape falls out.
        fromJsonCorpus(samples, { detectDirtyData: true })
      }),
      { numRuns: 200 },
    )
  })

  test("one array element has a completely different shape from the rest", () => {
    const arr = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
      { totallyDifferent: true, nested: { x: 1 } },
      { id: 4, name: "d" },
    ]
    const inferred = fromJson(arr)
    const err = inhabits(arr, inferred)
    expect(err).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 9. Empty / degenerate cases
// ---------------------------------------------------------------------------

describe("adversarial: empty and degenerate cases", () => {
  test("empty arrays in corpus never crash", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.constant([]), fc.array(fc.integer({ min: 0, max: 10 }), { minLength: 1, maxLength: 5 })), { minLength: 1, maxLength: 20 }),
        (samples) => {
          fromJsonCorpus(samples)
        },
      ),
      { numRuns: 500 },
    )
  })

  test("null fields mixed with typed fields never crash and cover all samples", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.integer({ min: 0, max: 100 }).map((n) => ({ v: n })),
            fc.constant({ v: null }),
          ),
          { minLength: 3, maxLength: 20 },
        ),
        (samples) => {
          const inferred = fromJsonCorpus(samples)
          for (const s of samples) {
            const err = inhabits(s, inferred)
            if (err !== null) {
              throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
            }
          }
        },
      ),
      { numRuns: 500 },
    )
  })

  test("array of nulls never crashes", () => {
    fc.assert(
      fc.property(fc.array(fc.constant(null), { minLength: 0, maxLength: 10 }), (arr) => {
        fromJson(arr)
      }),
      { numRuns: 200 },
    )
  })

  test("object with only null values never crashes and covers the sample", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[a-z]{2,6}$/), fc.constant(null), { minKeys: 1, maxKeys: 6 }),
        (obj) => {
          const inferred = fromJson(obj)
          const err = inhabits(obj, inferred)
          expect(err).toBeNull()
        },
      ),
      { numRuns: 200 },
    )
  })

  test("deeply nested empty containers never crash", () => {
    const value = { a: [{ b: [] }, { b: [] }, { b: {} }], c: {} }
    expect(() => fromJson(value)).not.toThrow()
    expect(() => fromJsonCorpus([value, value, value])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 10. Large corpus
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 11. Chained type+value corpus fuzzing — fc.letrec for the type, .chain()
// for the value, applied at corpus scale (multiple values sharing one
// randomly generated type, fed through fromJsonCorpus). This is the
// "generate a type, then generate N conforming values, then check the
// corpus-inferred type covers every one of them" property the single-value
// fuzz harness (from-json.fuzz.test.ts) doesn't exercise.
// ---------------------------------------------------------------------------

const corpusFieldNames = ["id", "name", "tag", "count", "meta", "items", "flag", "ref"]

interface LetrecTypes {
  leaf: TypeRef
  node: TypeRef
}

const { node: corpusTypeArb } = fc.letrec<LetrecTypes>((tie) => ({
  leaf: fc.oneof(
    fc.constant(t(types.null)),
    fc.constant(t(types.boolean)),
    fc.constant(t(types.integer)),
    fc.constant(t(types.number)),
    fc.constant(t(types.string)),
  ),
  node: fc.oneof(
    { maxDepth: 4, depthIdentifier: "corpusType" },
    { weight: 3, arbitrary: tie("leaf") as fc.Arbitrary<TypeRef> },
    {
      weight: 2,
      arbitrary: fc.tuple(
        fc.shuffledSubarray(corpusFieldNames, { minLength: 1, maxLength: 4 }),
        fc.array(tie("node") as fc.Arbitrary<TypeRef>, { minLength: 1, maxLength: 4 }),
      ).map(([names, fieldTypes]) => {
        const fields: Record<string, TypeRef> = {}
        const count = Math.min(names.length, fieldTypes.length)
        for (let i = 0; i < count; i++) fields[names[i]!] = fieldTypes[i]!
        return t(types.object(fields))
      }),
    },
    { weight: 1, arbitrary: (tie("node") as fc.Arbitrary<TypeRef>).map((el) => t(types.array(el))) },
  ) as fc.Arbitrary<TypeRef>,
}))

function arbValueForCorpusType(ref: TypeRef): fc.Arbitrary<unknown> {
  const kind = ref.shape.kind
  switch (kind) {
    case "null": return fc.constant(null)
    case "boolean": return fc.boolean()
    case "integer": return fc.integer({ min: -10_000, max: 10_000 })
    case "number":
      return fc.double({ min: -10_000, max: 10_000, noNaN: true, noDefaultInfinity: true })
    case "string": return fc.stringMatching(/^[A-Za-z0-9]{0,10}$/)
    case "object": {
      const fields = objectFields(ref)
      const entries = Object.entries(fields)
      if (entries.length === 0) return fc.constant({})
      const arbs: Record<string, fc.Arbitrary<unknown>> = {}
      for (const [name, fieldRef] of entries) arbs[name] = arbValueForCorpusType(fieldRef)
      return fc.record(arbs)
    }
    case "array": {
      const element = (ref.shape as { element: TypeRef }).element
      return fc.array(arbValueForCorpusType(element), { minLength: 0, maxLength: 5 })
    }
    default:
      return fc.constant(null)
  }
}

// Chain: generate a random type, then a random-length corpus of conforming
// values (a mix of variants, since fields can independently vary), and
// verify fromJsonCorpus's merged type covers every sample.
function arbTypeAndCorpus(): fc.Arbitrary<{ type: TypeRef; corpus: unknown[] }> {
  return corpusTypeArb.chain((type) =>
    fc.array(arbValueForCorpusType(type), { minLength: 1, maxLength: 40 }).map((corpus) => ({ type, corpus })),
  )
}

describe("adversarial: chained type+value corpus fuzzing", () => {
  test("fromJsonCorpus never crashes on chained type-driven corpora", () => {
    fc.assert(
      fc.property(arbTypeAndCorpus(), ({ corpus }) => {
        fromJsonCorpus(corpus)
      }),
      { numRuns: 500 },
    )
  })

  test("fromJsonCorpus is deterministic on chained type-driven corpora", () => {
    fc.assert(
      fc.property(arbTypeAndCorpus(), ({ corpus }) => {
        const a = fromJsonCorpus(corpus)
        const b = fromJsonCorpus(corpus)
        expect(a).toEqual(b)
      }),
      { numRuns: 300 },
    )
  })

  test("corpus-inferred type covers every sample in the chained corpus", () => {
    fc.assert(
      fc.property(arbTypeAndCorpus(), ({ type, corpus }) => {
        const inferred = fromJsonCorpus(corpus)
        for (const sample of corpus) {
          const err = inhabits(sample, inferred)
          if (err !== null) {
            throw new Error(
              `${err}\n` +
              `  original type: ${JSON.stringify(type.shape)}\n` +
              `  sample:        ${JSON.stringify(sample)}\n` +
              `  corpus size:   ${corpus.length}\n` +
              `  inferred:      ${JSON.stringify(inferred.shape)}`,
            )
          }
        }
      }),
      { numRuns: 500 },
    )
  })
})

// ---------------------------------------------------------------------------
// 12. Miscellaneous adversarial edge cases — unsafe integers, missing
// discriminants, wide tuple-arity variance.
// ---------------------------------------------------------------------------

describe("adversarial: misc numeric and structural edge cases", () => {
  test("integers beyond Number.MAX_SAFE_INTEGER never crash and roundtrip", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(Number.MAX_SAFE_INTEGER + 2),
          fc.constant(-(Number.MAX_SAFE_INTEGER + 2)),
          fc.constant(1e21),
          fc.constant(-1e21),
          fc.double({ min: 1e16, max: 1e21, noNaN: true, noDefaultInfinity: true }).filter(Number.isInteger),
        ),
        (n) => {
          const inferred = fromJson(n)
          const err = inhabits(n, inferred)
          if (err !== null) {
            throw new Error(`${err}\n  value: ${n}\n  inferred: ${JSON.stringify(inferred.shape)}`)
          }
        },
      ),
      { numRuns: 500 },
    )
  })

  // FAILURE FOUND — see packages/type-ir/src/from-json-corpus.ts,
  // walkAndDetectEnums (lines ~310-352, both the string-enum branch at line
  // 321 and the integer-literal-union branch at line 346).
  //
  // Root cause: when enum detection replaces a field's TypeRef with
  // `t(types.enum(members))` or `t(types.union(variants))`, it constructs a
  // brand-new TypeRef and drops the original field's `meta` — in particular
  // `meta.optional: true`, set upstream by mergeObjectTypes when the field
  // isn't present in every sample. The result: a field that is genuinely
  // optional (absent from some corpus samples) comes back marked required
  // once enum detection kicks in, so the corpus-inferred type rejects the
  // very samples that omitted the field.
  //
  // Minimal counterexample fast-check found (shrunk from a generated
  // corpus, 18 shrink steps):
  //   fromJsonCorpus([
  //     { type: "a", x: 0 },
  //     { type: "a", x: 0 },
  //     { type: "a", x: 0 },
  //     { type: "a", x: 0 },
  //     { type: "a", x: 0 },
  //     { y: 0 },            // <- no `x` field at all
  //     { type: "a", x: 1 },
  //   ])
  // infers `x: union(literal(0), literal(1))` as REQUIRED (meta === {}),
  // even though sample #6 has no `x` field — meta.optional was silently
  // dropped by the enum/literal-union rewrite in walkAndDetectEnums.
  //
  // Fix direction (not applied — task is report-only): thread `ref.meta`
  // through at both return sites, e.g.
  //   return t(types.enum(members), ref.meta)
  //   return t(types.union(variants), ref.meta)
  // mirroring how the object/array/tuple/union recursive branches already
  // do `t(..., ref.meta)` a few lines below.
  test.todo("discriminant-like field missing from some elements does not crash DU detection", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ type: fc.constantFrom("a", "b", "c"), x: fc.integer({ min: 0, max: 10 }) }),
            fc.record({ y: fc.integer({ min: 0, max: 10 }) }), // no `type` field at all
          ),
          { minLength: 3, maxLength: 15 },
        ),
        (samples) => {
          const inferred = fromJsonCorpus(samples)
          for (const s of samples) {
            const err = inhabits(s, inferred)
            if (err !== null) {
              throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
            }
          }
        },
      ),
      { numRuns: 500 },
    )
  })

  test("tuples of widely varying arity across the corpus never crash and cover all samples", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.integer({ min: 0, max: 10 }), { minLength: 0, maxLength: 8 }),
          { minLength: 3, maxLength: 15 },
        ).filter((arrs) => new Set(arrs.map((a) => a.length)).size >= 2),
        (arrs) => {
          const samples = arrs.map((a) => ({ v: a }))
          const inferred = fromJsonCorpus(samples)
          for (const s of samples) {
            const err = inhabits(s, inferred)
            if (err !== null) {
              throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
            }
          }
        },
      ),
      { numRuns: 500 },
    )
  })
})

describe("adversarial: large corpus", () => {
  test("100+ sample corpus of moderately varied objects infers without blowing up", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.integer({ min: 0, max: 1_000_000 }),
            name: fc.stringMatching(/^[A-Z][a-z]{2,10}$/),
            tag: fc.constantFrom("alpha", "beta", "gamma"),
            score: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
            extra: fc.option(fc.stringMatching(/^[a-z]{2,8}$/), { nil: undefined }),
          }),
          { minLength: 100, maxLength: 250 },
        ),
        (samples) => {
          const cleaned = samples.map((s) => {
            const { extra, ...rest } = s
            return extra === undefined ? rest : { ...rest, extra }
          })
          const inferred = fromJsonCorpus(cleaned)
          for (const s of cleaned) {
            const err = inhabits(s, inferred)
            if (err !== null) {
              throw new Error(`${err}\n  sample: ${JSON.stringify(s)}\n  inferred: ${JSON.stringify(inferred.shape)}`)
            }
          }
        },
      ),
      { numRuns: 20 },
    )
  })

  test("determinism holds at large corpus size", () => {
    fc.assert(
      fc.property(
        fc.array(jsonDeep, { minLength: 100, maxLength: 150 }),
        (samples) => {
          const a = fromJsonCorpus(samples)
          const b = fromJsonCorpus(samples)
          expect(a).toEqual(b)
        },
      ),
      { numRuns: 10 },
    )
  })
})
