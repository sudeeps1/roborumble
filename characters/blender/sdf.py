# Tiny signed-distance modeling kit (numpy) plus a sparse OpenVDB mesher.
# Shapes are nodes; every node has a bounding box so unions can skip children that are far away.
# Each primitive carries a material id and a body-part id; unions report the closest child's tags.
import numpy as np

try:
    import openvdb as vdb
except ImportError:  # outside Blender
    vdb = None

F = np.float32
BIG = F(1e3)


def V(*a):
    return np.array(a, dtype=np.float64)


def norm(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def frame(x=None, z=None):
    """Rotation matrix whose columns are a right-handed basis built from a forward (x) and up (z) hint."""
    x = norm(x if x is not None else (1, 0, 0))
    z = np.asarray(z if z is not None else (0, 0, 1), float)
    y = norm(np.cross(z, x))
    z = np.cross(x, y)
    return np.stack([x, y, z], axis=1)


def rot(axis, deg):
    axis = norm(axis)
    a = np.radians(deg)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(a) * K + (1 - np.cos(a)) * K @ K


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def box_dist(P, lo, hi):
    q = np.maximum(np.maximum(lo - P, P - hi), 0)
    return np.sqrt((q * q).sum(1)).astype(F)


# ---------------------------------------------------------------- noise

def _hash(ix, iy, iz):
    h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)
    h = (h ^ (h >> 13)) * 1274126177
    return ((h ^ (h >> 16)) & 0xFFFF).astype(F) / F(65535)


def vnoise(P, freq):
    """Value noise in [-1, 1]."""
    Q = P * freq
    i = np.floor(Q).astype(np.int64)
    f = (Q - i).astype(F)
    u = f * f * (3 - 2 * f)
    out = np.zeros(len(P), F)
    for dx in (0, 1):
        wx = u[:, 0] if dx else 1 - u[:, 0]
        for dy in (0, 1):
            wy = u[:, 1] if dy else 1 - u[:, 1]
            for dz in (0, 1):
                wz = u[:, 2] if dz else 1 - u[:, 2]
                out += wx * wy * wz * _hash(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz)
    return out * 2 - 1


def fbm(P, freq, octaves=3):
    out = np.zeros(len(P), F)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        out += F(amp) * vnoise(P + o * 17.3, freq * 2 ** o)
        tot += amp
        amp *= 0.5
    return out / F(tot)


# ---------------------------------------------------------------- nodes

class Node:
    lo: np.ndarray
    hi: np.ndarray

    def eval(self, P, band):
        raise NotImplementedError

    def tags(self, P, band):
        """-> (d, mat, part)"""
        raise NotImplementedError


class Prim(Node):
    def __init__(self, fn, lo, hi, mat=0, part=0):
        self.fn, self.lo, self.hi, self.mat, self.part = fn, np.asarray(lo, F), np.asarray(hi, F), mat, part

    def eval(self, P, band):
        return self.fn(P).astype(F)

    def tags(self, P, band):
        d = self.eval(P, band)
        return d, np.full(len(P), self.mat, np.int16), np.full(len(P), self.part, np.int16)


def _local(P, c, R):
    q = P - c
    return q @ R if R is not None else q


def sphere(c, r, **kw):
    c = V(*c)
    return Prim(lambda P: np.sqrt(((P - c) ** 2).sum(1)) - r, c - r, c + r, **kw)


def ell(q, rr):
    """Ellipsoid distance (iq's approximation outside; inside it is clamped so it never claims to be
    deeper than it is, which would make the sparse mesher skip surface blocks)."""
    k0 = np.sqrt(((q / rr) ** 2).sum(1))
    k1 = np.sqrt(((q / (rr * rr)) ** 2).sum(1))
    d = k0 * (k0 - 1) / np.maximum(k1, 1e-9)
    return np.where(k0 < 1, np.maximum(d, -(1 - k0) * rr.min()), d)


def ellipsoid(c, radii, R=None, **kw):
    c, rr = V(*c), V(*radii)
    m = rr.max()
    return Prim(lambda P: ell(_local(P, c, R), rr), c - m, c + m, **kw)


def round_cone(a, b, r1, r2, **kw):
    """Capsule with different end radii (iq's exact rounded cone)."""
    a, b = V(*a), V(*b)
    ba = b - a
    l2 = ba @ ba
    rr = r1 - r2
    a2 = l2 - rr * rr
    il2 = 1.0 / l2

    def fn(P):
        pa = P - a
        y = pa @ ba
        z = y - l2
        w = pa * l2 - y[:, None] * ba
        x2 = (w * w).sum(1)
        y2 = y * y * l2
        z2 = z * z * l2
        k = np.sign(rr) * rr * rr * x2
        d = (np.sqrt(np.maximum(x2 * a2 * il2, 0)) + y * rr) * il2 - r1
        c1 = np.sign(y) * a2 * y2 < k
        d = np.where(c1, np.sqrt(x2 + y2) * il2 - r1, d)
        c2 = np.sign(z) * a2 * z2 > k
        d = np.where(c2, np.sqrt(x2 + z2) * il2 - r2, d)
        return d

    m = max(r1, r2)
    return Prim(fn, np.minimum(a, b) - m, np.maximum(a, b) + m, **kw)


def capsule(a, b, r, **kw):
    return round_cone(a, b, r, r, **kw)


def rbox(c, half, R=None, r=0.0, **kw):
    c, hb = V(*c), V(*half)

    def fn(P):
        q = np.abs(_local(P, c, R)) - (hb - r)
        out = np.sqrt((np.maximum(q, 0) ** 2).sum(1))
        return out + np.minimum(q.max(1), 0) - r

    m = np.linalg.norm(hb)
    return Prim(fn, c - m, c + m, **kw)


def custom(fn, lo, hi, **kw):
    return Prim(fn, lo, hi, **kw)


def chain(points, radii, k=0.0, **kw):
    """Smooth tube through points (round cones between consecutive points)."""
    segs = [round_cone(points[i], points[i + 1], radii[i], radii[i + 1], **kw) for i in range(len(points) - 1)]
    return union(*segs, k=k) if len(segs) > 1 else segs[0]


def bezier(p0, p1, p2, p3, n=10):
    t = np.linspace(0, 1, n)[:, None]
    p0, p1, p2, p3 = (V(*p) for p in (p0, p1, p2, p3))
    return list((1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3)


class Union(Node):
    def __init__(self, children, k=0.0):
        self.ch, self.k = [c for c in children if c is not None], k
        # a smooth union bulges up to k/4 past its children
        self.lo = (np.min([c.lo for c in self.ch], 0) - k / 4).astype(F)
        self.hi = (np.max([c.hi for c in self.ch], 0) + k / 4).astype(F)

    def _parts(self, P, band, want_tags):
        # children feed a blend of width k, so they must be exact out to band + k (and are culled beyond it)
        band = band + self.k
        margin = band
        d = np.full(len(P), BIG, F)
        mat = np.zeros(len(P), np.int16) if want_tags else None
        part = np.zeros(len(P), np.int16) if want_tags else None
        best = np.full(len(P), BIG, F) if want_tags else None
        for c in self.ch:
            bd = box_dist(P, c.lo, c.hi)
            m = bd < margin
            dc = bd
            if m.any():
                dc = bd.copy()
                if want_tags:
                    dd, mm, pp = c.tags(P[m], band)
                    dc[m] = dd
                    closer = np.zeros(len(P), bool)
                    closer[m] = dd < best[m]
                    best[closer] = dc[closer]
                    sub = closer[m]
                    mat[closer] = mm[sub]
                    part[closer] = pp[sub]
                else:
                    dc[m] = c.eval(P[m], band)
            d = smin(d, dc, self.k)
        return d, mat, part

    def eval(self, P, band):
        return self._parts(P, band, False)[0]

    def tags(self, P, band):
        return self._parts(P, band, True)


def union(*ch, k=0.0):
    return Union(ch, k)


class Sub(Node):
    """a minus b (smoothly). The carved surface keeps a's tags unless cut_mat is given."""

    def __init__(self, a, b, k=0.0, cut_mat=None):
        self.a, self.b, self.k, self.cut_mat = a, b, k, cut_mat
        self.lo, self.hi = a.lo, a.hi

    def _b(self, P, band):
        band = band + self.k
        bd = box_dist(P, self.b.lo, self.b.hi)
        m = bd < band
        db = bd.copy()
        if m.any():
            db[m] = self.b.eval(P[m], band)
        return db

    def eval(self, P, band):
        return smax(self.a.eval(P, band + self.k), -self._b(P, band), self.k)

    def tags(self, P, band):
        da, mat, part = self.a.tags(P, band + self.k)
        db = self._b(P, band)
        d = smax(da, -db, self.k)
        if self.cut_mat is not None:
            mat = np.where(-db > da, self.cut_mat, mat).astype(np.int16)
        return d, mat, part


class Inter(Node):
    def __init__(self, a, b, k=0.0):
        self.a, self.b, self.k = a, b, k
        self.lo, self.hi = np.maximum(a.lo, b.lo), np.minimum(a.hi, b.hi)

    def eval(self, P, band):
        return smax(self.a.eval(P, band + self.k), self.b.eval(P, band + self.k), self.k)

    def tags(self, P, band):
        da, mat, part = self.a.tags(P, band + self.k)
        return smax(da, self.b.eval(P, band + self.k), self.k), mat, part


class Map(Node):
    """Wraps a child with a distance tweak f(P, d) -> d (offsets, displacement) and an optional
    material repaint paint(P, mat) -> mat. `grow` widens the bounds by the largest outward offset."""

    def __init__(self, child, f=None, paint=None, grow=0.0):
        self.c, self.f, self.paint, self.grow = child, f, paint, grow
        self.lo, self.hi = child.lo - grow, child.hi + grow

    def eval(self, P, band):
        d = self.c.eval(P, band + self.grow)
        return self.f(P, d).astype(F) if self.f else d

    def tags(self, P, band):
        d, mat, part = self.c.tags(P, band + self.grow)
        if self.f:
            d = self.f(P, d).astype(F)
        if self.paint:
            mat = self.paint(P, mat).astype(np.int16)
        return d, mat, part


class Retag(Node):
    def __init__(self, child, mat=None, part=None):
        self.c, self.mat, self.part = child, mat, part
        self.lo, self.hi = child.lo, child.hi

    def eval(self, P, band):
        return self.c.eval(P, band)

    def tags(self, P, band):
        d, mat, part = self.c.tags(P, band)
        if self.mat is not None:
            mat = np.full(len(P), self.mat, np.int16)
        if self.part is not None:
            part = np.full(len(P), self.part, np.int16)
        return d, mat, part


def mirror_y(fn_builder):
    """Calls fn_builder(s) for s=+1 (left) and s=-1 (right)."""
    return [fn_builder(1), fn_builder(-1)]


# ---------------------------------------------------------------- mesher

def mesh(node, h, lo=None, hi=None, block=8, adaptivity=0.0, batch=1_500_000, log=print):
    """Narrow-band sample `node` on a sparse grid of voxel size h and polygonize the zero set.
    Returns (verts (N,3) float64, faces list of index tuples)."""
    lo = np.asarray(node.lo if lo is None else lo, float) - 2 * h
    hi = np.asarray(node.hi if hi is None else hi, float) + 2 * h
    # blocks line up with OpenVDB's 8^3 leaf nodes, so no leaf is ever half filled
    i0 = (np.floor(lo / h / block) * block).astype(int)
    i1 = np.ceil(hi / h).astype(int)
    nb = np.ceil((i1 - i0) / block).astype(int)
    bi = np.stack(np.meshgrid(*[np.arange(n) for n in nb], indexing="ij"), -1).reshape(-1, 3)
    borg = i0 + bi * block                       # block origin (voxel index)
    centers = (borg + (block - 1) / 2) * h
    half = np.sqrt(3) * block * h / 2
    band = 3 * h
    thr = half * 2.2 + band
    dc = node.eval(centers.astype(F), thr)
    act = borg[np.abs(dc) < thr]
    log(f"  grid {nb.tolist()} blocks, {len(act)} active ({len(act) * block ** 3 / 1e6:.1f}M voxels)")

    grid = vdb.FloatGrid(float(band))
    grid.transform = vdb.createLinearTransform(voxelSize=float(h))
    grid.gridClass = vdb.GridClass.LEVEL_SET
    off = np.stack(np.meshgrid(*[np.arange(block)] * 3, indexing="ij"), -1).reshape(-1, 3)
    per = max(1, batch // block ** 3)
    for s in range(0, len(act), per):
        orgs = act[s:s + per]
        idx = (orgs[:, None, :] + off[None]).reshape(-1, 3)
        d = node.eval((idx * h).astype(F), band)
        d = np.clip(d, -band, band).astype(np.float32).reshape(len(orgs), block, block, block)
        for o, arr in zip(orgs, d):
            grid.copyFromArray(arr, tuple(int(v) for v in o), 0.0)
    grid.signedFloodFill()
    pts, tris, quads = grid.convertToPolygons(0.0, adaptivity)
    faces = [tuple(t) for t in tris.tolist()] + [tuple(q) for q in quads.tolist()]
    log(f"  mesh {len(pts)} verts, {len(faces)} faces")
    return np.asarray(pts, float), faces
