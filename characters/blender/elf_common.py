# Shared tables for the elf sculpt (see elf.py).
import numpy as np

# materials (index -> name; name is what the runtime keys its shaders on)
MATS = ["skin", "lips", "hair", "brow", "lash", "tunic", "leather", "leather_dark", "gold", "gem", "rune",
        "wrap", "legging", "boot", "mouth", "leather_green"]
M = {n: i for i, n in enumerate(MATS)}
# body parts for skinning
PARTS = ["spine", "l_arm", "r_arm", "l_leg", "r_leg", "hair", "flap"]
P_ = {n: i for i, n in enumerate(PARTS)}

# base colors (sRGB 0-255); the build turns them into linear vertex colors and adds variation + AO
COLORS = {
    "skin": (228, 180, 152), "lips": (176, 92, 96), "hair": (122, 128, 146), "brow": (70, 72, 84),
    "lash": (22, 18, 20), "tunic": (30, 92, 64), "leather": (112, 66, 38), "leather_dark": (70, 42, 26),
    "gold": (232, 180, 70), "gem": (40, 240, 150), "rune": (60, 255, 210), "wrap": (168, 142, 104),
    "legging": (34, 38, 52), "boot": (80, 48, 28), "mouth": (80, 30, 36), "leather_green": (40, 104, 70),
}


def lerp(a, b, t):
    return np.asarray(a, float) + (np.asarray(b, float) - np.asarray(a, float)) * t
