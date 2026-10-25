// Picks the clips to publish from clip-check reports: per motion, the best passing candidates (by
// score), kept only when they're not clearly worse than today's planner motion, written as a
// ClipSource library (index.json + clips) with a report.md.
//   node tools/kimodo/select.ts OUTDIR score.json [more reports...] [--baseline baseline.json] [--keep 2]
// A get-up clip only plays when its first frame lies the way the body lies, so getup.* keeps the
// best few starting face up AND the best few starting face down.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

interface Row { file: string; motion: string; job?: string; sample?: number; pass: boolean; score: number; metrics?: Record<string, unknown>; notes?: string }
const argv = process.argv.slice(2);
const opt = (k: string, d = "") => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const VALUED = new Set(["--baseline", "--keep"]);
const [outDir, ...reports] = argv.filter((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1]));
const KEEP = Math.max(1, Number(opt("--keep", "2")) || 2);
const rows: Row[] = reports.flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as Row[]).filter((r) => r && r.file && Number.isFinite(r.score));
const base = new Map<string, Row>();
if (opt("--baseline")) for (const r of JSON.parse(readFileSync(opt("--baseline"), "utf8")) as Row[]) base.set(r.motion, r);

// which way a clip's first frame lies: gravity in the pelvis frame (z down = standing)
function lies(file: string): "up" | "back" | "front" | "side" {
  try {
    const q = (JSON.parse(readFileSync(file, "utf8")) as { qpos: number[][] }).qpos[0];
    const [w, x, y, z] = [q[3], q[4], q[5], q[6]];
    const bz = 1 - 2 * (x * x + y * y), bx = 2 * (x * z - w * y); // world z of the body's z and x axes
    if (bz > 0.6) return "up";
    return Math.abs(bx) > 0.6 ? (bx > 0 ? "front" : "back") : "side";
  } catch { return "up"; }
}

mkdirSync(outDir, { recursive: true });
const index: Record<string, string[]> = {};
const lines = ["# Everyday clips (Kimodo, physics-checked)", "", "| motion | picked | score | baseline (planner) | candidates passing | notes |", "| --- | --- | --- | --- | --- | --- |"];
const motions = [...new Set(rows.map((r) => r.motion))].sort();
for (const m of motions) {
  const all = rows.filter((r) => r.motion === m);
  // a punch must look like one: a sluggish fist (under 1.8 m/s at its peak) reads as a shove
  const fist = (r: Row) => Number(/fist peak ([\d.]+) m\/s/.exec(r.notes ?? "")?.[1] ?? 99);
  const ok = all.filter((r) => r.pass && (!m.startsWith("punch") || fist(r) >= 1.8)).sort((a, b) => b.score - a.score);
  const b = base.get(m);
  // the planner is clearly better at this one: keep it (a clip only replaces it when it holds up);
  // punches are held closer to the planner, whose fists are faster
  const floor = b?.pass ? b.score - (m.startsWith("punch") ? 5 : 12) : -Infinity;
  let picks: Row[];
  if (m.startsWith("getup")) {
    const groups = new Map<string, Row[]>();
    for (const r of ok) { const k = lies(r.file); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
    picks = [...groups.values()].flatMap((g) => g.filter((r) => r.score >= floor).slice(0, KEEP));
  } else picks = ok.filter((r) => r.score >= floor).slice(0, KEEP);
  if (picks.length) {
    index[m] = picks.map((r, k) => {
      const name = `${m.replace(/\./g, "_")}_${k}.json`;
      copyFileSync(r.file, join(outDir, name));
      return name;
    });
  }
  const best = ok[0];
  lines.push(`| ${m} | ${picks.map((r) => `${r.job ?? basename(r.file)}/${r.sample ?? ""}`).join(", ") || "none: planner stays"} | ${best ? best.score.toFixed(0) : "-"} | ${b ? `${b.score.toFixed(0)}${b.pass ? "" : " (fails)"}` : "-"} | ${ok.length}/${all.length} | ${(best?.notes ?? "").replace(/\|/g, "/").slice(0, 160)} |`);
}
writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 1));
writeFileSync(join(outDir, "report.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log(`\n${Object.values(index).flat().length} clips for ${Object.keys(index).length} motions -> ${outDir}`);
