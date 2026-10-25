# The realistic base body as a signed distance field: fitted mesh (fit_base.py) -> OpenVDB level set ->
# dense float16 grids (body at 1.5 mm, head at 0.6 mm) sampled trilinearly. Cached in cache/.
import numpy as np

import fit_base
import sdf
from sdf import F, V

CACHE = fit_base.CACHE
GRIDS = {  # name: (voxel size, bbox lo, bbox hi, narrow band half width in meters)
    "body": (0.0015, (-0.16, -0.32, -0.02), (0.20, 0.32, 1.34), 0.030),
    "head": (0.0006, (-0.07, -0.095, 1.06), (0.14, 0.095, 1.335), 0.020),
}


def ensure(log=print):
    """Download, extract and fit the base mesh if the cache is missing or stale."""
    raw = CACHE / "hbm_female.npz"
    if not raw.exists():
        import fetch_base
        fetch_base.fetch()
        fetch_base.extract()
    fitted = CACHE / "base_fitted.npz"
    if not fitted.exists() or fitted.stat().st_mtime < max(raw.stat().st_mtime, (fit_base.HERE / "fit_base.py").stat().st_mtime):
        fit_base.fit(log=log)
        for name in GRIDS:
            (CACHE / f"grid_{name}.npy").unlink(missing_ok=True)
    return fitted


class Grid:
    def __init__(self, name, verts, tris, log=print):
        h, lo, hi, band = GRIDS[name]
        self.h = h
        self.i0 = np.floor(np.asarray(lo) / h).astype(int)
        path = CACHE / f"grid_{name}.npy"
        if path.exists():
            self.a = np.load(path, mmap_mode="r")
        else:
            import openvdb as vdb
            log(f"  base body: level set '{name}' at {h * 1000:.1f} mm")
            xf = vdb.createLinearTransform(voxelSize=h)
            g = vdb.FloatGrid.createLevelSetFromPolygons(np.asarray(verts, np.float32), triangles=np.asarray(tris, np.int32),
                                                        transform=xf, halfWidth=band / h)
            shape = tuple(np.ceil((np.asarray(hi) - np.asarray(lo)) / h).astype(int) + 2)
            a = np.zeros(shape, np.float32)
            g.copyToArray(a, ijk=tuple(int(v) for v in self.i0))
            np.save(path, a.astype(np.float16))
            self.a = np.load(path, mmap_mode="r")
        self.shape = np.array(self.a.shape)
        self.lo = (self.i0 * h).astype(F)
        self.hi = ((self.i0 + self.shape - 1) * h).astype(F)
        self.band = band

    def inside(self, P):
        return np.all((P >= self.lo + self.h) & (P <= self.hi - self.h), axis=1)

    def sample(self, P):
        g = P / self.h - self.i0
        gi = np.clip(np.floor(g).astype(np.int64), 0, self.shape - 2)
        f = (g - gi).astype(F)
        a = self.a
        out = np.zeros(len(P), F)
        for dx in (0, 1):
            wx = f[:, 0] if dx else 1 - f[:, 0]
            for dy in (0, 1):
                wy = f[:, 1] if dy else 1 - f[:, 1]
                for dz in (0, 1):
                    wz = f[:, 2] if dz else 1 - f[:, 2]
                    out += wx * wy * wz * a[gi[:, 0] + dx, gi[:, 1] + dy, gi[:, 2] + dz].astype(F)
        return out


class BaseBody:
    def __init__(self, log=print):
        d = np.load(ensure(log))
        self.verts, self.tris = d["verts"], d["tris"]
        self.T = {k[2:]: d[k] for k in d.files if k.startswith("T_")}
        self.eyes = {1: d["eyeL"], -1: d["eyeR"]}
        self.facesets = d["facesets"]
        # mouth line: front edge of the mouth-interior face sets (7 upper, 8 lower in the bundle's sculpt)
        c = self.verts[self.tris].mean(1)
        m = np.isin(self.facesets, (7, 8))
        if m.any():
            cm = c[m]
            front = cm[cm[:, 0] > cm[:, 0].max() - 0.004]
            self.mouth_c = front.mean(0) + V(0.001, 0, 0)
            self.mouth_w = float(np.abs(cm[:, 1]).max()) * 0.95
        else:
            self.mouth_c, self.mouth_w = V(0.086, 0, 1.177), 0.020
        self.arm_caps = None      # {side: (shoulder, elbow, r0, r1)} set by the outfit (armhole capsules)
        self.body = Grid("body", self.verts, self.tris, log)
        self.head = Grid("head", self.verts, self.tris, log)

    def eval(self, P):
        d = np.full(len(P), self.body.band, F)
        ib = self.body.inside(P)
        if ib.any():
            d[ib] = self.body.sample(P[ib])
        ih = self.head.inside(P)
        if ih.any():
            d[ih] = self.head.sample(P[ih])
        out = ~ib
        if out.any():   # outside both grids: at least the distance to the grid box
            d[out] = np.maximum(sdf.box_dist(P[out], self.body.lo, self.body.hi), self.body.band)
        return d

    def eye(self, s):
        e = self.eyes[s]
        c = e.mean(0)
        return c, float(np.linalg.norm(e - c, axis=1).mean())

    def labels(self, P, P_):
        """Body-part label per point from the fitted joint chains (normalized distance to each limb axis)."""
        T = self.T
        chains = {
            P_["spine"]: ([T["pelvis"] - V(0, 0, 0.06), T["waist"], T["chest"], T["neck"], T["top"]], 0.13),
            P_["l_arm"]: ([T["l_shoulder"], T["l_elbow"], T["l_wrist"], T["l_hand"]], 0.050),
            P_["r_arm"]: ([T["r_shoulder"], T["r_elbow"], T["r_wrist"], T["r_hand"]], 0.050),
            P_["l_leg"]: ([T["l_hip"], T["l_knee"], T["l_ankle"], T["l_toe"]], 0.075),
            P_["r_leg"]: ([T["r_hip"], T["r_knee"], T["r_ankle"], T["r_toe"]], 0.075),
        }
        best = np.full(len(P), np.inf)
        lab = np.zeros(len(P), np.int16)
        for part, (pts, r) in chains.items():
            dmin = np.full(len(P), np.inf)
            for a, b in zip(pts[:-1], pts[1:]):
                ab = b - a
                t = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
                dmin = np.minimum(dmin, np.linalg.norm(P - (a + t[:, None] * ab), axis=1))
            dn = dmin / r
            better = dn < best
            best[better] = dn[better]
            lab[better] = part
        if self.arm_caps is not None:
            # upper arms: exactly the capsules that cut the armholes (elf_outfit.body), so the torso/arm border
            # (and the skinning seam) sits in the armpit crease and the tunic edge stays on the torso
            for s, part in ((1, P_["l_arm"]), (-1, P_["r_arm"])):
                sh, el, r0, r1 = self.arm_caps[s]
                ab = el - sh
                t = np.clip(((P - sh) @ ab) / (ab @ ab), 0, 1)
                d = np.linalg.norm(P - (sh + t[:, None] * ab), axis=1) - (r0 + (r1 - r0) * t)
                upper = (P[:, 2] > 0.86) & (np.isin(lab, (P_["spine"], part)))
                lab[upper & (d < 0) & (lab == P_["spine"])] = part
                medial = s * P[:, 1] < s * sh[1]          # chest/back side of the shoulder line (not the deltoid)
                lab[upper & (d >= 0) & (lab == part) & medial & (((P - el) @ ab) < 0)] = P_["spine"]
        return lab

    def node(self, mat, P_):
        lo = np.minimum(self.body.lo, self.head.lo)
        hi = np.maximum(self.body.hi, self.head.hi)
        base = self

        class _Node(sdf.Prim):
            def tags(self, P, band):
                return base.eval(P), np.full(len(P), mat, np.int16), base.labels(P, P_)

        return _Node(lambda P: base.eval(P), lo, hi, mat=mat)
