# Elf hair: sleek swept-back cap whose clumped grooves converge on a high ponytail tie, two face-framing bangs,
# flat ribbon side locks, gold circlet, leaf tie cuff, and the ponytail piece.
# Mixed into Elf (elf.py); uses self.H, self.head_c, self.surf, self.face_node from the head mixin.
# Strands are "sweeps": one smooth SDF along a dense centerline with a lens (ribbon) or ellipse cross-section,
# so there are no per-segment bumps.
import numpy as np

import sdf
from sdf import V, F, norm, frame, rot, union, sphere, ellipsoid, round_cone, capsule, rbox, custom, chain, bezier, \
    Sub, Inter, Map, Retag, smin, smax, fbm, vnoise
from elf_common import M, P_, lerp

# The solid hair is the dark underlayer that hair_cards.py lays strand cards on (0.5-3 mm above it), so it is
# a little slimmer and smoother than a stand-alone sculpt would be: thickness scale (ribbons), groove scale,
# and how much thinner the cap and ponytail are.
UNDER_T = 0.8
UNDER_G = 0.5            # fine groove scale on ribbons (strand detail comes from the cards)
CAP_LOCKS = 1.0          # lock-sized cap grooves (the cards follow them), capped at CAP_LOCK_MAX of the cap thickness
CAP_LOCK_MAX = 0.6
PONY_GROOVE = 1.0        # ponytail clump grooves
UNDER_PONY = 0.92        # ponytail cross-section scale
CIRCLET_OVER_HAIR = 0.0032   # extra lift of the circlet band where it crosses hair, so it sits on top of the cards


# ---------------------------------------------------------------- small helpers

def _ss(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def _hash1(i):
    """Integer -> pseudo random in [0, 1]."""
    i = np.asarray(i).astype(np.int64)
    h = (i * 374761393 + 668265263) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF).astype(np.float64) / 65535.0


def _clumps(c, seed=0, period=None, lo=0.5):
    """Clumped-strand groove profile over a continuous cell coordinate c: 0 on the clump crests, up to 1 in the
    V-grooves between clumps; every groove gets its own depth. Max slope ~5.8 per cell."""
    i = np.floor(c)
    f = c - i
    i0, i1 = i, i + 1
    if period:
        i0, i1 = np.mod(i0, period), np.mod(i1, period)
    g0 = lo + (1 - lo) * _hash1(i0 + seed * 7919)
    g1 = lo + (1 - lo) * _hash1(i1 + seed * 7919)
    e = (2 * f - 1) ** 2
    e = 0.55 * e + 0.45 * e * e
    return e * (g0 * (1 - f) + g1 * f)


def _shingles(c, seed=0, ws=0.24, lo=0.55):
    """Overlapping-clump profile over a cell coordinate c: each clump rises slowly across its cell and drops
    steeply at its trailing edge onto the next one, like layered locks. Returns carve depth in [0, 1]
    (0 on a clump's raised edge). Max slope ~1.5 / ws per cell."""
    i = np.floor(c)
    f = c - i
    amp = lo + (1 - lo) * _hash1(i + seed * 7919)
    h = amp * _ss(0, 1 - ws, f) * (1 - _ss(1 - ws, 1, f))
    return 1 - h


def _prof(t, ks, vs, sigma=0.04):
    """Smooth 1D profile through knots (ks, vs), evaluated at t in [0, 1]."""
    g = np.linspace(0, 1, 401)
    y = np.interp(g, ks, vs)
    k = int(3 * sigma / (g[1] - g[0]))
    yp = np.concatenate([np.full(k, y[0]), y, np.full(k, y[-1])])
    w = np.exp(-0.5 * (np.arange(-k, k + 1) * (g[1] - g[0]) / sigma) ** 2)
    y = np.convolve(yp, w / w.sum(), mode="valid")
    return np.interp(t, g, y)


def _smooth_table(xs, ys, sigma=4.0, lo=0.0, hi=180.0):
    """Dense table (x, y, dy/dx) of a piecewise-linear curve blurred by a Gaussian; mirrored at both ends."""
    g = np.arange(lo, hi + 0.5, 1.0)
    y = np.interp(g, xs, ys)
    k = int(3 * sigma)
    yp = np.concatenate([y[k:0:-1], y, y[-2:-k - 2:-1]])
    w = np.exp(-0.5 * (np.arange(-k, k + 1) / sigma) ** 2)
    y = np.convolve(yp, w / w.sum(), mode="valid")
    return g, y, np.gradient(y, g)


def _lens2(u, v, a, b, rr):
    """Exact 2D distance to a lens (vesica) with half length a along u and half thickness b along v,
    edges rounded by rr. A lens with b == a is a circle."""
    rr = np.minimum(rr, 0.8 * b)
    A = np.maximum(a - rr, 1e-5)
    Tk = np.clip(b - rr, 1e-5, A)
    r = (A * A / Tk + Tk) * 0.5
    dd = r - Tk
    px, py = np.abs(v), np.abs(u)
    tip = (py - A) * dd > px * A
    d = np.where(tip, np.sqrt(px * px + (py - A) ** 2), np.sqrt((px + dd) ** 2 + py * py) - r)
    return d - rr


def _ell2(u, v, a, b):
    """2D ellipse distance (iq's approximation, fine for mild aspect ratios)."""
    k0 = np.sqrt((u / a) ** 2 + (v / b) ** 2)
    k1 = np.sqrt((u / (a * a)) ** 2 + (v / (b * b)) ** 2)
    d = k0 * (k0 - 1) / np.maximum(k1, 1e-12)
    d = np.where(k1 < 1e-9, -np.minimum(a, b), d)
    return np.where(k0 < 1, np.maximum(d, -(1 - k0) * np.minimum(a, b)), d)


class HairMixin:
    # hairline: elevation (deg, seen from the head center) vs |azimuth| (deg, 0 = straight ahead)
    HAIRLINE = ([0, 14, 28, 40, 52, 62, 70, 77, 84, 92, 102, 112, 124, 136, 150, 165, 180],
                [34, 33.5, 31.5, 28, 22, 14, 6, -2, -5, 0, 10, 14, 2, -14, -29, -38, -42])

    # ------------------------------------------------------------ head-rigid hair
    def hair(self):
        """Sleek swept-back cap whose clumped grooves converge on a high ponytail tie, two face-framing bangs
        and flat ribbon side locks. Rigid on the head. Returns (hair node, gold tie cuff node)."""
        hp = dict(mat=M["hair"], part=P_["spine"])
        td = norm(V(-np.cos(np.radians(50)), 0, np.sin(np.radians(50))))
        tie = self.surf(self.face_node, 180, 50, 0.019)    # stands ~2 cm off the skull, high on the crown
        self.tie, self.tie_dir = tie, td
        cap = self._cap(tie, td, hp)
        self._cap_node = cap
        skull = union(self.face_node, cap)
        strands = []
        for s in (1, -1):
            strands += self._bangs(skull, s, hp)
            strands += self._side_lock(skull, s, hp)
        node = union(cap, *strands, k=0.0025)
        self._hair_node = node
        return node, self._cuff(tie, td)

    def _cap(self, tie, td, hp):
        hc, face = self.head_c, self.face_node
        g_az, g_el, g_der = _smooth_table(*self.HAIRLINE, sigma=4.0)
        fwd = norm(np.cross(V(0, 1, 0), td))           # across the tie axis, toward the forehead
        mound = round_cone(tie - td * 0.036, tie - td * 0.004, 0.024, 0.0135)
        ears = []
        for s in (1, -1):
            root = self.H(-0.015, s * 0.062, -0.002)
            u = norm(V(-0.44, s * 0.66, 0.60))
            ears.append(capsule(root - u * 0.004, root + u * 0.03, 0.0125))
        ears = union(*ears)
        NC = 22   # big clumps around the tie (11 per side)

        def fn(P):
            P = P.astype(np.float64)
            q = P - hc
            r = np.sqrt((q * q).sum(1)) + 1e-9
            up, back = q[:, 2] / r, -q[:, 0] / r
            el = np.degrees(np.arcsin(np.clip(up, -1, 1)))
            az = np.degrees(np.arctan2(np.abs(q[:, 1]), q[:, 0]))
            # clump cells around the tie axis (mirrored angle: locks overlap outward from the middle, symmetric)
            g = P - tie
            gl = g - np.outer(g @ td, td)
            rp = np.sqrt((gl * gl).sum(1)) + 1e-9
            ang = np.abs(np.arctan2(gl[:, 1], gl @ fwd))
            c = ang * (NC / (2 * np.pi)) + 0.25 * np.sin(ang * 3 + 1.3) + 0.12 * np.sin(ang * 7 + 0.4) \
                + 0.22 * vnoise(P, 12) + 0.5
            # hairline; behind the ears every lock ends in a rounded tongue instead of one smooth hood edge
            f = c - np.floor(c)
            el_h = np.interp(az, g_az, g_el) - 4.0 * _ss(105, 135, az) * 4 * f * (1 - f)
            sl = np.interp(az, g_az, g_der) / np.maximum(np.cos(np.radians(el)), 0.3)
            cut = np.radians(el_h - el) * r / np.sqrt(1 + sl * sl) / 1.3           # > 0 below the hairline
            inner = _ss(0.0, 0.015, -cut)
            # hugs the skull: thin at the temples/nape, a little volume on the crown and toward the tie
            # (the strand cards on top add another 1-3 mm)
            t = 0.0024 + 0.0034 * _ss(0.15, 0.95, up) + 0.0014 * _ss(-0.1, 0.7, back) * _ss(-0.2, 0.5, up)
            t = t * (0.64 + 0.36 * inner)
            d = face.eval(P.astype(F), 0.06) - t
            d = smin(d, mound.eval(P, 0.06), 0.014)
            d = smax(d, cut, 0.003)
            d = smax(d, -ears.eval(P.astype(F), 0.06), 0.006)
            # layered clumps plus finer strand grooves, all running into the tie
            k = 2 * np.pi * rp / NC                          # cell width (m)
            a1 = np.minimum(0.0028, 0.62 * k / 6.3) * (0.75 + 0.25 * vnoise(P + 3.1, 18))
            a1 = np.minimum(CAP_LOCKS * a1, CAP_LOCK_MAX * t)
            a2 = np.minimum(0.0005, 0.3 * k / 3 / 5.8)
            gro = a1 * _shingles(c, 1) + 0.0 * a2 * _clumps(c * 3 + 0.3, 2)   # fine detail: cards
            return d + gro * (1 - _ss(-0.004, 0.004, cut))

        return custom(fn, hc + V(-0.135, -0.10, -0.115), hc + V(0.115, 0.10, 0.14), **hp)

    def _bangs(self, skull, s, hp):
        """Two face-framing strands per side: a long one sweeping from near the center of the hairline over the
        forehead corner and down past the temple to the cheekbone, and a short one layered behind it.
        Beside the face the ribbons turn to face forward-out so they read from the front."""
        hc = self.head_c
        side = norm(V(0.72, s * 0.69, 0.0))

        def normals(pts):
            out = []
            for p in pts:
                w = _ss(0.03, -0.01, (p - hc)[2])
                out.append(norm(norm(p - hc) * (1 - w) + side * w))
            return out

        out = []
        spec = [(3, 47, -0.0012), (11, 41, 0.0022), (21, 35, 0.0040), (32, 29.5, 0.0052), (43, 23, 0.0060),
                (51, 14, 0.0070), (56, 4, 0.0084), (59, -5, 0.0108), (61, -13, 0.0142), (62.5, -19, 0.0180)]
        pts = self._resample([self.surf(skull, s * az, el, off) for az, el, off in spec], 48)
        ts = np.linspace(0, 1, len(pts))
        hw = _prof(ts, [0, .12, .3, .5, .7, .88, 1], [.0040, .0078, .0102, .0098, .0078, .0046, .0008])
        ht = _prof(ts, [0, .3, .7, 1], [.0022, .0032, .0026, .0008])
        out.append(self._sweep(pts, hw, ht * UNDER_T, normals(pts), hp, groove=self._ribbon_groove(3, 0.0005 * UNDER_G, 3),
                               tag=("bang", s, 0)))
        spec = [(16, 42, -0.0010), (26, 35.5, 0.0032), (36, 30, 0.0044), (45, 23.5, 0.0052), (51, 16, 0.0060)]
        pts = self._resample([self.surf(skull, s * az, el, off) for az, el, off in spec], 24)
        ts = np.linspace(0, 1, len(pts))
        hw = _prof(ts, [0, .25, .6, 1], [.0036, .0068, .0058, .0008])
        ht = _prof(ts, [0, .5, 1], [.0019, .0024, .0008])
        out.append(self._sweep(pts, hw, ht * UNDER_T, normals(pts), hp, groove=self._ribbon_groove(2, 0.00045 * UNDER_G, 7),
                               tag=("bang", s, 1)))
        return out

    def _side_lock(self, skull, s, hp):
        """Flat ribbon lock from above the temple, down in front of the ear to the collarbone, turning to face
        forward as it lies over the chest; a narrower strand layered over its front edge."""
        H, hc = self.H, self.head_c
        top = [self.surf(skull, s * az, el, off) for az, el, off in [(92, 30, -0.0030), (85, 17, 0.0020), (80, 5, 0.0045)]]
        hang = [H(0.025, s * 0.081, -0.040), H(0.029, s * 0.086, -0.090), H(0.038, s * 0.088, -0.135),
                H(0.054, s * 0.091, -0.176), H(0.069, s * 0.087, -0.205)]
        pts = self._resample(top + hang, 60)
        ts = np.linspace(0, 1, len(pts))
        hw = _prof(ts, [0, .1, .3, .5, .7, .86, 1], [.0060, .0090, .0112, .0115, .0098, .0062, .0009])
        ht = _prof(ts, [0, .3, .7, 1], [.0024, .0030, .0024, .0008])
        n_mid, n_bot = norm(V(0.62, s * 0.78, 0.0)), norm(V(0.85, s * 0.53, 0.0))
        nrm = []
        for p in pts:
            z = (p - hc)[2]
            w0, w1 = _ss(0.02, -0.03, z), _ss(-0.05, -0.20, z)
            nrm.append(norm(norm(norm(p - hc) * (1 - w0) + n_mid * w0) * (1 - w1) + n_bot * w1))
        out = [self._sweep(pts, hw, ht * UNDER_T, nrm, hp, groove=self._ribbon_groove(3, 0.0006 * UNDER_G, 11 + s),
                           tag=("lock", s, 0))]
        _, N, Wd = self._frames(pts, nrm)
        Wf = Wd * np.sign(Wd[:, :1])
        k = int(len(pts) * 0.64)
        fl = _ss(0.6, 1.0, np.linspace(0, 1, k))[:, None]
        p2 = pts[:k] + N[:k] * 0.0026 + Wf[:k] * hw[:k, None] * 0.5 + V(0.003, s * 0.002, 0.0) * fl
        t2 = np.linspace(0, 1, k)
        hw2 = _prof(t2, [0, .2, .55, 1], [.0038, .0062, .0056, .0008])
        ht2 = _prof(t2, [0, .5, 1], [.0018, .0022, .0007])
        out.append(self._sweep(p2, hw2, ht2 * UNDER_T, nrm[:k], hp, groove=self._ribbon_groove(2, 0.0004 * UNDER_G, 17 + s),
                               tag=("lock", s, 1)))
        return out

    # ------------------------------------------------------------ strand machinery
    @staticmethod
    def _ribbon_groove(n, depth, seed=0):
        """Grooves along a ribbon splitting it into n strands (fade in at the root, out at the tip)."""
        def g(u, v, a, b, s):
            c = (u / np.maximum(a, 1e-4) + 1) * 0.5 * n + 0.18 * np.sin(s * 6 + seed)
            fade = _ss(0.0, 0.12, s) * (1 - _ss(0.8, 1.0, s))
            return depth * fade * _clumps(c, seed) * np.minimum(1, a / 0.004)
        return g

    @staticmethod
    def _resample(pts, n):
        """Catmull-Rom through pts, sampled evenly by arc length."""
        pts = np.asarray(pts, float)
        seg = np.cumsum([0] + [np.linalg.norm(pts[i + 1] - pts[i]) for i in range(len(pts) - 1)])
        out = []
        for m in np.linspace(0, seg[-1], n):
            i = max(min(np.searchsorted(seg, m) - 1, len(pts) - 2), 0)
            t = (m - seg[i]) / max(seg[i + 1] - seg[i], 1e-9)
            p0, p1, p2, p3 = pts[max(i - 1, 0)], pts[i], pts[i + 1], pts[min(i + 2, len(pts) - 1)]
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
        return np.asarray(out)

    @staticmethod
    def _frames(pts, nrm):
        """Per-point unit tangent T, thickness direction N (nrm made perpendicular to T), width direction W."""
        pts = np.asarray(pts, float)
        D = pts[1:] - pts[:-1]
        D /= np.linalg.norm(D, axis=1)[:, None]
        T = np.vstack([D[:1], D[:-1] + D[1:], D[-1:]])
        T /= np.linalg.norm(T, axis=1)[:, None]
        N = np.asarray(nrm, float)
        if N.ndim == 1:
            N = np.tile(N, (len(pts), 1))
        N = N - (N * T).sum(1)[:, None] * T
        N /= np.linalg.norm(N, axis=1)[:, None]
        return T, N, np.cross(N, T)

    def _sweep(self, pts, hw, ht, nrm, kw, shape="lens", rr=0.0006, groove=None, tag=None):
        """One smooth strand along pts: cross-section of half width hw (along W) and half thickness ht (along
        nrm), both per point. shape: "lens" (ribbon/clump with thin edges) or "ell" (ellipse).
        groove(u, v, a, b, s) -> extra distance (>= 0, carves in); s is the arc-length fraction.
        tag: if given, the sweep is recorded in self.sweeps so hair_cards.py can lay strand cards on it."""
        pts = np.asarray(pts, float)
        n = len(pts)
        hw = np.asarray(hw, float) * np.ones(n)
        ht = np.asarray(ht, float) * np.ones(n)
        if shape == "lens":
            ht = np.minimum(ht, hw)
        if tag is not None:
            if not hasattr(self, "sweeps"):
                self.sweeps = []
            self.sweeps.append(dict(tag=tag, pts=pts.copy(), hw=hw.copy(), ht=ht.copy(),
                                    nrm=np.asarray(nrm, float).copy(), shape=shape))
        _, Nn, _ = self._frames(pts, nrm)
        seg = pts[1:] - pts[:-1]
        L = np.linalg.norm(seg, axis=1)
        D = seg / L[:, None]
        S = np.concatenate([[0], np.cumsum(L)])
        S /= S[-1]
        R = max(hw.max(), ht.max()) + 0.003

        def fn(P):
            P = P.astype(np.float64)
            best = np.full(len(P), np.inf)
            bi = np.zeros(len(P), np.int64)
            bt = np.zeros(len(P))
            for i in range(n - 1):            # closest point on the centerline polyline
                Q = P - pts[i]
                al = Q @ D[i]
                t = np.clip(al / L[i], 0, 1)
                tl = t * L[i]
                r2 = np.einsum("ij,ij->i", Q, Q) - 2 * tl * al + tl * tl
                k = r2 < best
                best[k], bi[k], bt[k] = r2[k], i, t[k]
            i, t = bi, bt
            Di, Li = D[i], L[i]
            Q = P - pts[i]
            al = np.einsum("ij,ij->i", Q, Di)
            C = Q - (t * Li)[:, None] * Di
            Nt = (1 - t)[:, None] * Nn[i] + t[:, None] * Nn[i + 1]
            Nt -= np.einsum("ij,ij->i", Nt, Di)[:, None] * Di
            Nt /= np.linalg.norm(Nt, axis=1)[:, None]
            Wt = np.cross(Nt, Di)
            u = np.einsum("ij,ij->i", C, Wt)
            v = np.einsum("ij,ij->i", C, Nt)
            a = hw[i] + (hw[i + 1] - hw[i]) * t
            b = ht[i] + (ht[i + 1] - ht[i]) * t
            d2 = _lens2(u, v, a, b, rr) if shape == "lens" else _ell2(u, v, a, b)
            if groove is not None:
                d2 = d2 + groove(u, v, a, b, S[i] + (S[i + 1] - S[i]) * t)
            # cap the two real ends of the strand
            over = np.where(i == 0, np.maximum(-al, 0), 0) + np.where(i == n - 2, np.maximum(al - Li, 0), 0)
            return np.where(over > 0, np.where(d2 > 0, np.sqrt(d2 * d2 + over * over), np.maximum(d2, over)), d2)

        return custom(fn, pts.min(0) - R, pts.max(0) + R, **kw)

    def _leaf(self, base, tip, nrm, half_w, th, bend=0.0, **kw):
        """Thin leaf plate from base to tip (vesica outline), facing nrm, curled by `bend` (m at the ends)."""
        base, tip = V(*base), V(*tip)
        c = (base + tip) / 2
        ax = norm(tip - base)
        hl = np.linalg.norm(tip - base) / 2
        nz = norm(np.asarray(nrm, float) - (np.asarray(nrm, float) @ ax) * ax)
        Rl = np.stack([ax, np.cross(nz, ax), nz], 1)

        def fn(P):
            q = (P.astype(np.float64) - c) @ Rl
            w = q[:, 2] + bend * (q[:, 0] / hl) ** 2
            d2 = _lens2(q[:, 0], q[:, 1], hl, half_w, 0.0004)
            dz = np.abs(w) - th * 0.5
            return np.sqrt(np.maximum(d2, 0) ** 2 + np.maximum(dz, 0) ** 2) + np.minimum(np.maximum(d2, dz), 0) - 0.0003

        m = hl + abs(bend) + th + 0.002
        return custom(fn, c - m, c + m, **kw)

    def _cuff(self, tie, td):
        """Gold cuff around the ponytail root: a beaded band with leaves gripping the gathered hair."""
        g = dict(mat=M["gold"], part=P_["spine"])
        Rm = frame(np.cross(td, V(0, 1, 0)), td)      # columns: two radial axes, then the tie axis
        c = tie + td * 0.001
        R0, hl = 0.0158, 0.0066

        def fn(P):
            q = (P.astype(np.float64) - c) @ Rm
            rho = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2)
            a = q[:, 2]
            bx, by = rho - (R0 - 0.001), np.abs(a) - (hl - 0.001)
            body = np.sqrt(np.maximum(bx, 0) ** 2 + np.maximum(by, 0) ** 2) + np.minimum(np.maximum(bx, by), 0) - 0.001
            rims = np.sqrt((rho - R0) ** 2 + (np.abs(a) - (hl - 0.0011)) ** 2) - 0.0014
            bead = np.sqrt((rho - R0 - 0.0002) ** 2 + a ** 2) - 0.0011
            return smin(smin(body, rims, 0.0006), bead, 0.0005)

        m = R0 + 0.004
        cuff = custom(fn, c - V(m, m, m) - np.abs(td) * hl, c + V(m, m, m) + np.abs(td) * hl, **g)
        # a calyx of gold leaves cupping the ponytail where it leaves the cuff
        leaves = []
        for j in range(6):
            ph = 2 * np.pi * (j + 0.25) / 6
            rad = Rm[:, 0] * np.cos(ph) + Rm[:, 1] * np.sin(ph)
            base = c + rad * (R0 - 0.0022) + td * (hl - 0.004)
            tip = c + rad * (R0 - 0.0012) + td * (hl + 0.0175)
            leaves.append(self._leaf(base, tip, rad, 0.0056, 0.0012, 0.0010, **g))
        return union(cuff, *leaves, k=0.0008)

    # ------------------------------------------------------------ circlet
    def circlet(self, head_all):
        """Gold band all the way around the head (over the hair, under the ears and ponytail), with a leaf
        setting and gem on the brow."""
        H = self.H
        skull = union(self.face_node, self._cap_node)       # no ears (it passes under them), no loose strands
        simple = skull                                       # (bangs and side locks fall over it)
        n = norm(V(0.032, 0, 1))
        q0 = H(0.088, 0, 0.044)
        w = 0.0027
        g = dict(mat=M["gold"], part=P_["spine"])

        def band(P):
            dp = (P.astype(np.float64) - q0) @ n
            lift = 0.0013 + 0.0007 * np.clip(1 - (dp / w) ** 2, 0, 1)
            Pf = P.astype(F)
            hair_t = self.face_node.eval(Pf, 0.03) - self._cap_node.eval(Pf, 0.03)    # cap thickness here
            lift = lift + CIRCLET_OVER_HAIR * _ss(0.0012, 0.0035, hair_t)
            return smax(np.abs(dp) - w, skull.eval(Pf, 0.02) - lift, 0.0005)

        ring = custom(band, H(-0.13, -0.10, 0.030), H(0.12, 0.10, 0.064), **g)
        # front: where the band crosses the forehead
        lo_el, hi_el = 10.0, 45.0
        for _ in range(16):
            mid = (lo_el + hi_el) / 2
            if (self.surf(simple, 0, mid, 0) - q0) @ n > 0:
                hi_el = mid
            else:
                lo_el = mid
        el = (lo_el + hi_el) / 2
        top = self.surf(simple, 0, el, 0)
        fn_ = norm(V(np.cos(np.radians(el + 6)), 0, np.sin(np.radians(el + 6))))   # out of the forehead
        up = norm(np.cross(fn_, V(0, 1, 0)))
        self.circlet_setting = (top, up, fn_)
        # the center leaf reaches up over the hairline, so its tip rests on the strand cards
        setting = [self._leaf(top - up * 0.008 + fn_ * 0.0012, top + up * 0.022 + fn_ * (0.0004 + CIRCLET_OVER_HAIR),
                              fn_, 0.0074, 0.0018,
                              -0.0012, **g)]
        for s in (1, -1):
            tip = self.surf(simple, s * 17, el - 4, 0.0010)
            setting.append(self._leaf(top + fn_ * 0.0012 + V(0, s * 0.003, 0), tip, norm(tip - self.head_c) + fn_,
                                      0.0040, 0.0013, 0.0004, **g))
        gem = ellipsoid(top + fn_ * 0.0042 + up * 0.0045, (0.0030, 0.0056, 0.0090),
                        R=np.stack([fn_, np.cross(up, fn_), up], 1),
                        mat=M["gem"], part=P_["spine"])
        return union(head_all, ring, *setting, k=0.0), gem

    # ------------------------------------------------------------ ponytail (spring chain)
    def ponytail(self):
        """Sleek high ponytail: out of the cuff, over in a short arc, down the back to mid-back, tapering into a
        few separate clumps. Returns (node, centerline points from the tie to the tip)."""
        H = self.H
        t0, td = self.tie, self.tie_dir
        tl = t0 - self.head_c
        ctrl = [t0, t0 + td * 0.020, H(tl[0] - 0.032, 0, tl[2] + 0.022), H(tl[0] - 0.060, 0, tl[2] + 0.013),
                H(-0.172, 0, 0.088), H(-0.186, 0, 0.040), H(-0.190, 0, -0.030), H(-0.186, 0, -0.105),
                H(-0.180, 0, -0.180), H(-0.170, 0, -0.245), H(-0.160, 0, -0.300)]
        pts = self._resample(ctrl, 72)
        T, _, _ = self._frames(pts, V(0, 0, 1))
        nrm = np.cross(T, V(0, 1, 0))                    # in the sagittal plane; width runs side to side
        _, Nn, Wn = self._frames(pts, nrm)
        L = np.concatenate([[0], np.cumsum(np.linalg.norm(pts[1:] - pts[:-1], axis=1))])
        S = L / L[-1]
        hw = _prof(S, [0, .035, .09, .16, .3, .5, .68, .8, .9, 1], [.0124, .0132, .0215, .0262, .0280, .0250, .0190,
                                                                   .0130, .0065, .0012], 0.025) * UNDER_PONY
        ht = hw * _prof(S, [0, .6, 1], [.90, .84, .72])

        def groove(u, v, a, b, s):
            phi = np.arctan2(v / b, u / a)
            c = phi * (6 / (2 * np.pi)) + 0.45 * s + 0.2 * np.sin(phi * 2 + 1)
            k = 2 * np.pi * np.minimum(a, b) / 6 / 5.8
            return PONY_GROOVE * 0.62 * k * _clumps(c, 21, 6, lo=0.6) * _ss(0.03, 0.11, s)

        hk = dict(mat=M["hair"], part=P_["hair"])
        start = t0 - td * 0.012                            # bury the root in the gathered hair under the cuff
        body = self._sweep(np.vstack([start[None], pts]), np.concatenate([[hw[0]], hw]),
                           np.concatenate([[ht[0]], ht]), np.vstack([nrm[:1], nrm]), hk, shape="ell", groove=groove,
                           tag=("pony", 0, 0))
        # centerline frames for hair_cards.py (S = arc-length fraction of pts, without the buried start point)
        self.pony = dict(pts=pts, S=S, T=self._frames(pts, nrm)[0], Nn=Nn, Wn=Wn, hw=hw, ht=ht, start=start)
        # tip clumps: start inside the mass, peel apart as it tapers
        clumps = []
        self.pony_clumps = [(0.5, 0.58, 0.99, 0.0105, 0.009), (2.6, 0.62, 1.0, 0.0100, 0.010),
                            (4.4, 0.60, 0.96, 0.0098, 0.010)]       # (phase, s0, s1, radius, spread)
        for j, (ph, s0, s1, r0, spread) in enumerate(self.pony_clumps):
            ss = np.linspace(s0, s1, 26)
            C = np.stack([np.interp(ss, S, pts[:, i]) for i in range(3)], 1)
            Nc = np.stack([np.interp(ss, S, Nn[:, i]) for i in range(3)], 1)
            Wc = np.stack([np.interp(ss, S, Wn[:, i]) for i in range(3)], 1)
            x = (ss - s0) / (s1 - s0)
            phs = ph + 0.5 * x                             # follow the twist of the grooves a little
            off = 0.0085 + spread * _ss(0.15, 1.0, x)
            radial = Wc * np.cos(phs)[:, None] + Nc * np.sin(phs)[:, None]
            cp = C + radial * off[:, None]
            rc = r0 * (1 - x) ** 0.75 * (0.85 + 0.15 * np.sin(np.pi * np.clip(x * 1.6, 0, 1))) + 0.0006
            rc = rc * UNDER_PONY
            clumps.append(self._sweep(cp, rc, rc * 0.78, radial, hk, rr=0.0015, tag=("pony_clump", 0, j)))
        node = union(body, *clumps, k=0.004)
        return node, list(pts)
