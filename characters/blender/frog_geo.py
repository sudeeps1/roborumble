# Frog geometry (numpy + OpenVDB, no bpy): clean the AI statue into a watertight body in its own frame, warp it
# onto the G1 bind pose, and add procedural frog arms and hands as signed distance fields.
# Source frame (glTF import): meters, Z up, frog faces -Y, its left is +X, soles at z = FLOOR on a pedestal.
import numpy as np
import openvdb as vdb

import sdf
from fit_base import bone_map, seg_dist

F = np.float32
FLOOR = 0.0835                     # sole plane; the pedestal top sits just below
H_SRC = 0.0015                     # source-space voxel (m)
LO_SRC, HI_SRC = np.array([-0.24, -0.20, 0.06]), np.array([0.26, 0.20, 0.84])

# ---------------------------------------------------------------- landmarks (source frame, read off gridded views)
J = {k: np.array(v, float) for k, v in {
    "pelvis": (0.010, 0.015, 0.40), "waist": (0.012, 0.010, 0.47), "chest": (0.014, 0.010, 0.56),
    "neck": (0.015, 0.000, 0.650), "top": (0.016, -0.030, 0.78),
    "l_shoulder": (0.100, 0.005, 0.618), "r_shoulder": (-0.075, 0.020, 0.618),
    "l_hip": (0.062, -0.012, 0.40), "l_knee": (0.086, -0.052, 0.272), "l_ankle": (0.098, -0.048, 0.126),
    "l_toe": (0.070, -0.125, 0.092),
    "r_hip": (-0.042, 0.032, 0.40), "r_knee": (-0.058, 0.070, 0.272), "r_ankle": (-0.076, 0.086, 0.124),
    "r_toe": (-0.105, 0.005, 0.092),
}.items()}
CX = 0.012                         # torso midline (x)
CY = 0.012

# attachments to strip (source frame)
FSTAFF = (np.array([-0.149, -0.049, 0.12]), np.array([-0.0596, -0.0667, 1.0]))
BSTAFF = [(-0.140, 0.058, 0.26), (-0.100, 0.068, 0.32), (-0.045, 0.082, 0.40), (0.005, 0.094, 0.50),
          (0.050, 0.103, 0.58), (0.071, 0.104, 0.62), (0.114, 0.105, 0.70), (0.134, 0.104, 0.74),
          (0.156, 0.104, 0.78), (0.171, 0.106, 0.82), (0.26, 0.11, 1.02)]
PACK = [(0.120, 0.066, 0.44), (0.120, 0.066, 0.64), (0.110, 0.055, 0.69), (0.095, 0.030, 0.70)]
L_ARM = [(0.100, 0.005, 0.618), (0.200, 0.015, 0.545), (0.172, 0.000, 0.492), (0.140, -0.035, 0.464)]
R_ARM = [(-0.075, 0.020, 0.618), (-0.155, 0.070, 0.550), (-0.182, 0.005, 0.522), (-0.180, -0.065, 0.505)]
POUCH = ((0.084, -0.115, 0.365), (0.180, 0.030, 0.503))
SHEATH = ((-0.140, -0.075, 0.395), (-0.062, 0.075, 0.515))
LABELS = ["body", "fstaff", "bstaff", "l_arm", "r_arm", "pouch", "sheath", "pedestal", "pack"]
ARM_LABELS = (3, 4)


def poly_dist(P, pts):
    pts = [np.asarray(p, float) for p in pts]
    return np.min([seg_dist(P, a, b)[0] for a, b in zip(pts[:-1], pts[1:])], 0)


def hsv(col):
    mx, mn = col.max(-1), col.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-4)
    r, g, b = col[..., 0], col[..., 1], col[..., 2]
    hue = np.degrees(np.arctan2(np.sqrt(3) * (g - b), 2 * r - g - b)) % 360
    return hue, sat, mx


def sample_tex(tex, uv):
    """tex: (S, S, 3) uint8, row 0 = v 0 (Blender pixel order). Bilinear-free nearest lookup -> float 0..1 sRGB."""
    S = tex.shape[0]
    px = np.clip((uv[..., 0] % 1.0) * S, 0, S - 1).astype(int)
    py = np.clip((uv[..., 1] % 1.0) * S, 0, S - 1).astype(int)
    return tex[py, px].astype(F) / 255


def label_tris(co, tri, tuv, tex):
    """Per-triangle part label (index into LABELS) for the statue."""
    cen = co[tri].mean(1)
    col = sample_tex(tex, tuv.mean(1))
    hue, sat, val = hsv(col)
    lab = np.zeros(len(tri), np.int8)
    x, y, z = cen.T
    a0, ad = FSTAFF
    ad = ad / np.linalg.norm(ad)
    fs = seg_dist(cen, a0 + ad * (-0.2), a0 + ad * 1.2)[0]
    lab[(fs < 0.021) | ((fs < 0.028) & (z < 0.15))] = 1
    bs = poly_dist(cen, BSTAFF)
    lab[((bs < 0.021) | ((bs < 0.031) & (z > 0.38) & (z < 0.46))) & (lab == 0)] = 2
    # arms: everything near the arm skeleton beyond the armhole planes (the bisector to the body does the rest)
    for k, (pts, s, xc) in enumerate(((L_ARM, 1, 0.098), (R_ARM, -1, -0.072))):
        d = poly_dist(cen, [np.asarray(pts[0]) + np.array([s * 0.02, 0, -0.01])] + pts[1:])
        m = (d < 0.052) & (s * (x - xc) > 0) & (lab == 0)
        # keep the vest / fleece where it sits right at the armhole (brown / cream, not skin teal or glove red)
        vestish = (hue > 20) & (hue < 60) & (val > 0.25) & (s * (x - xc) < 0.03)
        lab[m & ~vestish] = 3 + k
    inb = lambda lo, hi: np.all((cen >= lo) & (cen <= hi), 1)
    pants = (hue > 185) & (hue < 230) & (val < 0.5)
    vest = (hue > 24) & (hue < 50) & (val > 0.3) & (sat < 0.6) & (x < 0.11) & (z > 0.47)
    sash = (sat < 0.3) & (val > 0.45)
    lab[inb(*POUCH) & (lab == 0) & ~pants & ~vest] = 5
    lab[inb(*SHEATH) & (lab == 0) & ~pants & ~sash] = 6
    lab[(z < FLOOR) & (lab == 0)] = 7
    cream = (sat < 0.34) & (val > 0.38) & (hue > 15) & (hue < 70)
    lab[(poly_dist(cen, PACK) < 0.03) & cream & (y > 0.03) & (lab == 0)] = 8
    return lab, col


def level_set(co, tri, h, half_width, lo, hi):
    """Dense signed (closed meshes) or |unsigned| distance grid over [lo, hi]; returns (array, i0)."""
    xf = vdb.createLinearTransform(voxelSize=h)
    g = vdb.FloatGrid.createLevelSetFromPolygons(co.astype(F), triangles=tri.astype(np.int32), transform=xf,
                                                halfWidth=float(half_width))
    i0 = np.floor(np.asarray(lo) / h).astype(int)
    shape = tuple(np.ceil((np.asarray(hi) - np.asarray(lo)) / h).astype(int) + 2)
    a = np.zeros(shape, F)
    g.copyToArray(a, ijk=tuple(int(v) for v in i0))
    return a, i0


def to_grid(a, i0, h):
    g = vdb.FloatGrid(float(np.abs(a).max()))
    g.transform = vdb.createLinearTransform(voxelSize=h)
    g.copyFromArray(np.ascontiguousarray(a, F), tuple(int(v) for v in i0), 0.0)
    return g


def polygons(a, i0, h, iso=0.0):
    g = to_grid(a, i0, h)
    pts, tris, quads = g.convertToPolygons(float(iso), 0.0)
    tris = np.asarray(tris, np.int64).reshape(-1, 3)
    quads = np.asarray(quads, np.int64).reshape(-1, 4)
    T = np.concatenate([tris, quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])
    return np.asarray(pts, float), T


def redistance(a, i0, h, iso, half_width):
    """Signed distance to the iso surface of a (by meshing it and re-voxelizing)."""
    pts, T = polygons(a, i0, h, iso)
    lo = i0 * h
    hi = (i0 + np.array(a.shape) - 2) * h
    b, _ = level_set(pts, T, h, half_width, lo, hi)
    return b[:a.shape[0], :a.shape[1], :a.shape[2]]


def gauss_blur(a, sigma_vox, mask=None):
    """Separable Gaussian on a dense grid; with mask (0..1) the blurred field is blended in only there."""
    r = int(np.ceil(2.5 * sigma_vox))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_vox) ** 2)
    k /= k.sum()
    out = a
    for ax in range(3):
        pad = [(0, 0)] * 3
        pad[ax] = (r, r)
        p = np.pad(out, pad, mode="edge")
        acc = np.zeros_like(out)
        for i, w in enumerate(k):
            sl = [slice(None)] * 3
            sl[ax] = slice(i, i + out.shape[ax])
            acc += F(w) * p[tuple(sl)]
        out = acc
    if mask is None:
        return out
    return a + (out - a) * mask


def coords(shape, i0, h, axis):
    return ((np.arange(shape[axis]) + i0[axis]) * h).astype(F)


def components(V, T):
    """Connected component label per vertex (welded by position)."""
    q = np.round(V / 1e-6).astype(np.int64)
    _, inv = np.unique(q, axis=0, return_inverse=True)
    inv = inv.ravel()
    TT = inv[T]
    n = inv.max() + 1
    E = np.concatenate([TT[:, [0, 1]], TT[:, [1, 2]]])
    lab = np.arange(n)
    for _ in range(500):
        la, lb = lab[E[:, 0]], lab[E[:, 1]]
        m = np.minimum(la, lb)
        old = lab.copy()
        np.minimum.at(lab, la, m)
        np.minimum.at(lab, lb, m)
        for _ in range(6):
            lab = lab[lab]
        if (lab == old).all():
            break
    return lab[inv]


def keep_largest(V, T):
    lab = components(V, T)
    u, c = np.unique(lab, return_counts=True)
    keep = lab == u[np.argmax(c)]
    remap = -np.ones(len(V), np.int64)
    remap[keep] = np.arange(keep.sum())
    T2 = remap[T]
    T2 = T2[(T2 >= 0).all(1)]
    return V[keep], T2, len(u)


def clean_source(co, tri, lab, log=print, dbg=None):
    """Statue -> watertight body (source frame) with the attachments carved away along the bisector between
    their surface and the body's, dents filled by a local morphological closing, and the surface smoothed.
    Returns (verts, tris) and the dense field for debugging."""
    h = H_SRC
    hw = 40
    log("  source level set")
    d, i0 = level_set(co, tri, h, hw, LO_SRC, HI_SRC)
    band = hw * h * 0.98

    def carve(sel, cap):
        """Field > 0 inside the solid parts that are nearer the selected attachment surfaces than the body's
        (the bisector between them), at most `cap` deep below the attachment surface."""
        ua, _ = level_set(co, tri[sel], h, hw, LO_SRC, HI_SRC)
        ua = np.abs(ua)
        c = np.where((ua < cap) & (ua < band), ub - ua, F(-1)).astype(F)
        c[(ub >= band) & (ua < cap)] = 1
        return c, ua

    body = lab == 0
    log(f"  {(~body).sum()} attachment tris, {body.sum()} body tris")
    ub, _ = level_set(co, tri[body], h, hw, LO_SRC, HI_SRC)
    ub = np.abs(ub)
    arm = np.isin(lab, ARM_LABELS)
    c_arm, ua_arm = carve(arm, 0.045)
    xc = coords(d.shape, i0, h, 0)[:, None, None]
    c_arm[((xc < 0.082) & (xc > -0.056))[:, 0, 0]] = -1     # never carve the torso between the armholes
    c_oth, ua_oth = carve(~body & ~arm & (lab != 7), 0.026)
    d1 = np.maximum(d, np.maximum(c_arm, c_oth))
    ua = np.minimum(ua_arm, ua_oth)
    zc = coords(d.shape, i0, h, 2)[None, None, :]
    d1 = np.maximum(d1, F(FLOOR) - zc)
    del c_arm, c_oth, ua_arm, ua_oth
    if dbg is not None:
        dbg.update(d=d.copy(), d1=d1.copy(), ua=ua.copy(), ub=ub.copy())
    # local closing where attachments were (fills the dents they leave in the trousers, vest and back)
    R = 0.016
    log("  closing")
    dil = redistance(d1, i0, h, R, hw)
    clo = dil + F(R)
    near = np.clip(1 - (ua - 0.004) / 0.022, 0, 1).astype(F)
    d2 = d1 + (np.minimum(d1, clo) - d1) * near
    d2 = np.maximum(d2, F(FLOOR) - zc)
    if dbg is not None:
        dbg.update(d2=d2.copy(), clo=clo.copy(), near=near.copy())
    del dil, clo
    # smoothing: light everywhere, stronger on the noisy fleece, ruffles and creases
    d3 = gauss_blur(d2, 1.2)
    d3 = np.maximum(d3, F(FLOOR) - zc)
    log("  polygonize")
    V, T = polygons(d3, i0, h, 0.0)
    V, T, nc = keep_largest(V, T)
    log(f"  clean body: {len(V)} verts, {len(T)} tris ({nc} pieces before keeping the largest)")
    return V, T, (d3, i0)


def close_union(Vs, Ts, Vh, Th, h=0.004, r=0.010, hw=6, k=0.006, log=print):
    """Watertight skin: the open statue shell (plus plugged-in procedural forearms) gets a morphological closing
    of radius r (seals tears and cut openings), then the procedural hands are smooth-unioned on (k = fillet)."""
    lo = np.minimum(Vs.min(0), Vh.min(0)) - 0.06
    hi = np.maximum(Vs.max(0), Vh.max(0)) + 0.06
    lo = np.floor(lo / h) * h
    u, i0 = level_set(Vs, Ts, h, hw, lo, hi)
    u = np.abs(u)
    log("  offset shell")
    V1, T1 = polygons(u, i0, h, r)
    V1, T1, nc = keep_largest(V1, T1)
    log(f"  offset surface {len(V1)} verts ({nc} pieces)")
    ds, _ = level_set(V1, T1, h, hw, lo, hi)
    ds = ds[:u.shape[0], :u.shape[1], :u.shape[2]] + F(r)
    dh, _ = level_set(Vh, Th, h, hw, lo, hi)
    dh = dh[:u.shape[0], :u.shape[1], :u.shape[2]]
    hh = np.clip(0.5 + 0.5 * (dh - ds) / k, 0, 1)
    d = (dh + (ds - dh) * hh - k * hh * (1 - hh)).astype(F)        # polynomial smooth min
    V, T = polygons(d, i0, h, 0.0)
    V, T, nc = keep_largest(V, T)
    log(f"  closed skin {len(V)} verts ({nc} pieces)")
    return V, T


def soup_skin(Vh, Th, h=0.003, hw=4, min_verts=300):
    """Union of overlapping closed blobs (procedural forearms + frog hands) -> one clean watertight skin per arm."""
    lo = np.floor((Vh.min(0) - 0.03) / h) * h
    hi = Vh.max(0) + 0.03
    d, i0 = level_set(Vh, Th, h, hw, lo, hi)
    d = gauss_blur(d, 0.7)
    V, T = polygons(d, i0, h, 0.0)
    lab = components(V, T)
    u, c = np.unique(lab, return_counts=True)
    keep = np.isin(lab, u[c >= min_verts])
    remap = -np.ones(len(V), np.int64)
    remap[keep] = np.arange(keep.sum())
    T2 = remap[T]
    return V[keep], T2[(T2 >= 0).all(1)]
