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


def _sst(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def _edges(tri):
    e = np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]])
    e = np.sort(e, 1)
    return np.unique(e, axis=0)


def _laplace(P, e, deg):
    acc = np.zeros_like(P)
    np.add.at(acc, e[:, 0], P[e[:, 1]])
    np.add.at(acc, e[:, 1], P[e[:, 0]])
    return acc / deg[:, None] - P


def _vnormals(P, tri):
    fn = np.cross(P[tri[:, 1]] - P[tri[:, 0]], P[tri[:, 2]] - P[tri[:, 0]])
    vn = np.zeros_like(P)
    for i in range(3):
        np.add.at(vn, tri[:, i], fn)
    return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)


def soften(P, tri, mask, iters=8, lam=0.5, mu=-0.53):
    """Taubin smoothing (shrink-free) weighted per vertex by mask in 0..1: irons out small anatomy (fine muscle
    striations, wrinkles, the nasolabial fold) and keeps the big forms."""
    e = _edges(tri)
    deg = np.maximum(np.bincount(e.ravel(), minlength=len(P)), 1).astype(float)
    m = mask[:, None]
    for _ in range(iters):
        P = P + m * lam * _laplace(P, e, deg)
        P = P + m * mu * _laplace(P, e, deg)
    return P


def flatten_ears(P, tri, fs, ear_sets=(4, 5), iters=5000):
    """Melt the human ears into the side of the head (the elf ears are separate): every ear vertex not on the
    ear's border ring relaxes to the harmonic membrane spanning that ring."""
    P = P.copy()
    ear = np.isin(fs, ear_sets)
    ev = np.unique(tri[ear])
    border = np.intersect1d(ev, np.unique(tri[~ear]))
    free = np.setdiff1d(ev, border)
    if not len(free):
        return P
    loc = np.full(len(P), -1)
    loc[ev] = np.arange(len(ev))
    e = loc[_edges(tri[ear])]                       # local indices on the ear patch
    Q = P[ev]
    isfree = np.isin(ev, free)
    deg = np.maximum(np.bincount(e.ravel(), minlength=len(ev)), 1).astype(float)
    for _ in range(iters):
        acc = np.zeros_like(Q)
        np.add.at(acc, e[:, 0], Q[e[:, 1]])
        np.add.at(acc, e[:, 1], Q[e[:, 0]])
        Q[isfree] = acc[isfree] / deg[isfree, None]
    P[ev] = Q
    return P


def shape_face(P, tri, eyes):
    """The elf's face: a touch slimmer and longer (narrower cheeks and jaw, chin 3 mm lower), a soft zygomatic
    ridge with a hollow under it, a smaller softer nose and heavier lids (smaller, calmer eye openings).
    Returns the new vertices and the eye vertices with the same lateral squeeze."""
    P = P.copy()
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    head = _sst(1.115, 1.140, z)
    # --- lids: rotate the lid skin about each eye's lateral axis (upper down, lower up); corners stay put
    up = np.array([0.0, 0, 1])
    for k, s in (("eyeL", 1), ("eyeR", -1)):
        E = eyes[k].mean(0)
        r0 = float(np.linalg.norm(eyes[k] - E, axis=1).mean())
        g = np.array([np.cos(np.radians(4)), s * np.sin(np.radians(4)), 0])
        lat = np.cross(up, g)
        lat /= np.linalg.norm(lat)
        side = np.cross(g, up)                  # + toward the eye's own left
        q = P - E
        r = np.linalg.norm(q, axis=1) + 1e-12
        near = r < r0 + 0.016
        qn = q[near]
        rn = r[near]
        d = qn / rn[:, None]
        el = np.degrees(np.arcsin(np.clip(d @ up, -1, 1)))
        az = np.degrees(np.arctan2(d @ side, d @ g))
        wr = _sst(r0 + 0.013, r0 + 0.003, rn) * _sst(0.0, 0.35, d @ g)
        wa = np.clip(1 - (az / 52.0) ** 2, 0, 1) ** 0.8
        theta = np.radians(7.5 * _sst(-3, 5, el) - 3.0 * _sst(3, -5, el)) * wr * wa
        c, sn = np.cos(theta)[:, None], np.sin(theta)[:, None]
        rot = qn * c + np.cross(lat, qn) * sn + lat[None] * (qn @ lat)[:, None] * (1 - c)
        P[near] = E + rot
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    # --- normals before the reshaping (for the cheekbone push)
    N = _vnormals(P, tri)
    # --- cheekbones: a ridge from under the outer eye corner back toward the ear, a hollow under it
    disp = np.zeros(len(P))
    for s in (1, -1):
        A, B = np.array([0.068, s * 0.047, 1.208]), np.array([0.036, s * 0.058, 1.214])
        dr, _t = seg_dist(P, A, B)
        out = _sst(0.15, 0.5, s * N[:, 1])
        disp += 0.0017 * np.exp(-(dr / 0.0062) ** 2) * out
        C = np.array([0.060, s * 0.049, 1.183])
        q = (P - C) / np.array([0.016, 0.016, 0.011])
        disp -= 0.0024 * np.exp(-(q * q).sum(1) * 1.4) * out
    P += N * (disp * head)[:, None]
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    # --- smaller, softer nose
    Nc = np.array([0.101, 0.0, 1.206])
    wn = _sst(0.026, 0.008, np.linalg.norm(P - Nc, axis=1))
    P[:, 0] = x - wn * 0.34 * np.maximum(x - 0.092, 0)
    P[:, 1] = y * (1 - 0.18 * wn)
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    # --- profile: mouth sits back a little, chin comes forward a little (no muzzle)
    q = (P - np.array([0.104, 0.0, 1.176])) / np.array([0.020, 0.030, 0.020])
    P[:, 0] -= 0.0026 * np.exp(-(q * q).sum(1) * 1.5)
    q = (P - np.array([0.094, 0.0, 1.143])) / np.array([0.020, 0.022, 0.014])
    P[:, 0] += 0.0016 * np.exp(-(q * q).sum(1) * 1.5)
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    # --- slimmer, longer face: lateral squeeze strongest at the jaw/cheeks, gone by the temples
    ZS, AS = [1.125, 1.145, 1.170, 1.195, 1.212, 1.232, 1.255], [0.0, 0.14, 0.14, 0.11, 0.05, 0.02, 0.0]

    def squeeze(Q):
        aq = np.interp(Q[:, 2], ZS, AS) * (0.3 + 0.7 * _sst(-0.025, 0.02, Q[:, 0]))
        Q = Q.copy()
        Q[:, 1] *= 1 - aq
        return Q

    P[:, 1] = squeeze(P)[:, 1]
    P[:, 2] = z - 0.0032 * _sst(1.205, 1.150, z) * _sst(1.110, 1.140, z) * _sst(-0.03, 0.03, x)
    eyes = {k: squeeze(v) for k, v in eyes.items()}
    # --- soften the whole face (no prominent features), lids a little less so the openings stay clean
    lid = np.zeros(len(P))
    for k in ("eyeL", "eyeR"):
        E = eyes[k].mean(0)
        lid = np.maximum(lid, _sst(0.020, 0.012, np.linalg.norm(P - E, axis=1)))
    face = _sst(1.13, 1.16, z) * _sst(1.29, 1.26, z) * _sst(0.0, 0.04, x)
    P = soften(P, tri, face * (1 - 0.7 * lid), iters=10)
    return P, eyes


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
    # smoother skin everywhere (gentle), then the elf's face
    fs = d["body_fs"] if "body_fs" in d else np.zeros(len(tri), int)
    out = flatten_ears(out, tri, fs)
    out = soften(out, tri, np.full(len(out), 0.8), iters=6)
    out, eyes = shape_face(out, tri, eyes)
    np.savez_compressed(out_path, verts=out, tris=tri, eyeL=eyes["eyeL"], eyeR=eyes["eyeR"],
                        eye_tris=d["eyeL_tri"], facesets=d["body_fs"] if "body_fs" in d else np.zeros(len(tri)),
                        **{"S_" + k: v for k, v in S.items()}, **{"T_" + k: v for k, v in T.items()})
    log(f"fitted base body: {len(out)} verts -> {out_path}")
    for k in sorted(S):
        log(f"  {k:12s} src {np.round(S[k], 3)}  tgt {np.round(T[k], 3)}")
    return out_path


if __name__ == "__main__":
    fit()
