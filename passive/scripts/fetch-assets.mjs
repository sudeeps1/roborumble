// Downloads everything the rig needs that isn't on npm. Skips files that are already there.
//   node scripts/fetch-assets.mjs            G1 model + meshes, SONIC encoder/decoder
//   node scripts/fetch-assets.mjs --planner  also the 774 MB SONIC kinematic planner (for planner/server.ts)
// Sources are pinned so the joint layout never shifts under us.
//   G1 model: NVlabs/GR00T-WholeBodyControl gear_sonic_deploy/g1 (Unitree assets, BSD-3)
//   SONIC weights: huggingface.co/nvidia/GEAR-SONIC (NVIDIA Open Model License)
import { access, mkdir, rename, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WBC_SHA = "45c03facbf848e0c743091b7d9c17952096ff908";
const HF_REV = "6733128a3d8a523b1418b06bca3cdf61c8b0987f";
const RAW = `https://raw.githubusercontent.com/NVlabs/GR00T-WholeBodyControl/${WBC_SHA}/gear_sonic_deploy/g1`;
const LFS = `https://media.githubusercontent.com/media/NVlabs/GR00T-WholeBodyControl/${WBC_SHA}/gear_sonic_deploy/g1`;
const HF = `https://huggingface.co/nvidia/GEAR-SONIC/resolve/${HF_REV}`;

const exists = (p) => access(p).then(() => true, () => false);

async function download(url, dest, minBytes = 1) {
  if (await exists(dest)) return false;
  await mkdir(dirname(dest), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const tmp = dest + ".part";
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      const { size } = await stat(tmp);
      // Git LFS pointer files are ~130 bytes; a real mesh is much bigger.
      if (size < minBytes) throw new Error(`only ${size} bytes (LFS pointer?)`);
      await rename(tmp, dest);
      return true;
    } catch (e) {
      if (attempt >= 3) throw new Error(`GET ${url} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

// 1. G1 robot model (the one SONIC's own sim uses) and its meshes
const g1Dir = join(ROOT, "public", "g1");
await download(`${RAW}/g1_29dof_old.xml`, join(g1Dir, "g1_29dof.xml"));
const { readFile } = await import("node:fs/promises");
const xml = await readFile(join(g1Dir, "g1_29dof.xml"), "utf8");
const meshes = [...new Set([...xml.matchAll(/file="([^"]+\.STL)"/g)].map((m) => m[1]))];
let got = 0;
for (let i = 0; i < meshes.length; i += 6) {
  const batch = meshes.slice(i, i + 6).map((f) => download(`${LFS}/meshes/${f}`, join(g1Dir, "meshes", f), 1000));
  got += (await Promise.all(batch)).filter(Boolean).length;
}
console.log(`g1: ${meshes.length} meshes (${got} downloaded)`);

// 2. SONIC whole-body controller (runs in the browser)
for (const f of ["model_encoder.onnx", "model_decoder.onnx", "observation_config.yaml"]) {
  if (await download(`${HF}/${f}`, join(ROOT, "public", "sonic", f))) console.log(`sonic: ${f}`);
}

// 3. SONIC kinematic planner (774 MB, runs in planner/server.ts, not the browser)
if (process.argv.includes("--planner")) {
  console.log("planner: downloading planner_sonic.onnx (774 MB)...");
  if (await download(`${HF}/planner_sonic.onnx`, join(ROOT, "models", "planner_sonic.onnx"), 1e8)) console.log("planner: done");
}
console.log("assets ready");
