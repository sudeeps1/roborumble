// Motion viewer: watch generated G1 motions one by one (CLAUDE.md: "generate 20, look at all 20").
//   /viewer.html?ids=mo_0001,mo_0002   motions from the server
//   drop agent/batches/batch_NNNN_*.json on the page to load a batch's kept moves
//   /viewer.html?mock                  the mock motions
// Keys: left/right = previous/next, space = pause, , and . = step a frame, 1/2/3 = 0.25x/0.5x/1x speed.
import * as THREE from "three";
import type { FighterState, Motion, Quat, Vec3 } from "./contract";
import { characterById, FIGHTER_GAP } from "./config";
import { Kinematics, mul, rotate, yawQuat } from "./g1/fk";
import { checkMotion, httpApi } from "./net/api";
import { buildArena } from "./render/arena";
import { RobotView, loadG1 } from "./render/robot";
import { Stage } from "./render/stage";
import { makeMotions } from "./mock/motions";

interface Entry { id: string; label: string; detail: string; hitFrame?: number; }

const params = new URLSearchParams(location.search);
const info = document.getElementById("info")!;
const list = document.getElementById("list")!;

async function main() {
  const stage = new Stage(document.getElementById("c") as HTMLCanvasElement);
  const arena = buildArena(stage);
  const assets = await loadG1();
  const kin = new Kinematics(assets.model);
  const api = httpApi();
  const mock = params.has("mock") ? makeMotions(assets.model) : null;

  const actor = new RobotView(assets, characterById(params.get("character") ?? "bramble"));
  const target = new RobotView(assets, characterById("hush")); // a still opponent 1.2 m away, to judge reach
  stage.world.add(actor.root, target.root);

  let entries: Entry[] = [];
  let index = 0;
  let motion: Motion | null = null;
  let mapper: ((row: number[], out?: number[]) => number[]) | null = null;
  let frame = 0, paused = false, speed = 1;
  let stats = "";

  const pose = (q: number[], at: Vec3, yaw: number): FighterState => {
    const p = kin.forward(q);
    const turn = yawQuat(yaw);
    const bodies = kin.bodyNames.map((name, i) => {
      const r = rotate(turn, [p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]]);
      const qq = mul(turn, [p.quat[i * 4], p.quat[i * 4 + 1], p.quat[i * 4 + 2], p.quat[i * 4 + 3]] as Quat);
      return { name, pos: [r[0] + at[0], r[1] + at[1], r[2] + at[2]] as Vec3, quat: qq };
    });
    return { bodies, hp: 100, energy: 100, cooldowns: {}, status: "idle" };
  };
  const stand = kin.qposFrom({}, { pos: [0, 0, 0.79], quat: [1, 0, 0, 0] }, assets.model.keyframes.stand);
  const targetState = pose(stand, [FIGHTER_GAP / 2, 0, 0], Math.PI);

  const show = async (i: number) => {
    if (!entries.length) return;
    index = (i + entries.length) % entries.length;
    const e = entries[index];
    renderList();
    info.textContent = `Loading ${e.id}…`;
    try {
      motion = checkMotion(mock?.byId.get(e.id) ?? (await api.motion(e.id)));
      if (!(motion.fps > 0)) throw new Error(`bad fps ${motion.fps}`);
    } catch (err) {
      motion = null;
      info.textContent = `${e.id}: ${(err as Error).message}`;
      return;
    }
    mapper = kin.motionMapper(motion);
    frame = 0;
    stats = describe(motion);
  };

  // Root travel and pelvis height range: the things the server's quality checks look at.
  const describe = (m: Motion) => {
    const r0 = m.qpos[0];
    let travel = 0, zMin = Infinity, zMax = -Infinity;
    for (const row of m.qpos) {
      travel = Math.max(travel, Math.hypot(row[0] - r0[0], row[1] - r0[1]));
      zMin = Math.min(zMin, row[2]);
      zMax = Math.max(zMax, row[2]);
    }
    return `${m.qpos.length} frames @ ${m.fps} fps (${(m.qpos.length / m.fps).toFixed(2)} s) · root travel ${travel.toFixed(2)} m · pelvis ${zMin.toFixed(2)}–${zMax.toFixed(2)} m · ${m.joint_names.length} joints`;
  };

  const renderList = () => {
    list.innerHTML = "";
    entries.forEach((e, i) => {
      const li = document.createElement("li");
      li.textContent = e.label;
      li.title = e.detail;
      if (i === index) li.className = "on";
      li.onclick = () => void show(i);
      list.append(li);
    });
  };

  const setEntries = (next: Entry[]) => {
    entries = next;
    if (!entries.length) info.textContent = "No motions. Use ?ids=mo_1,mo_2, ?mock, or drop a batch JSON from agent/batches here.";
    void show(0);
  };

  if (mock) setEntries([...mock.byId.keys()].map((id) => ({ id, label: id, detail: id, hitFrame: mock.hitFrame.get(id) })));
  else setEntries((params.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((id) => ({ id, label: id, detail: id })));

  // Drop an agent batch file to review its kept moves.
  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    try {
      const doc = JSON.parse(await file.text());
      const kept = (doc.records ?? []).filter((r: { move?: { motion_id?: string } }) => r.move?.motion_id);
      setEntries(kept.map((r: { spec: { name: string; type: string; kind: string; kimodo_prompt: string }; move: { motion_id: string; hit_frame?: number } }) => ({
        id: r.move.motion_id,
        label: `${r.spec.name} (${r.spec.type}/${r.spec.kind})`,
        detail: r.spec.kimodo_prompt,
        hitFrame: r.move.hit_frame,
      })));
    } catch (err) {
      info.textContent = `Couldn't read ${file.name}: ${(err as Error).message}`;
    }
  });

  addEventListener("keydown", (e) => {
    if (e.code === "ArrowRight") void show(index + 1);
    else if (e.code === "ArrowLeft") void show(index - 1);
    else if (e.code === "Space") paused = !paused;
    else if (e.code === "Period") { paused = true; frame++; }
    else if (e.code === "Comma") { paused = true; frame = Math.max(0, frame - 1); }
    else if (e.code === "Digit1") speed = 0.25;
    else if (e.code === "Digit2") speed = 0.5;
    else if (e.code === "Digit3") speed = 1;
  });

  const timer = new THREE.Timer();
  timer.connect(document);
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const loop = (now: number) => {
    timer.update(now);
    const dt = Math.min(0.05, timer.getDelta());
    const t = timer.getElapsed();
    const row = motion?.qpos[Math.floor(frame)];
    if (motion && mapper && !row) {
      info.textContent = `${motion.id}: frame ${Math.floor(frame)} is missing`;
      frame = 0;
    } else if (motion && mapper && row) {
      if (!paused) frame += dt * motion.fps * speed;
      if (!(frame < motion.qpos.length)) frame = 0;
      const q = mapper(row);
      // place the motion's start at the left fighter's spot, facing the target (motions start at the origin facing +X)
      q[0] += -FIGHTER_GAP / 2 - motion.qpos[0][0];
      q[1] -= motion.qpos[0][1];
      actor.update(pose(q, [0, 0, 0], 0), t, dt);
      const e = entries[index];
      const hit = e?.hitFrame != null && Math.abs(Math.floor(frame) - e.hitFrame) <= 1 ? "  ← hit frame" : "";
      info.textContent = `${index + 1}/${entries.length}  ${e?.label ?? ""}\n${e?.detail ?? ""}\nframe ${Math.floor(frame)}${hit}${paused ? " (paused)" : ""} · ${speed}x\n${stats}`;
    }
    target.update(targetState, t, dt);
    arena.update(t, dt);
    stage.render(dt, actor.center(a), target.center(b));
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch((e) => { info.textContent = String(e); console.error(e); });
