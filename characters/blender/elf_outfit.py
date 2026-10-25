# Elf body and outfit: skin body under the head, the outfit as raised paint on it, and the separate
# pieces (collar tube, belt flaps, pauldron, rune decals). Mixed into Elf (elf.py).
#
# Two kinds of garment geometry:
#   - "paint" garments (tunic, breastplate, harness, belt, leggings, hand wraps): region fields that thicken
#     the skin SDF and repaint skin faces, so cloth can never poke through skin;
#   - hard pieces (bracers, boots, buckle, rivets, studs): real prims unioned on, with their own material.
# Material borders sit on geometric creases (beads, steps, grooves) wherever possible: the body mesh is
# decimated to ~5 mm triangles and painted per face, so a border with no crease under it comes out jagged.
import numpy as np

import sdf
from sdf import V, F, norm, frame, rot, union, sphere, ellipsoid, round_cone, capsule, rbox, custom, chain, bezier, \
    Sub, Inter, Map, Retag, smin, smax, fbm, vnoise
from elf_common import M, P_, lerp


# ---------------------------------------------------------------- small field helpers
def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def bump(x, w):
    """Cosine bump: 1 at x = 0, 0 for |x| >= w (slope <= pi/2w)."""
    t = np.clip(np.abs(x) / w, 0, 1)
    return 0.5 + 0.5 * np.cos(np.pi * t)


def leaf2d(u, v, L, W, a=0.6, b=1.0):
    """Approximate signed distance to a leaf outline: u along the leaf (0 = base, L = tip), v across.
    Half width W at the widest point; a shapes the base (smaller = rounder), b the tip (1 = straight point)."""
    t = np.clip(u / L, 1e-3, 1 - 1e-3)
    tm = a / (a + b)
    k = 1.0 / (tm ** a * (1 - tm) ** b)
    w = W * k * t ** a * (1 - t) ** b
    dw = W * k * (a * t ** (a - 1) * (1 - t) ** b - b * t ** a * (1 - t) ** (b - 1)) / L
    dw = np.clip(dw, -5, 5)
    d = (np.abs(v) - w) / np.sqrt(1 + dw * dw)
    return np.maximum(d, np.maximum(-u, u - L))


def leaf_veins(u, v, L, starts, slope=0.9):
    """Distance to a leaf's vein lines: midrib (v = 0) plus side veins leaving it at u = starts toward the tip."""
    d = np.where((u > 0.006) & (u < L * 0.9), np.abs(v), 1.0)
    for u0 in starts:
        d = np.minimum(d, np.abs(u - u0 - slope * np.abs(v)) / np.sqrt(1 + slope * slope))
    return d


HAND_SCALE = 1.08   # fists a touch oversized so they read at game distance


class OutfitMixin:
    # ------------------------------------------------------------ helpers
    def _hand(self, s):
        """Hand-local frame: origin at wrist_yaw, x to the knuckles, y back of hand (+) / palm (-), z thumb side.
        Columns are mirrored for the right hand so one set of left-hand numbers serves both."""
        Wm = self.W[self.side(s, "wrist_yaw_link")]
        return Wm[:3, 3].copy(), Wm[:3, :3] @ np.diag([1.0, float(s), 1.0])

    def _snap(self, node, start, toward, sink=0.0):
        """March from start along toward onto node's surface; returns the hit point pushed `sink` further in."""
        d = norm(toward)
        p = V(*start)
        for _ in range(150):
            v = float(node.eval(p[None].astype(F), 0.05)[0])
            if abs(v) < 2e-5:
                break
            p = p + d * v * 0.8
        return p + d * sink

    def _normal(self, node, p, h=0.0015):
        e = np.eye(3) * h
        P = np.concatenate([p + e, p - e]).astype(F)
        d = node.eval(P, 0.05)
        return norm(d[:3] - d[3:])

    # ------------------------------------------------------------ body
    def body(self):
        S = P_["spine"]
        sk = dict(mat=M["skin"], part=S)
        torso = union(
            ellipsoid((-0.008, 0, 1.006), (0.080, 0.116, 0.112), **sk),          # ribcage
            ellipsoid((0.016, 0.040, 1.028), (0.06, 0.05, 0.05), **sk),         # chest L
            ellipsoid((0.016, -0.040, 1.028), (0.06, 0.05, 0.05), **sk),        # chest R
            ellipsoid((-0.004, 0, 0.900), (0.066, 0.090, 0.095), **sk),         # abdomen
            ellipsoid((-0.010, 0, 0.778), (0.080, 0.122, 0.082), **sk),         # pelvis
            ellipsoid((-0.040, 0.052, 0.742), (0.055, 0.058, 0.065), **sk),     # glutes
            ellipsoid((-0.040, -0.052, 0.742), (0.055, 0.058, 0.065), **sk),
            ellipsoid((-0.040, 0.066, 0.985), (0.038, 0.046, 0.085), **sk),     # lats (V taper)
            ellipsoid((-0.040, -0.066, 0.985), (0.038, 0.046, 0.085), **sk),
            ellipsoid((-0.048, 0.052, 1.052), (0.030, 0.040, 0.040), **sk),     # shoulder blades
            ellipsoid((-0.048, -0.052, 1.052), (0.030, 0.040, 0.040), **sk),
            ellipsoid((-0.026, 0, 1.090), (0.055, 0.125, 0.036), R=None, **sk), # shoulder girdle / traps
            round_cone((-0.022, 0, 1.06), (-0.017, 0, 1.125), 0.040, 0.037, **sk),  # neck stub (head mesh has the rest)
            k=0.03)
        self._torso_sdf = torso          # the outfit cuts the armholes on the torso/arm part boundary
        # spine groove
        torso = Sub(torso, capsule((-0.092, 0, 0.86), (-0.09, 0, 1.06), 0.006), k=0.012)
        parts = [torso]
        for s in (1, -1):
            parts.append(self._arm(s))
            parts.append(self._leg(s))
        if getattr(self, "base", None) is None:
            return union(*parts, k=0.022)
        # realistic skin from the fitted base mesh. The armhole reference shapes come from the same skin, split
        # by a capsule around each upper arm, so the tunic/plate edges land in the real armpit crease.
        caps = {}
        for s in (1, -1):
            sh = self.p(self.side(s, "shoulder_roll_link")) + V(0.0, -s * 0.012, 0.0)
            el = self.p(self.side(s, "elbow_link"))
            wr = self.p(self.side(s, "wrist_yaw_link"))
            caps[s] = union(round_cone(sh, el, 0.058, 0.046), round_cone(el, wr, 0.046, 0.040))
            self._limb_sdf[s] = Inter(self.base_node, caps[s], k=0.004)
        self._torso_sdf = Sub(self.base_node, union(caps[1], caps[-1]), k=0.004)
        # Sculpted fists, bracers and boots go on top.
        skin = union(self._base_skin(), self._fist_node[1], self._fist_node[-1], k=0.008)
        hard = [self._arm_hard[1], self._arm_hard[-1], self._boot_node[1], self._boot_node[-1]]
        return union(skin, *hard, k=0.0)

    def _base_skin(self):
        """Base-mesh skin below the collar, with the hands and feet cut off (fists and boots replace them)."""
        big = (V(-2, -2, -2), V(2, 2, 2))
        skin = Inter(self.base_node, custom(lambda P: P[:, 2] - 1.125, *big), k=0.004)
        cuts = []
        for s in (1, -1):
            o, Rs = self._hand(s)
            d = Rs[:, 0]
            c = o - d * 0.010
            cuts.append(Inter(custom(lambda P, c=c, d=d: (c - P) @ d, *big), sphere(o + d * 0.05, 0.11)))
            a = self.p(self.side(s, "ankle_pitch_link"))
            cuts.append(Inter(custom(lambda P: P[:, 2] - 0.095, *big), sphere(a + V(0.04, 0, -0.02), 0.15)))
        return Sub(skin, union(*cuts), k=0.004)

    def _arm(self, s):
        p, nm = self.p, lambda n: self.side(s, n)
        A = P_["l_arm" if s > 0 else "r_arm"]
        sk = dict(mat=M["skin"], part=A)
        sh = p(nm("shoulder_roll_link")) + V(-0.002, s * 0.010, -0.012)
        el = p(nm("elbow_link"))
        wr = p(nm("wrist_yaw_link"))
        ua = norm(el - sh)
        Rua = frame(ua, (1, 0, 0))   # x along the arm
        fa = norm(wr - el)
        Rfa = frame(fa, (0, 0, 1))
        delt = ellipsoid(sh + V(0.002, s * 0.003, 0.004), (0.049, 0.043, 0.041), R=Rua, **sk)
        upper = round_cone(sh, el + V(-0.002, 0, 0), 0.034, 0.0255, **sk)
        bic = ellipsoid(lerp(sh, el, 0.55) + V(0.011, 0, 0), (0.048, 0.0215, 0.0225), R=Rua, **sk)
        tri = ellipsoid(lerp(sh, el, 0.45) + V(-0.011, 0, 0), (0.053, 0.0225, 0.0215), R=Rua, **sk)
        elbow = sphere(el + V(-0.008, 0, 0.0), 0.026, **sk)
        fore = round_cone(el, wr - fa * 0.004, 0.028, 0.019, **sk)
        bulge = ellipsoid(lerp(el, wr, 0.28), (0.045, 0.029, 0.028), R=Rfa, **sk)
        arm = union(delt, upper, bic, tri, elbow, fore, bulge, k=0.02)
        if not hasattr(self, "_limb_sdf"):
            self._limb_sdf = {}
        self._limb_sdf[s] = arm

        # bracer: a stiff leather can on the forearm, gold bands at both ends, a dark strap with a stud
        t0, t1 = 0.050, 0.160
        r0, r1 = 0.0345, 0.0262

        def rad(t):
            return r0 + (r1 - r0) * np.clip((t - t0) / (t1 - t0), 0, 1)

        def can(P, grow, ta, tb, k):
            q = (P - el) @ Rfa
            t = q[:, 0]
            rho = np.sqrt(q[:, 1] ** 2 + q[:, 2] ** 2)
            return smax(rho - rad(t) - grow, np.maximum(ta - t, t - tb), k)

        lo, hi = np.minimum(el, wr) - 0.06, np.maximum(el, wr) + 0.06
        lea, gld, drk = (dict(mat=M[m], part=A) for m in ("leather", "gold", "leather_dark"))
        tm = 0.5 * (t0 + t1)
        bracer = union(
            custom(lambda P: can(P, 0.0, t0, t1, 0.0025), lo, hi, **lea),
            custom(lambda P: can(P, 0.0034, t0 - 0.0012, t0 + 0.0085, 0.0013), lo, hi, **gld),
            custom(lambda P: can(P, 0.0034, t1 - 0.0085, t1 + 0.0012, 0.0013), lo, hi, **gld),
            custom(lambda P: can(P, 0.0026, tm - 0.0060, tm + 0.0060, 0.0012), lo, hi, **drk),
            k=0.0)
        out_dir = s * Rfa[:, 1]
        stud_c = el + fa * tm + out_dir * (rad(tm) + 0.0012)
        stud = ellipsoid(stud_c, (0.0072, 0.0072, 0.0072), **gld)
        gem = sphere(stud_c + out_dir * 0.0040, 0.0040, mat=M["gem"], part=A)
        hard = union(bracer, stud, gem, k=0.0)
        fist = self._fist(s)
        self.__dict__.setdefault("_arm_hard", {})[s] = hard
        self.__dict__.setdefault("_fist_node", {})[s] = fist
        arm = union(arm, hard, k=0.002)
        return union(arm, fist, k=0.010)

    def _fist(self, s):
        A = P_["l_arm" if s > 0 else "r_arm"]
        o, Rs = self._hand(s)
        g = HAND_SCALE
        L = lambda x, y, z: o + Rs @ (V(x, y, z) * g)   # hand-local (left-hand numbers, mirrored for the right)
        sk = dict(mat=M["skin"], part=A)
        palm = rbox(L(0.029, -0.001, 0.0), V(0.030, 0.0145, 0.031) * g, R=Rs, r=0.011 * g, **sk)
        wrist = ellipsoid(L(-0.010, 0.0, 0.0), V(0.032, 0.0185, 0.025) * g, R=Rs, **sk)
        thenar = ellipsoid(L(0.020, -0.010, 0.020), V(0.022, 0.012, 0.013) * g, R=Rs, **sk)
        hypo = ellipsoid(L(0.020, -0.009, -0.020), V(0.022, 0.010, 0.011) * g, R=Rs, **sk)
        fingers = []
        # (z across the hand, radius, length scale, knuckle offset along x): index, middle, ring, pinky
        for z, r, sc, dx in ((0.0235, 0.0086, 1.00, 0.000), (0.0070, 0.0090, 1.04, 0.002),
                             (-0.0095, 0.0085, 0.98, 0.000), (-0.0245, 0.0074, 0.86, -0.005)):
            K = V(0.057 + dx, 0.004, z)
            P1 = K + V(0.009 * sc, -0.031 * sc, 0)            # proximal phalanx: down the punching face
            P2 = P1 + V(-0.023 * sc, -0.004, -0.0003)          # middle phalanx: back under the palm
            P3 = P2 + V(-0.012 * sc, 0.012, -0.0004)           # distal: curled up into the palm
            fingers.append(union(
                sphere(L(*(K + V(0.003, 0.002, 0))), r * 1.08 * g, **sk),   # knuckle head
                round_cone(L(*K), L(*P1), r * g, r * 0.96 * g, **sk),
                round_cone(L(*P1), L(*P2), r * 0.96 * g, r * 0.90 * g, **sk),
                round_cone(L(*P2), L(*P3), r * 0.90 * g, r * 0.78 * g, **sk), k=0.0035))
        thumb = chain([L(0.004, -0.006, 0.024), L(0.032, -0.024, 0.037), L(0.054, -0.043, 0.024),
                       L(0.058, -0.047, 0.004)], [x * g for x in (0.0125, 0.0105, 0.0095, 0.0085)], k=0.004, **sk)
        hand = union(palm, wrist, thenar, hypo, k=0.008)
        hand = union(hand, union(*fingers, k=0.0012), k=0.004)
        return union(hand, thumb, k=0.003)

    def _leg(self, s):
        p, nm = self.p, lambda n: self.side(s, n)
        Lg = P_["l_leg" if s > 0 else "r_leg"]
        sk = dict(mat=M["skin"], part=Lg)
        hip = V(-0.004, s * 0.092, 0.725)
        kn = p(nm("knee_link")) + V(0.004, -s * 0.002, 0)
        an = p(nm("ankle_pitch_link")) + V(0.0, 0, 0.012)
        th = norm(kn - hip)
        Rth = frame(th, (1, 0, 0))
        thigh = round_cone(hip, kn, 0.061, 0.041, **sk)
        quad = ellipsoid(lerp(hip, kn, 0.45) + V(0.021, s * 0.005, 0), (0.12, 0.044, 0.047), R=Rth, **sk)
        ham = ellipsoid(lerp(hip, kn, 0.42) + V(-0.021, 0, 0), (0.11, 0.046, 0.044), R=Rth, **sk)
        knee = sphere(kn + V(0.006, 0, 0), 0.041, **sk)
        cap = ellipsoid(kn + V(0.036, 0, 0.004), (0.012, 0.022, 0.024), **sk)
        shin = round_cone(kn, an, 0.039, 0.024, **sk)
        calf = ellipsoid(lerp(kn, an, 0.30) + V(-0.016, 0, 0), (0.042, 0.038, 0.085), **sk)
        leg = union(thigh, quad, ham, knee, cap, shin, calf, k=0.02)
        lower = union(knee, cap, shin, calf, k=0.02)
        if getattr(self, "base", None) is not None:
            y = p(nm("ankle_roll_link"))[1]
            region = round_cone(V(0.0, y, -0.02), V(0.0, y, 0.43), 0.085, 0.085)
            lower = union(lower, Inter(self.base_node, region, k=0.004), k=0.0)
        boot = self._boot(s, lower)
        self.__dict__.setdefault("_boot_node", {})[s] = boot
        return union(leg, boot, k=0.0015)

    def _boot(self, s, lower):
        """Knee-high boot that swallows the lower leg: stiff shaft, folded cuff with a gold band, ankle strap
        with buckle, pointed toe with a gold cap, sole with a welt, stacked heel. (The skin foot is gone:
        the boot is the foot.)"""
        Lg = P_["l_leg" if s > 0 else "r_leg"]
        y = self.p(self.side(s, "ankle_roll_link"))[1]
        bt = dict(mat=M["boot"], part=Lg)
        lo, hi = V(-0.13, y - 0.11, -0.01), V(0.22, y + 0.11, 0.47)

        def z_top(x):                      # boot top: higher over the knee
            return 0.364 + 0.030 * sstep(-0.02, 0.05, x)

        tube = round_cone((-0.002, y, 0.42), (0.002, y, 0.085), 0.0410, 0.0295, **bt)
        follow = Retag(Map(lower, f=lambda P, d: d - 0.0038, grow=0.005), mat=M["boot"])
        shaft_raw = union(tube, follow, k=0.02)

        def wrinkle(P):
            x, yy, z = P[:, 0], P[:, 1], P[:, 2]
            ang = np.arctan2(yy - y, x)
            front = sstep(-0.4, 0.5, np.cos(ang)) * (0.55 + 0.45 * np.sin(5 * ang + 1.0 + s))
            ph = (z - 0.085) / 0.0128 * 2 * np.pi + 0.9 * np.sin(3 * ang + 0.5 * s) + 0.6 * np.sin(7 * ang + 2.0)
            amp = 0.0013 * sstep(0.082, 0.098, z) * sstep(0.170, 0.130, z) * front
            seam = 0.0007 * bump(np.abs(yy - y) + np.maximum(x + 0.01, 0) * 3, 0.0016) * (x < 0)
            # embossed leaf on the outer side of the shaft (geometry only: reads by shading, no paint border)
            u, v = z - 0.168, x - 0.004
            ld = leaf2d(u, v, 0.135, 0.023, 0.6, 1.1)
            side = sstep(0.012, 0.022, s * (yy - y))
            vein = bump(leaf_veins(u, v, 0.135, (0.035, 0.060, 0.085), 0.9), 0.0012) * (ld < -0.002)
            emb = side * (0.0021 * sstep(0.0007, -0.0007, ld) - 0.0009 * vein)
            return amp * np.clip(0.5 + 0.5 * np.sin(ph), 0, 1) ** 1.5 - seam + emb

        shaft = Map(shaft_raw, f=lambda P, d: d - wrinkle(P), grow=0.002)
        yt = y + s * 0.003
        foot_up = union(
            ellipsoid((-0.029, y, 0.046), (0.035, 0.031, 0.042), **bt),                    # heel counter
            round_cone((-0.008, y, 0.052), (0.080, yt, 0.033), 0.0340, 0.0272, **bt),      # instep to ball
            round_cone((0.080, yt, 0.033), (0.156, y + s * 0.001, 0.046), 0.0272, 0.0045, **bt),  # pointed toe
            round_cone((0.0, y, 0.050), (0.0, y, 0.140), 0.0350, 0.0325, **bt),            # ankle
            k=0.022)
        upper_raw = union(shaft, foot_up, k=0.02)
        top_cut = custom(lambda P: np.maximum(P[:, 2] - z_top(P[:, 0]), 0.008 - P[:, 2]), lo, hi)
        upper = Inter(upper_raw, top_cut, k=0.002)

        def cuff_fn(P, extra=0.0, band=None):
            z = P[:, 2]
            zt = z_top(P[:, 0])
            zb = zt - 0.052
            tt = np.clip((z - zb) / 0.052, 0, 1)
            d = shaft_raw.eval(P, 0.03) - (0.0058 + 0.0045 * tt + extra)
            if band is not None:                       # gold band: a ring proud of the cuff
                return smax(d, np.abs(z - (zb + band)) - 0.0042, 0.0012)
            d = smax(d, zb - z, 0.0012)                 # crisp lower lip
            return smax(d, z - zt - 0.004, 0.005)       # rolled top fold

        clo, chi = V(-0.1, y - 0.1, 0.27), V(0.13, y + 0.1, 0.45)
        cuff = custom(cuff_fn, clo, chi, mat=M["leather"], part=Lg)     # folded-down cuff shows the lighter flesh side
        cuff_band = custom(lambda P: cuff_fn(P, 0.0022, 0.0135), clo, chi, mat=M["gold"], part=Lg)

        def foot_print(P):
            Q = P.copy()
            d = None
            for zz in (0.013, 0.020):
                Q[:, 2] = zz
                dd = foot_up.eval(Q, 0.03)
                d = dd if d is None else np.minimum(d, dd)
            return d

        dk = dict(mat=M["leather_dark"], part=Lg)
        sole = custom(lambda P: smax(foot_print(P) - 0.0020, np.maximum(-P[:, 2], P[:, 2] - 0.0115), 0.0012),
                      V(-0.1, y - 0.06, -0.005), V(0.2, y + 0.06, 0.02), **dk)
        heel = rbox((-0.041, y, 0.0140), (0.0215, 0.0225, 0.0140), r=0.0032, **dk)

        def cap_fn(P):
            d = foot_up.eval(P, 0.02) - 0.0017
            return smax(d, 0.131 + 0.55 * np.abs(P[:, 1] - yt) - P[:, 0], 0.0008)

        toe_cap = custom(cap_fn, V(0.10, y - 0.05, 0.0), V(0.2, y + 0.05, 0.09), mat=M["gold"], part=Lg)
        n = norm(V(0.36, 0, 1.0))
        p0 = V(0.0, y, 0.074)

        def strap_fn(P):
            d = upper_raw.eval(P, 0.02) - 0.0028
            d = smax(d, np.abs((P - p0) @ n) - 0.0062, 0.001)
            return smax(d, P[:, 0] - 0.07, 0.002)

        strap = custom(strap_fn, V(-0.09, y - 0.07, 0.02), V(0.1, y + 0.07, 0.13), mat=M["leather"], part=Lg)
        bk = V(0.012, y + s * 0.0405, 0.0697)
        Rb = frame(V(0.94, 0, -0.34), V(0.34, 0, 0.94))
        buckle = Sub(rbox(bk, (0.0095, 0.0030, 0.0088), R=Rb, r=0.0016, mat=M["gold"], part=Lg),
                     rbox(bk + V(0, s * 0.003, 0), (0.0045, 0.0026, 0.0040), R=Rb, r=0.001), k=0.0008)
        return union(upper, cuff, cuff_band, sole, heel, toe_cap, strap, buckle, k=0.0)

    # ------------------------------------------------------------ outfit (raised paint on the body)
    def outfit(self, body):
        """Wraps the skin SDF: each garment lowers the distance inside its region (thickness) and repaints skin.
        Then hard trim pieces (buckle, rivets, studs) are snapped onto the dressed surface."""
        p = self.p
        skin_only = (M["skin"],)

        torso_sdf, limbs = self._torso_sdf, (self._limb_sdf[1], self._limb_sdf[-1])
        memo = {"P": None}

        def hole_e(P):
            """Surface distance (approx.) from the armhole edge, which runs along the torso/arm part boundary,
            i.e. right in the armpit crease: > 0 on the torso, < 0 on the arms."""
            if memo["P"] is P:
                return memo["e"]
            # (wide eval band: culled children report box distance, which would fake a nearby arm)
            e = np.full(len(P), 0.03, F)
            sel = (P[:, 2] > 0.86) & (np.abs(P[:, 1]) > 0.03)
            if sel.any():
                Q = P[sel]
                da = np.minimum(limbs[0].eval(Q, 0.07), limbs[1].eval(Q, 0.07))
                e[sel] = np.clip(0.5 * (da - torso_sdf.eval(Q, 0.07)), -0.03, 0.03)
            memo["P"], memo["e"] = P, e
            return e

        # ---------------- leggings
        def legging(P):
            r = sstep(0.803, 0.797, P[:, 2]) * sstep(0.19, 0.18, np.abs(P[:, 1]))
            t = r * (0.0013 + 0.0004 * fbm(P, 150, 2))
            return t, M["legging"], r > 0.5

        # ---------------- tunic with folds and gold-piped armholes
        def tunic(P):
            x, y, z = P[:, 0], P[:, 1], P[:, 2]
            ea = hole_e(P) + 0.003           # edge sits 3 mm onto the arm side of the crease
            r = sstep(0.800, 0.806, z) * sstep(1.152, 1.146, z) * sstep(-0.0005, 0.0005, ea) * \
                sstep(0.158, 0.148, np.abs(y))
            ang = np.arctan2(y, x + 0.01)
            # compression folds above the belt
            ph = (z - 0.836) / 0.0135 * 2 * np.pi + 1.3 * np.sin(2 * ang + 0.7) + 0.7 * np.sin(5 * ang + 1.1)
            f = 0.0014 * sstep(0.836, 0.842, z) * sstep(0.912, 0.862, z) * np.clip(0.5 + 0.5 * np.sin(ph), 0, 1) ** 1.5
            # vertical drape on the back
            ph2 = y / 0.034 * 2 * np.pi + 2.0 * np.sin(z * 23 + 0.3)
            f = f + 0.0015 * sstep(0.0, -0.03, x) * sstep(0.84, 0.88, z) * sstep(1.06, 0.99, z) * \
                np.clip(0.5 + 0.5 * np.sin(ph2), 0, 1) ** 1.5
            piping = 0.0022 * bump(ea - 0.0034, 0.0034)
            t = r * (0.0026 + f + piping + 0.0004 * fbm(P, 140, 2))
            return t, np.where(ea < 0.0069, M["gold"], M["tunic"]), r > 0.02

        # ---------------- breastplate: tooled leather, gold bead rim, embossed leaf
        def plate_e(P):
            x, y, z = P[:, 0], P[:, 1], P[:, 2]
            ay = np.abs(y)
            z_top = 1.060 + 0.28 * ay + 1.4 * ay * ay
            z_bot = 0.900 + 0.20 * ay + 2.6 * ay * ay
            e = np.minimum(z - z_bot, z_top - z)
            e = np.minimum(e, (x + 0.022) * 0.9)
            return np.minimum(e, hole_e(P) - (0.004 if getattr(self, 'base', None) is not None else 0.021))

        LEAF0, LEAFL, LEAFW = 0.919, 0.114, 0.025

        def plate(P):
            e = plate_e(P)
            r = sstep(-0.0012, 0.0012, e)
            bead = 0.0026 * bump(e - 0.0037, 0.0037)
            groove = 0.0012 * bump(e - 0.0090, 0.0017)
            tool = 0.0008 * bump(e - 0.0170, 0.0013)
            u, v = P[:, 2] - LEAF0, P[:, 1]
            ld = leaf2d(u, v, LEAFL, LEAFW, 0.7, 1.1)
            vein = bump(leaf_veins(u, v, LEAFL, (0.028, 0.048, 0.068, 0.086), 0.8), 0.0014) * (ld < -0.003)
            front = sstep(0.0, 0.03, P[:, 0])
            emb = (0.0024 * sstep(0.0008, -0.0008, ld) - 0.0011 * vein - 0.0009 * bump(ld + 0.0035, 0.0012)) * front
            t = r * (0.0060 + bead - groove - tool + emb)
            m = np.where(e < 0.0076, M["gold"], np.where((ld < -0.0035) & (P[:, 0] > 0), M["leather_dark"], M["leather"]))
            return t, m, e > -0.0011

        # ---------------- harness: shoulder straps and a back strap (leather_dark), under the plate
        def harness(P):
            x, y, z = P[:, 0], P[:, 1], P[:, 2]
            ay = np.abs(y)
            e_sh = np.minimum(0.0125 - np.abs(ay - 0.076), z - 0.940)
            e_bk = np.minimum(0.0185 - np.abs(z - 0.957), -0.020 - x)
            e = np.maximum(e_sh, e_bk)
            e = np.minimum(np.minimum(e, hole_e(P) - 0.010), 0.001 - plate_e(P))   # stops under the plate rim
            r = sstep(-0.001, 0.001, e)
            stitch = 0.0007 * bump(e - 0.0035, 0.0010)
            t = r * (0.0047 - stitch + 0.0010 * sstep(0.0, 0.0025, e))
            return t, M["leather_dark"], e > -0.0009

        # ---------------- belt
        BZ0, BZ1 = 0.796, 0.837

        def belt(P):
            z = P[:, 2]
            e = np.minimum(z - BZ0, BZ1 - z)
            r = sstep(-0.0007, 0.0007, e) * sstep(0.17, 0.16, np.abs(P[:, 1]))
            stitch = 0.0008 * bump(e - 0.0042, 0.0011)
            t = r * (0.0062 + 0.0012 * sstep(0.0, 0.003, e) - stitch)
            return t, M["leather_dark"], r > 0.02

        # ---------------- hand wraps (cloth bands from under the bracer over the palm and knuckles)
        hands = {s: self._hand(s) for s in (1, -1)}

        def wraps(P):
            t = np.zeros(len(P), F)
            for s in (1, -1):
                o, Rs = hands[s]
                q = (P - o) @ Rs / HAND_SCALE
                x, y, z = q[:, 0], q[:, 1], q[:, 2]
                near = (np.abs(x - 0.02) < 0.08) & (np.abs(y) < 0.07) & (np.abs(z) < 0.07)
                # wrist and back of the hand up to just behind the knuckles, palm heel; knuckles/fingers bare
                reg = sstep(-0.034, -0.030, x) * sstep(0.052, 0.048, x)
                cover = np.maximum(sstep(-0.024, -0.020, y), sstep(0.036, 0.032, x))
                reg = reg * cover * near
                # diagonal bands with a groove between them
                ph = (x + 0.42 * z) / 0.0125
                fr = ph - np.floor(ph)
                band = 0.0012 * sstep(0.0, 0.10, fr) * sstep(1.0, 0.86, fr)
                t = np.maximum(t, reg * (0.0010 + band))
            return t, M["wrap"], t > 0.0002

        # ---------------- strap around the right thigh
        th_a = V(-0.004, -0.092, 0.725)
        th_b = self.p("right_knee_link") + V(0.004, 0.002, 0)
        th_ax = norm(th_b - th_a)

        def thigh_strap(P):
            q = P - th_a
            t = q @ th_ax
            rad = np.sqrt(np.maximum((q * q).sum(1) - t * t, 0))
            e = np.minimum(0.0085 - np.abs(t - 0.128), 0.085 - rad)
            e = np.minimum(e, -0.03 - P[:, 1])
            r = sstep(-0.0007, 0.0007, e)
            t_ = r * (0.0038 + 0.0010 * sstep(0.0, 0.0025, e) - 0.0007 * bump(e - 0.0034, 0.0010))
            return t_, M["leather"], e > -0.0007

        garments = [  # (fn, base materials it may repaint)
            (legging, skin_only), (tunic, skin_only), (harness, skin_only), (plate, skin_only),
            (belt, skin_only), (wraps, skin_only), (thigh_strap, skin_only),
        ]

        def thick(P):
            t = np.zeros(len(P), F)
            for fn, _ in garments:
                t = np.maximum(t, fn(P)[0])
            return t

        def paint(P, mat):
            out = mat.copy()
            best = np.full(len(P), -1.0, F)
            for fn, base in garments:
                t, m, mask = fn(P)
                sel = mask & np.isin(mat, base) & (t >= best)
                out[sel] = m[sel] if np.ndim(m) else m
                best = np.where(sel, t, best)
            return out

        dressed = Map(body, f=lambda P, d: d - thick(P), paint=paint, grow=0.012)
        self._dressed = dressed
        return union(dressed, *self._trim(dressed), k=0.0)

    def _trim(self, dressed):
        """Hard gold pieces on the dressed torso: belt buckle, belt studs, harness rivets."""
        S = P_["spine"]
        gd = dict(mat=M["gold"], part=S)
        out = []
        # buckle: a gold frame with a prong, on the belt front
        bp = self._snap(dressed, (0.25, 0, 0.8165), (-1, 0, 0))
        n = self._normal(dressed, bp)
        Rb = frame(n, (0, 0, 1))
        c = bp + n * 0.0012
        frame_ = Sub(rbox(c, (0.0042, 0.0275, 0.0215), R=Rb, r=0.0034, **gd),
                     rbox(c + n * 0.003, (0.006, 0.0172, 0.0112), R=Rb, r=0.0022), k=0.0012)
        prong = rbox(c + n * 0.0005, (0.0026, 0.0024, 0.0128), R=Rb, r=0.0016, **gd)
        gem = ellipsoid(c + n * 0.0055 + V(0, 0, 0.0), (0.0042, 0.0062, 0.0062), R=Rb, mat=M["gem"], part=S)
        out += [frame_, prong, gem]
        # belt studs
        for deg in (32, 52, 100, 122, 146):
            for s in (1, -1):
                a = np.radians(deg) * s
                d = V(np.cos(a), np.sin(a), 0)
                hit = self._snap(dressed, V(-0.01, 0, 0.8165) + d * 0.3, -d, sink=0.0014)
                out.append(sphere(hit, 0.0045, **gd))
        # pouch hanging under the belt on the right hip, behind the side tasset
        n = norm(V(-0.46, -0.89, 0.0))
        sp = self._snap(dressed, V(-0.01, 0, 0.781) + n * 0.3, -n)
        Rp = frame(n, (0, 0, 1))
        c = sp + n * 0.0105
        lt, dk = dict(mat=M["leather"], part=S), dict(mat=M["leather_dark"], part=S)
        out.append(rbox(c, (0.0115, 0.0235, 0.0215), R=Rp, r=0.0065, **lt))
        out.append(rbox(c + n * 0.0035 + V(0, 0, 0.0085), (0.0098, 0.0250, 0.0140), R=Rp, r=0.0050, **dk))
        out.append(sphere(c + n * 0.0138 + V(0, 0, -0.0010), 0.0038, **gd))
        # thigh strap buckle (outer front of the right thigh)
        th_a = V(-0.004, -0.092, 0.725)
        th_ax = norm(self.p("right_knee_link") + V(0.004, 0.002, 0) - th_a)
        sc = th_a + th_ax * 0.128
        n = norm(V(0.55, -0.83, 0.0))
        hit = self._snap(dressed, sc + n * 0.2, -n)
        Rt = frame(n, -th_ax)
        rl = P_["r_leg"]
        out.append(Sub(rbox(hit + n * 0.0008, (0.0035, 0.0105, 0.0115), R=Rt, r=0.0022, mat=M["gold"], part=rl),
                       rbox(hit + n * 0.0035, (0.003, 0.0055, 0.0068), R=Rt, r=0.0015), k=0.0008))
        # harness rivets: where the shoulder straps meet the plate (front) and the back strap (back)
        for s in (1, -1):
            for start, toward in (((0.25, s * 0.076, 1.098), (-1, 0, 0)), ((-0.25, s * 0.076, 0.957), (1, 0, 0))):
                hit = self._snap(dressed, start, toward, sink=0.0015)
                out.append(sphere(hit, 0.0050, **gd))
        return out

    def collar(self):
        """Stand-up collar: a real tube, so the head mesh's neck can sit inside it with no visible seam."""
        a, b = V(-0.020, 0, 1.080), V(-0.013, 0, 1.146)
        outer = round_cone(a, b, 0.056, 0.0455, mat=M["tunic"], part=P_["spine"])
        inner = round_cone(a + V(0, 0, 0.012), b + V(0.001, 0, 0.04), 0.044, 0.0415)
        shell = Sub(outer, inner, k=0.002)
        notch = custom(lambda P: np.maximum(np.abs(P[:, 1]) - 0.004 - (P[:, 2] - 1.105) * 0.35,
                                            np.maximum(0.02 - P[:, 0], 1.11 - P[:, 2])), (0.0, -0.05, 1.08), (0.08, 0.05, 1.2))
        shell = Sub(shell, notch, k=0.003)
        return Map(shell, f=lambda P, d: d + 0.0005 * fbm(P, 160, 2))

    # ------------------------------------------------------------ separate pieces
    def _leafplate(self, root, down, out_dir, L, W, th, mat, edge_mat=None, u0=0.0, off=0.0, flare=0.0,
                   arch=0.0, bead_w=0.0045, bead_h=0.0010, rib=0.0, veins=None, a=0.6, b=1.0, part=None):
        """A thin leaf-shaped plate hanging from root: u runs along `down`, the plate faces `out_dir`.
        Gold (edge_mat) bead around the rim; optional raised midrib and carved side veins."""
        down = norm(down)
        out_dir = np.asarray(out_dir, float)
        out_dir = norm(out_dir - (out_dir @ down) * down)
        across = norm(np.cross(down, out_dir))
        Rm = np.stack([down, across, out_dir], 1)
        part = P_["flap"] if part is None else part

        def geo(P):
            q = (P - root) @ Rm
            u, v, w = q[:, 0] - u0, q[:, 1], q[:, 2]
            d2 = leaf2d(u, v, L, W, a, b)
            t = np.clip(u / L, 0, 1)
            wc = off + flare * t * t - arch * (v / W) ** 2
            e = -d2
            h = th + bead_h * bump(e - bead_w * 0.5, bead_w * 0.5)
            if rib:
                h = h + rib * bump(v, 0.0035) * sstep(0.0, 0.03, u) * sstep(L * 0.92, L * 0.6, u)
            if veins:
                h = h - 0.0007 * bump(leaf_veins(u, v, L, veins, 1.0), 0.0012) * (e > bead_w + 0.002) * \
                    (np.abs(v) > 0.004)
            return smax(d2, np.abs(w - wc) - h, 0.0006), e

        def paint(P, m):
            if edge_mat is None:
                return m
            _, e = geo(P)
            out = m.copy()
            out[e < bead_w + 0.0003] = edge_mat
            return out

        R = L + abs(u0) + W + 0.03
        node = custom(lambda P: geo(P)[0], root - R, root + R, mat=mat, part=part)
        return Map(node, paint=paint)

    def flaps(self):
        """Belt tassets: front and back cloth leaves (gold-edged) over longer leather backing leaves, and
        leather side leaves (gold-edged) with a small cloth leaf on top. Returns {name: (node, root, length)}."""
        out = {}
        T, Lt, Ld, G = M["tunic"], M["leather"], M["leather_dark"], M["gold"]
        dressed = getattr(self, "_dressed", None)

        def seat(default, start, toward):
            """Root on the outside of the belt (snapped to the dressed body when it is available)."""
            if dressed is None:
                return default
            return self._snap(dressed, start, toward) - norm(toward) * 0.0015

        root = seat(V(0.084, 0, 0.806), V(0.25, 0, 0.806), (-1, 0, 0))
        dn, od = (0.12, 0, -1), (1, 0, 0.1)
        out["front"] = (union(
            self._leafplate(root, dn, od, 0.195, 0.048, 0.0015, Lt, Ld, u0=0.008, off=-0.0015, flare=0.012,
                            arch=0.008, bead_w=0.0040, bead_h=0.0008, a=0.42),
            self._leafplate(root, dn, od, 0.162, 0.041, 0.0016, T, G, u0=0.011, off=0.0042, flare=0.013,
                            arch=0.007, bead_w=0.0052, bead_h=0.0014, rib=0.0010, a=0.42,
                            veins=(0.040, 0.068, 0.096))), root, 0.19)
        root = seat(V(-0.088, 0, 0.806), V(-0.25, 0, 0.806), (1, 0, 0))
        dn, od = (-0.16, 0, -1), (-1, 0, 0.12)
        out["back"] = (union(
            self._leafplate(root, dn, od, 0.185, 0.052, 0.0015, Lt, Ld, u0=-0.016, off=0.0005, flare=0.014,
                            arch=0.009, bead_w=0.0040, bead_h=0.0008, a=0.45),
            self._leafplate(root, dn, od, 0.155, 0.043, 0.0016, T, G, u0=-0.014, off=0.0060, flare=0.015,
                            arch=0.008, bead_w=0.0052, bead_h=0.0014, rib=0.0010, a=0.45,
                            veins=(0.045, 0.072, 0.098))), root, 0.17)
        for s, name in ((1, "left"), (-1, "right")):
            root = seat(V(0.016, s * 0.118, 0.806), V(0.016, s * 0.30, 0.806), (0, -s, 0))
            dn, od = (0.06, s * 0.30, -1), (0.32, s * 1, 0.22)
            out[name] = (union(
                self._leafplate(root, dn, od, 0.165, 0.047, 0.0018, Lt, G, u0=-0.012, off=0.006, flare=0.020,
                                arch=-0.006, bead_w=0.0050, bead_h=0.0013, rib=0.0010,
                                veins=(0.040, 0.066, 0.092)),
                self._leafplate(root, dn, od, 0.105, 0.028, 0.0015, T, G, u0=-0.010, off=0.0105, flare=0.016,
                                arch=-0.004, bead_w=0.0040, bead_h=0.0010)), root, 0.15)
        return out

    def pauldron(self):
        """Layered leaf pauldron on the left shoulder: a big top leaf over a front and a back leaf, gold bead
        rims, raised midribs, carved veins, and a gold boss with a gem where they meet. Rigid on
        left_shoulder_roll_link."""
        c = self.p("left_shoulder_roll_link") + V(-0.004, 0.006, -0.008)
        A = P_["l_arm"]
        nodes = []

        def shell_leaf(e_up, e_out, R0, a0, a1, W, th=0.0016, flare=0.012, cup=0.004, bead_w=0.0045,
                       bead_h=0.0011, rib_h=0.0012, veins=(0.035, 0.060, 0.085)):
            e_up, e_out = norm(e_up), norm(e_out)
            e_out = norm(e_out - (e_out @ e_up) * e_up)
            m = np.cross(e_up, e_out)
            Lr = R0 * (a1 - a0)

            def geo(P):
                q = P - c
                r = np.sqrt((q * q).sum(1)) + 1e-9
                ang = np.arctan2(q @ e_out, q @ e_up)
                u = R0 * (ang - a0)
                v = R0 * np.arcsin(np.clip((q @ m) / r, -1, 1))
                d2 = leaf2d(u, v, Lr, W, 0.75, 1.1)
                t = np.clip(u / Lr, 0, 1)
                e = -d2
                rim = bump(e - bead_w * 0.5, bead_w * 0.5)
                rs = R0 + flare * t * t + cup * (v / W) ** 2 + 0.5 * bead_h * rim
                h = th + bead_h * rim + rib_h * bump(v, 0.0034) * sstep(0.004, 0.02, u) * sstep(Lr * 0.92, Lr * 0.6, u)
                h = h - 0.0007 * bump(leaf_veins(u, v, Lr, veins, 1.0), 0.0011) * (e > bead_w + 0.002) * \
                    (np.abs(v) > 0.0045)
                return smax(d2, np.abs(r - rs) - h, 0.0005), e

            def paint(P, mm):
                _, e = geo(P)
                out = mm.copy()
                out[e < bead_w + 0.0003] = M["gold"]
                return out

            node = custom(lambda P: geo(P)[0], c - 0.12, c + 0.12, mat=M["leather_green"], part=A)
            return Map(node, paint=paint)

        up = V(0, 0, 1)
        # top leaf: from beside the neck over the shoulder cap and down the outside of the arm
        nodes.append(shell_leaf(up, V(0, 1, 0), 0.069, -0.32, 1.80, 0.055, flare=0.018,
                                veins=(0.035, 0.058, 0.081, 0.104)))
        # front and back leaves underneath, fanned 38 degrees forward / back
        for sgn in (1, -1):
            a = np.radians(38) * sgn
            nodes.append(shell_leaf(up, V(np.sin(a), np.cos(a), 0), 0.0620, 0.02, 1.84, 0.040, flare=0.020,
                                    cup=0.005, veins=(0.035, 0.058, 0.081)))
        # boss with a gem where the leaves meet
        a = 0.10
        dirb = norm(V(0, np.sin(a), np.cos(a)))
        bc = c + dirb * (0.069 + 0.0035)
        Rb = frame(dirb, (1, 0, 0))

        def boss(P):
            q = (P - bc) @ Rb
            rho = np.sqrt(q[:, 1] ** 2 + q[:, 2] ** 2)
            return smax(rho - 0.0135, np.abs(q[:, 0]) - 0.0032, 0.0022)

        nodes.append(custom(boss, bc - 0.02, bc + 0.02, mat=M["gold"], part=A))
        nodes.append(ellipsoid(bc + dirb * 0.0030, (0.0045, 0.0078, 0.0078), R=Rb, mat=M["gem"], part=A))
        return union(*nodes, k=0.0)

    def runes(self):
        """Glowing vine armlets on both upper arms: a thin decal shell just above the skin."""
        nodes = []
        for s in (1, -1):
            arm = self.base_node if getattr(self, "base", None) is not None else self._arm(s)
            sh = self.p(self.side(s, "shoulder_roll_link"))
            el = self.p(self.side(s, "elbow_link"))
            ax = norm(el - sh)
            Rm = frame(ax, (1, 0, 0))
            r = 0.035

            def pattern(P, sh=sh, Rm=Rm, s=s):
                q = (P - sh) @ Rm
                t = q[:, 0]
                ang = np.arctan2(s * q[:, 1], q[:, 2])
                d = np.minimum(np.abs(t - 0.056) - 0.0013, np.abs(t - 0.114) - 0.0013)
                tv = 0.085 + 0.017 * np.sin(3 * ang)
                slope = 0.051 * np.cos(3 * ang) / r
                d = np.minimum(d, np.abs(t - tv) / np.sqrt(1 + slope ** 2) - 0.0012)
                for k in range(6):
                    ak = k * np.pi / 3 + np.pi / 12
                    tk = 0.085 + 0.017 * np.sin(3 * ak) + (0.0085 if k % 2 else -0.0085)
                    da = np.angle(np.exp(1j * (ang - ak))) * r
                    dt = t - tk
                    th = np.radians(38 if k % 2 else -38)
                    x1 = da * np.cos(th) + dt * np.sin(th)
                    y1 = -da * np.sin(th) + dt * np.cos(th)
                    leaf = np.sqrt((x1 / 0.0066) ** 2 + (y1 / 0.0028) ** 2) - 1
                    d = np.minimum(d, leaf * 0.0028)
                # small diamonds on the rings
                for k in range(6):
                    ak = k * np.pi / 3
                    da = np.abs(np.angle(np.exp(1j * (ang - ak)))) * r
                    for t0 in (0.056, 0.114):
                        d = np.minimum(d, (da + np.abs(t - t0) * 1.3) - 0.0034)
                # stay on the upper arm (the realistic skin field also contains the torso)
                return np.maximum(d, np.sqrt(q[:, 1] ** 2 + q[:, 2] ** 2) - 0.055)

            lo = np.minimum(sh, el) - 0.06
            hi = np.maximum(sh, el) + 0.06
            shell = Map(arm, f=lambda P, d: np.abs(d - 0.0009) - 0.00045)
            nodes.append(Retag(Inter(shell, custom(pattern, lo, hi), k=0.0003), mat=M["rune"],
                               part=P_["l_arm" if s > 0 else "r_arm"]))
        return union(*nodes)
