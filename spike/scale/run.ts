// spike/scale/run.ts — typecheck each generated variant×N in ISOLATION and
// record tsgo --extendedDiagnostics (Types, Instantiations, Memory, Check time)
// plus wall-clock (best of K runs, after one warm-up). Writes a CSV + a markdown
// table to logs/. tsgo is the nix-provided primary; pass `--tsc` to also run
// stock tsc 6.0.3 for cross-validation on a subset.

import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const HERE = import.meta.dir
const TSGO = join(HERE, "..", "..", "node_modules", ".bin", "tsgo")
const LOGS = join(HERE, "logs")

const Ns = [10, 100, 300, 600, 900]
const VARIANTS = ["A", "B", "C1", "C2"] as const
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
  wallMs: number // best of RUNS, ms
}

function writeTc(file: string) {
  writeFileSync(join(HERE, "_run_tc.json"),
    JSON.stringify({ extends: "./tsconfig.base.json", include: [`generated/${file}`] }))
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
    checkMs: (() => { const m = out.match(/Check time:\s+([\d.]+)s/); return m ? Math.round(Number(m[1]) * 1000) : undefined })(),
    totalMs: (() => { const m = out.match(/Total time:\s+([\d.]+)s/); return m ? Math.round(Number(m[1]) * 1000) : undefined })(),
    errors: (out.match(/error TS\d+/g) ?? []).length,
  }
}

function runOnce(): { out: string; wallMs: number } {
  const t0 = performance.now()
  let out = ""
  try {
    out = execFileSync(TSGO, ["-p", join(HERE, "_run_tc.json"), "--extendedDiagnostics"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 })
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
    // warm-up (paging the deps, JIT) — not counted
    for (let i = 0; i < WARMUP; i++) runOnce()
    let best = Number.POSITIVE_INFINITY
    let lastOut = ""
    for (let i = 0; i < RUNS; i++) {
      const { out, wallMs } = runOnce()
      lastOut = out
      if (wallMs < best) best = wallMs
    }
    const d = parseDiag(lastOut)
    const m: Metric = {
      variant: v, n, ok: d.errors === 0, errors: d.errors,
      types: d.types, instantiations: d.instantiations, memoryK: d.memoryK,
      checkMs: d.checkMs, totalMs: d.totalMs, wallMs: Math.round(best),
    }
    results.push(m)
    console.log(`${v}-${n}\tok=${m.ok}\terr=${m.errors}\ttypes=${m.types}\tinst=${m.instantiations}\tmemK=${m.memoryK}\tcheckMs=${m.checkMs}\ttotalMs=${m.totalMs}\twallMs=${m.wallMs}`)
  }
}

// CSV
const csv = ["variant,n,ok,errors,types,instantiations,memoryK,checkMs,totalMs,wallMs"]
for (const m of results) {
  csv.push([m.variant, m.n, m.ok, m.errors, m.types ?? "", m.instantiations ?? "", m.memoryK ?? "", m.checkMs ?? "", m.totalMs ?? "", m.wallMs].join(","))
}
writeFileSync(join(LOGS, "results.csv"), csv.join("\n") + "\n")

// Markdown table grouped by metric
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
  "# tsgo --extendedDiagnostics by variant × N (tsgo 7.0.0-dev native-preview)",
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
].join("\n")
writeFileSync(join(LOGS, "table.md"), md + "\n")
console.log("\nwrote logs/results.csv and logs/table.md")
