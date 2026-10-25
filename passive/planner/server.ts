// Local HTTP service for the SONIC kinematic planner (774 MB, too big for the browser).
//   npm run planner     (needs `npm run setup:planner` once)
// POST /plan  {context, mode, movement, facing, speed?, height?, seed?} -> {frames: n*36 at 30 Hz}
// GET  /health
import { createServer } from "node:http";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import { OnnxPlanner, type PlanRequest } from "../src/core/planner.ts";

const PORT = Number(process.env.PLANNER_PORT ?? 8787);
const model = join(import.meta.dirname, "..", "models", "planner_sonic.onnx");

const t0 = performance.now();
const planner = await OnnxPlanner.load(ort as never, model);
console.log(`planner loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

let served = 0, totalMs = 0;
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, served, avgMs: served ? totalMs / served : 0 }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/plan") { res.writeHead(404).end(); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const r = JSON.parse(body) as PlanRequest;
    if (!Array.isArray(r.context) || r.context.length !== 144) throw new Error("context must be 4 x 36 numbers");
    const a = performance.now();
    const frames = await planner.plan(r);
    totalMs += performance.now() - a; served++;
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ hz: 30, frames: Array.from(frames) }));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
  }
});
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`planner: port ${PORT} is already in use, so a planner is probably running already.`);
  console.error(`Stop it, or run this one on another port with PLANNER_PORT=8788 (and start the rig with the same PLANNER_PORT).`);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => console.log(`planner on http://127.0.0.1:${PORT}`));
