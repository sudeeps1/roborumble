// One command for the demo: the SONIC planner service, then the rig.
//   npm start            (PLANNER_PORT=8788 npm start to use another planner port)
// Reuses a planner that is already running on the port. Without the planner model it says so and
// starts the rig alone (standing guard, assisted get-ups). Ctrl-C stops everything it started.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PORT = Number(process.env.PLANNER_PORT ?? 8787);
const HEALTH = `http://127.0.0.1:${PORT}/health`;
const children = [];

function say(msg) { console.log(`[start] ${msg}`); }

if (!existsSync(join(ROOT, "public", "g1")) || !existsSync(join(ROOT, "public", "sonic"))) {
  say("the G1 model and SONIC aren't downloaded yet: run `npm run setup` first.");
  process.exit(1);
}

async function plannerUp() {
  try { return (await fetch(HEALTH, { signal: AbortSignal.timeout(800) })).ok; } catch { return false; }
}

function run(name, cmd, args) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, PLANNER_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (stream, out) => {
    let rest = "";
    stream.on("data", (d) => {
      const lines = (rest + d).split("\n");
      rest = lines.pop();
      for (const l of lines) out.write(`[${name}] ${l}\n`);
    });
  };
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    say(`${name} stopped (${signal ?? `exit ${code}`}).`);
    stopAll(code ?? 1);
  });
  children.push(child);
  return child;
}

let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

if (await plannerUp()) {
  say(`a planner is already running on port ${PORT}: using it.`);
} else if (!existsSync(join(ROOT, "models", "planner_sonic.onnx"))) {
  say("no planner model (run `npm run setup:planner` once, 774 MB). Starting the rig without footwork or planned get-ups.");
} else {
  say(`starting the planner on port ${PORT}…`);
  run("planner", process.execPath, ["planner/server.ts"]);
  const t0 = Date.now();
  while (!(await plannerUp())) {
    if (stopping) process.exit(1);
    if (Date.now() - t0 > 60_000) { say("the planner didn't come up within 60 s."); stopAll(1); }
    await new Promise((r) => setTimeout(r, 250));
  }
  say(`planner ready in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
}

say("starting the rig…");
run("rig", process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js")]);
