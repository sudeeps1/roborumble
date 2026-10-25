#!/usr/bin/env python
"""kgen: batch Kimodo-G1 generator. Loads Kimodo-G1-RP-v1 once and runs many jobs in GPU batches.

  ~/kvenv/bin/python kgen.py JOBS.json --out OUTDIR [--shard i/n] [--dry-run] [--only id1,id2]

Job format, outputs and the extra flags (--no-text, --batch) are in README.md (section "kgen").
Writes OUTDIR/<job id>/s<k>.json (ClipData + meta), OUTDIR/<job id>/constraints.json and
OUTDIR/manifest_<i>of<n>.json; readers glob manifest_*.json.
"""
import os

# cache only: kgen never downloads anything (the gated Llama text encoder least of all).
# HF_HUB_OFFLINE=0 in the environment turns downloads back on.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("LOCAL_CACHE", "true")
# local LLM2Vec on the GPU; TEXT_ENCODER_MODE=api reuses a running kimodo_textencoder instead
os.environ.setdefault("TEXT_ENCODER_MODE", "local")

import argparse
import contextlib
import gc
import glob
import json
import math
import re
import sys
import time
import zlib

import numpy as np
import torch

FPS = 30
MODEL = "Kimodo-G1-RP-v1"
LLM_DIM = 4096
MAX_FRAMES = 300  # Kimodo's 10 s cap
FRAME_BUDGET = 64 * 64  # samples x frames per denoiser batch (x3 inside separated CFG); tiny next to the 17 GB encoder
CLIP_RE = re.compile(r"s\d+\.json")  # OUTDIR/<id>/s<k>.json


class JobError(Exception):
    pass


def log(*a):
    print("[kgen]", *a, flush=True)


# ---------- MuJoCo-side pose helpers (qpos rows: root xyz, root quat wxyz, 29 hinges) ----------

def qmul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array([aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw])


def yaw_of(q):
    """Facing yaw (rad about +Z, 0 = +X) of a qpos row: where the pelvis x axis points on the ground."""
    w, x, y, z = q[3:7]
    return math.atan2(2 * (x * y + w * z), 1 - 2 * (y * y + z * z))


def apply_offset(q, off):
    """offset [dx, dy, dyaw]: turn the pose in place about its pelvis (world Z), then shift it."""
    q = np.array(q, dtype=np.float64)
    dx, dy, dyaw = off
    q[0] += dx
    q[1] += dy
    q[3:7] = qmul([math.cos(dyaw / 2), 0, 0, math.sin(dyaw / 2)], q[3:7])
    q[3:7] /= np.linalg.norm(q[3:7])
    return q


def rebase(q):
    """Anchor-maker helper: pelvis xy to the origin, facing +X."""
    q = np.array(q, dtype=np.float64)
    return apply_offset(q, [-q[0], -q[1], -yaw_of(q)])


def fix_hemispheres(qpos):
    """Same rotations, no sign flips: w >= 0 on frame 0, then each quat on the side of the last."""
    if qpos[0, 3] < 0:
        qpos[0, 3:7] *= -1
    for t in range(1, len(qpos)):
        if np.dot(qpos[t, 3:7], qpos[t - 1, 3:7]) < 0:
            qpos[t, 3:7] *= -1
    return qpos


# ---------- Kimodo-side constraint building ----------

class Rig:
    """G1Skeleton34 + MujocoQposConverter: MuJoCo qpos <-> Kimodo poses and constraint dicts."""

    def __init__(self, skeleton=None):
        from kimodo.exports.mujoco import MujocoQposConverter
        from kimodo.skeleton import G1Skeleton34
        self.sk = skeleton if skeleton is not None else G1Skeleton34()
        self.conv = MujocoQposConverter(self.sk)

    def local_rots(self, rows):
        """(N,36) qpos -> Kimodo local rotations (N,34,3,3) and root positions (N,3), Kimodo frame.

        MujocoQposConverter.qpos_to_motion_dict with one change: each hinge turns AFTER its body's rest
        quat Q (L = Q R(axis, q), MuJoCo's order). The converter turns it before (L = R(axis, q) Q), which
        lands up to 4 cm off MuJoCo FK at the hands and 2.5 cm at the feet wherever a body has a rest quat
        (hip roll 10 deg, shoulder pitch 16 deg). Kimodo-G1's own outputs follow MuJoCo's order (residual
        0.3-0.9 deg vs 1-2.2 deg on the 8 bundled G1 examples), so this is the pose the model knows.
        Same tables as the converter (rest quats, axes, joint map); Kimodo FK of it == MuJoCo FK."""
        from kimodo.geometry import axis_angle_to_matrix, quaternion_to_matrix
        cv, dev = self.conv, self.sk.device
        q = torch.as_tensor(np.asarray(rows, dtype=np.float32), device=dev)
        M = cv.mujoco_to_kimodo_matrix.to(dev)  # Kimodo = M @ MuJoCo
        f2q = cv._rot_offsets_f2q.to(dev)  # f2q[j] = Q_j^T in Kimodo axes (identity where no quat)
        axis = cv._mujoco_joint_axis_values_kimodo_space.to(dev)
        L = torch.eye(3, device=dev).repeat(len(q), self.sk.nbjoints, 1, 1)  # extras (toes, hand roll) stay identity
        L[:, 0] = f2q[0].T @ M @ quaternion_to_matrix(q[:, 3:7]) @ M.T  # root quat is wxyz
        for i, j in enumerate(cv._mujoco_indices_to_kimodo_indices.tolist()):
            L[:, j] = f2q[j].T @ axis_angle_to_matrix(q[:, 7 + i, None] * axis[i])
        return L, q[:, :3] @ M.T

    def poses(self, rows):
        """(N,36) qpos -> Kimodo (posed_joints (N,34,3), global_rot_mats (N,34,3,3)), Kimodo frame."""
        L, root = self.local_rots(rows)
        gr, pj, _ = self.sk.fk(L, root)
        return pj, gr

    def fullbody(self, frames, rows):
        """Keyframes -> Kimodo's own saved 'fullbody' dict (what get_save_info writes, as lists)."""
        from kimodo.constraints import FullBodyConstraintSet
        pj, gr = self.poses(rows)
        c = FullBodyConstraintSet(self.sk, torch.tensor(frames, device=self.sk.device), pj, gr)
        return to_lists(c.get_save_info()), c

    def root2d(self, frames, xy_mujoco):
        """MuJoCo ground (x, y) waypoints -> 'root2d' dict. Kimodo (x, z) = MuJoCo (y, x)."""
        from kimodo.constraints import Root2DConstraintSet
        xz = torch.tensor([[y, x] for x, y in xy_mujoco], dtype=torch.float32, device=self.sk.device)
        c = Root2DConstraintSet(self.sk, torch.tensor(frames, device=self.sk.device), xz)
        return to_lists(c.get_save_info())

    def load(self, saved, device=None):
        """Saved dicts -> constraint objects on this rig's skeleton (Kimodo's own loader)."""
        from kimodo.constraints import load_constraints_lst
        return load_constraints_lst(saved, self.sk, device=device)


def to_lists(obj):
    if isinstance(obj, torch.Tensor):
        return obj.detach().cpu().tolist()
    if isinstance(obj, dict):
        return {k: to_lists(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [to_lists(v) for v in obj]
    return obj


def heading_deg(c, i=0):
    """Kimodo hip-derived heading of constrained frame i (deg; = MuJoCo yaw)."""
    cs = c.global_root_heading[i]
    return math.degrees(math.atan2(float(cs[1]), float(cs[0])))


# ---------- job file ----------

def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def frames_of(duration):
    return int(duration * FPS + 1e-6)  # int(duration*30), minus float fuzz (4.1 s is 123 frames, not 122)


def frame_of(t, n, what):
    if t == "end":
        return n - 1
    if not num(t):
        raise JobError(f"{what}: t must be seconds or \"end\", got {t!r}")
    f = int(round(t * FPS))
    if not 0 <= f < n:
        # Kimodo would silently drop it (crop_move) or index past the clip
        raise JobError(f"{what}: t={t} s is frame {f}, outside the clip's frames 0..{n - 1}")
    return f


def load_jobs(path):
    with open(path) as f:
        spec = json.load(f)
    if not isinstance(spec, dict) or not isinstance(spec.get("jobs"), list):
        raise SystemExit(f"[kgen] {path}: expected an object with a \"jobs\" list")
    anchors = spec.get("anchors") or {}
    if isinstance(anchors, str):
        apath = os.path.join(os.path.dirname(os.path.abspath(path)), anchors)
        with open(apath) as f:
            anchors = json.load(f)
    if not isinstance(anchors, dict):
        raise SystemExit("[kgen] anchors must be a path to {name: {qpos: [36]}} or that object")
    bad = [k for k, a in anchors.items()
           if not isinstance(a, dict) or not isinstance(a.get("qpos"), list) or len(a["qpos"]) != 36
           or not all(num(v) for v in a["qpos"])]
    if bad:
        raise SystemExit(f"[kgen] anchors without a 36-number qpos: {bad}")
    anchors = {k: np.array(a["qpos"], dtype=np.float64) for k, a in anchors.items()}
    for k, q in anchors.items():
        q[3:7] /= np.linalg.norm(q[3:7])
    ids = [j.get("id") if isinstance(j, dict) else None for j in spec["jobs"]]
    dup = sorted({i for i in ids if ids.count(i) > 1 and i is not None})
    if dup:
        raise SystemExit(f"[kgen] duplicate job ids: {dup}")
    return spec.get("defaults") or {}, anchors, spec["jobs"]


def safe_id(jid):
    return isinstance(jid, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", jid) is not None and ".." not in jid


def resolve(job, defaults, anchors, rig):
    """Validate one job and build its constraints. Returns a plan dict; raises JobError."""
    if not isinstance(job, dict):
        raise JobError("job is not an object")
    jid = job.get("id")
    if not safe_id(jid):
        raise JobError(f"id must be a folder-safe string, got {jid!r}")
    g = lambda k, d=None: job[k] if k in job else defaults.get(k, d)
    warn = []
    motion, prompt = job.get("motion"), job.get("prompt")
    if not isinstance(motion, str) or not motion:
        raise JobError("motion (the ClipSource key) is required")
    if not isinstance(prompt, str) or not prompt.strip():
        raise JobError("prompt is required")
    if "." in prompt:
        raise JobError("prompt must not contain a period (Kimodo prompt rule)")
    nw = len(prompt.split())
    if not 7 <= nw <= 19:
        warn.append(f"prompt has {nw} words (7-19 work best)")
    if not prompt.lower().startswith("a person"):
        warn.append("prompt should start with \"A person\"")
    dur = job.get("duration")
    if not num(dur) or dur <= 0:
        raise JobError(f"duration (s) must be a positive number, got {dur!r}")
    n = frames_of(dur)
    if not 8 <= n <= MAX_FRAMES:
        raise JobError(f"duration {dur} s is {n} frames; allowed 8..{MAX_FRAMES}")
    samples, steps, cfg = g("samples", 8), g("steps", 100), g("cfg", [2.0, 2.0])
    if not isinstance(samples, int) or isinstance(samples, bool) or not 1 <= samples <= 512:
        raise JobError(f"samples must be an int 1..512, got {samples!r}")
    if not isinstance(steps, int) or isinstance(steps, bool) or not 1 <= steps <= 1000:
        raise JobError(f"steps must be an int 1..1000, got {steps!r}")
    if not isinstance(cfg, list) or len(cfg) != 2 or not all(num(v) for v in cfg):
        raise JobError(f"cfg must be [text, constraint] weights, got {cfg!r}")
    seed = g("seed")
    if seed is None:
        seed = zlib.crc32(jid.encode()) & 0x7FFFFFFF  # stable per id, decorrelated across jobs
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise JobError(f"seed must be an int, got {seed!r}")
    meta = job.get("meta") or {}
    if not isinstance(meta, dict):
        raise JobError("meta must be an object")

    saved, heading0, kf_xy = [], 0.0, {}
    kfs = job.get("keyframes") or []
    if not isinstance(kfs, list):
        raise JobError("keyframes must be a list")
    if kfs:
        frames, rows = [], []
        for i, k in enumerate(kfs):
            if not isinstance(k, dict):
                raise JobError(f"keyframes[{i}] is not an object")
            f = frame_of(k.get("t"), n, f"keyframes[{i}]")
            name = k.get("anchor")
            if name not in anchors:
                raise JobError(f"keyframes[{i}]: unknown anchor {name!r}")
            off = k.get("offset", [0.0, 0.0, 0.0])
            if not isinstance(off, list) or len(off) != 3 or not all(num(v) for v in off):
                raise JobError(f"keyframes[{i}]: offset must be [dx, dy, dyaw], got {off!r}")
            if f in frames:
                raise JobError(f"keyframes[{i}]: two keyframes on frame {f}")
            frames.append(f)
            rows.append(apply_offset(anchors[name], off))
            kf_xy[f] = rows[-1][:2]
        d, c = rig.fullbody(frames, rows)
        saved.append(d)
        for i, k in enumerate(kfs):  # anchor check in Kimodo's own heading (hip line), fine for lying poses too
            a, dyaw = anchors[k["anchor"]], k.get("offset", [0, 0, 0])[2]
            h = (heading_deg(c, i) - math.degrees(dyaw) + 180) % 360 - 180
            if math.hypot(a[0], a[1]) > 0.02 or abs(h) > 5:
                warn.append(f"anchor {k['anchor']} is not at the origin facing +X "
                            f"(xy {a[0]:+.3f} {a[1]:+.3f}, Kimodo heading {h:+.1f} deg)")
        if 0 in frames:
            i0 = frames.index(0)
            heading0 = math.radians(heading_deg(c, i0))  # the model's first_heading_angle must agree
            if math.hypot(*rows[i0][:2]) > 0.05:
                warn.append("frame-0 keyframe is off the origin; Kimodo starts clips at the origin")
    root = job.get("root") or []
    if not isinstance(root, list):
        raise JobError("root must be a list of [t, x, y]")
    if root:
        frames, xy = [], []
        for i, p in enumerate(root):
            if not isinstance(p, list) or len(p) != 3 or not num(p[1]) or not num(p[2]):
                raise JobError(f"root[{i}] must be [t, x, y], got {p!r}")
            f = frame_of(p[0], n, f"root[{i}]")
            if f in frames:
                raise JobError(f"root[{i}]: two waypoints on frame {f}")
            if f in kf_xy and math.hypot(kf_xy[f][0] - p[1], kf_xy[f][1] - p[2]) > 0.05:
                warn.append(f"root[{i}] and a keyframe disagree on frame {f}; Kimodo keeps one of them")
            frames.append(f)
            xy.append((float(p[1]), float(p[2])))
        saved.append(rig.root2d(frames, xy))
    return dict(id=jid, motion=motion, prompt=prompt.strip(), duration=dur, frames=n, samples=samples,
                steps=steps, cfg=[float(v) for v in cfg], seed=seed, meta=meta, saved=saved,
                heading0=heading0, warn=warn, nkf=len(kfs), nroot=len(root))


# ---------- generation ----------

class ZeroText:
    """Stand-in text encoder (no Llama): zero features. With empty prompts Kimodo masks them out,
    which is exactly its unconditional branch, so --no-text runs are constraint-only generation."""

    def __init__(self, device):
        self.device = device

    def __call__(self, texts):
        texts = [texts] if isinstance(texts, str) else texts
        return torch.zeros(len(texts), 1, LLM_DIM, device=self.device), [1] * len(texts)


class CachedText:
    """Encodes each distinct prompt once (LLM2Vec runs batch 1 per text anyway)."""

    def __init__(self, enc):
        self.enc, self.cache = enc, {}

    def __call__(self, texts):
        texts = [texts] if isinstance(texts, str) else list(texts)
        for t in dict.fromkeys(texts):
            if t not in self.cache:
                feat, ln = self.enc([t])
                self.cache[t] = feat[0, : ln[0]].detach()
        feats = [self.cache[t] for t in texts]
        L = max(len(f) for f in feats)
        out = torch.zeros(len(feats), L, feats[0].shape[-1], dtype=feats[0].dtype, device=feats[0].device)
        for i, f in enumerate(feats):
            out[i, : len(f)] = f
        return out, [len(f) for f in feats]


@contextlib.contextmanager
def fixed_noise(noise):
    """Kimodo draws its start noise with one torch.randn((B, T, D)) in _generate; hand it ours so
    every (job, sample) gets noise from its own seed whatever batch it lands in."""
    real, used = torch.randn, []

    def randn(*shape, **kw):
        s = shape[0] if len(shape) == 1 and isinstance(shape[0], (tuple, list, torch.Size)) else shape
        if not used and tuple(int(x) for x in s) == tuple(noise.shape):
            used.append(True)
            return noise.to(device=kw.get("device") or noise.device, dtype=kw.get("dtype") or noise.dtype)
        return real(*shape, **kw)

    torch.randn = randn
    try:
        yield used
    finally:
        torch.randn = real


def load_model(device, no_text):
    from kimodo import load_model as kload
    t0 = time.time()
    model = kload(MODEL, device=device, text_encoder=ZeroText(device))  # denoiser; real encoder below
    log(f"loaded {MODEL} denoiser on {device} in {(time.time() - t0) * 1e3:.0f} ms")
    if no_text:
        log("--no-text: prompts ignored, zero text features (constraint-only generation)")
        return model
    from kimodo.model.load_model import _select_text_encoder_conf
    from kimodo.model.loading import DEFAULT_TEXT_ENCODER_URL, get_env_var, instantiate_from_dict
    t0 = time.time()
    try:
        enc = instantiate_from_dict(
            _select_text_encoder_conf(get_env_var("TEXT_ENCODER_URL", DEFAULT_TEXT_ENCODER_URL)))
    except Exception as e:
        msg = f"{type(e).__name__}: {e}".strip().splitlines()
        raise SystemExit("[kgen] the text encoder (LLM2Vec on meta-llama/Meta-Llama-3-8B-Instruct) failed to load:\n"
                         + "\n".join("[kgen]   " + m for m in msg[:6])
                         + "\n[kgen] it needs the gated Llama weights in the HF cache (kgen runs with HF_HUB_OFFLINE=1"
                           " unless told otherwise); --no-text runs everything else.")
    model.text_encoder = CachedText(enc)
    log(f"loaded text encoder in {(time.time() - t0) * 1e3:.0f} ms")
    return model


def run_batch(model, rig, items, device):
    """items: [(plan, k, constraint list)] sharing frames/steps/cfg. Returns (qpos (B,T,36), ms)."""
    p0 = items[0][0]
    n, B, D = p0["frames"], len(items), model.motion_rep.motion_rep_dim
    noise = torch.stack([torch.randn((n, D), generator=torch.Generator().manual_seed(p["seed"] + k))
                         for p, k, _ in items])
    cl = [c for _, _, c in items]
    prompts = [("" if p.get("no_text") else p["prompt"]) for p, _, _ in items]
    heads = torch.tensor([p["heading0"] for p, _, _ in items], dtype=torch.float32, device=device)
    if device.startswith("cuda"):
        torch.cuda.synchronize()
    t0 = time.time()
    with fixed_noise(noise) as used:
        out = model(prompts, [n] * B, num_denoising_steps=p0["steps"], multi_prompt=False,
                    constraint_lst=cl if any(cl) else [], cfg_weight=list(p0["cfg"]),
                    first_heading_angle=heads, progress_bar=lambda x: x)
    if not used:
        raise RuntimeError("Kimodo did not draw its start noise through torch.randn; seeding is broken")
    qpos = rig.conv.dict_to_qpos(out, device)
    if device.startswith("cuda"):
        torch.cuda.synchronize()
    return np.asarray(qpos, dtype=np.float64), (time.time() - t0) * 1e3


def write_sample(outdir, plan, k, qpos, gen_ms, batch_n, no_text):
    qpos = fix_hemispheres(qpos.copy())
    meta = dict(plan["meta"])
    meta.update(job=plan["id"], motion=plan["motion"], prompt=plan["prompt"], sample=k, seed=plan["seed"] + k,
                cfg=plan["cfg"], steps=plan["steps"], duration=plan["duration"], frames=plan["frames"],
                gen_ms=round(gen_ms, 1), batch=batch_n, model=MODEL)
    if no_text:
        meta["text"] = "off"
    clip = {"fps": FPS, "qpos": [[round(float(v), 6) for v in row] for row in qpos], "meta": meta}
    if "loop" in plan["meta"]:
        clip["loop"] = plan["meta"]["loop"]
    rel = f"{plan['id']}/s{k}.json"
    with open(os.path.join(outdir, rel), "w") as f:
        json.dump(clip, f, separators=(",", ":"))
    return {"job": plan["id"], "motion": plan["motion"], "file": rel, "sample": k}


def read_rows(path):
    try:
        with open(path) as f:
            rows = json.load(f)
    except Exception:
        return []
    return [r for r in rows if isinstance(r, dict) and "job" in r] if isinstance(rows, list) else []


def write_rows(path, rows):
    rows = sorted(rows, key=lambda r: (str(r["job"]), r.get("sample", 0)))
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rows, f, indent=0)
    os.replace(tmp, path)


class Manifest:
    """OUTDIR/manifest_<i>of<n>.json, rewritten after every batch. The jobs this run picks leave EVERY
    manifest in OUTDIR (an earlier run with another --shard spec too), so a job is listed once, by its last run."""

    def __init__(self, outdir, shard, job_ids):
        self.path = os.path.join(outdir, f"manifest_{shard[0]}of{shard[1]}.json")
        self.rows = []
        for path in glob.glob(os.path.join(outdir, "manifest_*.json")):
            rows = read_rows(path)
            keep = [r for r in rows if r["job"] not in job_ids]
            if os.path.abspath(path) == os.path.abspath(self.path):
                self.rows = keep
            elif len(keep) < len(rows):
                write_rows(path, keep)

    def add(self, row):
        self.rows.append(row)

    def save(self):
        write_rows(self.path, self.rows)


def clear_job(outdir, jid):
    """A rerun replaces the job: delete the clips and constraints.json an earlier run left in OUTDIR/<id>
    (clip-check scores every clip on disk, manifest or not). Other files stay. Returns the clip count."""
    d = os.path.join(outdir, jid)
    if not safe_id(jid) or not os.path.isdir(d):
        return 0
    clips = [f for f in os.listdir(d) if CLIP_RE.fullmatch(f)]
    for f in clips + (["constraints.json"] if os.path.exists(os.path.join(d, "constraints.json")) else []):
        os.remove(os.path.join(d, f))
    with contextlib.suppress(OSError):
        os.rmdir(d)  # only when nothing else is in it
    return len(clips)


def main():
    ap = argparse.ArgumentParser(description="Batch Kimodo-G1 generation (see README.md, section kgen)")
    ap.add_argument("jobs")
    ap.add_argument("--out", required=True)
    ap.add_argument("--shard", default="0/1", help="i/n: run jobs whose index %% n == i")
    ap.add_argument("--dry-run", action="store_true", help="no model: validate, build and save constraints")
    ap.add_argument("--only", default="", help="comma-separated job ids")
    ap.add_argument("--no-text", action="store_true", help="debug: no text encoder, constraint-only generation")
    ap.add_argument("--batch", type=int, default=64, help="max samples per denoiser batch")
    ap.add_argument("--tf32", action="store_true",
                    help="TF32 matmuls in the denoiser: 1.46x faster on the A10G, median 0.1 deg drift vs fp32")
    args = ap.parse_args()
    if args.tf32:  # Kimodo's FK turns TF32 back off around itself, so constraints/FK stay fp32
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

    m = re.fullmatch(r"(\d+)/(\d+)", args.shard)
    if not m or not 0 <= int(m[1]) < int(m[2]):
        raise SystemExit(f"[kgen] --shard must be i/n with 0 <= i < n, got {args.shard}")
    shard = (int(m[1]), int(m[2]))
    defaults, anchors, jobs = load_jobs(args.jobs)
    only = [s for s in args.only.split(",") if s]
    known = {j.get("id") for j in jobs if isinstance(j, dict)}
    missing = [s for s in only if s not in known]
    if missing:
        raise SystemExit(f"[kgen] --only: unknown job ids {missing}")
    picked = [j for i, j in enumerate(jobs) if i % shard[1] == shard[0]
              and (not only or (isinstance(j, dict) and j.get("id") in only))]
    os.makedirs(args.out, exist_ok=True)

    device = "cuda:0" if torch.cuda.is_available() and not args.dry_run else "cpu"
    model = None
    if not args.dry_run:
        model = load_model(device, args.no_text)
    rig = Rig(model.skeleton if model is not None else None)

    man = None
    if not args.dry_run:  # once the model is up: every picked job is replaced, even one that then fails
        ids = {j.get("id") for j in picked if isinstance(j, dict)}
        man = Manifest(args.out, shard, ids)
        gone = sum(clear_job(args.out, jid) for jid in ids if isinstance(jid, str))
        man.save()  # disk and manifests agree from here on
        if gone:
            log(f"rerun: deleted {gone} old clips of the picked jobs")
    stray = sorted(d for d in os.listdir(args.out) if d not in known and os.path.isdir(os.path.join(args.out, d))
                   and any(CLIP_RE.fullmatch(f) for f in os.listdir(os.path.join(args.out, d))))
    if stray:
        log(f"warn: {args.out} also holds clips of {len(stray)} jobs not in this file (clip-check scores them too): "
            + ", ".join(stray[:8]) + (" ..." if len(stray) > 8 else ""))

    plans, failed = [], {}
    for i, job in enumerate(picked):
        jid = job.get("id") if isinstance(job, dict) else f"#{i}"
        try:
            p = resolve(job, defaults, anchors, rig)
            p["no_text"] = args.no_text
            d = os.path.join(args.out, p["id"])
            os.makedirs(d, exist_ok=True)
            if args.dry_run and any(CLIP_RE.fullmatch(f) for f in os.listdir(d)):
                p["warn"].append("dry run rewrote constraints.json next to an earlier run's clips")
            with open(os.path.join(d, "constraints.json"), "w") as f:
                json.dump(p["saved"], f)
            for w in p["warn"]:
                log(f"warn {p['id']}: {w}")
            plans.append(p)
        except (JobError, OSError) as e:
            failed[str(jid)] = str(e)
            log(f"FAIL {jid}: {e}")

    groups = {}
    for p in plans:
        groups.setdefault((p["frames"], p["steps"], tuple(p["cfg"])), []).append(p)
    nsamp = sum(p["samples"] for p in plans)
    log(f"{len(picked)} jobs in shard {shard[0]}/{shard[1]}: {len(plans)} ok, {len(failed)} failed; "
        f"{nsamp} samples in {len(groups)} batch groups (frames, steps, cfg)")

    if args.dry_run:
        for p in plans:
            log(f"  {p['id']:28s} {p['motion']:16s} {p['frames']:3d}f x{p['samples']:<3d} seed {p['seed']:<10d} "
                f"kf {p['nkf']} root {p['nroot']} head0 {math.degrees(p['heading0']):+6.1f} | {p['prompt']}")
        log(f"dry run: constraints saved to {args.out}/<id>/constraints.json")
        if failed:
            log("failed: " + ", ".join(failed))
        sys.exit(1 if failed else 0)

    if not args.no_text:  # encode every distinct prompt up front (cached for the whole run)
        from kimodo.sanitize import sanitize_texts
        t0 = time.time()
        uniq = list(dict.fromkeys(p["prompt"] for p in plans))
        model.text_encoder(sanitize_texts(uniq))
        log(f"encoded {len(uniq)} prompts in {(time.time() - t0) * 1e3:.0f} ms")

    left = {p["id"]: p["samples"] for p in plans}
    job_ms = {p["id"]: 0.0 for p in plans}
    done = [0]
    total = len(plans)
    t_all = time.time()

    def finish(p, err=None):
        if err:
            failed[p["id"]] = err
            log(f"FAIL {p['id']}: {err}")
        done[0] += 1
        if not err:
            log(f"job {p['id']} {done[0]}/{total} {job_ms[p['id']]:.0f}")

    def attempt(items):
        """Run items (one batch); on OOM halve it, on other errors isolate the bad job."""
        live = [it for it in items if it[0]["id"] not in failed]
        if not live:
            return
        err = None
        try:
            qpos, ms = run_batch(model, rig, live, device)
        except Exception as e:  # retry only after leaving this block: e's traceback pins the failed batch's tensors
            err, oom = f"{type(e).__name__}: {e}", isinstance(e, torch.cuda.OutOfMemoryError)
        if err:
            if oom:
                gc.collect()
                torch.cuda.empty_cache()
            if len(live) > 1 and (oom or len({it[0]['id'] for it in live}) > 1):
                if oom:
                    h = len(live) // 2
                    log(f"OOM at batch {len(live)}, splitting")
                    attempt(live[:h])
                    attempt(live[h:])
                else:
                    by = {}
                    for it in live:
                        by.setdefault(it[0]["id"], []).append(it)
                    for its in by.values():
                        attempt(its)
                return
            for pid in {it[0]["id"] for it in live}:
                finish(next(it[0] for it in live if it[0]["id"] == pid), err)
            return
        per = ms / len(live)
        for (p, k, _), q in zip(live, qpos):
            if p["id"] in failed:
                continue
            try:
                man.add(write_sample(args.out, p, k, q, per, len(live), args.no_text))
            except OSError as e:
                finish(p, f"write failed: {e}")
                continue
            job_ms[p["id"]] += per
            left[p["id"]] -= 1
            if left[p["id"]] == 0:
                finish(p)
        man.save()

    for (n, steps, cfg), ps in groups.items():
        cap = max(1, min(args.batch, FRAME_BUDGET // n))
        items = []
        for p in ps:
            try:
                cl = rig.load(p["saved"], device=device)
            except Exception as e:
                finish(p, f"constraints did not load: {type(e).__name__}: {e}")
                continue
            items += [(p, k, cl) for k in range(p["samples"])]
        for b in range(0, len(items), cap):
            attempt(items[b: b + cap])
    man.save()
    secs = time.time() - t_all
    ok = [p["id"] for p in plans if p["id"] not in failed]
    mem = f"; peak GPU mem {torch.cuda.max_memory_allocated() / 2**30:.1f} GB (torch)" if device.startswith("cuda") else ""
    log(f"done: {len(ok)} jobs ok, {len(failed)} failed, {sum(p['samples'] for p in plans if p['id'] in ok)} clips "
        f"in {secs:.1f} s{mem}; manifest {man.path}")
    for jid, err in failed.items():
        log(f"  failed {jid}: {err}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
