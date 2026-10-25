# Pulls the G1 kinematic tree (body offsets + hinge axes) out of the MJCF the physics uses, so the
# character rig and the viewer agree with MuJoCo without shipping the robot model.
#   python3 characters/scripts/extract_g1.py passive/public/g1/g1_29dof.xml
# Source: NVlabs/GR00T-WholeBodyControl gear_sonic_deploy/g1/g1_29dof_old.xml (Unitree assets, BSD-3).
import json, sys, xml.etree.ElementTree as ET
from pathlib import Path

src = Path(sys.argv[1])
root = ET.parse(src).getroot()
nums = lambda s, d: [float(v) for v in s.split()] if s else d
bodies = []

def walk(el, parent):
    for b in el.findall("body"):
        j = b.find("joint")
        joint = None
        if j is not None and j.get("type", "hinge") == "hinge":
            joint = {"name": j.get("name"), "axis": nums(j.get("axis"), [0, 0, 1]), "range": nums(j.get("range"), None)}
        bodies.append({
            "name": b.get("name"), "parent": parent,
            "pos": nums(b.get("pos"), [0, 0, 0]), "quat": nums(b.get("quat"), [1, 0, 0, 0]),
            "joint": joint,
        })
        walk(b, len(bodies) - 1)

walk(root.find("worldbody"), -1)
out = Path(__file__).resolve().parent.parent / "src" / "g1_kinematics.json"
out.write_text(json.dumps({"source": "g1_29dof_old.xml (GR00T-WholeBodyControl, Unitree BSD-3)", "bodies": bodies}, indent=1))
print(f"{len(bodies)} bodies -> {out}")
