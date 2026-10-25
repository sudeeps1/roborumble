#!/usr/bin/env python
"""Checks for kgen (run on the GPU box with ~/kvenv/bin/python; this part needs no text encoder or GPU).

  ~/kvenv/bin/python test_roundtrip.py                        # constraint round trip + heading tests
  ~/kvenv/bin/python test_roundtrip.py --check OUTDIR JOBS    # check a kgen run: ClipData shape, keyframe hits

Round trip: MuJoCo qpos -> kgen keyframe constraint (Kimodo 'fullbody' JSON, what kgen saves) -> Kimodo's own
loader + skeleton FK -> joint positions, compared with MuJoCo FK of the same qpos after the axis map
Kimodo (x, y, z) = MuJoCo (y, z, x). Pelvis, hands, feet, head must agree within 1.5 cm.
"""
import glob
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kgen  # noqa: E402

PASSIVE = os.path.abspath(os.path.join(HERE, "..", ".."))
SIM_XML = os.path.join(PASSIVE, "public", "g1", "g1_29dof.xml")
CLIPS = os.path.join(PASSIVE, "public", "clips-kimodo")
TOL = 0.015
PARTS = {"pelvis": ["pelvis_skel"], "hands": ["left_wrist_yaw_skel", "right_wrist_yaw_skel"],
         "feet": ["left_ankle_roll_skel", "right_ankle_roll_skel"]}


def k2m(p):
    return np.asarray(p)[..., [2, 0, 1]]  # Kimodo (x, y, z) -> MuJoCo (z, x, y)


def kimodo_xml():
    from kimodo.assets import skeleton_asset_path
    return str(skeleton_asset_path("g1skel34", "xml", "g1.xml"))


class MJ:
    """MuJoCo FK of qpos rows: Kimodo-named joint anchors + the head mesh centre, MuJoCo world frame."""

    def __init__(self, xml):
        import mujoco
        self.mujoco, self.xml = mujoco, xml
        self.m = mujoco.MjModel.from_xml_path(xml)
        self.d = mujoco.MjData(self.m)
        assert self.m.nq == 36, f"{xml}: nq {self.m.nq}, want 36"
        mesh = mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_MESH, "head_link")
        self.head = next((g for g in range(self.m.ngeom) if self.m.geom_type[g] == mujoco.mjtGeom.mjGEOM_MESH
                          and self.m.geom_dataid[g] == mesh), -1)
        self.torso = mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_BODY, "torso_link")

    def fk(self, q):
        self.d.qpos[:] = q
        self.mujoco.mj_kinematics(self.m, self.d)

    def joint(self, kname):
        if kname == "pelvis_skel":
            return self.d.xpos[self.mujoco.mj_name2id(self.m, self.mujoco.mjtObj.mjOBJ_BODY, "pelvis")].copy()
        j = self.mujoco.mj_name2id(self.m, self.mujoco.mjtObj.mjOBJ_JOINT, kname.replace("_skel", "_joint"))
        return None if j < 0 else self.d.xanchor[j].copy()

    def head_pos(self):
        return self.d.geom_xpos[self.head].copy()


def torso_frame(lsh, rsh, piv):
    """Frame on the torso from 3 rigid torso points (both shoulder pivots and the waist-pitch pivot)."""
    o = (lsh + rsh) / 2
    y = (lsh - rsh) / np.linalg.norm(lsh - rsh)
    z = o - piv
    z = z - y * np.dot(z, y)
    z /= np.linalg.norm(z)
    return o, np.stack([np.cross(y, z), y, z], axis=1)


class Head:
    """Head centre from Kimodo joints: the head is rigid on the torso, so fix it in a frame of the shoulder
    pivots + Kimodo's waist-pitch pivot, calibrated on the MuJoCo rest pose of `mj`."""

    def __init__(self, mj, kref):
        q = np.zeros(36)
        q[2], q[3] = 0.793, 1.0
        kref.fk(q)
        piv_w = kref.joint("waist_pitch_skel")  # Kimodo's pivot (its xml has it at the torso origin)
        mj.fk(q)
        R = mj.d.xmat[mj.torso].reshape(3, 3)
        self.piv_local = R.T @ (piv_w - mj.d.xpos[mj.torso])  # same physical point, on mj's torso
        self.mj = mj
        o, F = self.mj_frame()
        self.c = F.T @ (mj.head_pos() - o)

    def mj_frame(self):
        mj = self.mj
        piv = mj.d.xpos[mj.torso] + mj.d.xmat[mj.torso].reshape(3, 3) @ self.piv_local
        return torso_frame(mj.joint("left_shoulder_pitch_skel"), mj.joint("right_shoulder_pitch_skel"), piv)

    def from_kimodo(self, P, names):
        ix = lambda n: names.index(n)
        o, F = torso_frame(P[ix("left_shoulder_pitch_skel")], P[ix("right_shoulder_pitch_skel")],
                           P[ix("waist_pitch_skel")])
        return o + F @ self.c


def tilt_deg(q):
    w, x, y, z = q[3:7]
    return math.degrees(math.acos(max(-1.0, min(1.0, 1 - 2 * (x * x + y * y)))))  # pelvis z vs world z


def compare(rig, mjs, heads, rows, labels):
    """kgen constraint for rows -> JSON -> Kimodo loader FK; vs MuJoCo FK. Returns (worst error m, report)."""
    frames = list(range(len(rows)))
    saved, c0 = rig.fullbody(frames, rows)
    saved = json.loads(json.dumps(saved))  # exactly what kgen writes to constraints.json
    assert saved["type"] == "fullbody" and np.array(saved["local_joints_rot"]).shape == (len(rows), 34, 3)
    c = rig.load([saved])[0]
    P = k2m(c.global_joints_positions.detach().cpu().numpy())  # (N, 34, 3), MuJoCo axes
    P0 = k2m(c0.global_joints_positions.detach().cpu().numpy())
    names = rig.sk.bone_order_names
    worst, out = {}, []
    for i, (q, lab) in enumerate(zip(rows, labels)):
        line = [f"{lab:22s} tilt {tilt_deg(q):5.1f}"]
        line.append(f"saved JSON (axis-angle) vs in-memory constraint {np.abs(P[i] - P0[i]).max() * 100:.3f} cm")
        for xml, mj in mjs.items():
            mj.fk(q)
            errs = {}
            for part, js in PARTS.items():
                errs[part] = max(np.linalg.norm(P[i, names.index(j)] - mj.joint(j)) for j in js)
            allj = [np.linalg.norm(P[i, k] - mj.joint(n)) for k, n in enumerate(names) if mj.joint(n) is not None]
            mjh = mj.head_pos()
            o, F = heads[xml].mj_frame()
            rigid = np.linalg.norm(o + F @ heads[xml].c - mjh)
            assert rigid < 1e-4, f"head frame not rigid on {xml} ({rigid})"
            errs["head"] = np.linalg.norm(heads[xml].from_kimodo(P[i], names) - mjh)
            for k, v in errs.items():
                worst.setdefault((xml, k), 0.0)
                worst[(xml, k)] = max(worst[(xml, k)], v)
            line.append(f"{xml}: " + " ".join(f"{k} {v * 100:.2f}" for k, v in errs.items())
                        + f" | all {len(allj)} joints max {max(allj) * 100:.2f} cm")
        out.append("  ".join(line[:2]) + "\n      " + "\n      ".join(line[2:]))
    return worst, out, c


def roundtrip():
    import torch
    rig = kgen.Rig()
    mjs = {"sim g1_29dof.xml": MJ(SIM_XML), "kimodo g1.xml": MJ(kimodo_xml())}
    kref = mjs["kimodo g1.xml"]
    heads = {k: Head(m, kref) for k, m in mjs.items()}
    fails = []

    idle = np.array(json.load(open(os.path.join(CLIPS, "idle_fighting.json")))["qpos"])
    gup = np.array(json.load(open(os.path.join(CLIPS, "get_up.json")))["qpos"])
    tilts = [tilt_deg(q) for q in gup]
    gi = int(np.argmax(tilts))
    mid = int(np.argmin([abs(t - 45) for t in tilts]))
    rows = [kgen.rebase(idle[f]) for f in (0, 40, 80)] + [kgen.rebase(gup[gi]), gup[mid]]
    labels = ["idle_fighting f0", "idle_fighting f40", "idle_fighting f80", f"get_up f{gi} rebased", f"get_up f{mid} raw"]
    turned = kgen.apply_offset(rows[0], [0.3, -0.2, math.pi / 2])
    rows.append(turned)
    labels.append("idle f0 +(0.3,-0.2,+90)")

    print("== round trip: MuJoCo qpos -> kgen fullbody constraint JSON -> Kimodo FK, vs MuJoCo FK (cm)")
    worst, report, c = compare(rig, mjs, heads, rows, labels)
    print("\n".join(report))
    print("worst per part:")
    for (xml, part), v in sorted(worst.items()):
        ok = v < TOL
        print(f"  {'ok  ' if ok else 'FAIL'} {xml:18s} {part:7s} {v * 100:.2f} cm")
        if not ok and xml.startswith("kimodo"):
            fails.append(f"{xml} {part} {v * 100:.2f} cm")
        if not ok and xml.startswith("sim"):
            fails.append(f"{xml} {part} {v * 100:.2f} cm")

    print("== heading of the dyaw=+90 anchor")
    h = kgen.heading_deg(c, len(rows) - 1)
    h0 = kgen.heading_deg(c, 0)
    yaw = math.degrees(kgen.yaw_of(turned))
    mjs["sim g1_29dof.xml"].fk(turned)
    xaxis = mjs["sim g1_29dof.xml"].d.xmat[1].reshape(3, 3)[:, 0]
    lh, rh = (mjs["sim g1_29dof.xml"].joint(n) for n in ("left_hip_pitch_skel", "right_hip_pitch_skel"))
    print(f"  base anchor Kimodo heading {h0:+.2f} deg; turned: Kimodo heading {h:+.2f} deg, MuJoCo yaw {yaw:+.2f} deg, "
          f"pelvis x axis ({xaxis[0]:+.3f} {xaxis[1]:+.3f} {xaxis[2]:+.3f}), left hip - right hip "
          f"({(lh - rh)[0]:+.3f} {(lh - rh)[1]:+.3f})")
    pel = np.array(c.global_joints_positions[len(rows) - 1, 0].tolist())
    print(f"  turned pelvis in Kimodo frame (x, y, z) = ({pel[0]:+.3f} {pel[1]:.3f} {pel[2]:+.3f}); "
          f"MuJoCo (0.3, -0.2) -> Kimodo x = -0.2, z = +0.3")
    for cond, what in [(abs(h0) < 3, "base anchor faces Kimodo +Z (heading ~0)"),
                       (abs(h - 90) < 3, "turned anchor Kimodo heading ~ +90"),
                       (abs(yaw - 90) < 1, "turned anchor MuJoCo yaw ~ +90"),
                       (xaxis[1] / math.hypot(xaxis[0], xaxis[1]) > 0.999,
                        "turned anchor faces MuJoCo +Y (pelvis x axis on the ground; the guard leans 12 deg)"),
                       ((lh - rh)[0] < -0.1, "turned anchor's left hip is at -X (it faces +Y)"),
                       (abs(pel[0] + 0.2) < 1e-3 and abs(pel[2] - 0.3) < 1e-3, "offset lands at Kimodo (x, z) = (-0.2, 0.3)")]:
        print(f"  {'ok  ' if cond else 'FAIL'} {what}")
        if not cond:
            fails.append(what)

    print("== a keyframe hit exactly, through Kimodo's CSV export (dict_to_qpos, kgen's output path), vs the anchor;"
          "\n   and why kgen does not use qpos_to_motion_dict: its pose vs MuJoCo FK (Kimodo's g1.xml)")
    R = np.stack(rows)
    L, root = rig.local_rots(R)
    back = np.asarray(rig.conv.dict_to_qpos({"local_rot_mats": L[None], "root_positions": root[None]}, "cpu"),
                      dtype=np.float64).reshape(len(R), 36)
    pad = np.concatenate([R, np.repeat(R[-1:], max(0, 5 - len(R)), 0)])  # its root smoother needs >= 5 rows
    conv_pj = k2m(rig.conv.qpos_to_motion_dict(torch.tensor(pad, dtype=torch.float32), kgen.FPS)["posed_joints"]
                  [: len(R)].numpy())
    names = rig.sk.bone_order_names
    sim, kx = mjs["sim g1_29dof.xml"], mjs["kimodo g1.xml"]
    hinge = [kx.mujoco.mj_id2name(kx.m, kx.mujoco.mjtObj.mjOBJ_JOINT, j) for j in range(1, kx.m.njnt)]
    worst_exp = 0.0
    for i, (q, lab) in enumerate(zip(R, labels)):
        dq = np.abs(back[i, 7:] - q[7:])
        dquat = min(np.abs(back[i, 3:7] - q[3:7]).max(), np.abs(back[i, 3:7] + q[3:7]).max())
        sim.fk(q)
        want = {n: sim.joint(n) for n in names if sim.joint(n) is not None}
        want["head"] = sim.head_pos()
        sim.fk(back[i])
        got = {n: sim.joint(n) for n in want if n != "head"}
        got["head"] = sim.head_pos()
        e_exp = {n: np.linalg.norm(got[n] - want[n]) for n in want}
        parts = max(e_exp[n] for n in ["pelvis_skel", "head"] + [j for js in PARTS.values() for j in js])
        worst_exp = max(worst_exp, parts)
        kx.fk(q)
        e_conv = max(np.linalg.norm(conv_pj[i, names.index(n)] - kx.joint(n)) for n in names if kx.joint(n) is not None)
        print(f"  {lab:24s} export: hinge max {math.degrees(dq.max()):.2f} deg ({hinge[int(dq.argmax())]}), root quat "
              f"{dquat:.1e}, sim FK parts {parts * 100:.2f} cm, all joints {max(e_exp.values()) * 100:.2f} cm"
              f" | qpos_to_motion_dict pose off by {e_conv * 100:.2f} cm")
    ok = worst_exp < TOL
    print(f"  {'ok  ' if ok else 'FAIL'} exported keyframe within {TOL * 100:.1f} cm of the anchor (pelvis/hands/feet/head,"
          f" worst {worst_exp * 100:.2f} cm)")
    if not ok:
        fails.append(f"export of an exact keyframe {worst_exp * 100:.2f} cm")

    print("== kgen job validation")
    anchors = {"guard": kgen.rebase(idle[0])}
    base = {"id": "t.a", "motion": "step.forward", "prompt": "A person in a boxing stance takes a quick short step forward",
            "duration": 0.9}
    cases = [("t=end ok", {"keyframes": [{"t": 0, "anchor": "guard"}, {"t": "end", "anchor": "guard"}]}, None),
             ("t past the end", {"keyframes": [{"t": 0.9, "anchor": "guard"}]}, "outside"),
             ("negative t", {"root": [[-0.1, 0, 0]]}, "outside"),
             ("period in prompt", {"prompt": "A person steps 0.5 m forward"}, "period"),
             ("unknown anchor", {"keyframes": [{"t": 0, "anchor": "nope"}]}, "unknown anchor"),
             ("bad offset", {"keyframes": [{"t": 0, "anchor": "guard", "offset": [1, 2]}]}, "offset")]
    for name, over, want in cases:
        try:
            p = kgen.resolve({**base, **over}, {}, anchors, rig)
            got = None
            extra = f" frames {[ (s.get('frame_indices')) for s in p['saved']]}"
        except kgen.JobError as e:
            got, extra = str(e), ""
        ok = (want is None and got is None) or (want is not None and got is not None and want in got)
        print(f"  {'ok  ' if ok else 'FAIL'} {name}: {got or 'accepted'}{extra}")
        if not ok:
            fails.append(f"validation: {name}")

    print("PASS" if not fails else "FAILED: " + "; ".join(fails))
    return 0 if not fails else 1


def check(outdir, jobs_path):
    """A kgen run: every manifest row loads as ClipData; keyframe frames vs anchors (MuJoCo FK, sim xml)."""
    defaults, anchors, jobs = kgen.load_jobs(jobs_path)
    jobs = {j["id"]: j for j in jobs}
    rows = []
    for m in sorted(glob.glob(os.path.join(outdir, "manifest_*.json"))):
        rows += json.load(open(m))
    print(f"== {len(rows)} clips in {outdir} ({len(glob.glob(os.path.join(outdir, 'manifest_*.json')))} manifests)")
    mj = MJ(SIM_XML)
    head = Head(mj, MJ(kimodo_xml()))
    bad, per_job = [], {}
    for r in sorted(rows, key=lambda r: (r["job"], r["sample"])):
        clip = json.load(open(os.path.join(outdir, r["file"])))
        q = np.asarray(clip.get("qpos"), dtype=np.float64)
        job = jobs[r["job"]]
        n = kgen.frames_of(job["duration"])
        probs = []
        if clip.get("fps") != 30:
            probs.append("fps")
        if q.ndim != 2 or q.shape != (n, 36) or not np.isfinite(q).all():
            probs.append(f"qpos shape {q.shape}, want ({n}, 36)")
        else:
            if np.abs(np.linalg.norm(q[:, 3:7], axis=1) - 1).max() > 1e-4:
                probs.append("quat not unit")
            if (np.sum(q[1:, 3:7] * q[:-1, 3:7], axis=1) < 0).any():
                probs.append("quat hemisphere flip")
        meta = clip.get("meta", {})
        for k in ("job", "motion", "prompt", "sample", "seed", "cfg", "steps", "duration", "gen_ms", "model"):
            if k not in meta:
                probs.append(f"meta.{k} missing")
        if probs:
            bad.append(f"{r['file']}: {', '.join(probs)}")
            continue
        s = per_job.setdefault(r["job"], {"ms": [], "kf": [], "root": [], "drift": []})
        s["ms"].append(meta["gen_ms"])
        s["drift"].append((math.hypot(q[0, 0], q[0, 1]), math.degrees(kgen.yaw_of(q[0]))))
        for k in job.get("keyframes") or []:
            f = kgen.frame_of(k.get("t"), n, "kf")
            target = kgen.apply_offset(anchors[k["anchor"]], k.get("offset", [0, 0, 0]))
            mj.fk(target)
            want = {p: [mj.joint(j) for j in js] for p, js in PARTS.items()}
            want["head"] = [mj.head_pos()]
            mj.fk(q[f])
            got = {p: [mj.joint(j) for j in js] for p, js in PARTS.items()}
            got["head"] = [mj.head_pos()]
            e = {p: max(np.linalg.norm(a - b) for a, b in zip(want[p], got[p])) for p in want}
            dyaw = (math.degrees(kgen.yaw_of(q[f]) - kgen.yaw_of(target)) + 180) % 360 - 180
            s["kf"].append((r["sample"], f, e, dyaw))
        for p in job.get("root") or []:
            f = kgen.frame_of(p[0], n, "root")
            s["root"].append((r["sample"], f, math.hypot(q[f, 0] - p[1], q[f, 1] - p[2])))
    for jid, s in per_job.items():
        print(f"-- {jid} ({jobs[jid]['motion']}, {kgen.frames_of(jobs[jid]['duration'])} frames): {len(s['ms'])} samples, "
              f"gen {np.mean(s['ms']):.0f} ms/sample; frame-0 pelvis off origin {np.mean([d for d, _ in s['drift']]) * 100:.1f} cm, "
              f"yaw {np.mean([y for _, y in s['drift']]):+.1f} deg (mean)")
        for smp, f, e, dyaw in s["kf"]:
            print(f"   s{smp} keyframe f{f:<3d} " + " ".join(f"{p} {v * 100:5.1f}" for p, v in e.items())
                  + f" cm, yaw {dyaw:+.1f} deg")
        if s["kf"]:
            print("   mean over keyframes: " + " ".join(
                f"{p} {np.mean([e[p] for _, _, e, _ in s['kf']]) * 100:.1f}" for p in ("pelvis", "hands", "feet", "head"))
                  + f" cm, |yaw| {np.mean([abs(d) for *_, d in s['kf']]):.1f} deg")
        for smp, f, d in s["root"]:
            print(f"   s{smp} root waypoint f{f:<3d} pelvis xy off by {d * 100:.1f} cm (the constraint is on the smoothed root)")
    for b in bad:
        print("BAD", b)
    print("ClipData OK" if not bad else f"{len(bad)} bad clips")
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--check":
        sys.exit(check(sys.argv[2], sys.argv[3]))
    sys.exit(roundtrip())
