// spike/iron/run-scale.ts — typecheck each generated iron variant×N in
// ISOLATION via tsgo --extendedDiagnostics + wall-clock (best of RUNS after a
// warm-up). Also runs STOCK tsc at the high end for the survival gate. Writes
// CSV + md to logs/.

import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const HERE = import.meta.dir
const TSGO = join(HERE, "..", "..", "node_modules", ".bin", "tsgo")
const TSC = join(HERE, "..", "..", "node_modules", ".bin", "tsc")
const LOGS = join(HERE, "logs")

const Ns = [10, 100, 300, 600, 900]
const VARIANTS = ["I", "J"] as const
const WARMUP = 1
const RUNS = 3

interface Metric {
  variant: string
  n: number
  ok: boolean
  errors: number
  types?: number
  instantiations?: number
  memoryK?: number
  checkMs?: number
  totalMs?: number
  wallMs: number
}

function writeTc(file: string) {
  writeFileSync(
    join(HERE, "_run_tc.json"),
    JSON.stringify({ extends: "./tsconfig.base.json", include: [`generated/${file}`] }),
  )
}

function parseDiag(out: string) {
  const num = (re: RegExp) => {
    const m = out.match(re)
    return m ? Number(m[1].replace(/K$/, "")) : undefined
  }
  return {
    types: num(/Types:\s+(\d+)/),
    instantiations: num(/Instantiations:\s+(\d+)/),
    memoryK: num(/Memory used:\s+(\d+)K/),
    checkMs: (() => {
      const m = out.match(/Check time:\s+([\d.]+)s/)
      return m ? Math.round(Number(m[1]) * 1000) : undefined
    })(),
    totalMs: (() => {
      const m = out.match(/Total time:\s+([\d.]+)s/)
      return m ? Math.round(Number(m[1]) * 1000) : undefined
    })(),
    errors: (out.match(/error TS\d+/g) ?? []).length,
  }
}

function runOnce(bin: string, extraArgs: string[]): { out: string; wallMs: number } {
  const t0 = performance.now()
  let out = ""
  try {
    out = execFileSync(bin, ["-p", join(HERE, "_run_tc.json"), ...extraArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    out = (err.stdout ?? "") + (err.stderr ?? "")
  }
  return { out, wallMs: performance.now() - t0 }
}

const results: Metric[] = []

for (const v of VARIANTS) {
  for (const n of Ns) {
    const file = `${v}-${n}.ts`
    writeTc(file)
    for (let i = 0; i < WARMUP; i++) runOnce(TSGO, ["--extendedDiagnostics"])
    let best = Number.POSITIVE_INFINITY
    let lastOut = ""
    for (let i = 0; i < RUNS; i++) {
      const { out, wallMs } = runOnce(TSGO, ["--extendedDiagnostics"])
      lastOut = out
      if (wallMs < best) best = wallMs
    }
    const d = parseDiag(lastOut)
    const m: Metric = {
      variant: v,
      n,
      ok: d.errors === 0,
      errors: d.errors,
      types: d.types,
      instantiations: d.instantiations,
      memoryK: d.memoryK,
      checkMs: d.checkMs,
      totalMs: d.totalMs,
      wallMs: Math.round(best),
    }
    results.push(m)
    console.log(
      `${v}-${n}\tok=${m.ok}\terr=${m.errors}\ttypes=${m.types}\tinst=${m.instantiations}\tmemK=${m.memoryK}\tcheckMs=${m.checkMs}\ttotalMs=${m.totalMs}\twallMs=${m.wallMs}`,
    )
  }
}

// STOCK tsc survival gate — does the OLD stable compiler survive the iron model
// at the high end? Run variant I at 600 and 900 with stock tsc 6.0.3.
const stock: { variant: string; n: number; ok: boolean; errors: number; wallMs: number }[] = []
for (const n of [600, 900]) {
  writeTc(`I-${n}.ts`)
  const { out, wallMs } = runOnce(TSC, [])
  const errs = (out.match(/error TS\d+/g) ?? []).length
  stock.push({ variant: "I", n, ok: errs === 0, errors: errs, wallMs: Math.round(wallMs) })
  console.log(`STOCK tsc I-${n}\tok=${errs === 0}\terr=${errs}\twallMs=${Math.round(wallMs)}`)
}

const csv = ["variant,n,ok,errors,types,instantiations,memoryK,checkMs,totalMs,wallMs"]
for (const m of results) {
  csv.push(
    [m.variant, m.n, m.ok, m.errors, m.types ?? "", m.instantiations ?? "", m.memoryK ?? "", m.checkMs ?? "", m.totalMs ?? "", m.wallMs].join(","),
  )
}
writeFileSync(join(LOGS, "results.csv"), csv.join("\n") + "\n")

function table(metric: keyof Metric, label: string) {
  const lines: string[] = []
  lines.push(`### ${label}`)
  lines.push(`| N | ${VARIANTS.join(" | ")} |`)
  lines.push(`|---|${VARIANTS.map(() => "---").join("|")}|`)
  for (const n of Ns) {
    const cells = VARIANTS.map((v) => {
      const m = results.find((r) => r.variant === v && r.n === n)
      return m ? String(m[metric] ?? "—") : "—"
    })
    lines.push(`| ${n} | ${cells.join(" | ")} |`)
  }
  return lines.join("\n")
}

const md = [
  "# Iron model — tsgo --extendedDiagnostics by variant × N",
  "",
  "I = `choice(route(method, path(lit, param), fn), ...)` of handler VALUES + `client(app)` + typed probes.",
  "J = per-route typing only (no client) — isolates per-route cost.",
  "",
  table("instantiations", "Type instantiations"),
  "",
  table("types", "Types created"),
  "",
  table("checkMs", "Check time (ms)"),
  "",
  table("totalMs", "Total tsc time (ms)"),
  "",
  table("memoryK", "Memory used (KB)"),
  "",
  table("wallMs", "Wall-clock best-of-3 (ms, full process incl. startup)"),
  "",
  "## Stock tsc 6.0.3 survival gate (variant I)",
  "| N | ok | errors | wallMs |",
  "|---|---|---|---|",
  ...stock.map((s) => `| ${s.n} | ${s.ok} | ${s.errors} | ${s.wallMs} |`),
].join("\n")
writeFileSync(join(LOGS, "table.md"), md + "\n")
console.log("\nwrote logs/results.csv and logs/table.md")
