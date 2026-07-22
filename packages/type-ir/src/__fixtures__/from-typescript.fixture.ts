// packages/type-ir/src/__fixtures__/from-typescript.fixture.ts
//
// A real on-disk TS source file — used only by from-typescript.test.ts's
// `createExtractorProgram` smoke test, to confirm the factory produces a
// working `ts.Program` against an actual file (every other test in that
// suite builds an in-memory program instead, so coverage of the real
// extraction branches never depends on disk I/O).

export type Sample = {
  id: string
  count: number
}
