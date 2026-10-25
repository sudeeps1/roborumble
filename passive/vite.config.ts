import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const characters = fileURLToPath(new URL("../characters", import.meta.url));

export default defineConfig({
  server: {
    port: 5180,
    // Cross-origin isolation lets ONNX Runtime use threads (SharedArrayBuffer).
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    // planner/server.ts (SONIC kinematic planner) runs on 8787, or PLANNER_PORT.
    proxy: { "/planner": { target: `http://127.0.0.1:${process.env.PLANNER_PORT ?? 8787}`, rewrite: (p) => p.replace(/^\/planner/, "") } },
    // the elf skin lives next door in ../characters
    fs: { allow: [".", characters] },
  },
  resolve: {
    // @elf: the elf skin's runtime (../characters/src) and asset (../characters/public/elf.glb).
    // dedupe: it imports three too; there must be exactly one three.js on the page.
    alias: { "@elf": `${characters}/src`, "@elf-assets": `${characters}/public` },
    dedupe: ["three"],
  },
  // Both ship wasm next to their JS; pre-bundling would break the relative wasm URLs.
  optimizeDeps: { exclude: ["@mujoco/mujoco", "onnxruntime-web"] },
});
