import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5180,
    // Cross-origin isolation lets ONNX Runtime use threads (SharedArrayBuffer).
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    // planner/server.ts (SONIC kinematic planner) runs on 8787.
    proxy: { "/planner": { target: "http://127.0.0.1:8787", rewrite: (p) => p.replace(/^\/planner/, "") } },
  },
  // Both ship wasm next to their JS; pre-bundling would break the relative wasm URLs.
  optimizeDeps: { exclude: ["@mujoco/mujoco", "onnxruntime-web"] },
});
