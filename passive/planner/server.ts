// Local HTTP service for the SONIC kinematic planner (774 MB, too big for the browser).
//   npm run planner     (needs `npm run setup:planner` once)
// POST /plan  {context, mode, movement, facing, speed?, height?, seed?, urgent?} -> {frames: n*36 at 30 Hz}
// GET  /health
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import { OnnxPlanner, type PlanRequest } from "../src/core/planner.ts";

const PORT = Number(process.env.PLANNER_PORT ?? 8787);
const model = join(import.meta.dirname, "..", "models", "planner_sonic.onnx");

const t0 = performance.now();
const planner = await OnnxPlanner.load(ort as never, model);
console.log(`planner loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

// One plan at a time (concurrent ORT runs only slow each other down): urgent requests (attacks,
// defenses, get-ups) first, then footwork, oldest first within each. A request whose client gave up
// (HttpPlanner aborts after 2.5 s) or that waited longer than MAX_WAIT_MS is dropped instead of
// planned (its context is stale by then and the client asks again), so when several rigs share one
// planner the queue stays short and a fighter stepping in to attack isn't stuck behind footwork.
const MAX_WAIT_MS = 1500;
interface Job { req: PlanRequest; res: ServerResponse; at: number; gone: boolean }
const queue: Job[] = [];
let served = 0, dropped = 0, totalMs = 0, running = false;
const reply = (res: ServerResponse, code: number, body: unknown) => {
  if (!res.destroyed && !res.writableEnded) res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
};
async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const i = queue.findIndex((j) => j.req.urgent === true);
      const job = queue.splice(i >= 0 ? i : 0, 1)[0];
      if (job.gone) { dropped++; continue; }
      if (performance.now() - job.at > MAX_WAIT_MS) { dropped++; reply(job.res, 503, { error: "planner busy" }); continue; }
      try {
        const a = performance.now();
        const frames = await planner.plan(job.req);
        totalMs += performance.now() - a; served++;
        reply(job.res, 200, { hz: 30, frames: Array.from(frames) });
      } catch (e) {
        reply(job.res, 400, { error: String(e) });
      }
    }
  } finally {
    running = false;
  }
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  if (req.method === "GET" && req.url === "/health") {
    reply(res, 200, { ok: true, served, avgMs: served ? totalMs / served : 0, queued: queue.length, dropped });
    return;
  }
  if (req.method !== "POST" || req.url !== "/plan") { res.writeHead(404).end(); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  let r: PlanRequest;
  try {
    r = JSON.parse(body) as PlanRequest;
    if (!Array.isArray(r.context) || r.context.length !== 144) throw new Error("context must be 4 x 36 numbers");
  } catch (e) {
    reply(res, 400, { error: String(e) });
    return;
  }
  const job: Job = { req: r, res, at: performance.now(), gone: false };
  res.on("close", () => { job.gone = true; }); // before the reply: the client left
  queue.push(job);
  void drain();
});
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`planner: port ${PORT} is already in use, so a planner is probably running already.`);
  console.error(`Stop it, or run this one on another port with PLANNER_PORT=8788 (and start the rig with the same PLANNER_PORT).`);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => console.log(`planner on http://127.0.0.1:${PORT}`));
