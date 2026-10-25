"""Validation, normalization and dedupe for Library Builder move specs.

prompt.py tells Claude what to write. This file enforces the parts that matter, so a bad
template can't flood the library overnight. If a dry run shows false drops, tune the word
lists below (BANNED_PATTERNS, PROP_PATTERNS, ORDINARY_WORDS).

Live wildcards use their own rules in specs.py (server/wildcard.py imports it); this file is
only the overnight builder's.
"""
from __future__ import annotations

import difflib
import os
import re
import unicodedata

TYPES = ["physical", "fire", "ice", "lightning", "shadow"]
KINDS = ["melee", "projectile", "strike", "shockwave", "defend"]
# The team's effect tags (CLAUDE.md "Move spec", the server's EFFECTS, specs.py). "shockwave" is a
# ring along the ground, for shockwave moves of any type; "earth_wall" (stone slabs burst out of the
# ground) is for defend moves; "spiral_orb" (a spinning orb in the right palm) is for right-hand
# melee palm strikes.
EFFECTS = ["ember_orb", "wisp_bolt", "frost_crystals", "moon_smoke", "thorn_burst", "fairy_dust", "shockwave",
           "earth_wall", "spiral_orb", "none"]
JOINTS = ["head", "chest", "l_hand", "r_hand", "l_foot", "r_foot"]

# Older CLAUDE.md effect tags, mapped to the fairy-tale ones.
OLD_EFFECTS = {"fireball": "ember_orb", "bolt": "wisp_bolt", "frost": "frost_crystals", "smoke": "moon_smoke"}
TYPE_EFFECT = {"fire": "ember_orb", "lightning": "wisp_bolt", "ice": "frost_crystals",
               "shadow": "moon_smoke", "physical": "none"}
TYPE_EFFECTS_OK = {
    "fire": {"ember_orb", "fairy_dust"},
    "lightning": {"wisp_bolt", "fairy_dust"},
    "ice": {"frost_crystals", "fairy_dust"},
    "shadow": {"moon_smoke", "fairy_dust"},
    "physical": {"none", "thorn_burst", "fairy_dust"},
}
POWER_BANDS = {1: (0.8, 1.0), 2: (1.0, 1.3), 3: (1.2, 1.5)}

# The subject Kimodo reads first: "a person", or one style word from its training data
# (docs/kimodo-g1.md, docs/GPU_ACCESS.md): "an angry person", "a tired person", ...
STYLE_WORDS = ["angry", "tired", "sneaky", "drunk", "old", "stealthy", "happy", "childlike",
               "sad", "scared", "injured"]
SUBJECT_RE = re.compile(r"(?:a|an)\s+(?:(" + "|".join(STYLE_WORDS) + r")\s+)?person\b", re.I)

# What Claude writes, and what the agent POSTs to /generate (plus optional motion_id).
FIELDS = ["name", "aliases", "type", "kind", "effect", "kimodo_prompt", "hit_joint", "duration", "power"]
POST_FIELDS = FIELDS + ["source", "creator", "motion_id"]

SIMILARITY_THRESHOLD = 0.95

# Generic shouts (prompt.CORE_SHOUTS) only stay on a move of their own element, so shouting "hook"
# never casts a fire move: plain shouts belong to physical moves, "fire punch" to fire moves.
# Famous energy attacks fit any type. A move's own name is always kept.
ELEMENT_WORDS = {
    "fire": {"fire", "fireball", "flame", "burn", "burning"},
    "ice": {"ice", "frost", "freeze", "frozen"},
    "lightning": {"lightning", "thunder", "zap", "shock", "electric"},
    "shadow": {"shadow", "dark"},
}
ANY_TYPE_SHOUTS = {"energy blast", "hadouken", "shoryuken", "kamehameha", "falcon punch"}


class Drop(Exception):
    """A spec that can't go to the server. code is a short category for the hourly counts."""

    def __init__(self, code, detail):
        super().__init__(detail)
        self.code = code
        self.detail = detail


# --------------------------------------------------------------------------- text helpers

def norm_text(s) -> str:
    """lowercase, apostrophes dropped, other punctuation to spaces, spaces collapsed."""
    s = unicodedata.normalize("NFKC", str(s)).lower()
    s = s.replace("’", "'").replace("‘", "'").replace("'", "")
    s = re.sub(r"[\W_]+", " ", s)
    return " ".join(s.split())


def singular(w: str) -> str:
    if len(w) > 4 and w.endswith(("ches", "shes", "sses", "xes", "zes")):
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith(("ss", "us", "is")):
        return w[:-1]
    return w


def key(s) -> str:
    """Dedupe key for names and aliases: normalized text with simple plurals folded."""
    return " ".join(singular(w) for w in norm_text(s).split())


_core_shout_keys = None


def shout_element(alias):
    """The element a generic shout belongs to ("physical" for plain ones), or None when the alias
    is not a generic shout or fits any type."""
    global _core_shout_keys
    if _core_shout_keys is None:
        from prompt import CORE_SHOUTS  # lazy: prompt.py imports this module
        _core_shout_keys = {key(s) for s in CORE_SHOUTS} - {key(s) for s in ANY_TYPE_SHOUTS}
    k = key(alias)
    if k not in _core_shout_keys:
        return None
    words = set(k.split())
    for elem, ws in ELEMENT_WORDS.items():
        if words & ws:
            return elem
    return "physical"


SMALL_WORDS = {"a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"}


def title_case(s: str) -> str:
    words = s.split(" ")
    out = []
    for i, w in enumerate(words):
        lw = w.lower()
        if i > 0 and lw in SMALL_WORDS:
            out.append(lw)
        else:
            # capitalize each hyphen part: "will-o'-wisp" -> "Will-O'-Wisp"
            out.append("-".join(p[:1].upper() + p[1:].lower() for p in lw.split("-")))
    return " ".join(out)


def raw_name(raw) -> str:
    if isinstance(raw, dict):
        return str(raw.get("name") or "?")[:60]
    return "?"


# --------------------------------------------------------------------------- word lists

# Words that make Kimodo produce bad motion: magic, elements, creatures, robots, camera words,
# and motions that leave the robot's spot or the floor. Regex fragments, matched as whole
# words against norm_text(prompt).
BANNED_PATTERNS = [
    # magic and spells
    r"magic\w*", r"spells?", r"spellbooks?", r"enchant\w*", r"sorcer\w*", r"wizard\w*", r"witch\w*",
    r"warlocks?", r"mages?", r"summon\w*", r"conjur\w*", r"cast", r"casts", r"casting", r"curse[sd]?",
    r"cursing", r"hex\w*", r"potions?", r"wands?", r"staffs?", r"runes?", r"mystic\w*", r"arcane",
    r"auras?", r"chakra", r"mana", r"energy", r"energies", r"telekine\w*",
    # elements and weather
    r"fire\w*", r"flames?", r"flaming", r"flamed", r"flamethrow\w*", r"fiery", r"burn\w*", r"blaz\w*", r"inferno\w*", r"lava", r"magma",
    r"embers?", r"smok\w*", r"ash", r"ashes", r"ice", r"icy", r"icicles?", r"frost\w*", r"froz\w*",
    r"freez\w*", r"snow\w*", r"blizzards?", r"lightning", r"thunder\w*", r"electr\w*", r"shock\w*",
    r"sparks?", r"sparkl\w*", r"zap\w*", r"bolts?", r"storms?", r"stormy", r"tornado\w*",
    r"whirlwinds?", r"plasma", r"lasers?", r"beams?", r"blast\w*", r"glow\w*",
    r"radian\w*", r"shadows?", r"shadowy", r"darkness", r"moonlight", r"moonbeams?", r"starlight",
    r"elemental\w*",
    r"poison\w*", r"venom\w*", r"toxic", r"acid\w*",
    # "explosive(ly)" is a fine motion word; explosions are effects
    r"explod\w*", r"explosions?",
    # creatures and characters
    r"dragon\w*", r"wyverns?", r"trolls?", r"ogres?", r"giants?", r"goblins?", r"fairy", r"fairies",
    r"pixie\w*", r"elf", r"elves", r"elven", r"dwarf\w*", r"dwarves", r"gnomes?", r"unicorns?",
    r"phoenix\w*", r"griff?ins?", r"gryphons?", r"ghosts?", r"ghostly", r"ghouls?", r"spirits?",
    r"demons?", r"devils?", r"monsters?", r"werewol\w*", r"vampires?", r"zombies?", r"golems?",
    r"krakens?", r"yetis?", r"dryads?", r"wisps?", r"banshees?", r"creatures?", r"beasts?",
    r"mermaids?", r"wraiths?", r"spect(?:er|re)s?", r"sprites?",
    # robots (Kimodo learned "robot" as a stiff robot dance)
    r"robot\w*", r"androids?", r"cyborgs?", r"mechs?", r"mechanical\w*",
    # camera, editing and effects
    r"camera\w*", r"slow motion", r"slowmo", r"zoom\w*", r"cinematic\w*", r"close ups?",
    r"particles?", r"vfx", r"special effects?", r"visual effects?", r"screen",
    # motions that leave the spot or the floor
    r"runs?", r"ran", r"running", r"sprint\w*", r"jogs?", r"jogging", r"walks?", r"walked", r"walking",
    r"kneel\w*", r"knelt", r"(?:on|to|onto) (?:one|both) knees?", r"(?:to|onto) (?:his|her|their) knees?", r"crawl\w*", r"backflips?",
    r"frontflips?", r"back flips?", r"front flips?", r"flips over", r"somersault\w*",
    r"cartwheel\w*", r"handstand\w*", r"rolls (?:on|over|across|forward|backward|sideways|away)",
    r"rolling (?:on|over|across|forward|backward|sideways|away)", r"lies down", r"lying down",
    r"lies on", r"lying on", r"lays down", r"sits down", r"sitting down", r"long jump",
]

# Props and held objects: the robot's hands are empty.
# "holding a low crouch" is a pose, not a prop.
_HOLD_OK = (r"(?:(?:wide|low|high|deep|strong|firm|tight|solid|steady|fighting|boxing|horse|defensive|guard|"
            r"crouched|wide-legged) )?(?:stance|pose|position|guard|crouch|squat|lunge|balance|beat|moment)\b")
# Words that are props as nouns but also everyday motion verbs ("shields the face", "sticks the arm
# out", "rocks back", "cups the hands", "hammers the fists down"): a prop only after a determiner.
_DET = r"(?:a|an|the|his|her|their|its|one|two)"
PROP_PATTERNS = [
    r"holding an? (?!" + _HOLD_OK + r")\w+",
    r"holds an? (?!" + _HOLD_OK + r")\w+",
    r"wield\w*", r"brandish\w*", r"grabs an?", r"grabbing an?", r"picks up", r"picking up",
    r"carr(?:y|ies|ying)", r"swords?", r"blades?(?! of the (?:\w+ )?hands?)", r"daggers?", r"knife",
    r"knives", r"axes?(?! kicks?)", r"spears?", r"lances?", r"arrows?",
    _DET + r" (?:shield|stick|rock|cup|whip|club|bat|pole|net|flag|pan|pot)s?",
    _DET + r" hammers?(?! ?fists?)",
    _DET + r" balls?(?! of (?:the|his|her|their|both) (?:\w+ )?(?:foot|feet))",
    r"mallets?", r"ropes?", r"stones?", r"boulders?", r"pebbles?", r"bricks?", r"canes?",
    r"brooms?", r"broomsticks?", r"mops?", r"kettles?", r"teapots?", r"mugs?", r"bottles?",
    r"plates?", r"spoons?", r"ladles?", r"forks?", r"rolling pins?", r"umbrellas?", r"chairs?",
    r"tables?", r"pillows?", r"books?", r"hats?", r"capes?", r"cloaks?", r"lanterns?", r"torch\w*",
    r"candles?", r"candlesticks?", r"buckets?", r"baskets?", r"bags?", r"banners?", r"guitars?",
    r"phones?", r"cauldrons?", r"crowns?", r"mirrors?", r"weapons?", r"props?",
]

BANNED_RE = re.compile(r"\b(?:" + "|".join(BANNED_PATTERNS) + r")\b")
PROP_RE = re.compile(r"\b(?:" + "|".join(PROP_PATTERNS) + r")\b")

# Plain words a move name may share with its kimodo_prompt (body parts, fighting verbs,
# directions, martial arts). Any other word of the name found in the prompt drops the spec,
# because the name is flavor and Kimodo should only see literal body motion.
ORDINARY_WORDS = set("""
head face chin jaw neck shoulder shoulders chest torso body back spine hip hips waist belly
arm arms elbow elbows forearm forearms wrist wrists hand hands palm palms fist fists finger fingers
fingertip fingertips knuckle knuckles thumb thumbs leg legs thigh thighs knee knees shin shins
ankle ankles foot feet heel heels toe toes stance guard shield shields
punch jab cross hook uppercut kick strike slam smash stomp stamp sweep spin twist turn pivot jump
hop leap step lunge thrust push shove pull chop slap clap swing swipe throw toss pound crush drop
charge block parry brace dodge duck weave bob flex pose bow wave point reach grab grip squeeze hug
tackle bash butt headbutt backfist elbow knee flurry combo combination burst sidestep shuffle
flick snap whip hammer sway rock shake stretch bend lean tilt nod shrug crouch squat rise sink lower
raise lift extend rotate circle scoop swoop poke stab tap pat clench spread fold beckon salute curl
press drive smack whack thump knock bump ram shoulder hip lash flail wind coil spring bounce
stamp kick sprawl reach slash cut clip crack pop rip tear wrench yank heave hurl fling sling launch
twirl whirl pirouette sashay strut stagger wobble tremble shiver march shimmy
double triple twin rising falling flying leaping jumping spinning turning crouching quick fast slow
big heavy light short long wide hard soft low high front side rear lead reverse inside outside
straight overhead upward downward forward backward sideways left right center middle power super
one two three hundred roundhouse axe hammer palm karate kung boxing boxer box wrestling wrestler
judo taekwondo muay thai kickboxing capoeira ballet dance dancer dancing tai
haymaker overhand crescent superman lariat clothesline dropkick bolo windmill scissor sliding slide
skip diving dive counter feint taunt roar cover underhand backhand forehand sidearm gut ground floor
air rapid wild mighty sneaky stealthy angry tired drunk drunken happy proud lazy giddy sweeping
old childlike sad scared injured
stomping clapping punching kicking chopping pounding crushing smashing slamming
pinch pummel wallop bonk bop swat thwack whomp clobber batter barge prod nudge wiggle jiggle flap
flutter tickle scratch sneeze yawn tantrum curtsy drum rattle roll rolling
the and for from with into onto over under off out its his her their your our all any this that
then than who are was has have not
""".split()) | SMALL_WORDS

HAND_WORDS = {
    "fist", "fists", "hand", "hands", "palm", "palms", "arm", "arms", "punch", "punches", "jab", "jabs",
    "hook", "hooks", "uppercut", "uppercuts", "chop", "chops", "slap", "slaps", "elbow", "elbows",
    "finger", "fingers", "fingertips", "backfist", "clap", "claps", "forearm", "forearms", "wrist",
    "wrists", "knuckles", "swipe", "swipes", "thrust", "thrusts", "push", "pushes", "points", "point",
    "claw", "claws", "throw", "throws", "toss", "tosses", "pound", "pounds", "slams", "slam", "haymaker",
    "haymakers", "overhand", "backhand", "backhands", "cross", "crosses", "shove", "shoves",
}
FOOT_WORDS = {
    "kick", "kicks", "leg", "legs", "foot", "feet", "heel", "heels", "knee", "knees", "stomp", "stomps",
    "toe", "toes", "shin", "shins", "sweep", "sweeps", "stamp", "stamps",
}
HEAD_WORDS = {"head", "headbutt", "headbutts", "forehead"}
# Which side strikes: "right uppercut", "left lead hand", "right leg". Support and guard phrases
# ("pivots on the left foot", "keeps the left hand up by the chin") are removed first, so they
# don't count as the striking side.
_HAND_PART = (r"(?:fist|hand|palm|arm|elbow|forearm|wrist|knuckle|punch|jab|hook|uppercut|cross|backfist|chop|haymaker|"
              r"overhand|slap|swipe|backhand)s?")
_FOOT_PART = r"(?:leg|foot|feet|knee|heel|shin|toe|kick|instep)s?"
HAND_SIDE_RE = re.compile(r"\b(left|right)\s+(?:\w+\s+){0,2}?" + _HAND_PART + r"\b")
FOOT_SIDE_RE = re.compile(r"\b(left|right)\s+(?:\w+\s+){0,2}?" + _FOOT_PART + r"\b")
HAND_SUPPORT_RE = re.compile(
    r"\b(?:keeps?|keeping|holds?|holding|guards?\s+with|covers?\s+with|protects?\s+with)\s+(?:the|his|her|their)\s+"
    r"(?:left|right)\s+(?:\w+\s+)?(?:hand|arm|fist|forearm|elbow)s?\b"
    r"|\b(?:left|right)\s+(?:hand|arm|fist|forearm)s?\s+(?:up|high|guarding|covering|tucked|stays|"
    r"(?:by|near|at)\s+the\s+(?:chin|face|cheek|jaw))\b")
FOOT_SUPPORT_RE = re.compile(
    r"\b(?:on|onto|off|over)\s+(?:the|his|her|their)\s+(?:left|right)\s+(?:foot|leg|heel|toes?|ball)s?\b"
    r"|\bsteps?\s+(?:\w+\s+){0,2}?(?:with|on)\s+the\s+(?:left|right)\s+(?:foot|leg)\b"
    r"|\b(?:left|right)\s+(?:foot|leg)\s+(?:planted|stays|steady|firm|stationary|grounded)\b"
    r"|\bweight\s+(?:on|onto|to)\s+(?:the\s+)?(?:left|right)\b")


# --------------------------------------------------------------------------- spec validation

def validate_spec(raw):
    """Return (spec, notes) for a raw spec from Claude, or raise Drop.

    spec has exactly FIELDS. notes lists the small fixes applied (shown in the dry run table).
    """
    if not isinstance(raw, dict):
        raise Drop("not an object", f"spec is a {type(raw).__name__}, not an object")
    missing = [f for f in FIELDS if f not in raw or raw[f] is None]
    if missing:
        raise Drop("missing fields", "missing " + ", ".join(missing))
    notes = []

    # ---- enums
    typ = str(raw["type"]).strip().lower()
    kind = str(raw["kind"]).strip().lower()
    effect = str(raw["effect"]).strip().lower()
    joint = str(raw["hit_joint"]).strip().lower()
    if typ not in TYPES:
        raise Drop("bad type", f"bad type {raw['type']!r}")
    if kind not in KINDS:
        raise Drop("bad kind", f"bad kind {raw['kind']!r}")
    if effect in OLD_EFFECTS:
        notes.append(f"effect {effect} -> {OLD_EFFECTS[effect]} (old tag)")
        effect = OLD_EFFECTS[effect]
    if effect not in EFFECTS:
        raise Drop("bad effect", f"bad effect {raw['effect']!r}")
    if joint not in JOINTS:
        raise Drop("bad hit_joint", f"bad hit_joint {raw['hit_joint']!r}")

    # ---- power and duration
    power = raw["power"]
    if isinstance(power, bool):
        raise Drop("bad power", f"bad power {power!r}")
    if isinstance(power, str) and power.strip().isdigit():
        notes.append(f"power {power!r} -> {int(power)}")
        power = int(power.strip())
    elif isinstance(power, float) and power.is_integer():
        power = int(power)
    if power not in (1, 2, 3) or not isinstance(power, int):
        raise Drop("bad power", f"bad power {raw['power']!r}")
    try:
        duration = float(raw["duration"])
    except (TypeError, ValueError):
        raise Drop("bad duration", f"bad duration {raw['duration']!r}") from None
    if duration != duration:  # NaN
        raise Drop("bad duration", "duration is NaN")
    clamped = round(min(1.5, max(0.8, duration)), 2)
    if clamped != round(duration, 2):
        notes.append(f"duration {duration:g} -> {clamped:g}")
    duration = clamped
    lo, hi = POWER_BANDS[power]
    if not lo - 1e-6 <= duration <= hi + 1e-6:
        notes.append(f"duration {duration:g}s is outside the power {power} band {lo:g}-{hi:g}s")

    # ---- name
    name = unicodedata.normalize("NFKC", str(raw["name"])).replace("’", "'").replace("‘", "'")
    name = " ".join(name.split()).strip(" \"'`.,!?:;*")
    if not 2 <= len(name) <= 40:
        raise Drop("bad name", f"name {name!r} must be 2-40 characters")
    if not all(c.isalnum() or c in " '-." for c in name):
        raise Drop("bad name", f"name {name!r} has characters you can't shout")
    if len(name.split()) > 5:
        raise Drop("bad name", f"name {name!r} has more than 5 words")
    if not any(c.isalpha() for c in name):
        raise Drop("bad name", f"name {name!r} has no letters")
    if name == name.lower() or name == name.upper():
        fixed = title_case(name)
        if fixed != name:
            notes.append(f"name {name!r} -> {fixed!r}")
            name = fixed

    # ---- aliases
    raw_aliases = raw["aliases"]
    if isinstance(raw_aliases, str):
        notes.append("aliases given as a string, split on commas")
        raw_aliases = raw_aliases.split(",")
    if not isinstance(raw_aliases, list):
        raise Drop("bad aliases", "aliases is not a list")
    name_alias = norm_text(name)
    aliases, seen = [name_alias], {key(name_alias)}
    for a in raw_aliases:
        if not isinstance(a, str):
            continue
        n = norm_text(a)
        if not n or len(n) > 32 or len(n.split()) > 4 or key(n) in seen:
            continue
        seen.add(key(n))
        elem = shout_element(n)
        if elem is not None and elem != typ:
            notes.append(f"alias {n!r} dropped: a generic {elem} shout on {'an' if typ[0] in 'aeiou' else 'a'} {typ} move")
            continue
        aliases.append(n)
    aliases = aliases[:7]  # the name plus up to 6 shouts

    # ---- kimodo_prompt
    prompt = unicodedata.normalize("NFKC", str(raw["kimodo_prompt"])).replace("’", "'")
    prompt = " ".join(prompt.split())
    prev = None
    while prompt != prev:  # outer quotes and a trailing period (or several) are harmless: drop them
        prev = prompt
        prompt = prompt.strip(" \"'`").rstrip(".")
    m = SUBJECT_RE.match(prompt)
    if not m:
        raise Drop("prompt start", "kimodo_prompt must start with 'a person' or a style subject "
                                   f"('an angry person', 'a tired person', ...): {prompt[:60]!r}")
    style = (m.group(1) or "").lower()
    subject = (("an " if style[0] in "aeiou" else "a ") + style + " person") if style else "a person"
    prompt = subject + prompt[m.end():]  # lowercase subject with the right article
    if "." in prompt:
        # Kimodo splits a prompt at every period, decimals included, and gives each piece the whole
        # duration: "steps 0.5 m forward and punches" becomes "steps 0." then "5 m forward and punches".
        raise Drop("prompt period", f"kimodo_prompt has a period inside it: {prompt!r}")
    words = prompt.split()
    if not 6 <= len(words) <= 40:
        raise Drop("prompt length", f"kimodo_prompt has {len(words)} words (6-40): {prompt!r}")
    ptext = norm_text(prompt)
    m = BANNED_RE.search(ptext)
    if m:
        raise Drop("banned word", f"kimodo_prompt has banned word {m.group(0)!r}: {prompt!r}")
    m = PROP_RE.search(ptext)
    if m:
        raise Drop("prop", f"kimodo_prompt has a prop {m.group(0)!r}: {prompt!r}")
    pwords = set(ptext.split())
    pwords |= {singular(w) for w in pwords}
    for w in norm_text(name).split():
        if len(w) < 3 or w in ORDINARY_WORDS or singular(w) in ORDINARY_WORDS:
            continue
        if w in pwords or singular(w) in pwords:
            raise Drop("name word in prompt", f"kimodo_prompt uses the name word {w!r}: {prompt!r}")

    # ---- hit_joint must be the part the prompt moves
    hands, feet = bool(pwords & HAND_WORDS), bool(pwords & FOOT_WORDS)
    if joint.endswith("_hand") and kind not in ("defend", "shockwave") and not hands:
        if not (feet and kind in ("melee", "strike")):
            raise Drop("hit_joint mismatch", f"hit_joint {joint} but the prompt never moves a hand or arm: {prompt!r}")
        notes.append(f"hit_joint {joint} -> {joint[0]}_foot (the prompt moves a leg, not a hand)")
        joint = joint[0] + "_foot"
    elif joint.endswith("_foot") and not feet:
        if not (hands and kind in ("melee", "projectile", "strike", "shockwave")):
            raise Drop("hit_joint mismatch", f"hit_joint {joint} but the prompt never moves a leg or foot: {prompt!r}")
        notes.append(f"hit_joint {joint} -> {joint[0]}_hand (the prompt moves an arm, not a leg)")
        joint = joint[0] + "_hand"
    if joint == "head" and not pwords & HEAD_WORDS:
        raise Drop("hit_joint mismatch", f"hit_joint head but the prompt never moves the head: {prompt!r}")
    if joint.endswith(("_hand", "_foot")):
        side_re, support_re = (HAND_SIDE_RE, HAND_SUPPORT_RE) if joint.endswith("_hand") else (FOOT_SIDE_RE, FOOT_SUPPORT_RE)
        sides = set(side_re.findall(support_re.sub(" , ", ptext)))
        want = "left" if joint.startswith("l_") else "right"
        if sides and want not in sides:  # the prompt strikes only with the other side
            fixed = ("r_" if want == "left" else "l_") + joint[2:]
            notes.append(f"hit_joint {joint} -> {fixed} (the prompt strikes with the {'right' if want == 'left' else 'left'} side)")
            joint = fixed

    # ---- type / kind / effect agreement
    if kind == "defend":
        if effect not in ("fairy_dust", "none", "earth_wall"):
            notes.append(f"effect {effect} -> fairy_dust (defend)")
            effect = "fairy_dust"
    elif kind == "projectile" and effect == "none":
        fixed = "thorn_burst" if typ == "physical" else TYPE_EFFECT[typ]
        notes.append(f"effect none -> {fixed} (projectiles need an effect)")
        effect = fixed
    else:
        # shockwave (a ground ring) and thorn_burst suit shockwave moves of any type
        ok = set(TYPE_EFFECTS_OK[typ]) | ({"shockwave", "thorn_burst"} if kind == "shockwave" else set())
        if kind == "melee" and joint == "r_hand":
            ok.add("spiral_orb")  # the orb is drawn in the right palm
        if effect not in ok:
            fixed = TYPE_EFFECT[typ]
            if fixed == "none" and kind in ("projectile", "shockwave"):
                fixed = "thorn_burst"
            notes.append(f"effect {effect} -> {fixed} (type {typ})")
            effect = fixed

    spec = {
        "name": name, "aliases": aliases, "type": typ, "kind": kind, "effect": effect,
        "kimodo_prompt": prompt, "hit_joint": joint, "duration": duration, "power": power,
    }
    return spec, notes


def post_body(spec) -> dict:
    """The JSON body for POST /generate: the spec fields, source agent, no creator."""
    body = {k: spec[k] for k in POST_FIELDS if k in spec}
    body["source"] = "agent"
    body["creator"] = None
    return body


# --------------------------------------------------------------------------- dedupe

class Registry:
    """Every name and alias already taken (library file + agent state + this batch).

    Names collide with names and aliases: a new move called "Uppercut" is a duplicate when an
    older move already answers to the shout "uppercut".
    """

    def __init__(self):
        self.names = {}    # key -> display name
        self.aliases = {}  # key -> owner name key

    def claim(self, name, aliases):
        nk = key(name)
        if not nk:
            return
        self.names.setdefault(nk, name)
        self.aliases.setdefault(nk, nk)
        for a in aliases or []:
            if isinstance(a, str) and key(a):
                self.aliases.setdefault(key(a), nk)

    def release(self, name, aliases):
        nk = key(name)
        if self.names.get(nk) is not None:
            del self.names[nk]
        for a in [name] + list(aliases or []):
            ak = key(a) if isinstance(a, str) else ""
            if ak and self.aliases.get(ak) == nk:
                del self.aliases[ak]

    def taken(self, name) -> bool:
        nk = key(name)
        return nk in self.names or nk in self.aliases

    def check(self, spec):
        """Return (spec, stripped_aliases) or raise Drop. Does not claim."""
        name = spec["name"]
        if self.taken(name):
            owner = self.names.get(key(name)) or self.names.get(self.aliases.get(key(name), ""), "")
            raise Drop("duplicate name", f"name {name!r} already exists" + (f" ({owner})" if owner and owner != name else ""))
        keep, stripped = [], []
        for a in spec["aliases"]:
            if key(a) != key(name) and (key(a) in self.aliases or key(a) in self.names):
                stripped.append(a)
            else:
                keep.append(a)
        if len(keep) < 2:
            if stripped:
                raise Drop("aliases taken", f"only {len(keep)} alias left after stripping claimed ones ({', '.join(stripped)})")
            raise Drop("too few aliases", f"only {len(keep)} alias: needs the name plus at least one more shout")
        out = dict(spec)
        out["aliases"] = keep
        return out, stripped


# --------------------------------------------------------------------------- motion reuse

# Side and direction words. A prompt and its mirror ("a left hook" / "a right hook", "spins
# clockwise" / "counterclockwise") embed almost identically, so a motion is reused only when these
# words match exactly and in the same order (contract/api.md: near-duplicates are the agent's job,
# so left/right mirrors never share a motion). Plural and -ward forms count as the same word.
# Count and extent words change the motion as much, and MiniLM barely sees them either (measured:
# inside vs outside crescent kick 0.977, spins once vs twice 0.975, full vs half turn 0.973).
DIRECTION_WORDS = {
    "left": "left", "leftward": "left", "leftwards": "left",
    "right": "right", "rightward": "right", "rightwards": "right",
    "forward": "forward", "forwards": "forward",
    "backward": "backward", "backwards": "backward",
    "back": "back", "front": "front",
    "up": "up", "upward": "up", "upwards": "up",
    "down": "down", "downward": "down", "downwards": "down",
    "clockwise": "clockwise", "counterclockwise": "counterclockwise", "anticlockwise": "counterclockwise",
    "inward": "inward", "inwards": "inward", "outward": "outward", "outwards": "outward",
    "inside": "inside", "outside": "outside",
    "once": "once", "twice": "twice", "thrice": "thrice", "double": "double", "triple": "triple",
    "half": "half", "full": "full",
}
_COUNTER_RE = re.compile(r"\b(?:counter|anti) clockwise\b")  # "counter-clockwise" after norm_text


def directions(prompt) -> tuple:
    """The prompt's side, direction, count and extent words, in order."""
    text = _COUNTER_RE.sub("counterclockwise", norm_text(prompt))
    return tuple(DIRECTION_WORDS[w] for w in text.split() if w in DIRECTION_WORDS)


class PromptIndex:
    """kimodo_prompt -> motion_id for the motions already in the library, for motion reuse.

    A spec reuses a motion when its prompt is more than 0.95 similar to an indexed one AND both
    have the same directions(), so mirrors never share a motion. Similarity is all-MiniLM-L6-v2
    cosine when sentence-transformers imports (it does on the GPU box), else difflib on normalized
    prompts. Never required. Env: AGENT_SIMILARITY=difflib forces the fallback; AGENT_EMBED_DEVICE
    (default cpu, so it never competes with Kimodo for VRAM). reset() empties the index when the
    library is re-read; embeddings stay cached, so no prompt is encoded twice.
    """

    def __init__(self, log=None, threshold=SIMILARITY_THRESHOLD):
        self.log = log
        self.threshold = threshold
        self.backend = None  # "minilm" | "difflib"
        self._model = None
        self._vecs = {}      # normalized prompt -> embedding, kept across reset()
        self.reset()

    def reset(self):
        self.prompts = []    # normalized prompts
        self.ids = []
        self.dirs = []       # directions() of each prompt
        self.exact = {}      # normalized prompt -> motion_id
        self._emb = None     # embedding matrix aligned with self.prompts, built on demand

    def __len__(self):
        return len(self.prompts)

    def _ensure_backend(self):
        if self.backend:
            return
        self.backend = "difflib"
        if os.environ.get("AGENT_SIMILARITY", "").lower() == "difflib":
            return
        try:
            import numpy as np  # noqa: F401
            from sentence_transformers import SentenceTransformer
        except Exception:
            return
        try:
            device = os.environ.get("AGENT_EMBED_DEVICE", "cpu")
            self._model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2", device=device)
            self.backend = "minilm"
        except Exception as e:  # offline, no cached weights, ...
            if self.log:
                self.log("INFO", f"motion reuse: sentence-transformers failed to load ({type(e).__name__}: {e}); using difflib")

    def _vectors(self, texts):
        missing = [t for t in dict.fromkeys(texts) if t not in self._vecs]
        if missing:
            vecs = self._model.encode(missing, normalize_embeddings=True, show_progress_bar=False)
            self._vecs.update(zip(missing, vecs))
        return [self._vecs[t] for t in texts]

    def add(self, prompt, motion_id):
        if not prompt or not motion_id:
            return
        p = norm_text(prompt)
        if not p or p in self.exact:
            return
        self.exact[p] = str(motion_id)
        self.prompts.append(p)
        self.ids.append(str(motion_id))
        self.dirs.append(directions(p))
        self._emb = None

    def best(self, prompt):
        """Return (motion_id, score, matched_prompt) for the closest prompt with the same
        directions above the threshold, else (None, best_score, None)."""
        p = norm_text(prompt)
        if not p or not self.prompts:
            return None, 0.0, None
        if p in self.exact:
            return self.exact[p], 1.0, p
        want = directions(p)
        cands = [i for i, d in enumerate(self.dirs) if d == want]
        if not cands:
            return None, 0.0, None
        self._ensure_backend()
        if self.backend == "minilm":
            try:
                import numpy as np
                if self._emb is None:
                    self._emb = np.asarray(self._vectors(self.prompts))
                q = np.asarray(self._vectors([p])[0])
                sims = self._emb[cands] @ q
                k = int(np.argmax(sims))
                score, i = float(sims[k]), cands[k]
                if score > self.threshold:
                    return self.ids[i], score, self.prompts[i]
                return None, score, None
            except Exception as e:
                if self.log:
                    self.log("INFO", f"motion reuse: embedding failed ({type(e).__name__}: {e}); using difflib")
                self.backend = "difflib"
        sm = difflib.SequenceMatcher(None, autojunk=False)
        sm.set_seq2(p)
        best_i, best_score = -1, 0.0
        for i in cands:
            sm.set_seq1(self.prompts[i])
            if sm.real_quick_ratio() <= max(best_score, self.threshold) or sm.quick_ratio() <= max(best_score, self.threshold):
                continue
            r = sm.ratio()
            if r > best_score:
                best_i, best_score = i, r
        if best_i >= 0 and best_score > self.threshold:
            return self.ids[best_i], best_score, self.prompts[best_i]
        return None, best_score, None
