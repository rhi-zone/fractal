// spike/drift-guard/run.ts — measure each guard formulation × N.
//
// For each formulation file × resource-count, typecheck in ISOLATION and record
// tsgo --extendedDiagnostics (instantiations, check ms, errors) plus stock-tsc
// 6.0.3 survival (ok / crash / errors). The in-sync cases must be 0 errors; we
// measure their COST. Writes logs/results.csv + logs/table.md.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const TSGO = join(HERE, "..", "..", "node_modules", ".bin", "tsgo");
const TSC = join(HERE, "..", "..", "node_modules", ".bin", "tsc");
const LOGS = join(HERE, "logs");

// resource counts → ~3x routes. (33→99, 100→300, 200→600, 300→900)
const RES = [33, 100, 200, 300];
const ROUTES: Record<number, number> = { 33: 99, 100: 300, 200: 600, 300: 900 };
// formulation file prefixes (in-sync). noguard = baseline; f1 = naive; f2 =
// flatmap (candidate); f3 = per-route; f4 = hybrid.
const FORMS = ["noguard", "f1-naive", "f2-flatmap", "f3-perroute", "f4-hybrid", "f5-union"] as const;
const RUNS = 2;
const WARMUP = 1;

function tcfg(file: string) {
  writeFileSync(join(HERE, "_run_tc.json"),
    JSON.stringify({ extends: "./tsconfig.base.json", include: [`out/${file}`] }));
}

function parse(out: string) {
  const num = (re: RegExp) => { const m = out.match(re); return m ? Number(m[1]) : undefined; };
  return {
    instantiations: num(/Instantiations:\s+(\d+)/),
    types: num(/Types:\s+(\d+)/),
    checkMs: (() => { const m = out.match(/Check time:\s+([\d.]+)s/); return m ? Math.round(Number(m[1]) * 1000) : undefined; })(),
    errors: (out.match(/error TS\d+/g) ?? []).length,
    crash: /RangeError|stack size exceeded|Maximum call stack|FATAL|out of memory/i.test(out),
  };
}

function runTsgo(): string {
  try {
    return execFileSync(TSGO, ["-p", join(HERE, "_run_tc.json"), "--extendedDiagnostics"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return (x.stdout ?? "") + (x.stderr ?? "");
  }
}

function runTsc(): { out: string; crash: boolean } {
  try {
    const out = execFileSync(TSC, ["-p", join(HERE, "_run_tc.json")],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
    return { out, crash: false };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; status?: number | null };
    const out = (x.stdout ?? "") + (x.stderr ?? "");
    // a real type error exits 2 with `error TS…`; a crash has no TS errors but a
    // RangeError/stack message, OR a null status (killed).
    const crash = /RangeError|stack size exceeded|Maximum call stack|FATAL/i.test(out)
      || (x.status == null && !/error TS\d+/.test(out));
    return { out, crash };
  }
}

interface Row {
  form: string; res: number; routes: number;
  inst?: number; checkMs?: number; tsgoErrors: number;
  tscOk: boolean; tscCrash: boolean; tscErrors: number;
}

const rows: Row[] = [];

for (const form of FORMS) {
  for (const res of RES) {
    const file = `${form}-${res}.ts`;
    tcfg(file);
    for (let i = 0; i < WARMUP; i++) runTsgo();
    let best: ReturnType<typeof parse> | undefined;
    for (let i = 0; i < RUNS; i++) {
      const p = parse(runTsgo());
      if (!best || (p.instantiations ?? Infinity) <= (best.instantiations ?? Infinity)) best = p;
    }
    const tsc = runTsc();
    const tscP = parse(tsc.out);
    const row: Row = {
      form, res, routes: ROUTES[res]!,
      inst: best!.instantiations, checkMs: best!.checkMs, tsgoErrors: best!.errors,
      tscOk: !tsc.crash && tscP.errors === 0, tscCrash: tsc.crash, tscErrors: tscP.errors,
    };
    rows.push(row);
    console.log(
      `${form.padEnd(12)} res=${String(res).padStart(3)} routes=${String(row.routes).padStart(3)} ` +
      `inst=${String(row.inst).padStart(8)} checkMs=${String(row.checkMs).padStart(5)} ` +
      `tsgoErr=${row.tsgoErrors} tsc=${row.tscCrash ? "CRASH" : row.tscOk ? "ok" : `ERR(${row.tscErrors})`}`,
    );
  }
}

const csv = ["form,res,routes,instantiations,checkMs,tsgoErrors,tscOk,tscCrash,tscErrors"];
for (const r of rows) csv.push([r.form, r.res, r.routes, r.inst ?? "", r.checkMs ?? "", r.tsgoErrors, r.tscOk, r.tscCrash, r.tscErrors].join(","));
writeFileSync(join(LOGS, "results.csv"), csv.join("\n") + "\n");

function tbl(pick: (r: Row) => string | number, label: string) {
  const L = [`### ${label}`, `| routes | ${FORMS.join(" | ")} |`, `|---|${FORMS.map(() => "---").join("|")}|`];
  for (const res of RES) {
    const cells = FORMS.map((f) => { const r = rows.find((x) => x.form === f && x.res === res); return r ? String(pick(r)) : "—"; });
    L.push(`| ${ROUTES[res]} | ${cells.join(" | ")} |`);
  }
  return L.join("\n");
}

writeFileSync(join(LOGS, "table.md"), [
  "# Drift-guard scale: formulation × N (tsgo 7.0.0-dev + stock tsc 6.0.3)",
  "", tbl((r) => r.inst ?? "—", "Type instantiations (tsgo)"),
  "", tbl((r) => r.checkMs ?? "—", "Check time ms (tsgo)"),
  "", tbl((r) => r.tscCrash ? "CRASH" : r.tscOk ? "ok" : `ERR`, "Stock tsc 6.0.3 survival"),
  "",
].join("\n") + "\n");

console.log("\nwrote logs/results.csv + logs/table.md");
