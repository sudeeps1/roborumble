// Pulls Vaibhav's spell library from the GPU server into public/clips-library/ in the format the rig,
// the fight screen and the checkers read (spells.json + one ClipData file per motion). Read only: GETs.
//   node scripts/spell-sync.ts [--server https://...] [--out public/clips-library] [--limit N]
// Then: npm run spell-batch -- public/clips-library/spells.json checks every spell in the physics.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SERVER = opt("--server", process.env.KIMODO_SERVER ?? "https://kr2vjwse2bhd6t-8000.proxy.runpod.net");
const OUT = opt("--out", join(import.meta.dirname, "..", "public", "clips-library"));
const LIMIT = Number(opt("--limit", "0")) || Infinity;
const get = async (p: string) => {
  for (let k = 0; ; k++) {
    try {
      const r = await fetch(SERVER + p, { headers: { "User-Agent": "curl/8.7.1" }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return await r.json();
    } catch (e) { if (k >= 2) throw e; }
  }
};
// eight at a time
async function pool<T, R>(items: T[], f: (x: T) => Promise<R>, n = 8): Promise<R[]> {
  const out: R[] = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]); } }));
  return out;
}

mkdirSync(OUT, { recursive: true });
const list = ((await get("/library/moves")) as { id: string }[]).slice(0, LIMIT);
let bad = 0;
const lib = (await pool(list, async (m) => {
  try {
    const s = await get(`/move/${m.id}`);
    if (!s.motion_id) throw new Error("no motion");
    const clip = await get(`/motion/${s.motion_id}`);
    if (!Array.isArray(clip.qpos) || clip.qpos.length < 2) throw new Error("empty motion");
    const file = `${s.motion_id}.json`;
    writeFileSync(join(OUT, file), JSON.stringify({ fps: clip.fps ?? 30, qpos: clip.qpos }));
    return { name: s.name, kind: s.kind, type: s.type, effect: s.effect, power: s.power, hit_joint: s.hit_joint, hit_frame: s.hit_frame,
      stability: s.stability, aliases: s.aliases, prompt: s.kimodo_prompt, id: s.id, source: s.source, creator: s.creator, file };
  } catch (e) { bad++; console.log(`skipped ${m.id}: ${e instanceof Error ? e.message : e}`); return null; }
})).filter(Boolean);
writeFileSync(join(OUT, "spells.json"), JSON.stringify(lib, null, 1));
console.log(`${lib.length} spells synced to ${OUT}${bad ? `, ${bad} skipped` : ""}`);
