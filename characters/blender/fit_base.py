# Fit Blender Studio's CC0 realistic female base mesh (Human Base Meshes v1.4.1) onto the G1 bind pose.
# Pure numpy: rotate/scale into the MuJoCo frame, find the mesh's joints from cross-sections, then warp it
# bone by bone (linear blend skinning with distance weights) so its joints land on the G1's.
# Input: cache/hbm_female.npz from extract_base.py. Output: cache/base_fitted.npz (verts, tris, eyes, landmarks).
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import g1  # noqa: E402

CACHE = HERE / "cache"
SCALE = 0.80          # 1.64 m base body -> about the G1's 1.32 m
X_SHIFT = -0.030      # the base body stands with its torso ~3-5 cm ahead of the G1's; pull it back


def to_mujoco(p, cx, cy):
    """Base mesh faces -Y with +X on its left; MuJoCo character faces +X with +Y on its left."""
    p = np.asarray(p, float)
    out = np.empty_like(p)
    out[..., 0] = -(p[..., 1] - cy) * SCALE + X_SHIFT
    out[..., 1] = (p[..., 0] - cx) * SCALE
    out[..., 2] = p[..., 2] * SCALE
    return out


def slice_clusters(co, z, dz=0.004, gap=0.02):
    """Clusters of vertices along x (lateral, raw mesh frame) at height z."""
    s = co[np.abs(co[:, 2] - z) < dz]
    if len(s) == 0:
        return []
    order = np.argsort(s[:, 0])
    s = s[order]
    cuts = np.where(np.diff(s[:, 0]) > gap)[0]
    return np.split(s, cuts + 1)


def landmarks(co):
    """Joint centers in the raw mesh frame (meters, Z up, facing -Y, character left = +X)."""
    cx = (co[:, 0].min() + co[:, 0].max()) / 2
    L = {}
    # legs: cluster centroids, left = x > cx
    def leg_center(z, side):
        cl = [c for c in slice_clusters(co, z) if np.sign(c[:, 0].mean() - cx) == side and abs(c[:, 0].mean() - cx) < 0.25]
        c = max(cl, key=len)
        return np.array([(c[:, 0].min() + c[:, 0].max()) / 2, (c[:, 1].min() + c[:, 1].max()) / 2, z])
    H = co[:, 2].max()
    for side, nm in ((1, "l"), (-1, "r")):
        knee = leg_center(0.285 * H, side)
        ankle = leg_center(0.050 * H, side) + np.array([0, 0.012, 0.0])     # joint sits behind the shin center
        thigh = leg_center(0.43 * H, side)
        hip = knee + (thigh - knee) * (0.52 - 0.285) / (0.43 - 0.285)
        hip[0] = cx + side * 0.085
        hip[2] = 0.52 * H
        foot = co[(np.sign(co[:, 0] - cx) == side) & (co[:, 2] < 0.05 * H)]
        toe = foot[np.argmin(foot[:, 1])]                                       # most forward point (-Y)
        L[nm + "_hip"], L[nm + "_knee"], L[nm + "_ankle"], L[nm + "_toe"] = hip, knee, ankle, toe
        # arm centerline: outer clusters between shoulder and hand
        pts = []
        for z in np.linspace(0.78 * H, 0.50 * H, 40):
            cl = [c for c in slice_clusters(co, z) if side * (c[:, 0].mean() - cx) > 0.13]
            if cl:
                c = max(cl, key=lambda c: side * c[:, 0].mean())
                pts.append([(c[:, 0].min() + c[:, 0].max()) / 2, (c[:, 1].min() + c[:, 1].max()) / 2, z])
        pts = np.array(pts)
        # fit a line through the upper part (upper arm + forearm are nearly straight in the A-pose)
        shoulder = np.array([cx + side * 0.170, -0.010, 0.815 * H])
        d = pts[-1] - shoulder
        d /= np.linalg.norm(d)
        elbow = shoulder + d * 0.186 * H
        wrist = shoulder + d * (0.186 + 0.146) * H
        hand = co[(side * (co[:, 0] - cx) > 0.2) & (co[:, 2] < 0.47 * H)]
        tip = hand[np.argmin(hand[:, 2])] if len(hand) else wrist + d * 0.1
        # snap elbow/wrist to the arm centerline
        for key, p in (("elbow", elbow), ("wrist", wrist)):
            j = np.argmin(np.abs(pts[:, 2] - p[2]))
            p[:2] = pts[j, :2]
        L[nm + "_shoulder"], L[nm + "_elbow"], L[nm + "_wrist"], L[nm + "_hand"] = shoulder, elbow, wrist, tip
    L["pelvis"] = np.array([cx, 0.0, 0.54 * H])
    L["waist"] = np.array([cx, 0.0, 0.63 * H])
    L["chest"] = np.array([cx, 0.0, 0.72 * H])
    L["neck"] = np.array([cx, 0.005, 0.815 * H])
    L["head"] = np.array([cx, 0.0, 0.89 * H])
    L["top"] = np.array([cx, 0.0, H])
    return L, cx


def frame_from(head, tail, hint):
    y = tail - head
    ln = np.linalg.norm(y)
    y = y / ln
    x = hint - (hint @ y) * y
    x /= np.linalg.norm(x)
    z = np.cross(x, y)
    return np.stack([x, y, z], 1), ln


def rot_between(a, b):
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = a @ b
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K * (1 / (1 + c))


def bone_map(sh, st, th, tt):
    """Affine map taking a source bone (head sh, tail st) onto a target bone, scaling only along its length."""
    ds, dt = st - sh, tt - th
    R = rot_between(ds, dt)
    u = ds / np.linalg.norm(ds)
    ratio = np.linalg.norm(dt) / np.linalg.norm(ds)
    S = np.eye(3) + (ratio - 1) * np.outer(u, u)          # stretch along the source bone axis
    A = R @ S
    return A, th - A @ sh


def seg_dist(P, a, b):
    ab = b - a
    t = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1), t


def athletic_chest(P, keep=0.33, fill=0.75):
    """Armored-fighter chest: flatten the bust toward a plane through the sternum above and the ribs below it,
    and fill the cleavage and under-bust creases up to that plane, so a breastplate sits on a smooth shell."""
    P = P.copy()
    x, y, z = P[:, 0], P[:, 1], P[:, 2]

    def mid_x(zz):
        m = (x > 0) & (np.abs(z - zz) < 0.004) & (np.abs(y) < 0.008)
        return np.percentile(x[m], 95)

    za, zb = 1.075, 0.900
    xa, xb = mid_x(za), mid_x(zb)
    xref = xb + (xa - xb) * (z - zb) / (za - zb) + 0.006

    def sst(e0, e1, v):
        t = np.clip((v - e0) / (e1 - e0), 0, 1)
        return t * t * (3 - 2 * t)

    w = sst(0.895, 0.930, z) * sst(1.090, 1.055, z) * sst(0.120, 0.090, np.abs(y)) * (x > 0)
    over = x - xref
    flat = np.where(over > 0, over * keep, over)
    filled = np.where((over < 0) & (over > -0.022) & (np.abs(y) < 0.075), over * (1 - fill), flat)
    P[:, 0] = x + w * (xref + filled - x)
    return P


def fit(npz_path=CACHE / "hbm_female.npz", out_path=CACHE / "base_fitted.npz", log=print):
    d = np.load(npz_path)
    co_raw, tri = d["body_co"], d["body_tri"]
    Lraw, cx = landmarks(co_raw)
    cy = (Lraw["l_knee"][1] + Lraw["r_knee"][1]) / 2 + 0.012
    S = {k: to_mujoco(v, cx, cy) for k, v in Lraw.items()}
    P = to_mujoco(co_raw, cx, cy)
    eyes = {k: to_mujoco(d[k + "_co"], cx, cy) for k in ("eyeL", "eyeR")}
    W = g1.fk(g1.BIND)
    p = lambda n: W[n][:3, 3]
    T = dict(S)  # targets; torso and head stay where uniform scaling put them
    for s, nm in ((1, "l"), (-1, "r")):
        side = "left_" if s > 0 else "right_"
        T[nm + "_shoulder"] = p(side + "shoulder_roll_link") + np.array([0.0, s * 0.004, -0.004])
        T[nm + "_elbow"] = p(side + "elbow_link")
        T[nm + "_wrist"] = p(side + "wrist_yaw_link")
        hand_len = np.linalg.norm(S[nm + "_hand"] - S[nm + "_wrist"])
        T[nm + "_hand"] = T[nm + "_wrist"] + W[side + "wrist_yaw_link"][:3, :3] @ np.array([hand_len, 0, 0])
        T[nm + "_hip"] = np.array([0.0, s * 0.098, p(side + "hip_pitch_link")[2] - 0.004])
        T[nm + "_knee"] = p(side + "knee_link") + np.array([0.0, -s * 0.004, 0.0])
        T[nm + "_ankle"] = p(side + "ankle_pitch_link") + np.array([0.0, 0.0, 0.004])
        T[nm + "_toe"] = T[nm + "_ankle"] + (S[nm + "_toe"] - S[nm + "_ankle"]) * np.array([1, 0, 1])
    # bones: (name, source head, source tail, target head, target tail, radius for weighting)
    B = [("pelvis", S["pelvis"], S["waist"], T["pelvis"], T["waist"], 0.12),
         ("spine", S["waist"], S["chest"], T["waist"], T["chest"], 0.11),
         ("chest", S["chest"], S["neck"], T["chest"], T["neck"], 0.11),
         ("head", S["neck"], S["top"], T["neck"], T["top"], 0.09)]
    for nm in ("l", "r"):
        B += [(nm + "_clav", S["neck"], S[nm + "_shoulder"], T["neck"], T[nm + "_shoulder"], 0.06),
              (nm + "_upper", S[nm + "_shoulder"], S[nm + "_elbow"], T[nm + "_shoulder"], T[nm + "_elbow"], 0.045),
              (nm + "_fore", S[nm + "_elbow"], S[nm + "_wrist"], T[nm + "_elbow"], T[nm + "_wrist"], 0.035),
              (nm + "_hand", S[nm + "_wrist"], S[nm + "_hand"], T[nm + "_wrist"], T[nm + "_hand"], 0.03),
              (nm + "_thigh", S[nm + "_hip"], S[nm + "_knee"], T[nm + "_hip"], T[nm + "_knee"], 0.07),
              (nm + "_shin", S[nm + "_knee"], S[nm + "_ankle"], T[nm + "_knee"], T[nm + "_ankle"], 0.05),
              (nm + "_foot", S[nm + "_ankle"], S[nm + "_toe"], T[nm + "_ankle"], T[nm + "_toe"], 0.04)]
    maps = [bone_map(sh, st, th, tt) for _, sh, st, th, tt, _ in B]
    # weights: inverse distance to each source bone segment, sharpened, then smoothed over the mesh
    Dm = np.stack([seg_dist(P, sh, st)[0] / r for _, sh, st, _, _, r in B], 1)
    Wt = 1.0 / (Dm ** 6 + 1e-6)
    # keep limbs from grabbing the torso (and vice versa) across the armpit/crotch: side masks
    lat = P[:, 1]
    for i, (nm, *_rest) in enumerate(B):
        if nm.startswith("l_"):
            Wt[lat < 0.02, i] = 0
        if nm.startswith("r_"):
            Wt[lat > -0.02, i] = 0
    Wt /= Wt.sum(1, keepdims=True)
    edges = np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]])
    deg = np.bincount(edges.ravel(), minlength=len(P)).astype(float)
    for _ in range(12):
        acc = np.zeros_like(Wt)
        np.add.at(acc, edges[:, 0], Wt[edges[:, 1]])
        np.add.at(acc, edges[:, 1], Wt[edges[:, 0]])
        Wt = 0.5 * Wt + 0.5 * acc / np.maximum(deg, 1)[:, None]
    out = np.zeros_like(P)
    for i, (A, t) in enumerate(maps):
        out += Wt[:, i:i + 1] * (P @ A.T + t)
    out = athletic_chest(out)
    # eyes ride on the head bone
    hi = [b[0] for b in B].index("head")
    A, t = maps[hi]
    eyes = {k: v @ A.T + t for k, v in eyes.items()}
    np.savez_compressed(out_path, verts=out, tris=tri, eyeL=eyes["eyeL"], eyeR=eyes["eyeR"],
                        eye_tris=d["eyeL_tri"], facesets=d["body_fs"] if "body_fs" in d else np.zeros(len(tri)),
                        **{"S_" + k: v for k, v in S.items()}, **{"T_" + k: v for k, v in T.items()})
    log(f"fitted base body: {len(out)} verts -> {out_path}")
    for k in sorted(S):
        log(f"  {k:12s} src {np.round(S[k], 3)}  tgt {np.round(T[k], 3)}")
    return out_path


if __name__ == "__main__":
    fit()
