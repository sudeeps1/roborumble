# Skeleton + skin weights. Bones are named after the G1 bodies that drive them; a few extra bones are
# "virtual" (driven by a body with a fixed offset) or springs (simulated at runtime).
import numpy as np

import g1
from sdf import V, norm

LIMB_NAMES = {
    "arm": ["shoulder_pitch_link", "shoulder_roll_link", "shoulder_yaw_link", "elbow_link",
            "wrist_roll_link", "wrist_pitch_link", "wrist_yaw_link"],
    "leg": ["hip_pitch_link", "hip_roll_link", "hip_yaw_link", "knee_link", "ankle_pitch_link", "ankle_roll_link"],
}


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


class Rig:
    def __init__(self, W, elf):
        self.W = W
        p = lambda n: W[n][:3, 3].copy()
        # bone: (parent, head, tail, driver body or None for springs)
        B = {}
        B["pelvis"] = (None, p("pelvis"), p("torso_link") + V(0, 0, 0.02), "pelvis")
        B["torso_link"] = ("pelvis", p("torso_link") + V(0, 0, 0.02), V(-0.01, 0, 1.10), "torso_link")
        B["neck"] = ("torso_link", V(-0.01, 0, 1.10), V(0.0, 0, 1.17), "torso_link")
        B["head"] = ("neck", V(0.0, 0, 1.17), V(0.0, 0, 1.33), "torso_link")
        for s in (1, -1):
            side = "left_" if s > 0 else "right_"
            arm = [side + n for n in LIMB_NAMES["arm"]]
            ends = [p(n) for n in arm[1:]] + [p(arm[-1]) + W[arm[-1]][:3, :3] @ V(0.08, 0, 0)]
            parent = "torso_link"
            for n, tail in zip(arm, ends):
                B[n] = (parent, p(n), tail, n)
                parent = n
            leg = [side + n for n in LIMB_NAMES["leg"]]
            ends = [p(n) for n in leg[1:]] + [p(leg[-1]) + V(0.13, 0, -0.01)]
            parent = "pelvis"
            for n, tail in zip(leg, ends):
                B[n] = (parent, p(n), tail, n)
                parent = n
        self.bones = B
        self.springs = []

    def add_chain(self, name, parent, pts, nseg):
        """Spring chain along a polyline: nseg bones named name_0.. with evenly split points."""
        pts = np.asarray(pts)
        seg = np.cumsum([0] + [np.linalg.norm(pts[i + 1] - pts[i]) for i in range(len(pts) - 1)])
        marks = np.linspace(0, seg[-1], nseg + 1)
        joints = [pts[0]] + [self._along(pts, seg, m) for m in marks[1:]]
        names = []
        par = parent
        for i in range(nseg):
            bn = f"{name}_{i}"
            self.bones[bn] = (par, joints[i], joints[i + 1], None)
            names.append(bn)
            par = bn
        self.springs.append({"name": name, "bones": names})
        return names, joints

    @staticmethod
    def _along(pts, seg, m):
        i = min(np.searchsorted(seg, m) - 1, len(pts) - 2)
        i = max(i, 0)
        t = (m - seg[i]) / max(seg[i + 1] - seg[i], 1e-9)
        return pts[i] + (pts[i + 1] - pts[i]) * t

    # ------------------------------------------------------------ weights
    @staticmethod
    def chain_weights(s, joints_s, radii, bones):
        """s: (N,) param along a chain. joints_s[i] is where bone i hands over to bone i+1 (len = len(bones)-1).
        Returns {bone: (N,) weight}, summing to 1."""
        steps = [np.ones_like(s)] + [smoothstep(j - r, j + r, s) for j, r in zip(joints_s, radii)] + [np.zeros_like(s)]
        return {b: steps[i] - steps[i + 1] for i, b in enumerate(bones)}

    def spine_weights(self, P):
        z = P[:, 2]
        return self.chain_weights(z, [0.862, 1.115, 1.165], [0.034, 0.02, 0.02], ["pelvis", "torso_link", "neck", "head"])

    def leg_weights(self, P, s):
        side = "left_" if s > 0 else "right_"
        bones = ["pelvis"] + [side + n for n in LIMB_NAMES["leg"]]
        z = -P[:, 2]   # param grows downward
        js = [-0.735, -0.680, -0.585, -0.362, -0.078, -0.046]
        rs = [0.028, 0.02, 0.06, 0.034, 0.028, 0.014]
        return self.chain_weights(z, js, rs, bones)

    def arm_weights(self, P, s):
        side = "left_" if s > 0 else "right_"
        names = [side + n for n in LIMB_NAMES["arm"]]
        p = lambda n: self.W[n][:3, 3]
        pts = [V(-0.01, s * 0.06, 1.08)] + [p(n) for n in names] + [p(names[-1]) + self.W[names[-1]][:3, :3] @ V(0.1, 0, 0)]
        pts = np.asarray(pts)
        sp = self._project(P, pts)
        L = np.cumsum([0] + [np.linalg.norm(pts[i + 1] - pts[i]) for i in range(len(pts) - 1)])
        # handover points: shoulder pitch, roll, yaw (mid upper arm), elbow, mid forearm (twist), wrist pitch, wrist yaw
        el, wr = L[4], L[5]
        js = [L[1] + 0.004, L[2], L[3], el + 0.002, el + 0.62 * (wr - el), L[6], L[7] - 0.004]
        rs = [0.026, 0.018, 0.05, 0.024, 0.032, 0.014, 0.012]
        return self.chain_weights(sp, js, rs, ["torso_link"] + names)

    def chain_param_weights(self, P, joints, bones, radii):
        joints = np.asarray(joints)
        sp = self._project(P, joints)
        L = np.cumsum([0] + [np.linalg.norm(joints[i + 1] - joints[i]) for i in range(len(joints) - 1)])
        return self.chain_weights(sp, list(L[1:-1]), radii, bones)

    @staticmethod
    def _project(P, pts):
        """Arc-length parameter of each point's closest point on the polyline."""
        best = np.full(len(P), np.inf)
        out = np.zeros(len(P))
        acc = 0.0
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            ab = b - a
            l2 = ab @ ab
            t = np.clip(((P - a) @ ab) / l2, 0, 1)
            if i == 0:
                t = np.minimum(((P - a) @ ab) / l2, 1)      # allow before the start
            if i == len(pts) - 2:
                t = np.maximum(((P - a) @ ab) / l2, 0)      # and past the end
            q = a + t[:, None] * ab
            d = ((P - q) ** 2).sum(1)
            better = d < best
            best[better] = d[better]
            out[better] = acc + t[better] * np.sqrt(l2)
            acc += np.sqrt(l2)
        return out
