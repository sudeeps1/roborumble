import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // SERVER_URL from the shell or client/.env.local, e.g. SERVER_URL=http://gpu-box:8000
  const env = loadEnv(mode, process.cwd(), "");
  const server = env.SERVER_URL || "http://localhost:8000";
  return {
    server: {
      port: 5173,
      host: true, // reachable from phones on the same network
      // The game screen calls /api/* (HTTP and the room WebSocket); Vite forwards to the FastAPI server.
      proxy: {
        "/api": { target: server, changeOrigin: true, ws: true, rewrite: (p) => p.replace(/^\/api/, "") },
      },
    },
    build: {
      chunkSizeWarningLimit: 2000,
      rolldownOptions: { input: { main: "index.html", viewer: "viewer.html" } },
    },
  };
});
