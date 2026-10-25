import { defineConfig, type Plugin } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Dev-only helper: `SHOT_DIR=/some/dir npm run dev` lets the page POST canvas PNGs to /__shot?name=x
// (viewer.shot("x") in the console). Off unless SHOT_DIR is set.
function shots(): Plugin {
  return {
    name: "shots",
    configureServer(server) {
      const dir = process.env.SHOT_DIR;
      if (!dir) return;
      mkdirSync(dir, { recursive: true });
      server.middlewares.use("/__shot", (req, res) => {
        const name = (new URL(req.url ?? "", "http://x").searchParams.get("name") ?? "shot").replace(/[^\w.-]/g, "_");
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const b64 = Buffer.concat(chunks).toString().replace(/^data:image\/png;base64,/, "");
          const file = join(dir, `${name}.png`);
          writeFileSync(file, Buffer.from(b64, "base64"));
          res.end(file);
        });
      });
    },
  };
}

// public/ (elf.glb) is served at the site root; src/g1_kinematics.json is imported as a module.
export default defineConfig({
  publicDir: "public",
  server: { port: 5190 },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  plugins: [shots()],
});
