# The elf, sculpted as signed distance fields on top of the G1's bind-pose joints (MuJoCo frame, meters).
# Main mesh = skin + outfit as one surface (outfit is raised "paint"), so clothes can never poke through skin.
# Pieces that swing or sit rigidly on one bone (ponytail, belt flaps, pauldron) are separate meshes.
#   base_body.py   realistic skin: Blender Studio's CC0 base mesh fitted to the G1 (fit_base.py) as an SDF
#   elf.py         head: face (from the base mesh), eyes, lashes, brows, elf ears (+ shared helpers)
#   elf_hair.py    hair cap, bangs, side locks, circlet, ponytail
#   elf_outfit.py  body, outfit, collar, flaps, pauldron, runes
#   elf_common.py  material and part tables, colors
import numpy as np

import sdf
from sdf import V, F, norm, frame, rot, union, sphere, ellipsoid, round_cone, capsule, rbox, custom, chain, bezier, \
    Sub, Inter, Map, Retag, smin, smax, fbm, vnoise
from elf_common import M, P_, lerp
from elf_common import MATS, PARTS, COLORS  # noqa: F401  (re-exported for build.py)
from base_body import BaseBody
from elf_hair import HairMixin
from elf_outfit import OutfitMixin


class Elf(HairMixin, OutfitMixin):
    # A touch taller than the G1 (uniform size about the floor under the pelvis, applied by the runtime and
    # pose.py from g1_rig.scale) and slimmer about the G1's own bone axes (build.py slim pass), so the joints
    # never move: fractions of each part's width removed.
    rig_scale = 1.05
    slim = dict(torso=0.11, depth=0.04, neck=0.06, arm=0.10, hand=0.04, leg=0.10, foot=0.06)
    brow_strength = 0.70           # soft, low-contrast brows
    lip_strength = 0.60            # soft rose lips, close to skin

    def __init__(self, W):
        """W: {body name: 4x4 world matrix at the bind pose}."""
        self.W = W
        p = lambda n: W[n][:3, 3].copy()
        self.p = p
        self.base = BaseBody()                     # fitted CC0 realistic body (base_body.py)
        self.base_node = self.base.node(M["skin"], P_)
        self.head_c = V(0.010, 0, 1.220)          # head center (between the ears)
        self.eye_r = self.base.eye(1)[1]
        self.eyes = {}

    # ------------------------------------------------------------ helpers
    def H(self, x, y, z):
        return self.head_c + V(x, y, z)

    def side(self, s, name):
        return ("left_" if s > 0 else "right_") + name

    # ------------------------------------------------------------ head
    def eye_frame(self, s):
        fwd = V(np.cos(np.radians(4)), s * np.sin(np.radians(4)), 0)
        return frame(fwd, (0, 0, 1))

    def snap(self, node, start, toward, off=0.0):
        """March from `start` along `toward` until hitting node's surface; returns surface point + off along -toward."""
        d = norm(toward)
        p = V(*start)
        for _ in range(80):
            v = float(node.eval(p[None].astype(F), 0.05)[0])
            if abs(v) < 2e-5:
                break
            p = p + d * v * 0.9
        return p - d * off

    def surf(self, node, az, el, off=0.0):
        """Point on the head surface seen from the head center at azimuth/elevation (degrees)."""
        a, e = np.radians(az), np.radians(el)
        d = V(np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e))
        return self.snap(node, self.head_c + d * 0.2, -d, off)

    def face(self):
        """Head skin from the fitted CC0 base mesh (realistic anatomy), lips painted, human ears removed
        (head() adds elf ears)."""
        H = self.H
        region = union(sphere(H(0.025, 0, 0.012), 0.118), round_cone(V(-0.012, 0, 1.00), V(0.0, 0, 1.16), 0.062, 0.058))
        face = Inter(self.base_node, region, k=0.003)
        big = (V(-2, -2, -2), V(2, 2, 2))
        pinnae = union(*[Inter(ellipsoid(H(-0.012, s * 0.066, -0.020), (0.022, 0.024, 0.040)),
                               custom(lambda P, s=s: 0.057 - s * P[:, 1], *big)) for s in (1, -1)])
        face = Sub(face, pinnae, k=0.006)
        return face

    def lip_weight(self, P):
        """0..1 soft lip mask (vertex-color tint on skin; smooth where a per-face material would be jagged)."""
        mc, mw = self.base.mouth_c, self.base.mouth_w * 0.70
        q = P - mc
        t = np.clip(np.abs(q[:, 1]) / mw, 0, 1.2)
        up = 0.0052 * np.clip(1 - t * t, 0, 1) ** 0.55 - 0.0010 * np.exp(-(q[:, 1] / 0.0035) ** 2)   # cupid's bow
        lo = 0.0062 * np.clip(1 - t * t, 0, 1) ** 0.70
        d = np.maximum(q[:, 2] - up, -lo - q[:, 2])          # < 0 inside vertically
        w = np.clip(0.5 - d / 0.0030, 0, 1) * np.clip((1.0 - t) / 0.30, 0, 1)   # soft edges, fading corners
        return w * (q[:, 0] > -0.012)

    def face_shade(self, P):
        """0..1 painted shade that shapes the face (multiplied in by build.py): deep soft sockets around the eyes,
        a hollow under each cheekbone, a little under the brow ridge and along the jaw."""
        w = np.zeros(len(P))
        for s in (1, -1):
            E, R = self.eyes[s]
            q = (P - (E + V(-0.001, s * 0.001, 0.0015))) / np.array([0.020, 0.019, 0.0135])
            w = np.maximum(w, 0.72 * np.exp(-(q * q).sum(1) * 0.75))
            # soft lash line along the upper lid margin (shape without lash geometry)
            g = R[:, 0]
            q = P - E
            r = np.linalg.norm(q, axis=1) + 1e-9
            liner = np.clip((0.0034 - (r - self.eye_r)) / 0.0026, 0, 1) * np.clip((q[:, 2] / r + 0.12) / 0.4, 0, 1) * \
                np.clip(((q @ g) / r - 0.30) / 0.3, 0, 1)
            w = np.maximum(w, 0.95 * liner)
            q = (P - V(0.068, s * 0.045, 1.182)) / np.array([0.034, 0.017, 0.013])      # hollow under the cheekbone
            w = np.maximum(w, 0.70 * np.exp(-(q * q).sum(1) * 0.8))
            q = (P - V(0.040, s * 0.044, 1.160)) / np.array([0.030, 0.011, 0.012])       # jaw line
            w = np.maximum(w, 0.40 * np.exp(-(q * q).sum(1) * 0.8))
        # temples (gentle)
        for s in (1, -1):
            q = (P - V(0.050, s * 0.058, 1.240)) / np.array([0.018, 0.010, 0.016])
            w = np.maximum(w, 0.30 * np.exp(-(q * q).sum(1) * 0.8))
        return w * (P[:, 2] > 1.12)

    def brow_weight(self, P):
        """0..1 soft brow mask over the brow ridge (vertex-color tint; reads as hair, not a strip)."""
        w = np.zeros(len(P))
        for s in (1, -1):
            E, R = self.eyes[s]
            q = P - E
            lat = s * q[:, 1]                                   # + toward the temple
            t = np.clip((lat + 0.012) / 0.034, 0, 1)            # 0 at the inner head, 1 at the tail
            zc = 0.0105 + 0.0040 * np.sin(np.pi * np.clip(t * 1.15, 0, 1)) - 0.0022 * t   # arched, tail drops
            half = 0.0034 * (1 - 0.60 * t) + 0.0008             # thick head, thin tail
            d = np.abs(q[:, 2] - zc) - half
            core = np.clip(0.5 - d / 0.0026, 0, 1)            # soft, low-contrast: no hard edge, no streaks
            ends = np.clip((lat + 0.012) / 0.008, 0, 1) * np.clip((0.022 - lat) / 0.010, 0, 1)
            w = np.maximum(w, core * ends * (q[:, 0] > -0.015))
        return w

    def head(self):
        base = self.face()
        self.face_node = base
        for s in (1, -1):
            E, _r = self.base.eye(s)
            self.eyes[s] = (E, self.eye_frame(s))
        # no lash geometry: the lids' own shading carries the eyes (soft, wizard-like face)
        base = union(base, self._ear(1), self._ear(-1), k=0.007)
        return base

    def _lid_margin(self, s, upper=True, n=25):
        """Points where the base mesh's lid meets the eyeball, found by marching up (or down) the eye sphere."""
        E, R = self.eyes[s]
        r = self.eye_r + 0.0007
        pts = []
        for a in np.radians(np.linspace(-52, 52, n)):
            els = np.radians(np.linspace(0, 75, 151)) * (1 if upper else -1)
            dirs = np.stack([np.cos(els) * np.cos(a), s * np.cos(els) * np.sin(a), np.sin(els)], 1) @ R.T
            Q = (E + r * dirs).astype(F)
            d = self.face_node.eval(Q, 0.01)
            hit = np.nonzero(d < 0)[0]
            if len(hit) and hit[0] > 0:
                pts.append(Q[hit[0]] + dirs[hit[0]] * 0.0004)
        return pts

    def _lashes(self):
        out = []
        for s in (1, -1):
            up = self._lid_margin(s, True)
            n = len(up)
            if n >= 3:
                radii = [0.00075 + 0.00085 * (i / (n - 1)) ** 1.3 for i in range(n)]
                if s < 0:
                    radii = radii   # lateral ordering is mirrored by the s-signed sweep already
                out.append(chain(up, radii, k=0.0004, mat=M["lash"], part=P_["spine"]))
            low = self._lid_margin(s, False)
            if len(low) >= 3:
                out.append(chain(low[len(low) // 3:], [0.00032] * len(low[len(low) // 3:]), k=0.0003,
                                 mat=M["lash"], part=P_["spine"]))
        return out

    def _brows(self):
        out = []
        for s in (1, -1):
            E, R = self.eyes[s]
            # (lateral offset from the eye center, height above it, radius): inner head -> outer tail
            spec = [(-0.0105, 0.0098, 0.0013), (-0.0040, 0.0118, 0.0015), (0.0030, 0.0131, 0.0014),
                    (0.0100, 0.0135, 0.0012), (0.0165, 0.0124, 0.0009), (0.0215, 0.0102, 0.0005)]
            pts, rad = [], []
            for dy, dz, r in spec:
                start = E + V(0.06, s * dy, dz)
                p = self.snap(self.face_node, start, (-1, 0, 0))
                pts.append(p + V(r * 0.30, 0, 0))
                rad.append(r)
            out.append(chain(pts, rad, k=0.0010, mat=M["brow"], part=P_["spine"]))
        return out

    def _ear(self, s):
        H = self.H
        root = H(-0.015, s * 0.062, -0.002)
        u = norm(V(-0.44, s * 0.66, 0.60))      # along the ear, toward the tip
        n0 = V(0.35, s * 0.9, -0.15)            # roughly outward/forward: the ear's face
        w = norm(n0 - (n0 @ u) * u)
        v = np.cross(w, u)
        Rr = np.stack([u, v, w], 1)
        L, Wd = 0.094, 0.021

        def fn(P):
            q = (P - root) @ Rr
            t = np.clip(q[:, 0] / L, 0, 1)
            wid = Wd * 2.25 * np.power(t + 0.02, 0.42) * np.power(1 - t, 1.05) + 0.0015
            off = 0.004 * (1 - t) * t * 4
            vv = q[:, 1] - off * s
            d2 = np.abs(vv) - wid
            d2 = np.maximum(d2, np.maximum(-q[:, 0] - 0.004, q[:, 0] - L))
            r = np.clip(np.abs(vv) / np.maximum(wid, 1e-4), 0, 1)
            cup = 0.0045 * (1 - r * r) * (1 - t) ** 0.6
            thick = 0.0022 + 0.0018 * (1 - t) + 0.0016 * np.clip((r - 0.75) / 0.25, 0, 1)
            dw = np.abs(q[:, 2] + cup) - thick
            return smax(d2, dw, 0.0018)

        return custom(fn, root - L - 0.01, root + L + 0.01, mat=M["skin"], part=P_["spine"])

Character = Elf
