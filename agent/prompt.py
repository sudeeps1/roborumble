"""The Library Builder's prompt template: system prompt, themes, output schema, user message.

This is the file to tune after reading the first dry run (see README.md). The system prompt is
stable and cached; everything that changes per batch goes in the user message. Bump
PROMPT_VERSION whenever you edit the template, so log.txt and the dry run files show which
version wrote which moves.
"""
from __future__ import annotations

from validate import EFFECTS, JOINTS, KINDS, TYPES

PROMPT_VERSION = "v5"  # v5: earth_wall and spiral_orb effects; v4: style subjects, no periods, shockwave

PLAIN = "plain combat"

# Theme -> what to riff on. Rotation order: plain combat every 4th batch, the rest in turn.
THEMES = {
    PLAIN: (
        "the plain fighting moves people shout without thinking: punches (jab, cross, hook, uppercut, "
        "haymaker, overhand), kicks (front, side, roundhouse, low, back, axe), elbows, knees, headbutts, sweeps, "
        "chops, palm strikes, hammer fists, shoulder charges, stomps, ground pounds, guards and blocks, plus "
        "a few elemental classics (Fire Punch, Ice Kick, Thunder Punch, Fireball, Ice Blast, Lightning Bolt, "
        "Shadow Punch). The names ARE the plain move names and most moves are physical."
    ),
    "knights & dragons": (
        "knights, squires, castles, jousts, royal guards, banners, oaths, shining armor, dragons, wyverns, "
        "dragon fire, scales and wings. Names like a legendary knight's technique or a dragon's attack."
    ),
    "witches & potions": (
        "witches, cauldrons, hexes, curses, bubbling brews, broomsticks, black cats, toads, spellbooks, "
        "crystal balls and midnight rituals. Names like a spell from a fairy-tale witch."
    ),
    "forest spirits & beasts": (
        "dryads, will-o'-wisps, brambles, moss, mushrooms, ancient oaks, the green man, stags, bears, wolves, "
        "owls, foxes and boars. Names like old forest magic or a beast's signature attack."
    ),
    "winter tales": (
        "snow queens, frost giants, icicles, blizzards, sleighs, polar bears, the north wind, frozen lakes, "
        "snowmen and mittens. Names like a winter fairy tale's spell or a frost giant's blow."
    ),
    "moonlight & night creatures": (
        "the moon and stars, eclipses, midnight, werewolves, bats, owls, vampires, ghosts, fog and shadows. "
        "Names like a creature of the night's move or a moonlit curse."
    ),
    "giants & trolls": (
        "giants, trolls, ogres, bridges, beanstalks, boulders, mountains, caves, thunderous footsteps and "
        "bellowing roars. Names like a giant's or troll's brutal signature attack."
    ),
    "enchanted household objects (played for laughs)": (
        "enchanted household things come to life: teapots, brooms, candlesticks, clocks, feather dusters, "
        "rolling pins, wardrobes, soup ladles, socks, pillows and rubber ducks. Silly, funny names that are "
        "still easy to shout; the body motion is still a plain human fighting motion with empty hands."
    ),
}
OTHER_THEMES = [t for t in THEMES if t != PLAIN]

# Kind and power mix per batch (largest-remainder rounding to the batch size).
KIND_WEIGHTS = {"melee": 0.40, "projectile": 0.25, "shockwave": 0.15, "strike": 0.10, "defend": 0.10}
KIND_WEIGHTS_PLAIN = {"melee": 0.50, "projectile": 0.15, "shockwave": 0.15, "strike": 0.10, "defend": 0.10}
POWER_WEIGHTS = {1: 0.40, 2: 0.40, 3: 0.20}

# Shouts that must always hit the library. Unclaimed ones are listed in every batch's request,
# so plain combat batches claim them first. The famous attack shouts are aliases only (people will
# shout them); names stay original.
CORE_SHOUTS = [
    "punch", "kick", "jab", "cross", "hook", "uppercut", "haymaker", "overhand", "headbutt", "elbow",
    "knee", "front kick", "side kick", "back kick", "roundhouse", "high kick", "low kick", "spin kick",
    "jump kick", "flying kick", "flying knee", "sweep", "leg sweep", "chop", "karate chop",
    "palm strike", "slap", "backfist", "hammer fist", "body slam", "shoulder charge", "tackle",
    "stomp", "ground pound", "clap", "spin", "block", "guard", "parry", "double punch", "one two",
    "combo", "power punch", "super punch", "fireball", "fire punch", "fire kick", "ice punch",
    "ice kick", "ice blast", "thunder punch", "lightning bolt", "lightning punch", "shadow punch",
    "shadow kick", "energy blast", "hadouken", "shoryuken", "kamehameha", "falcon punch",
]

# How many recent kimodo_prompts each request lists, so motions vary from batch to batch.
RECENT_PROMPTS = 40

SYSTEM_PROMPT = """\
You write move specs for Infinite Fighter, a voice-controlled fighting game shown live at a hackathon.

## The game
Two Unitree G1 humanoid robots (about 1.3 m tall) fight in a MuJoCo physics simulation. Players shout a move into their phone. Speech-to-text and an embedding search match the shout against every move's name and aliases, and the robot performs the matched move at once. A shout that matches nothing has to be generated live, which is slow, so the library you are building overnight should cover what people will actually shout, and every move should be fun to watch.

Every move is a spec plus a short body motion. The motion comes from Kimodo, a text-to-motion diffusion model trained on human motion capture with plain-English captions, which outputs the motion for the G1 robot. Kimodo knows locomotion, gestures, everyday actions, videogame-style combat (boxing, kicks, martial arts) and dance, performed in styles such as angry, tired, sneaky, drunk or happy. It has never seen magic, creatures or special effects, and fantasy words make it produce vague or broken motion. Kimodo sees only kimodo_prompt: never the name, type, effect or theme. The fantasy lives entirely in the name, the type and the effect. The game client draws the effect (embers, fairy-light bolts, frost, violet smoke, thorny vines, sparkles, a ring rippling along the ground) and the physics engine makes the hits land and the robots stagger.

Each clip is short (0.8 to 1.5 s): one beat of motion, such as one strike, one push, one stomp or one guard. The robot has to stay on its feet while it plays the clip, and every clip goes through automatic quality checks that reject it if the body barely moves, the root drifts more than 1.5 m, any body part goes below the floor, or a joint leaves its limits.

## kimodo_prompt (the most important field)
Write it the way a motion-capture annotator captions a clip:
- One plain sentence in the present tense, usually 8 to 18 words, lowercase. It starts with "a person", or with a style subject Kimodo knows: "an angry person", "a tired person", "a sneaky person", "a drunk person", "an old person", "a stealthy person", "a happy person", "a childlike person".
- Never a period anywhere, not even in a number: Kimodo cuts the prompt into separate motions at every period. Write numbers as words.
- Medium detail: the action, the body part that strikes with its side (left or right), and the direction or height (head, chest, waist or knee height, overhead, toward the floor). "a person kicks" is too vague; a sentence that narrates five different body parts is too much for the model.
- One behavior, or at most two quick ones ("steps in and throws a right hook"), that fits the duration and ends with the person upright on both feet.
- Stay roughly in place: at most one small step, lunge, pivot, hop or spin. No running or walking, no long jumps, no flips or cartwheels, no rolling, no lying down, sitting or kneeling.
- Fighting and dance vocabulary is good, because Kimodo learned it: jab, cross, hook, uppercut, haymaker, elbow strike, knee strike, front kick, roundhouse kick, axe kick, palm strike, hammer fist, shoulder charge, stomp, sweep, guard, parry, spin. A style is good too, as the subject or as a manner ("a drunk person sways and throws a wild right haymaker", "a person sways like a drunk and throws a wild right haymaker").
- Literal words only:
  - empty hands: no props or held objects (no sword, staff, wand, ball, broom, shield, cup);
  - no magic, spell, energy, element or weather words (fire, flame, ice, frost, snow, lightning, thunder, electric, smoke, shadow, storm, glowing, beam, blast);
  - no creatures, no character or move names, and never the word "robot";
  - no effects, no camera or editing words, and no emotion without motion ("angrily attacks" says nothing about the body).
- The striking body part and target height must agree with hit_joint and kind: a kick names the leg that kicks, a palm thrust names the hands, a headbutt moves the head, a stomp names the foot.
- Vary the motions across the batch and away from the recent motions the request lists (different limbs, levels, directions, rhythms and styles), so the library does not fill up with the same palm push under fifty names. Reuse a listed motion only when it is clearly the right motion for the move.

Good:
- a person steps forward and thrusts both palms out at chest height
- a person pivots on the left foot and throws a roundhouse kick with the right leg at waist height
- a person raises both fists overhead and slams them down in front
- a person dips the knees and drives a right uppercut up to head height
- a person lifts the right knee high and stomps the right foot down with both arms spread wide
- a person spins once in place with both arms held straight out at shoulder height
- a person raises both forearms in front of the face and braces with the knees bent
- a person draws both hands back to the right hip and pushes them forward together at chest height
- a person raises the right arm straight up and swings it down to point at the floor in front
- a person crouches low and sweeps the right leg in a wide arc along the floor
- a person sways like a drunk and throws a wild right haymaker
- an angry person stomps forward and throws a wide right hook at head height
- a sneaky person leans low and snaps a quick left jab at chest height

Bad, and the fix:
- "a person casts a fireball" -> "a person pulls both hands back to the right hip and pushes them forward at chest height"
- "a person swings a sword overhead" -> "a person raises both hands together overhead and chops them down in front"
- "a person summons thunder from the sky" -> "a person raises the right arm straight up and swings it down to point forward"
- "a person runs across the room and tackles the enemy" -> "a person lunges one step forward and drives the right shoulder forward at chest height"
- "a robot does a backflip kick" -> "a person hops and snaps the right leg up to head height"
- "a person angrily attacks" -> "a person stomps forward and throws a wide right hook at head height"
- "a person kicks" -> "a person snaps a quick front kick with the left leg at waist height"
- "a person steps 0.5 m forward and jabs" -> "a person takes a half step forward and jabs with the left fist at head height"
- "a person ducks, spins twice, jumps and then punches with both fists while turning left" -> "a person ducks low and springs up with a right uppercut"

## The other fields
- name: 1 to 4 words, Title Case, easy to shout and for speech-to-text to spell: real English words, no numbers, no invented spellings (an apostrophe or hyphen is fine). It sounds like a fairy-tale spell or a legendary move from the batch's theme ("Bramble Fist", "Dragon's Breath", "Snow Queen's Parry"). In plain combat batches the name is simply the plain move name (Jab, Uppercut, Roundhouse Kick, Fire Punch). Never reuse a name from the request's lists and never make a close variant of one (a plural, a reordering, one word swapped for a synonym, an added "Super" or "Mega"). Names are original: no famous characters and no famous attack names as names.
- aliases: 3 to 6 lowercase shouts of 1 to 3 words that a player would actually yell for this move: the lowercased name, its catchiest part, plain descriptions ("fire kick", "ice push"), synonyms, and common misspellings or spacings ("upper cut", "head butt"). Famous video game and anime attack shouts are welcome as aliases of the move that fits them best (people will shout them). Every alias is new: never use a shout from the request's claimed list, and never repeat one within the batch (a duplicate alias is deleted).
- Generic shouts ("punch", "kick", "uppercut", "fire punch", "block") belong to the plainest move that fits them, and only to a move of their own element: a plain shout ("hook", "clap", "kick") only on a physical move, "fire punch" only on a fire move, "ice kick" only on an ice move (shouting "hook" must never cast a fire spell). Famous energy-attack shouts may go on any type. In a plain combat batch give each one to exactly one plain move, as its name or an alias. In a themed batch use one only when the request lists it as unclaimed and it truly fits a move; otherwise build aliases from the move's own name and imagery.
- type: physical, fire, ice, lightning or shadow. Physical is the plain choice; the theme suggests the rest.
- kind and hit_joint:
  - melee: punch, kick, elbow, knee, headbutt, shoulder charge, sweep; it lands on contact at close range. hit_joint is the striking part (an elbow strike uses that hand, a knee strike uses that foot, a shoulder charge uses chest).
  - projectile: a throw, thrust, push or casting gesture aimed forward; the game launches the effect from hit_joint, usually the leading hand (r_hand when both hands push together). Its effect is never none.
  - strike: comes down from above on the spot where the opponent stood: an overhead slam, pointing up then down, a downward chop, an axe kick. hit_joint is the hand (or the foot) that comes down.
  - shockwave: a stomp, ground pound, spin or double clap that hits everything within 1.5 m. hit_joint is the stomping foot or the hand that pounds or claps.
  - defend: a guard, brace, parry or cover-up. hit_joint is chest, or the parrying hand.
  The game times the hit to the frame where hit_joint moves fastest, so hit_joint must be the body part the kimodo_prompt makes strike, on the same side.
- effect: fire -> ember_orb, lightning -> wisp_bolt, ice -> frost_crystals, shadow -> moon_smoke, physical -> none or thorn_burst. shockwave (a ring rippling out along the ground) is for shockwave moves of any type, as are thorn_burst and the type's own effect; no other kind uses it. fairy_dust suits playful moves of any type and defend moves. earth_wall (stone slabs burst out of the ground in front of the caster) is for defend moves, best after a hand seal or a slam to the ground; defend moves use only fairy_dust, earth_wall or none. spiral_orb (a spinning sphere of energy held in the right palm that bursts on impact) is for melee palm strikes delivered with the right hand (hit_joint r_hand) of any type. Projectiles never use none.
- power: 1 is a quick light move (duration 0.8 to 1.0 s), 2 a normal move (1.0 to 1.3 s), 3 a big committed move that leaves the attacker open (1.2 to 1.5 s). Big moves cost more energy and can tip the attacker over, so a power 3 move can be wide and heavy but still ends on both feet.
- duration: seconds, 0.8 to 1.5, inside the power's band and long enough for the motion described.

## The batch
- Match the requested counts per kind and per power exactly.
- Favor the thin types the request lists where they fit the theme.
- Names, types and effects follow the theme; the motions stay plain human fighting, gesture and dance motions.
- Every name and every alias is unique within the batch and new against the request's lists.
"""

# Key order is the order Claude writes the fields: decide the move, then caption its motion, then
# derive hit_joint and effect from the caption, then the shouts.
MOVE_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "type": {"type": "string", "enum": TYPES},
        "kind": {"type": "string", "enum": KINDS},
        "power": {"type": "integer", "enum": [1, 2, 3]},
        "duration": {"type": "number"},
        "kimodo_prompt": {"type": "string"},
        "hit_joint": {"type": "string", "enum": JOINTS},
        "effect": {"type": "string", "enum": EFFECTS},
        "aliases": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["name", "type", "kind", "power", "duration", "kimodo_prompt", "hit_joint", "effect", "aliases"],
    "additionalProperties": False,
}
SCHEMA = {
    "type": "object",
    "properties": {"moves": {"type": "array", "items": MOVE_SCHEMA}},
    "required": ["moves"],
    "additionalProperties": False,
}


def split_counts(n, weights):
    """Largest-remainder split of n items by weight: {key: count}, in weight order."""
    raw = {k: n * w for k, w in weights.items()}
    out = {k: int(v) for k, v in raw.items()}
    for k in sorted(raw, key=lambda k: raw[k] - out[k], reverse=True)[: n - sum(out.values())]:
        out[k] += 1
    return out


def build_user_message(theme, count, kinds, powers, thin, type_counts, theme_names, other_names,
                       claimed, unclaimed_core, recent_prompts=()):
    lines = [f"Theme: {theme}. Riff on {THEMES[theme]}"]
    if theme == PLAIN and len(theme_names) >= 30:
        lines.append("The obvious plain moves already exist (see the names below). Reach for real but less "
                     "common techniques from boxing, kickboxing, karate, taekwondo, muay thai, capoeira, "
                     "wrestling and street fighting, and for elemental variants of them.")
    lines += ["", f"Write exactly {count} moves."]
    lines.append("Kinds: " + ", ".join(f"{k} {n}" for k, n in kinds.items() if n) + ".")
    lines.append("Power: " + ", ".join(f"{n} at power {p}" for p, n in powers.items() if n) + ".")
    if thin:
        lines.append("Thin types in the library right now (favor them where they fit the theme): "
                     + ", ".join(f"{t} ({type_counts.get(t, 0)} moves)" for t in thin) + ".")
    if unclaimed_core:
        if theme == PLAIN:
            lines.append("Common shouts no move has claimed yet. Give each one to the single move in this batch "
                         "it describes best, as its name when it is a plain move name or else as an alias; skip "
                         "any that fits none of your moves: " + ", ".join(unclaimed_core) + ".")
        else:
            lines.append("Common shouts no move has claimed yet (use one as an alias only where it truly fits "
                         "a move in this batch): " + ", ".join(unclaimed_core) + ".")
    lines.append("")
    lines.append("Names already used in this theme (do not reuse them or make close variants): "
                 + (", ".join(theme_names) if theme_names else "none yet") + ".")
    if other_names:
        lines.append("Other names already in the library (avoid these too): " + ", ".join(other_names) + ".")
    if claimed:
        lines.append("Shouts already claimed by other moves (do not use them as aliases): "
                     + ", ".join(claimed) + ".")
    if recent_prompts:
        lines.append("")
        lines.append("Recent motions already in the library (write different ones where you can):")
        lines += [f"- {p}" for p in recent_prompts]
    return "\n".join(lines)
