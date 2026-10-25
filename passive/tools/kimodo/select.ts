// Picks the clips to publish from clip-check reports: per motion, the best passing candidates (by
// score), kept only when they're not clearly worse than today's planner motion, written as a
// ClipSource library (index.json + clips) with a report.md comparing each pick with the planner.
//   node tools/kimodo/select.ts OUTDIR score.json [more reports...] [--baseline baseline.json]
//        [--keep 2] [--variants 1] [--lenient dodge.back,..]
// Run it from the folder clip-check ran in (report paths are relative to it). Planner rows
// (clip-check --baseline: job "baseline") are the baseline wherever they sit; --baseline FILE adds more.
// --keep N: guard variants kept (each fighter sticks to one, so 2 lets the two differ); --variants N:
// kept for every other motion (ClipSource picks one per ask by seed).
// A get-up clip only plays when its first frame lies the way the body lies, so getup.* keeps the
// best --keep starting face up AND the best --keep starting face down.
// OUTDIR may hold candidates (e.g. public/clips-everyday): every pick is read before anything is written.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

interface Row { file: string; motion: string; job?: string; sample?: number | string; pass: boolean; score: number; metrics?: Record<string, any>; notes?: string | string[]; line?: string }
const noteOf = (r: Row) => (Array.isArray(r.notes) ? r.notes.join("; ") : String(r.notes ?? ""));
// the planner's strike keys (motion.ts PUNCH): what a clip without its own hit frame was scored against
const PUNCH_KEY: Record<string, number> = { leftJab: 0.32, rightJab: 0.32, leftHook: 0.56, rightHook: 0.56 };
const argv = process.argv.slice(2);
const opt = (k: string, d = "") => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const VALUED = new Set(["--baseline", "--keep", "--variants", "--lenient"]);
const [outDir, ...reports] = argv.filter((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1]));
if (!outDir || !reports.length) { console.log("usage: node tools/kimodo/select.ts OUTDIR score.json [more...] [--baseline b.json] [--keep 2] [--variants 1] [--lenient keys]"); process.exit(1); }
const KEEP = Math.max(1, Number(opt("--keep", "2")) || 2);
const VARIANTS = Math.max(1, Number(opt("--variants", "1")) || 1);
// --lenient dodge.back[,..]: these motions also take candidates that miss a gate narrowly but score
// >= 80 (a fall caps the score at 20), e.g. a back dodge whose head is 0.16 m away by 0.3 s, not 0.18
const LENIENT = new Set(opt("--lenient").split(",").filter(Boolean));
// a character's own clip (meta.character, scored under its base key) is published as <key>.<character>
const charOf = (file: string): string => { try { return String((JSON.parse(readFileSync(file, "utf8")) as { meta?: { character?: string } }).meta?.character ?? ""); } catch { return ""; } };
const isBase = (r: Row) => r.job === "baseline" || r.file === "(planner)";
const scored = reports.flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as Row[]).filter((r) => r && r.file && r.motion && Number.isFinite(r.score));
// the same sample scored twice (e.g. re-scored with its own hit frame): the later report wins; a
// library's clips (job "library") are told apart by file
const same = (a: Row, o: Row) => a.motion === o.motion && (a.job && a.job !== "library" ? a.job === o.job && String(a.sample) === String(o.sample) : a.file === o.file);
const rows: Row[] = scored.filter((r) => !isBase(r))
  .map((r) => { const ch = charOf(r.file); return ch && !r.motion.endsWith(`.${ch}`) ? { ...r, motion: `${r.motion}.${ch}` } : r; })
  .filter((r, i, all) => !all.slice(i + 1).some((o) => same(r, o)));
const base = new Map<string, Row>();
for (const r of [...scored.filter(isBase), ...(opt("--baseline") ? JSON.parse(readFileSync(opt("--baseline"), "utf8")) as Row[] : [])]) base.set(r.motion, r);

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
const out: [string, string][] = []; // [file name, clip JSON], written once every pick has been read
const r2 = (_: string, v: unknown) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
// what a row did, for the report: clip-check's summary line (else its notes, else its metrics)
const said = (r?: Row) => (!r ? "-" : r.line || noteOf(r) || JSON.stringify({ ...r.metrics, trials: undefined, runs: undefined }, r2)).replace(/\|/g, "/").slice(0, 240);
const lines = ["# Everyday clips (Kimodo, physics-checked)", "",
  `${rows.length} candidates from ${reports.map((f) => basename(f)).join(", ")}, scored by scripts/clip-check.ts (contact mode). Per motion the best passing ones (guard and each get-up lying pose: top ${KEEP}; others: top ${VARIANTS}) that score at most 12 points (punches 5) under the planner. A motion without a pick stays on the planner. "vs planner": pick score minus the planner's.`, "",
  "| motion | picked | score | planner | vs planner | passing | the pick | the planner |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
const motions = [...new Set(rows.map((r) => r.motion))].sort();
for (const m of motions) {
  const all = rows.filter((r) => r.motion === m);
  // a punch must look like one: a sluggish fist (under 1.8 m/s at its peak) reads as a shove
  const fist = (r: Row) => Number(r.metrics?.fistPeak ?? /fist peak ([\d.]+) m\/s/.exec(noteOf(r))?.[1] ?? 99);
  const ok = all.filter((r) => (r.pass || (LENIENT.has(m) && r.score >= 80)) && (!m.startsWith("punch") || fist(r) >= 1.8)).sort((a, b) => b.score - a.score || (a.metrics?.seconds ?? 99) - (b.metrics?.seconds ?? 99)); // ties: the quicker get-up
  const b = base.get(m) ?? base.get(m.split(".").slice(0, m.startsWith("guard") ? 1 : 2).join("."));
  // the planner is clearly better at this one: keep it (a clip only replaces it when it holds up);
  // punches are held closer to the planner, whose fists are faster
  const floor = b?.pass ? b.score - (m.startsWith("punch") ? 5 : 12) : -Infinity;
  let picks: Row[];
  if (m.startsWith("getup")) {
    const groups = new Map<string, Row[]>();
    for (const r of ok) { const k = lies(r.file); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
    picks = [...groups.values()].flatMap((g) => g.filter((r) => r.score >= floor).slice(0, KEEP));
  } else picks = ok.filter((r) => r.score >= floor).slice(0, m.startsWith("guard") ? KEEP : VARIANTS);
  if (picks.length) {
    index[m] = picks.map((r, k) => {
      const name = `${m.replace(/\./g, "_")}_${k}.json`;
      const clip = JSON.parse(readFileSync(r.file, "utf8")) as { fps: number; qpos: unknown[]; meta?: Record<string, any> };
      // a punch strikes when its fist really arrived in the physics (the key it was scored against + how late it was)
      const late = ((r.metrics?.trials ?? []) as { late?: number | null }[]).map((t) => t.late).filter((x): x is number => Number.isFinite(x));
      if (m.startsWith("punch") && late.length) {
        const meta = (clip.meta ??= {}), fps = clip.fps || 30;
        // the clip's own key only counted when ClipSource could read it (motion.ts: hit_limb/hit_joint + hit_frame)
        const own = Number.isFinite(meta.hit_frame) && typeof (meta.hit_limb ?? meta.hit_joint) === "string";
        const used = own ? meta.hit_frame / fps : PUNCH_KEY[m.split(".")[1]] ?? 0.4;
        meta.hit_frame = Math.min(clip.qpos.length - 1, Math.max(1, Math.round((used + late.reduce((a, b) => a + b, 0) / late.length) * fps)));
        meta.hit_limb ??= meta.hit_joint ?? (m.includes("left") ? "l_hand" : "r_hand");
      }
      out.push([name, JSON.stringify(clip)]);
      return name;
    });
  }
  // the report shows the pick, else the best passing one, else the best failing one (why nothing passed)
  const best = picks[0] ?? ok[0] ?? [...all].sort((x, y) => y.score - x.score)[0], vs = picks[0] && b ? picks[0].score - b.score : NaN;
  const none = ok.length ? `none: planner stays (best ${ok[0].score.toFixed(0)} is too far under it)` : "none: planner stays";
  lines.push(`| ${m} | ${picks.map((r) => `${r.job ?? basename(r.file)}/${r.sample ?? ""}`).join(", ") || none} | ${best ? `${best.score.toFixed(0)}${ok.length ? "" : " (fails)"}` : "-"} | ${b ? `${b.score.toFixed(0)}${b.pass ? "" : " (fails)"}` : "-"} | ${Number.isFinite(vs) ? `${vs >= 0 ? "+" : ""}${vs.toFixed(0)}` : "-"} | ${ok.length}/${all.length} | ${said(best)} | ${said(b)} |`);
}
for (const [name, s] of out) writeFileSync(join(outDir, name), s);
writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 1));
const noClip = [...base.keys()].filter((m) => !motions.includes(m)).sort();
if (noClip.length) lines.push("", `No candidates, planner stays: ${noClip.map((m) => `${m} (${base.get(m)!.score.toFixed(0)}${base.get(m)!.pass ? "" : ", fails"})`).join(", ")}.`);
writeFileSync(join(outDir, "report.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
// clips an earlier selection left here: the index no longer lists them (ClipSource never loads them)
const stale = readdirSync(outDir).filter((f) => /_\d+\.json$/.test(f) && !out.some(([n]) => n === f));
if (stale.length) console.log(`\nnote: ${stale.length} older clips in ${outDir} are not in the new index: ${stale.slice(0, 10).join(", ")}${stale.length > 10 ? " ..." : ""}`);
console.log(`\n${out.length} clips for ${Object.keys(index).length} motions -> ${outDir}`);
