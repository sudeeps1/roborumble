# Shared look for imported (textured) characters, so they match the sculpted ones: painted-not-photographed
# surfaces, moderate saturation with one accent, matte finish. Operates on Blender images in place.
import numpy as np

TEX = 1024


def _blur(a, r):
    """Cheap separable box blur (r pixels) on an (H, W, C) array."""
    k = 2 * r + 1
    c = np.cumsum(np.pad(a, ((r + 1, r), (0, 0), (0, 0)), mode="edge"), 0)
    a = (c[k:] - c[:-k]) / k
    c = np.cumsum(np.pad(a, ((0, 0), (r + 1, r), (0, 0)), mode="edge"), 1)
    return (c[:, k:] - c[:, :-k]) / k


def paint_flatten(rgb, r=3, keep=0.45):
    """Painterly flattening: pull each pixel toward its local mean except across strong edges."""
    m = _blur(rgb, r)
    edge = np.abs(rgb - m).sum(-1, keepdims=True)
    w = np.clip(1 - edge / 0.25, 0, 1) * (1 - keep)
    return rgb * (1 - w) + m * w


def grade(rgb, vibrance=0.35, sat_cap=0.72, lift=0.03, gamma=0.92, warm=0.02):
    """Shared color grade: vibrance (boosts dull colors more than vivid ones), saturation cap, lifted shadows,
    slight warm highlights / cool shadows."""
    mx = rgb.max(-1, keepdims=True)
    mn = rgb.min(-1, keepdims=True)
    sat = (mx - mn) / np.maximum(mx, 1e-4)
    lum = (rgb * np.array([0.2126, 0.7152, 0.0722])).sum(-1, keepdims=True)
    boost = 1 + vibrance * (1 - sat)
    rgb = lum + (rgb - lum) * boost
    mx = rgb.max(-1, keepdims=True)
    mn = rgb.min(-1, keepdims=True)
    sat = (mx - mn) / np.maximum(mx, 1e-4)
    over = np.clip(sat - sat_cap, 0, None) / np.maximum(sat, 1e-4)
    rgb = rgb - (rgb - lum) * over
    rgb = lift + (1 - lift) * np.clip(rgb, 0, 1) ** gamma
    lum = (rgb * np.array([0.2126, 0.7152, 0.0722])).sum(-1, keepdims=True)
    rgb = rgb + warm * (lum - 0.5) * np.array([1.0, 0.3, -1.0])
    return np.clip(rgb, 0, 1)


def stylize_image(img, flatten=True, **kw):
    """Scale a Blender image to TEX x TEX and apply the shared look."""
    if img.size[0] != TEX or img.size[1] != TEX:
        img.scale(TEX, TEX)
    a = np.array(img.pixels[:], np.float32).reshape(TEX, TEX, 4)
    rgb = a[..., :3]
    if flatten:
        rgb = paint_flatten(rgb)
    a[..., :3] = grade(rgb, **kw)
    img.pixels = a.ravel().tolist()
    return img


def matte(rough_img, metal_img=None, rough_floor=0.55, metal_scale=0.6):
    """Matte finish: raise roughness, tame metalness."""
    for img, fn in ((rough_img, lambda x: rough_floor + (1 - rough_floor) * x),
                    (metal_img, lambda x: x * metal_scale)):
        if img is None:
            continue
        a = np.array(img.pixels[:], np.float32).reshape(-1, 4)
        a[:, :3] = fn(a[:, :3])
        img.pixels = a.ravel().tolist()
