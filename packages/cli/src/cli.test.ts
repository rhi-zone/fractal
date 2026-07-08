// packages/cli/src/cli.test.ts — @rhi-zone/fractal-cli
//
// Tests using examples/library-api/src/tree.ts as the fixture tree.
//
// All tests inject a mock CliIO so nothing touches process.stdout/stderr.
// runCli throws CliError on error/abort rather than calling process.exit(),
// so the bun test runner stays alive across all tests.

import { describe, it, expect, beforeEach } from "bun:test"
import { runCli, CliError } from "./cli.ts"
import { api, clearStore } from "../../../examples/library-api/src/tree.ts"

// ============================================================================
// Mock IO
// ============================================================================

type MockIO = {
  out: string[]
  err: string[]
  confirmAnswer: boolean
  confirmCalled: boolean
  confirmPrompts: string[]
  io: {
    stdout: { write(s: string): void }
    stderr: { write(s: string): void }
    confirm(prompt: string): Promise<boolean>
  }
}

function makeMockIO(confirmAnswer = true): MockIO {
  const mock: MockIO = {
    out: [],
    err: [],
    confirmAnswer,
    confirmCalled: false,
    confirmPrompts: [],
    io: {
      stdout: { write: (s: string) => { mock.out.push(s) } },
      stderr: { write: (s: string) => { mock.err.push(s) } },
      confirm: async (prompt: string) => {
        mock.confirmCalled = true
        mock.confirmPrompts.push(prompt)
        return mock.confirmAnswer
      },
    },
  }
  return mock
}

// ============================================================================
// Helpers
// ============================================================================

/** Run cli and return captured streams. */
async function run(
  argv: string[],
  confirmAnswer = true,
): Promise<{ stdout: string; stderr: string; mock: MockIO }> {
  const mock = makeMockIO(confirmAnswer)
  await runCli(api, argv, mock.io)
  return {
    stdout: mock.out.join(""),
    stderr: mock.err.join(""),
    mock,
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("CLI projection — library-api fixture", () => {
  beforeEach(() => {
    clearStore()
  })

  // 1. Subcommand path resolves from tree position
  it("books list — resolves to BooksService.list op", async () => {
    const { stdout } = await run(["books", "list"])
    const result = JSON.parse(stdout)
    expect(Array.isArray(result)).toBe(true)
  })

  it("catalog search — resolves to catalog node's search op", async () => {
    const { stdout } = await run(["catalog", "search"])
    const result = JSON.parse(stdout)
    expect(Array.isArray(result)).toBe(true)
  })

  it("unknown command — throws CliError", async () => {
    const mock = makeMockIO()
    await expect(runCli(api, ["nonexistent", "op"], mock.io)).rejects.toBeInstanceOf(CliError)
  })

  // 2. readOnly op runs WITHOUT calling io.confirm
  it("books list (readOnly) — does NOT call confirm", async () => {
    const mock = makeMockIO(false)
    await runCli(api, ["books", "list"], mock.io)
    expect(mock.confirmCalled).toBe(false)
  })

  it("catalog search (readOnly inherited from node) — does NOT call confirm", async () => {
    const mock = makeMockIO(false)
    await runCli(api, ["catalog", "search"], mock.io)
    expect(mock.confirmCalled).toBe(false)
  })

  // 3. destructive op DOES call io.confirm; --yes skips it
  it("books byId remove (destructive) — calls confirm when no --yes", async () => {
    // First add a book
    const addMock = makeMockIO(true)
    await runCli(api, ["books", "add", "--title", "Dune", "--author", "Herbert", "--genre", "Sci-Fi"], addMock.io)
    const book = JSON.parse(addMock.out.join("")) as { id: string }

    const removeMock = makeMockIO(true)  // confirm returns true
    await runCli(api, ["books", "byId", book.id, "remove"], removeMock.io)
    expect(removeMock.confirmCalled).toBe(true)
  })

  it("books byId remove (destructive) with --yes — skips confirm, succeeds", async () => {
    // Add a book first
    const addMock = makeMockIO(true)
    await runCli(api, ["books", "add", "--title", "Dune", "--author", "Herbert", "--genre", "Sci-Fi"], addMock.io)
    const book = JSON.parse(addMock.out.join("")) as { id: string }

    const removeMock = makeMockIO(false)  // confirm would return false, but should not be called
    await runCli(api, ["books", "byId", book.id, "remove", "--yes"], removeMock.io)
    expect(removeMock.confirmCalled).toBe(false)
    const result = JSON.parse(removeMock.out.join("")) as { deleted: boolean }
    expect(result.deleted).toBe(true)
  })

  it("books byId remove (destructive) confirm declined — throws CliError", async () => {
    // Add a book
    const addMock = makeMockIO(true)
    await runCli(api, ["books", "add", "--title", "Dune", "--author", "Herbert", "--genre", "Sci-Fi"], addMock.io)
    const book = JSON.parse(addMock.out.join("")) as { id: string }

    const removeMock = makeMockIO(false)  // confirm returns false → abort
    await expect(
      runCli(api, ["books", "byId", book.id, "remove"], removeMock.io)
    ).rejects.toBeInstanceOf(CliError)
    expect(removeMock.confirmCalled).toBe(true)
    expect(removeMock.err.join("")).toContain("Aborted")
  })

  // 4. param-node slug value threads into op input (round-trip)
  it("books byId details — slug bookId threads into op input", async () => {
    // Add a book to get a known ID
    const addMock = makeMockIO(true)
    await runCli(api, ["books", "add", "--title", "Foundation", "--author", "Asimov", "--genre", "Sci-Fi"], addMock.io)
    const added = JSON.parse(addMock.out.join("")) as { id: string; title: string }

    // Fetch it via param-node slug path: books byId <id> details
    const detailsMock = makeMockIO(true)
    await runCli(api, ["books", "byId", added.id, "details"], detailsMock.io)
    const fetched = JSON.parse(detailsMock.out.join("")) as { id: string; title: string }

    expect(fetched.id).toBe(added.id)
    expect(fetched.title).toBe("Foundation")
  })

  // 5. Input fields parse from --flags
  it("books add — parses --title --author --genre flags into op input", async () => {
    const { stdout } = await run(["books", "add", "--title", "Neuromancer", "--author", "Gibson", "--genre", "Cyberpunk"])
    const book = JSON.parse(stdout) as { id: string; title: string; author: string; genre: string }
    expect(book.title).toBe("Neuromancer")
    expect(book.author).toBe("Gibson")
    expect(book.genre).toBe("Cyberpunk")
    expect(typeof book.id).toBe("string")
  })

  it("catalog search --q filters results", async () => {
    // Add two books
    await run(["books", "add", "--title", "Dune", "--author", "Herbert", "--genre", "Sci-Fi"])
    await run(["books", "add", "--title", "Foundation", "--author", "Asimov", "--genre", "Sci-Fi"])

    const { stdout } = await run(["catalog", "search", "--q", "dune"])
    const results = JSON.parse(stdout) as { title: string }[]
    expect(results.length).toBe(1)
    expect(results[0]?.title).toBe("Dune")
  })

  // 6. Result is written to io.stdout
  it("result is written to io.stdout as JSON", async () => {
    const mock = makeMockIO(true)
    await runCli(api, ["books", "add", "--title", "Test Book", "--author", "Tester", "--genre", "Fiction"], mock.io)
    expect(mock.out.length).toBeGreaterThan(0)
    const out = mock.out.join("")
    const parsed = JSON.parse(out) as unknown
    expect(parsed).toBeTruthy()
  })

  // 7. --help produces usage text
  it("--help produces usage text at root", async () => {
    const mock = makeMockIO(true)
    await runCli(api, ["--help"], mock.io)
    const out = mock.out.join("")
    expect(out).toContain("Usage:")
    expect(out).toContain("--help")
  })

  it("books --help lists subcommands", async () => {
    const mock = makeMockIO(true)
    await runCli(api, ["books", "--help"], mock.io)
    const out = mock.out.join("")
    expect(out).toContain("Usage:")
  })

  it("books add --help shows add op usage", async () => {
    const mock = makeMockIO(true)
    await runCli(api, ["books", "add", "--help"], mock.io)
    const out = mock.out.join("")
    expect(out).toContain("Usage:")
  })

  // Extra: books update (idempotent, not destructive) — no confirm
  it("books byId update (idempotent, not destructive) — no confirm, result written", async () => {
    const addMock = makeMockIO(true)
    await runCli(api, ["books", "add", "--title", "Old Title", "--author", "Auth", "--genre", "Genre"], addMock.io)
    const book = JSON.parse(addMock.out.join("")) as { id: string }

    const updateMock = makeMockIO(false)  // would say no if asked
    await runCli(api, ["books", "byId", book.id, "update", "--title", "New Title"], updateMock.io)
    expect(updateMock.confirmCalled).toBe(false)
    const updated = JSON.parse(updateMock.out.join("")) as { title: string }
    expect(updated.title).toBe("New Title")
  })

  // catalog genres
  it("catalog genres — returns genres array", async () => {
    await run(["books", "add", "--title", "Dune", "--author", "Herbert", "--genre", "Sci-Fi"])
    await run(["books", "add", "--title", "Neuromancer", "--author", "Gibson", "--genre", "Cyberpunk"])
    const { stdout } = await run(["catalog", "genres"])
    const genres = JSON.parse(stdout) as string[]
    expect(genres).toContain("Sci-Fi")
    expect(genres).toContain("Cyberpunk")
  })
})
