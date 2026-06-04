// spike/std/scale/run.ts — typecheck each generated std-N app in ISOLATION and
// record tsgo --extendedDiagnostics (Types, Instantiations, Memory, Check time)
// + wall-clock (best of RUNS after a warm-up). Also cross-validates with stock
// tsc 6.0.3 (bunx tsc) at every N to prove it SURVIVES (the chained baseline
// crashes stock tsc between N=300 and N=600). Writes logs/results.csv + table.md.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const TSGO = join(HERE, "..", "..", "..", "node_modules", ".bin", "tsgo");
const LOGS = join(HERE, "logs");
mkdirSync(LOGS, { recursive: true });

const Ns = [10, 100, 300, 600, 900];
const WARMUP = 1;
const RUNS = 3;

interface Metric {
  n: number;
  ok: boolean;
  errors: number;
  types?: number;
  instantiations?: number;
  memoryK?: number;
  checkMs?: number;
  wallMs: number;
  tscOk: boolean;
  tscInst?: number;
  tscNote: string;
}

function writeTc(file: string): string {
  const p = join(HERE, "_run_tc.json");
  writeFileSync(
    p,
    JSON.stringify({
      extends: "./tsconfig.base.json",
      include: [`generated/${file}`],
    }),
  );
  return p;
}

function parseDiag(out: string) {
  const num = (re: RegExp) => {
    const m = out.match(re);
    return m ? Number(m[1].replace(/K$/, "")) : undefined;
  };
  return {
    types: num(/Types:\s+(\d+)/),
    instantiations: num(/Instantiations:\s+(\d+)/),
    memoryK: num(/Memory used:\s+(\d+)K/),
    checkMs: (() => {
      const m = out.match(/Check time:\s+([\d.]+)s/);
      return m ? Math.round(Number(m[1]) * 1000) : undefined;
    })(),
    errors: (out.match(/error TS\d+/g) ?? []).length,
  };
}

function runTsgo(tc: string): { out: string; wallMs: number } {
  const t0 = performance.now();
  let out = "";
  try {
    out = execFileSync(TSGO, ["-p", tc, "--extendedDiagnostics"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    out = (err.stdout ?? "") + (err.stderr ?? "");
  }
  return { out, wallMs: performance.now() - t0 };
}

// stock tsc 6.0.3 via bunx — capture instantiations and whether it crashed.
function runTsc(tc: string): { ok: boolean; inst?: number; note: string } {
  try {
    const out = execFileSync(
      "bunx",
      ["tsc", "-p", tc, "--extendedDiagnostics", "--pretty", "false"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const d = parseDiag(out);
    return { ok: d.errors === 0, inst: d.instantiations, note: d.errors === 0 ? "ok" : `${d.errors} errors` };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const all = (err.stdout ?? "") + (err.stderr ?? "");
    if (/Maximum call stack|stack overflow|RangeError/i.test(all)) {
      return { ok: false, note: "CRASH (stack overflow)" };
    }
    const d = parseDiag(all);
    return { ok: d.errors === 0, inst: d.instantiations, note: d.errors === 0 ? "ok" : `${d.errors} errors` };
  }
}

const results: Metric[] = [];

for (const n of Ns) {
  const file = `std-${n}.ts`;
  const tc = writeTc(file);
  for (let i = 0; i < WARMUP; i++) runTsgo(tc);
  let best = Number.POSITIVE_INFINITY;
  let lastOut = "";
  for (let i = 0; i < RUNS; i++) {
    const { out, wallMs } = runTsgo(tc);
    lastOut = out;
    if (wallMs < best) best = wallMs;
  }
  const d = parseDiag(lastOut);
  const tsc = runTsc(tc);
  const m: Metric = {
    n,
    ok: d.errors === 0,
    errors: d.errors,
    types: d.types,
    instantiations: d.instantiations,
    memoryK: d.memoryK,
    checkMs: d.checkMs,
    wallMs: Math.round(best),
    tscOk: tsc.ok,
    tscInst: tsc.inst,
    tscNote: tsc.note,
  };
  results.push(m);
  console.log(
    `std-${n}\ttsgoOk=${m.ok}\tinst=${m.instantiations}\ttypes=${m.types}\tmemK=${m.memoryK}\tcheckMs=${m.checkMs}\twallMs=${m.wallMs}\t| tsc: ${m.tscNote} inst=${m.tscInst ?? "-"}`,
  );
}

const csv = ["n,tsgoOk,errors,types,instantiations,memoryK,checkMs,wallMs,tscOk,tscInst,tscNote"];
for (const m of results) {
  csv.push(
    [m.n, m.ok, m.errors, m.types ?? "", m.instantiations ?? "", m.memoryK ?? "", m.checkMs ?? "", m.wallMs, m.tscOk, m.tscInst ?? "", `"${m.tscNote}"`].join(","),
  );
}
writeFileSync(join(LOGS, "results.csv"), csv.join("\n") + "\n");

const md: string[] = [
  "# std typed-client compile cost by N (tsgo 7.0.0-dev native-preview + stock tsc 6.0.3)",
  "",
  "| N | tsgo inst | tsgo types | tsgo check ms | tsgo mem KB | tsgo wall ms | stock tsc inst | stock tsc |",
  "|---|---|---|---|---|---|---|---|",
];
for (const m of results) {
  md.push(
    `| ${m.n} | ${m.instantiations ?? "—"} | ${m.types ?? "—"} | ${m.checkMs ?? "—"} | ${m.memoryK ?? "—"} | ${m.wallMs} | ${m.tscInst ?? "—"} | ${m.tscNote} |`,
  );
}
writeFileSync(join(LOGS, "table.md"), md.join("\n") + "\n");
console.log("\nwrote logs/results.csv and logs/table.md");
