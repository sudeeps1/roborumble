# Everyday clips (Kimodo, physics-checked)

| motion | picked | score | baseline (planner) | candidates passing | notes |
| --- | --- | --- | --- | --- | --- |
| block | block.b/0, block.b/1 | 93 | 70 (fails) | 6/8 | gloves up at 0.16 s, held 1.08 s, leftJab blocked (forearm), rightHook blocked |
| dodge.back | none: planner stays | - | 46 (fails) | 0/4 |  |
| dodge.left | none: planner stays | - | 58 (fails) | 0/4 |  |
| dodge.right | none: planner stays | - | 71 (fails) | 0/4 |  |
| duck | duck.c/0, duck.c/2 | 74 | 42 (fails) | 4/8 | head 0.09/0.19/0.22 m at 0.2/0.3/0.45 s, rightHook missed (closest -0.09 m), defense 0.78 s, back in guard |
| getup.knees | getup_front.b/6, getup_front.a/2, getup_back.a/6, getup_back.c/0 | 100 | 89 | 39/44 | front->face up: up 4.7 s help 0.60 (planner); behind->face down: up 2.9 s help 0.00 clip x1 |
| guard | guard.b/2, guard.b/1 | 79 | 71 | 21/21 | bob 1.5 cm, gloves up 100%, slide 17.6 cm/s, track 4.7 cm, jump 4.2 deg, seam 0.28 rad |
| guard.elf | guard_elf.a/7, guard_elf.b/1 | 88 | - | 19/19 | bob 0.9 cm, gloves up 100%, slide 1.9 cm/s, track 5.0 cm, jump 1.0 deg, seam 0.27 rad |
| guard.knight | guard_knight.b/0, guard_knight.a/5 | 92 | - | 17/17 | bob 1.2 cm, gloves up 100%, slide 1.3 cm/s, track 4.9 cm, jump 1.3 deg, seam 0.13 rad |
| punch.leftHook | punch_leftHook.b/2, punch_leftHook.d/2 | 80 | 78 | 6/12 | lands 2/2, fist peak 2.9 m/s, 0.40 s off the key, back in guard 100% |
| punch.leftJab | punch_leftJab.a/1, punch_leftJab.b/2 | 82 | 46 | 5/12 | lands 2/2, fist peak 2.0 m/s, 0.17 s off the key, back in guard 100% |
| punch.rightHook | punch_rightHook.b/2 | 92 | 74 | 2/12 | lands 2/2, fist peak 3.3 m/s, 0.09 s off the key, back in guard 100% |
| punch.rightJab | punch_rightJab.b/0, punch_rightJab.b/3 | 86 | 45 | 5/12 | lands 2/2, fist peak 2.2 m/s, 0.09 s off the key, back in guard 100% |
| jump | clips-kimodo/jump.json (Vaibhav's library clip) | 82 | 22 (fails) | 1/1 | airborne 0.16 s, feet up 0.10 m, lowest shin 0.11 m (sweep clear), lands upright |
| step.forward | step_forward.a/2 | 89 | - | 1/4 | travel 0.27 m, heading 10 deg, gloves up |
| step.left | step_left.a/3, step_left.a/1 | 89 | - | 2/4 | travel 0.16-0.20 m, heading 11-14 deg, gloves up |
| step.right | step_right.a/2 | 82 | - | 1/4 | travel 0.14 m, heading 2 deg, gloves up |
| step.back | none: planner stays | - | - | 0/16 | Kimodo step-backs don't travel in physics |
| dodge.* | none: planner stays | - | 46-71 (fail) | 0/36 | head moves <= 0.12 m by 0.3 s: SONIC ignores Kimodo's root shift |
