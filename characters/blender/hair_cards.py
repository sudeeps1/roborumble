# Strand-card hair: thin UV'd ribbons with an alpha strand texture layered over the solid hair volume.
# build() makes the card objects (mesh, UVs, material "hair_card", "_FLOW" strand-direction attribute);
# weights() skins them (head-rigid cards to the head bones, ponytail cards along the hair spring chain).
#
# The solid hair (elf_hair.py) is the dark underlayer. Cards sit 0.5-3 mm above it in layers:
#   cap      hairline -> ponytail tie, traced on the cap surface (base, mid, top layers + loose clumps)
#   ribbons  bangs and side locks: cards across the ribbon width on both faces, tips running past the solid
#   pony     cards wrapped around the ponytail, following its groove twist, peeling onto the three tip clumps
#   wisps    a few flyaways at the hairline, on the crown and off the ponytail
# Every card is a grid of vertices: rows run root -> tip (texture v), columns run across (texture u).
# Texture: one generated atlas (8 columns of strand patterns), color x vertex color "Col", alpha clip.
# Card normals are the underlying hair surface normal (custom normals), so cards light like the volume.
import numpy as np
import bpy

import sdf
from sdf import F, V, union
from sdf import vnoise
from elf_hair import _ss, _smooth_table, _shingles, _clumps
import elf_hair

TEX_W, TEX_H, NCOL = 1024, 512, 8      # strands run along v: half the rows lose nothing visible
DENSE, DENSE_B, CLUMP, CLUMP_B, CAP, CAP_B, WISP, SPLAY = range(NCOL)
TINT = (204, 210, 226)          # sRGB strand tint (vertex color); the texture adds per-strand variation
CUR_TINT = [TINT]                # per character: build() sets it from elf.hair_tint
ALPHA_CUT = 0.42                 # glTF alphaMode MASK cutoff
SEED = 23

PONY_TWIST = -0.4712             # rad per unit s: the ponytail grooves' twist (elf_hair.ponytail groove)
LOCK_DARK = 0.38                 # how much darker cards get down in the underlayer's lock grooves
AO_FLOOR = 0.42                  # vertex color floor in fully occluded spots (under bangs, behind ears)
# How busy the hair is: loose clumps on the cap and ponytail, flyaways and ponytail strays. Kept low for a
# smooth, sleek read (the layered base coverage is unchanged).
N_CAP_CLUMPS = 130
N_PONY_CLUMPS = 28
N_FLYAWAYS = 0
N_BABY_HAIRS = 0
N_PONY_STRAYS = 6


def _lin(c):
    c = np.asarray(c, float) / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _unit(v, axis=-1):
    return v / np.maximum(np.linalg.norm(v, axis=axis, keepdims=True), 1e-12)


# ---------------------------------------------------------------- strand texture

def _paint_column(kind, rng, cw, H):
    """One atlas column: (lum, alpha), each (H, cw); row 0 = v 0 = root."""
    v = (np.arange(H) + 0.5) / H
    x = np.arange(cw) + 0.5
    lum = np.full((H, cw), 0.84)
    A = np.zeros((H, cw))
    m = 7.0
    if kind in (DENSE, DENSE_B):
        n, ncl, conv, wr, lr = 64, 6, (0.04, 0.22), (1.6, 2.8), (0.50, 0.95)
    elif kind in (CLUMP, CLUMP_B):
        n, ncl, conv, wr, lr = 46, 3, (0.12, 0.62), (1.5, 2.6), (0.58, 1.0)
    elif kind == CAP:
        n, ncl, conv, wr, lr = 52, 4, (0.18, 0.32), (1.5, 2.6), (0.56, 1.0)
    elif kind == CAP_B:
        n, ncl, conv, wr, lr = 44, 3, (0.38, 0.52), (1.5, 2.6), (0.56, 1.0)
    elif kind == WISP:
        n, ncl, conv, wr, lr = 11, 2, (0.0, 0.15), (1.3, 2.1), (0.80, 1.0)
    else:  # SPLAY
        n, ncl, conv, wr, lr = 26, 3, (0.30, -0.25), (1.3, 2.3), (0.72, 1.0)
    centers = np.sort(rng.uniform(m + 10, cw - m - 10, ncl))
    for i in range(n):
        if kind in (CLUMP, CLUMP_B, SPLAY):
            x0 = m + (cw - 2 * m) * (rng.random() + rng.random()) / 2       # denser in the middle
        else:
            x0 = rng.uniform(m, cw - m)
        xc = centers[np.argmin(np.abs(centers - x0))]
        cv = conv[0] + (conv[1] - conv[0]) * _ss(0.15, 1.0, v)
        f1, f2 = rng.uniform(0.6, 1.8), rng.uniform(2.5, 5.0)
        amp = rng.uniform(0.6, 2.2) * (2.2 if kind == WISP else 1.0)
        wob = amp * np.sin(2 * np.pi * (f1 * v + rng.random())) + 0.35 * amp * np.sin(2 * np.pi * (f2 * v + rng.random()))
        cx = x0 + (xc - x0) * cv + wob
        cx = np.clip(cx, 3.0, cw - 3.0)
        # where the strand starts and ends (v) and how it tapers
        if kind in (DENSE, DENSE_B):
            v0 = rng.uniform(0.0, 0.015)
            v1 = rng.uniform(0.90, 1.02) if rng.random() < 0.75 else rng.uniform(0.70, 0.92)
            tl, fl = 0.07, 0.01
        elif kind in (CLUMP, CLUMP_B):
            v0 = rng.uniform(0.0, 0.03)
            v1 = rng.uniform(0.80, 1.0) if rng.random() < 0.6 else rng.uniform(0.55, 0.85)
            tl, fl = 0.16, 0.02
        elif kind in (CAP, CAP_B):
            v0 = rng.uniform(0.0, 0.22) ** 1.3
            v1 = 1.2
            tl, fl = 0.1, 0.05
        elif kind == WISP:
            v0 = rng.uniform(0.0, 0.25)
            v1 = rng.uniform(0.6, 1.0)
            tl, fl = 0.2, 0.08
        else:
            v0 = rng.uniform(0.0, 0.05)
            v1 = rng.uniform(0.65, 1.0)
            tl, fl = 0.22, 0.03
        taper = _ss(v1, v1 - tl, v)
        fade = _ss(v0, v0 + fl, v)
        w = rng.uniform(*wr)
        hw = 0.5 * w * (0.3 + 0.7 * taper) * (0.55 + 0.45 * fade)
        a = (taper ** 0.8) * fade * rng.uniform(0.82, 1.0)
        cov = np.clip(hw[:, None] + 0.5 - np.abs(x[None, :] - cx[:, None]), 0, 1)
        ai = cov * a[:, None]
        li = rng.uniform(*lr) * (1 + 0.05 * np.sin(2 * np.pi * (rng.uniform(1, 3) * v + rng.random())))
        lum = lum * (1 - ai) + li[:, None] * ai
        A = 1 - (1 - A) * (1 - ai)
    return lum, A


def strand_atlas():
    img = bpy.data.images.get("hair_strands")
    if img is not None:
        return img
    rng = np.random.default_rng(SEED)
    cw = TEX_W // NCOL
    lum = np.zeros((TEX_H, TEX_W))
    A = np.zeros((TEX_H, TEX_W))
    for c in range(NCOL):
        l, a = _paint_column(c, rng, cw, TEX_H)
        lum[:, c * cw:(c + 1) * cw] = l
        A[:, c * cw:(c + 1) * cw] = a
    img = bpy.data.images.new("hair_strands", TEX_W, TEX_H, alpha=True)
    px = np.concatenate([np.repeat(lum[..., None], 3, -1), A[..., None]], -1)   # sRGB values, straight alpha
    img.pixels = px.astype(np.float32).ravel()
    img.alpha_mode = "STRAIGHT"
    img.file_format = "PNG"
    img.pack()
    return img


def card_material(img):
    mt = bpy.data.materials.get("hair_card")
    if mt is not None:
        return mt
    mt = bpy.data.materials.new("hair_card")
    mt.use_nodes = True
    nt = mt.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Linear"
    ca = nt.nodes.new("ShaderNodeVertexColor")
    ca.layer_name = "Col"
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    sock = lambda socks, ident: next(s for s in socks if s.identifier == ident)
    nt.links.new(ca.outputs["Color"], sock(mix.inputs, "A_Color"))
    nt.links.new(tex.outputs["Color"], sock(mix.inputs, "B_Color"))
    nt.links.new(sock(mix.outputs, "Result_Color"), bsdf.inputs["Base Color"])
    # alpha clip (glTF exporter reads 1 - (alpha < cutoff) as alphaMode MASK + alphaCutoff)
    lt = nt.nodes.new("ShaderNodeMath")
    lt.operation = "LESS_THAN"
    lt.inputs[1].default_value = ALPHA_CUT
    sub = nt.nodes.new("ShaderNodeMath")
    sub.operation = "SUBTRACT"
    sub.inputs[0].default_value = 1.0
    nt.links.new(tex.outputs["Alpha"], lt.inputs[0])
    nt.links.new(lt.outputs[0], sub.inputs[1])
    nt.links.new(sub.outputs[0], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.42
    bsdf.inputs["Sheen Weight"].default_value = 0.25
    bsdf.inputs["Sheen Tint"].default_value = (0.75, 0.82, 1.0, 1)
    mt.use_backface_culling = False
    for attr, val in (("surface_render_method", "DITHERED"), ("blend_method", "HASHED")):
        try:
            setattr(mt, attr, val)
        except (AttributeError, TypeError):
            pass
    return mt


# ---------------------------------------------------------------- card container

class Cards:
    """Accumulates card grids and turns them into one mesh object."""

    def __init__(self):
        self.P, self.N, self.UV, self.C, self.FL, self.Q = [], [], [], [], [], []
        self.nv = 0
        self.count = 0

    def add(self, P, N, col, v=(0.0, 1.0), shade=1.0, wmin=0.0):
        """P, N: (R, K, 3) vertex grid and outward normals (rows root -> tip, columns across).
        col: atlas column. v: texture v at the first and last row (or (R,) per row). shade: scalar, (R,) or (R, K)."""
        P = np.asarray(P, float)
        N = _unit(np.asarray(N, float))
        R, K = P.shape[:2]
        if R < 2 or K < 2 or not np.isfinite(P).all():
            return
        if wmin > 0:      # keep cards from collapsing to slivers where the hair they sit on thins out
            c = P[:, K // 2:K // 2 + 1] if K % 2 else 0.5 * (P[:, K // 2 - 1:K // 2] + P[:, K // 2:K // 2 + 1])
            wid = np.linalg.norm(P[:, -1] - P[:, 0], axis=1)
            sc = np.maximum(1.0, wmin / np.maximum(wid, 1e-6))
            P = c + (P - c) * sc[:, None, None]
        vv = np.asarray(v, float)
        if vv.shape != (R,):
            vv = np.linspace(vv[0], vv[1], R)
        u = (col + 0.04 + 0.92 * np.linspace(0, 1, K)) / NCOL
        UV = np.stack(np.broadcast_arrays(u[None, :], vv[:, None]), -1).reshape(-1, 2)
        idx = self.nv + np.arange(R * K).reshape(R, K)
        q = np.stack([idx[:-1, :-1], idx[:-1, 1:], idx[1:, 1:], idx[1:, :-1]], -1).reshape(-1, 4)
        g = np.cross(P[:-1, 1:] - P[:-1, :-1], P[1:, :-1] - P[:-1, :-1]).sum((0, 1))
        if g @ N.sum((0, 1)) < 0:
            q = q[:, ::-1]
        fl = np.gradient(P, axis=0)
        fl = _unit(fl)
        sh = np.broadcast_to(np.asarray(shade, float).reshape((-1, 1) if np.ndim(shade) == 1 else np.shape(shade) or ()),
                             (R, K))
        self.P.append(P.reshape(-1, 3))
        self.N.append(N.reshape(-1, 3))
        self.UV.append(UV)
        self.C.append(sh.reshape(-1))
        self.FL.append(fl.reshape(-1, 3))
        self.Q.append(q)
        self.nv += R * K
        self.count += 1

    def tris(self):
        return sum(2 * len(q) for q in self.Q)

    def occlude(self, node, floor=AO_FLOOR):
        """Bake ambient occlusion from node (sampled along the card normals) into the vertex shade."""
        if not self.count:
            return
        P = np.concatenate(self.P)
        N = np.concatenate(self.N)
        occ, tot, sca = np.zeros(len(P)), 0.0, 1.0
        for i in range(5):
            hh = 0.004 + 0.006 * i
            d = node.eval((P + N * hh).astype(F), 0.03).astype(float)
            occ += np.clip((hh - d) / hh, 0, 1) * sca
            tot += sca
            sca *= 0.75
        f = floor + (1 - floor) * np.clip(1 - occ / tot * 1.1, 0, 1)
        i = 0
        for k, c in enumerate(self.C):
            self.C[k] = c * f[i:i + len(c)]
            i += len(c)

    def to_object(self, name, scene, mat):
        P = np.concatenate(self.P)
        N = np.concatenate(self.N)
        UV = np.concatenate(self.UV)
        sh = np.concatenate(self.C)
        FL = np.concatenate(self.FL)
        Q = np.concatenate(self.Q)
        me = bpy.data.meshes.new(name)
        me.from_pydata(P.tolist(), [], Q.tolist())
        me.validate()
        ob = bpy.data.objects.new(name, me)
        scene.collection.objects.link(ob)
        lv = np.zeros(len(me.loops), int)
        me.loops.foreach_get("vertex_index", lv)
        uv = me.uv_layers.new(name="UVMap")
        uv.data.foreach_set("uv", UV[lv].astype(np.float32).ravel())
        try:
            me.shade_smooth()
        except AttributeError:
            me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), bool))
        me.normals_split_custom_set_from_vertices(N.tolist())
        at = me.attributes.new("_FLOW", "FLOAT_VECTOR", "POINT")
        at.data.foreach_set("vector", FL.astype(np.float32).ravel())
        rgb = _lin(CUR_TINT[0])[None, :] * sh[:, None]
        col = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        col.data.foreach_set("color", np.concatenate([rgb, np.ones((len(rgb), 1))], 1).astype(np.float32).ravel())
        me.color_attributes.active_color = col
        try:
            me.color_attributes.render_color_index = me.color_attributes.active_color_index
        except AttributeError:
            pass
        me.materials.append(mat)
        return ob


# ---------------------------------------------------------------- sdf helpers

_TET = np.array([[1, -1, -1], [-1, -1, 1], [-1, 1, -1], [1, 1, 1]], float)


def _grad(node, P, h=3e-4):
    """(distance, unit gradient) by a tetrahedral difference."""
    ds = [node.eval((P + h * k).astype(F), 0.02).astype(float) for k in _TET]
    g = sum(k[None, :] * d[:, None] for k, d in zip(_TET, ds))
    return sum(ds) / 4, _unit(g)


def _snap(node, P, off, iters=2):
    for _ in range(iters):
        d, n = _grad(node, P)
        P = P - n * (d - off)[:, None]
    d, n = _grad(node, P)
    return P - n * (d - off)[:, None], n


def _march(node, hc, az, el):
    """Points on node's surface seen from hc at azimuth/elevation (degrees), vectorized elf.surf."""
    a, e = np.radians(az), np.radians(el)
    D = np.stack([np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e)], 1)
    P = hc + D * 0.2
    for _ in range(45):
        P = P - D * (0.9 * node.eval(P.astype(F), 0.05).astype(float))[:, None]
    return P


def _resample(path, n):
    """Polyline (m, 3) -> n points evenly spaced by arc length."""
    seg = np.linalg.norm(np.diff(path, axis=0), axis=1)
    L = np.concatenate([[0], np.cumsum(seg)])
    t = np.linspace(0, L[-1], n)
    return np.stack([np.interp(t, L, path[:, i]) for i in range(3)], 1), L[-1]


def _interp(S, arr, s):
    arr = np.asarray(arr, float)
    if arr.ndim == 1:
        return np.interp(s, S, arr)
    return np.stack([np.interp(s, S, arr[:, i]) for i in range(arr.shape[1])], -1)


def _seg_dist(P, a, b):
    ab = b - a
    t = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


def _closest_on_polyline(P, pts):
    """For each P: (segment index, t in [0, 1], distance) of the closest point on the polyline pts."""
    best = np.full(len(P), np.inf)
    bi = np.zeros(len(P), int)
    bt = np.zeros(len(P))
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        ab = b - a
        t = np.clip(((P - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
        d = np.linalg.norm(P - (a + t[:, None] * ab), axis=1)
        k = d < best
        best[k], bi[k], bt[k] = d[k], i, t[k]
    return bi, bt, best


# ---------------------------------------------------------------- cap

class _Cap:
    def __init__(self, elf):
        self.elf = elf
        self.hc, self.tie, self.td = elf.head_c, elf.tie, elf.tie_dir
        self.skull = union(elf.face_node, elf._cap_node)
        self.g_az, self.g_el, _ = _smooth_table(*elf.HAIRLINE, sigma=4.0)
        H = elf.H
        self.ears = []
        for s in (1, -1):
            root = H(-0.015, s * 0.062, -0.002)
            u = np.array([-0.44, s * 0.66, 0.60])
            u /= np.linalg.norm(u)
            self.ears.append((root - u * 0.006, root + u * 0.05, 0.0125))
        top, up, fn_ = elf.circlet_setting
        self.setting = (top + up * 0.002, top + up * 0.020, 0.0055)

    def el_h(self, az):
        return np.interp(np.abs(az), self.g_az, self.g_el)

    def lock(self, P):
        """Groove depth (0 on a lock's raised edge, 1 deep in the groove) of the cap's lock pattern at P
        (same cells as elf_hair._cap, so card shading lines up with the underlayer grooves)."""
        tie, td = self.tie, self.td
        fwd = _unit(np.cross([0.0, 1.0, 0.0], td))
        g = P - tie
        gl = g - np.outer(g @ td, td)
        ang = np.abs(np.arctan2(gl[:, 1], gl @ fwd))
        c = ang * (22 / (2 * np.pi)) + 0.25 * np.sin(ang * 3 + 1.3) + 0.12 * np.sin(ang * 7 + 0.4) \
            + 0.22 * vnoise(P.astype(F), 12) + 0.5
        return _shingles(c, 1)

    def keepout(self, P, margin, off=0.0):
        """> 0 where P is clear of the ears (and, for cards above the leaf, the circlet setting) by margin."""
        d = np.full(len(P), np.inf)
        for a, b, r in self.ears + ([self.setting] if off > 0.0017 else []):
            d = np.minimum(d, _seg_dist(P, a, b) - r)
        return d - margin

    def hairline_seeds(self, n, inset, rng, az_range=(-180, 180)):
        """n seed points spread evenly (by arc length) along the hairline, `inset` degrees inside it."""
        az = np.linspace(az_range[0], az_range[1], 721)
        line = _march(self.skull, self.hc, az, self.el_h(az) + 2.0)
        L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(line, axis=0), axis=1))])
        t = (np.arange(n) + rng.uniform(0.15, 0.85, n)) / n * L[-1]
        a = np.interp(t, L, az)
        el = self.el_h(a) + np.asarray(inset) * np.ones(n)
        return _march(self.skull, self.hc, a, el), a

    def area_seeds(self, n, rng, el_lo=4.0, el_hi=85.0, pref=None):
        """n seeds scattered over the cap (uniform-ish by area), at least el_lo degrees inside the hairline.
        pref(P) -> acceptance probability, judged on approximate positions before the (slow) surface march."""
        out_p, out_a = [], []
        for _ in range(30):
            if sum(len(p) for p in out_p) >= n:
                break
            m = 4 * n
            az = rng.uniform(-180, 180, m)
            z = rng.uniform(np.sin(np.radians(-40)), np.sin(np.radians(el_hi)), m)
            el = np.degrees(np.arcsin(z))
            k = el > self.el_h(az) + el_lo
            az, el = az[k], el[k]
            if pref is not None:
                a, e = np.radians(az), np.radians(el)
                D = np.stack([np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e)], 1)
                k = rng.random(len(az)) < pref(self.hc + D * 0.092)
                az, el = az[k], el[k]
            need = n - sum(len(p) for p in out_p)
            az, el = az[:need], el[:need]
            out_p.append(_march(self.skull, self.hc, az, el))
            out_a.append(az)
        return np.concatenate(out_p)[:n], np.concatenate(out_a)[:n]

    def trace(self, P, off, step=0.0035, nmax=80):
        """Trace seeds over the offset surface toward the ponytail tie. -> list of (m, 3) paths."""
        tie, td = self.tie, self.td
        P, _ = _snap(self.skull, P, off)
        paths = [P.copy()]
        alive = np.ones(len(P), bool)
        ln = np.ones(len(P), int)
        for _ in range(nmax):
            g = tie - P
            done = ((P - tie) @ td > -0.0062) | (np.linalg.norm(g, axis=1) < 0.0165)
            alive &= ~done
            if not alive.any():
                break
            d, n = _grad(self.skull, P)
            t = _unit(g - (g * n).sum(1)[:, None] * n)
            Pn = P + t * step
            Pn, _ = _snap(self.skull, Pn, off, iters=1)
            P = np.where(alive[:, None], Pn, P)
            ln += alive
            paths.append(P.copy())
        paths = np.stack(paths, 1)
        return [paths[i, :ln[i]] for i in range(len(P))]

    def card(self, path, off, w0, rng, wob=0.0015, rows_per_m=62.0, wmin=0.0024, trim_margin=0.003):
        """Card grid (P, N) along a traced path; None if too short. Width shrinks toward the tie."""
        # drop the part of the path inside the ear / circlet-setting keep-outs (cards start after them)
        ok = self.keepout(path, w0 * 0.5 + trim_margin, off) > 0
        if not ok.all():
            bad = np.nonzero(~ok)[0]
            if bad[-1] < len(path) - 1 and (bad[0] == 0 or bad[-1] < len(path) * 0.4):
                path = path[bad[-1] + 1:]
            else:
                path = path[:bad[0]]
        if len(path) < 3:
            return None
        L = np.linalg.norm(np.diff(path, axis=0), axis=1).sum()
        if L < 0.012:
            return None
        R = int(np.clip(round(L * rows_per_m), 3, 16)) + 1
        C, _ = _resample(path, R)
        d, n = _grad(self.skull, C)
        T = _unit(np.gradient(C, axis=0))
        B = _unit(np.cross(n, T))
        s = np.linspace(0, 1, R)
        tie, td = self.tie, self.td
        g = C - tie
        rp = np.linalg.norm(g - np.outer(g @ td, td), axis=1)
        w = w0 * np.clip(rp / max(rp[0], 1e-3), 0.3, 1.0)
        w = np.maximum(w, wmin)
        C = C + B * (wob * np.sin(2 * np.pi * (rng.uniform(0.5, 1.3) * s + rng.random())) * (1 - s ** 2))[:, None]
        cols = np.stack([C - B * (w / 2)[:, None], C + B * (w / 2)[:, None]], 1)
        flat = cols.reshape(-1, 3)
        flat, nn = _snap(self.skull, flat, off)
        self.last_lock = self.lock(flat).reshape(R, 2)
        return flat.reshape(R, 2, 3), nn.reshape(R, 2, 3), s, L


def cap_cards(elf, cards, rng, log):
    cap = _Cap(elf)
    layers = [  # off, count, inset (deg), width (m), atlas columns, v range, shade
        dict(off=0.0006, n=160, inset=(-0.7, 0.4), w=(0.009, 0.013), cols=(DENSE, DENSE_B), v=(0.0, 0.84), shade=0.50),
        dict(off=0.0013, n=130, inset=(-0.3, 1.2), w=(0.007, 0.011), cols=(CAP, CAP), v=(0.0, 1.0), shade=0.66),
        dict(off=0.0020, n=100, inset=(0.8, 4.0), w=(0.006, 0.010), cols=(CAP, CAP_B), v=(0.0, 1.0), shade=0.80),
    ]
    for li, ly in enumerate(layers):
        seeds, _ = cap.hairline_seeds(ly["n"], rng.uniform(*ly["inset"], ly["n"]), rng)
        paths = cap.trace(seeds, ly["off"])
        for path in paths:
            c = cap.card(path, ly["off"], rng.uniform(*ly["w"]), rng)
            if c is None:
                continue
            P, N, s, L = c
            shade = ly["shade"] * rng.uniform(0.86, 1.08) * (1 - 0.22 * _ss(0.75, 1.0, s))
            shade = shade[:, None] * (1 - LOCK_DARK * cap.last_lock ** 1.4)
            cards.add(P, N, ly["cols"][rng.integers(2)], ly["v"], shade)
    # loose clumps on top: start anywhere on the cap and run to the tie
    n_top = N_CAP_CLUMPS
    # mostly on the lock crests
    seeds, _ = cap.area_seeds(n_top, rng, el_lo=3.0, pref=lambda P: (1 - cap.lock(P)) ** 2.5)
    n_top = len(seeds)
    for k, off in enumerate((0.0025, 0.0030)):     # two offset bands so neighbouring clumps don't z-fight
        sel = np.arange(n_top)[k::2]
        paths = cap.trace(seeds[sel], off)
        for path in paths:
            c = cap.card(path, off, rng.uniform(0.004, 0.0075), rng, wob=0.002)
            if c is None:
                continue
            P, N, s, L = c
            shade = rng.uniform(0.86, 1.06) * (1 - 0.2 * _ss(0.75, 1.0, s))
            shade = shade[:, None] * (1 - LOCK_DARK * cap.last_lock ** 1.4)
            cards.add(P, N, (CAP_B, CAP_B, WISP)[rng.integers(3)], (0.0, 1.0), shade)
    return cap


# ---------------------------------------------------------------- ribbons (bangs, side locks)

def _lens_v(u, a, b):
    """Outer surface height of a lens of half width a, half thickness b at u (and its slope)."""
    a = np.maximum(a, 1e-4)
    b = np.clip(b, 1e-5, a)
    r = (a * a / b + b) * 0.5
    dd = r - b
    uc = np.clip(u, -0.985 * a, 0.985 * a)
    root = np.sqrt(np.maximum(r * r - uc * uc, 1e-12))
    return root - dd, -uc / root


def ribbon_cards(elf, cards, rng, log):
    face = elf.face_node
    for sw in [s for s in elf.sweeps if s["tag"][0] in ("bang", "lock")]:
        kind, side, idx = sw["tag"]
        pts, hw, ht = sw["pts"], sw["hw"], sw["ht"]
        T, N, Wd = elf._frames(pts, sw["nrm"])
        seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        Ltot = seg.sum()
        S = np.concatenate([[0], np.cumsum(seg)]) / Ltot
        big = hw.max() > 0.008
        ext = (0.09 if kind == "bang" else 0.06) if big else 0.12      # how far tips run past the solid (fraction)

        def frame_at(s):
            sc = np.clip(s, 0, 1)
            C = _interp(S, pts, sc) + np.outer(np.maximum(s - 1, 0) * Ltot, T[-1])
            return (C, _unit(_interp(S, T, sc)), _unit(_interp(S, N, sc)), _unit(_interp(S, Wd, sc)),
                    np.maximum(_interp(S, hw, sc), 0.0012), _interp(S, ht, sc))

        # the solid ribbon's strand grooves (elf_hair._ribbon_groove): count and seed per ribbon
        gn, gseed = {("bang", 0): (3, 3), ("bang", 1): (2, 7), ("lock", 0): (3, 11 + side),
                     ("lock", 1): (2, 17 + side)}[(kind, idx)]

        def groove(us, s):
            c = (us + 1) * 0.5 * gn + 0.18 * np.sin(s[:, None] * 6 + gseed)
            fade = _ss(0.0, 0.12, s) * (1 - _ss(0.8, 1.0, s))
            return _clumps(c, gseed) * fade[:, None]

        n_out = 6 if big else 4
        specs = []   # (u center (-1..1) or crest index, half span (fraction of hw), off, outer?, col, s0, s1, shade)
        for j, uc in enumerate(np.linspace(-0.78, 0.78, n_out)):
            specs.append((uc + rng.uniform(-0.06, 0.06), 0.42, 0.0006, True, (DENSE, DENSE_B)[j % 2], 0.0,
                          1.0 + rng.uniform(0.0, ext * 0.5), 0.56))
        for j, uc in enumerate(np.linspace(-0.65, 0.65, n_out - 1)):
            specs.append((uc + rng.uniform(-0.08, 0.08), 0.38, 0.0014, True, (CLUMP, CLUMP_B)[j % 2],
                          rng.uniform(0.0, 0.08), 1.0 + rng.uniform(0.2, 1.0) * ext, 0.76))
        for j in range(gn + 1):          # top layer rides the strand crests
            specs.append((("crest", j % gn, rng.uniform(-0.08, 0.08)), 0.30, 0.0022, True,
                          (CLUMP, SPLAY, CLUMP_B)[j % 3], rng.uniform(0.0, 0.25), 1.0 + rng.uniform(-0.1, 1.0) * ext, 0.98))
        for j, uc in enumerate(np.linspace(-0.6, 0.6, n_out - 2)):
            specs.append((uc, 0.45, 0.0006, False, (DENSE, DENSE_B)[j % 2], 0.0, 1.0 + rng.uniform(0, 0.4) * ext, 0.5))
        for uc, hs, off, outer, col, s0, s1, shade in specs:
            R = int(np.clip(round((s1 - s0) * Ltot * 110), 5, 26)) + 1
            s = np.linspace(s0, s1, R)
            C, Tt, Nn, Ww, a, b = frame_at(s)
            spread = 1 + 0.9 * _ss(0.8, 1.0 + ext, s)            # tips fan out a little past the solid
            if isinstance(uc, tuple):
                _, ci, jit = uc
                ucr = 2 * (ci + 0.5 - 0.18 * np.sin(np.clip(s, 0, 1) * 6 + gseed) / 1.0) / gn - 1 + jit
            else:
                ucr = np.full(R, uc)
            us = (ucr[:, None] + np.array([-hs, 0.0, hs])[None, :]) * spread[:, None]
            u = us * a[:, None]
            vv, dv = _lens_v(u, a[:, None], b[:, None])
            beyond = np.abs(us) > 0.985
            vv = np.where(beyond, 0.0, vv)
            dv = np.where(beyond, 0.0, dv)
            sg = 1.0 if outer else -1.0
            nrm = _unit(Nn[:, None, :] * sg - Ww[:, None, :] * (dv * sg)[..., None])
            P = C[:, None, :] + Ww[:, None, :] * u[..., None] + Nn[:, None, :] * (sg * vv)[..., None] + nrm * off
            # keep off the skin
            flat = P.reshape(-1, 3)
            d, g = _grad(face, flat)
            push = np.maximum(0.0012 - d, 0)
            flat = flat + g * push[:, None]
            P = flat.reshape(P.shape)
            sh = shade * rng.uniform(0.88, 1.06) * (1 - LOCK_DARK * groove(np.clip(us, -1, 1), np.clip(s, 0, 1)) ** 1.2)
            cards.add(P, nrm, col, (0.0, 1.0), sh, wmin=0.0025)


# ---------------------------------------------------------------- ponytail

class _Pony:
    def __init__(self, elf):
        d = elf.pony
        self.pts, self.S, self.Tn, self.Nn, self.Wn = d["pts"], d["S"], d["T"], d["Nn"], d["Wn"]
        self.hw, self.ht = d["hw"], d["ht"]
        self.L = np.linalg.norm(np.diff(self.pts, axis=0), axis=1).sum()
        self.clumps = elf.pony_clumps
        from elf_hair import UNDER_PONY
        self.under = UNDER_PONY

    def frame(self, s):
        sc = np.clip(s, 0, 1)
        T = _unit(_interp(self.S, self.Tn, sc))
        past = np.maximum(s - 1, 0) * self.L
        C = _interp(self.S, self.pts, sc) + past[:, None] * _unit(self.Tn[-1])
        return (C, T, _unit(_interp(self.S, self.Nn, sc)), _unit(_interp(self.S, self.Wn, sc)),
                np.maximum(_interp(self.S, self.hw, sc), 0.0012), np.maximum(_interp(self.S, self.ht, sc), 0.001))

    def groove(self, s, phi, a, b):
        """(carve depth m, normalized 0..1) of the ponytail's clump grooves (elf_hair.ponytail groove)."""
        ss = (s * self.L + 0.012) / (self.L + 0.012)          # the sweep also has the buried start point
        c = phi * (6 / (2 * np.pi)) + 0.45 * ss[:, None] + 0.2 * np.sin(phi * 2 + 1)
        k = 2 * np.pi * np.minimum(a, b) / 6 / 5.8
        g = _clumps(c, 21, 6, lo=0.6)
        return elf_hair.PONY_GROOVE * 0.62 * k[:, None] * g * _ss(0.03, 0.11, ss)[:, None], g

    def body(self, s, phi, off):
        """Points on the ponytail ellipse (+off along its normal, following the grooves) at rows s and angles
        phi (R, K). Also sets self.last_groove (R, K) in 0..1."""
        C, T, N, W, a, b = self.frame(s)
        c, sn = np.cos(phi), np.sin(phi)
        E = C[:, None] + W[:, None] * (a[:, None] * c)[..., None] + N[:, None] * (b[:, None] * sn)[..., None]
        n = _unit(W[:, None] * (c / a[:, None])[..., None] + N[:, None] * (sn / b[:, None])[..., None])
        dep, g = self.groove(s, phi, a, b)
        dep = np.where(s[:, None] > 1, 0.0, dep)
        self.last_groove = g * _ss(0.03, 0.11, s)[:, None]
        return E + n * (off - dep)[..., None], n

    def clump(self, k, s, psi, off):
        """Points around tip clump k at rows s, angle psi around the clump (0 = facing out)."""
        ph, s0, s1, r0, spread = self.clumps[k]
        x = (s - s0) / (s1 - s0)
        xc = np.clip(x, 0, 1)
        phs = ph + 0.5 * xc
        C, T, N, W, a, b = self.frame(np.minimum(s, s1))
        rad = W * np.cos(phs)[:, None] + N * np.sin(phs)[:, None]
        tan = -W * np.sin(phs)[:, None] + N * np.cos(phs)[:, None]
        cp = C + rad * (0.0085 + spread * _ss(0.15, 1.0, xc))[:, None]
        # past the clump end: carry on along the clump's own direction
        past = np.maximum(s - s1, 0) * self.L
        if past.any():
            e1 = self.clump_end(k)
            cp = cp + np.outer(past, e1)
        rc = (r0 * (1 - xc) ** 0.75 * (0.85 + 0.15 * np.sin(np.pi * np.clip(xc * 1.6, 0, 1))) + 0.0006) * self.under
        rc = np.maximum(rc, 0.0018)
        ca, sa = 0.78 * rc, rc
        c, sn = np.cos(psi), np.sin(psi)
        E = cp[:, None] + rad[:, None] * (ca[:, None] * c)[..., None] + tan[:, None] * (sa[:, None] * sn)[..., None]
        n = _unit(rad[:, None] * (c / ca[:, None])[..., None] + tan[:, None] * (sn / sa[:, None])[..., None])
        return E + n * off, n

    def clump_end(self, k):
        ph, s0, s1, r0, spread = self.clumps[k]
        ss = np.array([s1 - 0.03, s1])
        p, _ = self.clump(k, ss, np.zeros((2, 1)), 0.0)
        return _unit(p[1, 0] - p[0, 0])

    def nearest_clump(self, phi_at_tip):
        best, bk = 9.0, 0
        for k, (ph, *_r) in enumerate(self.clumps):
            d = abs((phi_at_tip - (ph + 0.2) + np.pi) % (2 * np.pi) - np.pi)
            if d < best:
                best, bk = d, k
        return bk

    def territory(self, k):
        """Angular half widths (left, right) of clump k's share of the ponytail around its phase."""
        phs = [c[0] + 0.2 for c in self.clumps]
        p = phs[k]
        others = [((q - p + np.pi) % (2 * np.pi)) - np.pi for j, q in enumerate(phs) if j != k]
        right = min([o for o in others if o > 0], default=np.pi)
        left = -max([o for o in others if o < 0], default=-np.pi)
        return left / 2, right / 2

    def crest(self, j, s):
        """Angle (param) of groove crest j (0..5) at rows s (the grooves wind a little around the ponytail)."""
        ss = (s * self.L + 0.012) / (self.L + 0.012)
        phi = (j + 0.5 - 0.45 * ss) * 2 * np.pi / 6
        for _ in range(6):
            phi = (j + 0.5 - 0.45 * ss - 0.2 * np.sin(phi * 2 + 1)) * 2 * np.pi / 6
        return phi

    def card(self, phi0, dphi, off, s0, s1, rows_per_m=66.0, tip=True, crest=None):
        R = int(np.clip(round((s1 - s0) * self.L * rows_per_m), 4, 44)) + 1
        s = np.linspace(s0, s1, R)
        phi = phi0 + PONY_TWIST * s
        if crest is not None:                     # ride on groove crest `crest`, offset by phi0
            phi = self.crest(crest, s) + phi0
        cols = phi[:, None] + np.array([-0.5, 0.0, 0.5])[None, :] * dphi
        P, N = self.body(s, cols, off)
        if tip and s1 > 0.6:
            phi_t = phi[min(np.searchsorted(s, 0.75), R - 1)]
            k = self.nearest_clump(phi_t)
            left, right = self.territory(k)
            ph = self.clumps[k][0] + 0.2
            dl = ((cols - (ph + 0.5 * np.clip((s[:, None] - self.clumps[k][1]) / (self.clumps[k][2] - self.clumps[k][1]), 0, 1))
                   + np.pi) % (2 * np.pi)) - np.pi
            psi = np.where(dl >= 0, dl / max(right, 0.3), dl / max(left, 0.3)) * np.pi * 0.92
            Pc, Nc = self.clump(k, s, psi, off)
            beta = _ss(0.56, 0.74, s)[:, None, None]
            P = P * (1 - beta) + Pc * beta
            N = _unit(N * (1 - beta) + Nc * beta)
            self.last_groove = self.last_groove * (1 - beta[..., 0])
        return P, N, s


def pony_cards(elf, cards, rng, log):
    pony = _Pony(elf)
    layers = [  # count, off, angular overlap, columns, s_end range, s_start range, shade
        dict(n=20, off=0.0007, ov=1.7, cols=(DENSE, DENSE_B), s1=(0.95, 1.04), s0=(0.0, 0.0), shade=0.52),
        dict(n=20, off=0.0015, ov=1.25, cols=(CLUMP, CLUMP_B), s1=(0.88, 1.08), s0=(0.0, 0.02), shade=0.72),
        dict(n=18, off=0.0023, ov=1.0, cols=(CLUMP, CLUMP_B, SPLAY), s1=(0.80, 1.12), s0=(0.0, 0.2), shade=0.88),
    ]
    for li, ly in enumerate(layers):
        n = ly["n"]
        ph0 = rng.uniform(0, 2 * np.pi)
        for j in range(n):
            dphi = 2 * np.pi / n * ly["ov"] * rng.uniform(0.9, 1.1)
            s0, s1 = rng.uniform(*ly["s0"]), rng.uniform(*ly["s1"])
            if li == 2:      # top layer rides the clump crests, so the grooves between show the darker layers
                P, N, s = pony.card(rng.uniform(-0.18, 0.18), dphi, ly["off"], s0, s1, crest=j % 6)
            else:
                phi0 = ph0 + 2 * np.pi * (j + rng.uniform(-0.2, 0.2)) / n
                P, N, s = pony.card(phi0, dphi, ly["off"], s0, s1)
            root = _ss(0.0, 0.07, s)
            shade = ly["shade"] * rng.uniform(0.86, 1.08) * (0.62 + 0.38 * root)
            shade = shade[:, None] * (1 - LOCK_DARK * pony.last_groove ** 1.2)
            v0 = 0.0 if s0 < 0.01 else 0.04
            cards.add(P, N, ly["cols"][j % len(ly["cols"])], (v0, 1.0), shade, wmin=0.003)
    # short loose clumps over the top
    for j in range(N_PONY_CLUMPS):
        s0 = rng.uniform(0.04, 0.62)
        s1 = min(s0 + rng.uniform(0.14, 0.38), 1.08)
        P, N, s = pony.card(rng.uniform(-0.3, 0.3), rng.uniform(0.18, 0.32), rng.uniform(0.0027, 0.0032), s0, s1,
                            crest=j % 6)
        shade = rng.uniform(0.88, 1.06) * (1 - LOCK_DARK * pony.last_groove ** 1.2)
        if j % 3 == 0:     # some locks bow out a little, so the silhouette isn't a clean tube
            x = (s - s0) / max(s1 - s0, 1e-6)
            P = P + N * (rng.uniform(0.001, 0.003) * np.sin(np.pi * x) ** 1.5)[:, None, None]
        cards.add(P, N, (CLUMP, CLUMP_B, WISP, SPLAY)[j % 4], (0.03, 1.0), shade, wmin=0.003)
    return pony


# ---------------------------------------------------------------- flyaways

def wisp_cards(elf, cap, pony, head_cards, pony_cards_, rng, log):
    # crown / hairline flyaways: short strands that leave the cap and arc back down
    n = N_FLYAWAYS
    paths = cap.trace(cap.area_seeds(n, rng, el_lo=2.0)[0], 0.0025, step=0.004, nmax=22) if n else []
    for path in paths:
        if len(path) < 6:
            continue
        m = rng.integers(6, min(len(path), 22) + 1)
        p = path[:m]
        c = cap.card(p, 0.0025, rng.uniform(0.0022, 0.0035), rng, wob=0.0012, rows_per_m=140, wmin=0.0018)
        if c is None:
            continue
        P, N, s, L = c
        lift = rng.uniform(0.0015, 0.0045) * np.sin(np.pi * np.clip(s * rng.uniform(0.75, 1.0), 0, 1)) ** 1.2
        P = P + N * lift[:, None, None]
        head_cards.add(P, N, (WISP, SPLAY)[rng.integers(2)], (0.05, 0.95), rng.uniform(0.95, 1.08))
    # baby hairs along the front/temple hairline
    if N_BABY_HAIRS:
        seeds, az = cap.hairline_seeds(N_BABY_HAIRS, rng.uniform(-0.6, 0.6, N_BABY_HAIRS), rng, az_range=(-100, 100))
        seeds = seeds[np.abs(az) > 14]
        paths = cap.trace(seeds, 0.0010, step=0.003, nmax=8)
    else:
        paths = []
    for path in paths:
        c = cap.card(path, 0.0010, rng.uniform(0.003, 0.005), rng, wob=0.0006, rows_per_m=200, wmin=0.002)
        if c is None:
            continue
        P, N, s, L = c
        P = P + N * (rng.uniform(0.0004, 0.0015) * s ** 2)[:, None, None]
        head_cards.add(P, N, WISP, (0.0, 0.8), rng.uniform(0.92, 1.05))
    # ponytail strays: strands that peel off the ponytail surface
    for j in range(N_PONY_STRAYS):
        phi0 = rng.uniform(0, 2 * np.pi)
        s0 = rng.uniform(0.08, 0.75)
        s1 = min(s0 + rng.uniform(0.08, 0.2), 1.05)
        P, N, s = pony.card(phi0, rng.uniform(0.05, 0.09), 0.003, s0, s1, rows_per_m=90, tip=False)
        x = (s - s0) / (s1 - s0)
        P = P + N * (rng.uniform(0.004, 0.014) * x ** 1.6)[:, None, None]
        pony_cards_.add(P, N, (WISP, SPLAY)[j % 2], (0.0, 1.0), rng.uniform(0.95, 1.08), wmin=0.002)


# ---------------------------------------------------------------- hooks

def build(elf, scene, pony_pts, log):
    CUR_TINT[0] = getattr(elf, "hair_tint", TINT)
    """-> {object name: bpy object}"""
    log("hair cards")
    rng = np.random.default_rng(SEED)
    img = strand_atlas()
    mat = card_material(img)
    head = Cards()
    pony = Cards()
    cap = cap_cards(elf, head, rng, log)
    log(f"  cap: {head.count} cards")
    ribbon_cards(elf, head, rng, log)
    log(f"  + ribbons: {head.count} cards")
    pz = pony_cards(elf, pony, rng, log)
    wisp_cards(elf, cap, pz, head, pony, rng, log)
    # occlusion: bangs/locks shade the cap under them, ears and the ponytail root shade what's behind them
    pp = elf.pony["pts"][::6]
    pr = elf.pony["hw"][::6] * 0.85
    occ = union(elf._hair_node, elf.face_node, elf._ear(1), elf._ear(-1), sdf.chain(list(pp), list(pr)))
    head.occlude(occ)
    pony.occlude(union(elf._hair_node, elf.face_node))
    log("  occlusion baked")
    out = {}
    for name, cs in (("HairCards", head), ("HairCardsPony", pony)):
        if cs.count:
            out[name] = cs.to_object(name, scene, mat)
            log(f"  {name}: {cs.count} cards, {cs.tris()} tris, {cs.nv} verts")
    return out


def weights(name, P, rig, pony_joints, pony_names):
    """-> {bone name: (N,) weights}"""
    if name == "HairCardsPony":
        return rig.chain_param_weights(P, pony_joints, pony_names, [0.02, 0.025, 0.03, 0.03])
    return rig.spine_weights(P)


def flow(elf, P, piece_name):
    """Strand direction (unit vectors, world/MuJoCo frame) for every vertex of a solid piece, or None.
    Only matters on hair; build.py calls it for every SDF piece."""
    P = np.asarray(P, float)
    if piece_name == "Head":
        skull = union(elf.face_node, elf._cap_node)
        _, n = _grad(skull, P)
        g = elf.tie - P
        fl = _unit(g - (g * n).sum(1)[:, None] * n)          # cap: hairline -> tie
        best = np.full(len(P), np.inf)
        for sw in elf.sweeps:
            if sw["tag"][0] not in ("bang", "lock"):
                continue
            pts = sw["pts"]
            T, _, _ = elf._frames(pts, sw["nrm"])
            i, t, d = _closest_on_polyline(P, pts)
            a = sw["hw"][i] + (sw["hw"][i + 1] - sw["hw"][i]) * t
            score = d - a                                    # < 0: within the ribbon's half width
            k = (score < 0.002) & (score < best)
            Tt = _unit(T[i] * (1 - t)[:, None] + T[i + 1] * t[:, None])
            fl[k] = Tt[k]
            best[k] = score[k]
        return _unit(fl)
    if piece_name == "Ponytail":
        best = np.full(len(P), np.inf)
        fl = np.zeros_like(P)
        for sw in elf.sweeps:
            if sw["tag"][0] not in ("pony", "pony_clump"):
                continue
            pts = sw["pts"]
            T, _, _ = elf._frames(pts, sw["nrm"])
            i, t, d = _closest_on_polyline(P, pts)
            a = np.maximum(sw["hw"][i] + (sw["hw"][i + 1] - sw["hw"][i]) * t, 1e-3)
            score = d / a
            k = score < best
            Tt = _unit(T[i] * (1 - t)[:, None] + T[i + 1] * t[:, None])
            fl[k] = Tt[k]
            best[k] = score[k]
        return _unit(fl)
    return None
