// Downloads the MuJoCo Menagerie Unitree G1 (g1.xml + the meshes it uses) into public/g1/.
// Runs before `npm run dev` / `mock` / `build`; skips files that are already there.
// Pinned to one Menagerie commit so the body names never shift under us.
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = "cda5236f98383f6fbaa4820c6b18dba892cd087f";
const BASE = `https://raw.githubusercontent.com/google-deepmind/mujoco_menagerie/${COMMIT}/unitree_g1`;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "g1");

const exists = (p) => access(p).then(() => true, () => false);

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 3) throw new Error(`GET ${url} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function fetchTo(rel) {
  const dest = join(OUT, rel);
  if (await exists(dest)) return false;
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, await get(`${BASE}/${rel}`));
  return true;
}

await mkdir(OUT, { recursive: true });
await fetchTo("LICENSE");
await fetchTo("g1.xml");
const { readFile } = await import("node:fs/promises");
const xml = await readFile(join(OUT, "g1.xml"), "utf8");
const meshdir = xml.match(/meshdir="([^"]+)"/)?.[1] ?? "assets";
const files = [...new Set([...xml.matchAll(/<mesh\b[^>]*\bfile="([^"]+)"/g)].map((m) => m[1]))];

let fetched = 0;
for (let i = 0; i < files.length; i += 6) {
  const got = await Promise.all(files.slice(i, i + 6).map((f) => fetchTo(`${meshdir}/${f}`)));
  fetched += got.filter(Boolean).length;
}
if (fetched) console.log(`fetch-g1: downloaded ${fetched} of ${files.length} G1 meshes into public/g1/`);
