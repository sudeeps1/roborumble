// The Commentator's lines, spoken by TTS on the game screen in a storybook narrator's voice
// ("And lo, the Thorn Knight falls!"). Lines come from the server (`narrate` room message);
// storybookLine() is the offline stand-in used by the mock server.
import { ROUNDS_TO_WIN, TYPE_NAME } from "../config";
import { MOVE_TYPES, type GameEvent, type Kind, type MoveSpec, type MoveType, type Player } from "../contract";
import { sfx } from "./sfx";

// ---------- Narrator: Web Speech, never lagging the fight ----------
const RATE = 0.95;
const PITCH = 0.9;
const STALE_MS = 5000;   // a line queued longer ago than this is old news: drop it if waiting, cut it if talking
const RESTART_MS = 120;  // beat after cancel(): Chrome and Safari can swallow a speak() issued right after it
const WATCH_MS = 1000;   // how often to look in on the line being spoken (end events do get lost)

// Warm storytelling voices first (macOS, Chrome, Edge/Windows), then any English voice.
const VOICE_PREFS: RegExp[] = [
  /^daniel\b/i, /^arthur\b/i, /google uk english male/i, /^serena\b/i,
  /^oliver\b/i, /^kate\b/i, /^martha\b/i, /^jamie\b/i, /^stephanie\b/i,
  /microsoft (ryan|thomas|george|oliver|alfie|elliot|noah)\b/i, /microsoft (sonia|libby|maisie|hazel|susan|bella)\b/i,
  /google uk english female/i, /^moira\b/i, /^fiona\b/i, /^karen\b/i, /^lee\b/i, /^tessa\b/i,
  /^samantha\b/i, /^alex\b/i, /^ava\b/i, /^tom\b/i, /^evan\b/i, /^zoe\b/i,
  /microsoft (guy|davis|christopher|andrew|brian|eric|aria|jenny|emma|ava)\b/i, /google us english/i,
];
// macOS novelty and Eloquence voices: fun, but not a storyteller.
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|junior|ralph|fred|kathy|princess|bruce|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;
const NOT_ENGLISH = -1000;

function voiceScore(v: SpeechSynthesisVoice): number {
  const lang = (v.lang || "").toLowerCase().replace(/_/g, "-");
  const name = v.name || "";
  if (!lang.startsWith("en")) return NOT_ENGLISH;
  let s = lang.startsWith("en-gb") ? 40 : /^en-(ie|au|nz|za|scotland)/.test(lang) ? 15 : 8;
  const i = VOICE_PREFS.findIndex((r) => r.test(name));
  if (i >= 0) s += 100 - i * 3;
  if (/premium|enhanced|natural|neural/i.test(name)) s += 5; // the better build of a voice, without reordering the list
  if (NOVELTY.test(name)) s -= 200;
  if (v.localService) s += 3; // local voices start faster than network ones
  return s;
}

/** Strip what a TTS engine would read out loud or choke on (emoji, markdown), cap the length. */
function speakable(text: unknown): string {
  return String(text ?? "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_#~`<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

interface Line { text: string; at: number; started?: number; utt?: SpeechSynthesisUtterance; }

export class Narrator {
  private synth: SpeechSynthesis | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private enabled = true;
  private primed = false;
  private current: Line | null = null;  // being spoken
  private pending: Line | null = null;  // at most one waiting line; a newer one replaces it
  private holdUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    try {
      if (typeof window === "undefined" || !window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") return;
      const synth = window.speechSynthesis;
      this.synth = synth;
      synth.cancel(); // Chrome can stay stuck "speaking" across a reload
      this.pickVoice();
      const onVoices = () => this.pickVoice(); // voices load async in Chrome
      if (typeof synth.addEventListener === "function") synth.addEventListener("voiceschanged", onVoices);
      else synth.onvoiceschanged = onVoices;
    } catch {
      this.synth = null;
    }
  }

  /** Name of the chosen voice (null until voices load, or without speech support). */
  get voiceName(): string | null {
    return this.voice?.name ?? null;
  }

  /** Speak a line (Web Speech speechSynthesis). Keeps the queue short: drop stale lines rather than lag. */
  say(text: string): void {
    try {
      const t = speakable(text);
      if (!t || !this.enabled || !this.synth) return;
      const now = performance.now();
      this.pending = { text: t, at: now };
      // Never cut a line mid-sentence, unless it is already old news.
      if (this.current && now - this.current.at > STALE_MS) this.cut();
      this.pump();
    } catch { /* speech is a nicety; never break the game */ }
  }

  /** Mute/unmute. */
  setEnabled(on: boolean): void {
    this.enabled = !!on;
    if (this.enabled) return;
    this.pending = null;
    clearTimeout(this.timer);
    if (this.current) this.cut();
    sfx.duck(false);
  }

  /** Call from a user gesture once (some browsers need it before speech works). */
  unlock(): void {
    if (this.primed || !this.synth) return;
    this.primed = true;
    try {
      this.pickVoice();
      if (this.current || this.synth.speaking) return; // already talking, nothing to prime
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      this.synth.speak(u);
    } catch { /* ignore */ }
  }

  // Start the waiting line if nothing is being spoken; otherwise look in on the current one soon.
  private pump(): void {
    clearTimeout(this.timer);
    if (!this.synth || !this.enabled) return;
    const now = performance.now();
    const cur = this.current;
    if (cur) {
      const untilStale = cur.at + STALE_MS + 20 - now;
      this.timer = setTimeout(() => this.check(cur), untilStale > 0 ? Math.max(10, Math.min(WATCH_MS, untilStale)) : WATCH_MS);
      return;
    }
    sfx.duck(false); // nothing is being said
    const next = this.pending;
    if (!next) return;
    if (now - next.at > STALE_MS) {
      this.pending = null;
      return;
    }
    if (now < this.holdUntil) {
      this.timer = setTimeout(() => this.pump(), this.holdUntil - now + 5);
      return;
    }
    this.pending = null;
    this.speak(next);
  }

  private speak(line: Line): void {
    const synth = this.synth;
    if (!synth) return;
    if (!this.voice) this.pickVoice();
    try {
      const u = new SpeechSynthesisUtterance(line.text);
      if (this.voice) u.voice = this.voice;
      u.lang = this.voice?.lang || "en-GB";
      u.rate = RATE;
      u.pitch = PITCH;
      u.volume = 1;
      const done = () => {
        if (this.current !== line) return; // a cut line reporting late
        this.current = null;
        this.pump();
      };
      u.onstart = () => { if (this.current === line) sfx.duck(true); };
      u.onend = done;
      u.onerror = done;
      line.utt = u; // keep a reference: Chrome can skip onend for a garbage-collected utterance
      line.started = performance.now();
      this.current = line;
      if (synth.paused) synth.resume();
      synth.speak(u);
    } catch {
      this.current = null;
      return;
    }
    this.pump(); // arms the watch timer
  }

  // The engine went quiet without an end event: move on. A stale line gives way to a waiting one.
  private check(line: Line): void {
    const synth = this.synth;
    if (this.current !== line || !synth) return;
    const now = performance.now();
    const quiet = !synth.speaking && !synth.pending;
    if (quiet && now - (line.started ?? line.at) > WATCH_MS) this.current = null;
    else if (this.pending && now - line.at > STALE_MS) this.cut();
    this.pump();
  }

  private cut(): void {
    this.current = null;
    try { this.synth?.cancel(); } catch { /* ignore */ }
    this.holdUntil = performance.now() + RESTART_MS;
  }

  private pickVoice(): void {
    try {
      const voices = this.synth?.getVoices() ?? [];
      let best: SpeechSynthesisVoice | null = null;
      let bestScore = NOT_ENGLISH;
      for (const v of voices) {
        const s = voiceScore(v);
        if (s > bestScore) { best = v; bestScore = s; }
      }
      if (best) this.voice = best;
    } catch { /* keep the old voice */ }
  }
}

// ---------- storybookLine: the offline Commentator ----------
export interface NarrationContext {
  names: Record<Player, string>;   // character names, e.g. "Sir Bramble"
  titles: Record<Player, string>;  // "the Thorn Knight"
  nicknames: Record<Player, string>;
}

export type NarrationEvent = GameEvent | { kind: "move"; player: Player; move: MoveSpec };

type Tpl = () => string | null;
interface Who { name: string; title: string; nick: string; any(): string; full: string; subj: string; }

const MAX_WORDS = 14;
const GAP_MS = 1600;       // optional lines never crowd each other...
const AFTER_BIG_MS = 3000; // ...or step on a big moment (the Narrator keeps only one waiting line)
const BIG_HIT = 15;        // damage that makes a blow worth a gasp

let lastLine = "";
let lastAt = -1e9;
let lastBigAt = -1e9;
const bags = new Map<string, number[]>();     // shuffle bag of template indices per event key
const lastIdx = new Map<string, number>();

/** Forget recent lines (variety and pacing history). */
export function resetStorybook(): void {
  lastLine = "";
  lastAt = lastBigAt = -1e9;
  bags.clear();
  lastIdx.clear();
}

/** One short storybook line for an event, or null to stay quiet (not every hit needs a line). */
export function storybookLine(e: GameEvent | { kind: "move"; player: Player; move: MoveSpec }, ctx: NarrationContext): string | null {
  try {
    const now = performance.now();
    const pick = templatesFor(e, ctx);
    if (!pick) return null;
    if (!pick.must && (Math.random() >= pick.chance || now - lastAt < GAP_MS || now - lastBigAt < AFTER_BIG_MS)) return null;
    const line = choose(pick.key, pick.tpls);
    if (!line) return null;
    lastLine = line;
    lastAt = now;
    if (pick.must) lastBigAt = now;
    return line;
  } catch {
    return null;
  }
}

interface Pick { key: string; tpls: Tpl[]; must: boolean; chance: number; }

function templatesFor(e: NarrationEvent, ctx: NarrationContext): Pick | null {
  const P = (p: Player) => who(ctx, p);
  switch (e.kind) {
    case "hit": {
      const A = P(e.attacker), D = P(other(e.attacker));
      const ty = typeOf(e.type), noun = typeNoun(ty);
      if (e.clean) return { key: "hit:clean", must: false, chance: 0.6, tpls: [
        () => `A clean strike! ${D.any()} reels!`,
        () => `Right on the mark! What a blow from ${A.any()}!`,
        () => `True as an arrow, ${A.any()} strikes home!`,
        () => `Straight and true! ${D.any()} rings like a bell!`,
        () => `${A.any()} lands it clean, and the whole ring gasps!`,
        () => `Perfect! ${noun} lands true!`,
      ] };
      if (e.damage >= BIG_HIT) return { key: "hit:big", must: false, chance: 0.5, tpls: [
        () => `${noun}, and ${D.any()} rattles like an old clock!`,
        () => `Oof! ${D.any()} felt that one down to the gears.`,
        () => `What a wallop! Even the mushrooms shook.`,
        () => `${noun}! ${D.any()} is sent staggering!`,
        () => `${A.any()} hits like a falling oak!`,
      ] };
      return { key: "hit", must: false, chance: 0.3, tpls: [
        () => `${A.any()} lands ${noun}.`,
        () => `${flavor(ty)} ${D.any()} winces.`,
        () => `${noun} for ${D.any()}!`,
        () => `${D.any()} takes a knock, gears groaning.`,
        () => `${A.any()} chips away at ${D.any()}.`,
        () => `${flavor(ty)} ${A.any()} presses on!`,
        () => `Ooh, that one stung, ${D.nick || D.name}!`,
      ] };
    }
    case "blocked": {
      const B = P(e.defender), A = P(other(e.defender));
      return { key: "blocked", must: false, chance: 0.3, tpls: [
        () => `${B.any()} raises a stout guard!`,
        () => `Blocked! ${B.any()} will not yield.`,
        () => `Clang! The blow glances off ${B.any()}.`,
        () => `${B.any()} turns the blow aside.`,
        () => `Not today! ${B.any()} holds firm.`,
        () => `A sturdy guard! ${A.any()} must try harder.`,
        () => `Well blocked, ${B.nick || B.name}!`,
      ] };
    }
    case "dodged": {
      const B = P(e.defender);
      return { key: "dodged", must: false, chance: 0.4, tpls: [
        () => `Swift as a sparrow, ${B.any()} slips away!`,
        () => `A miss! ${B.any()} dances clear.`,
        () => `Like smoke on the wind, ${B.any()} is gone!`,
        () => `${B.any()} skips aside, and the blow finds only air!`,
        () => `Too slow! ${B.any()} is already elsewhere.`,
        () => `Nimble as a fox, ${B.any()} leaps clear!`,
        () => `Well dodged, ${B.nick || B.name}!`,
      ] };
    }
    case "down": {
      const D = P(e.player);
      return { key: "down", must: true, chance: 1, tpls: [
        () => `Down goes ${D.any()}, gears a-rattle!`,
        () => `${D.any()} topples into the clover!`,
        () => (D.title !== D.name ? `${D.name} tumbles! Will ${D.title} rise again?` : `${D.name} tumbles! Will they rise again?`),
        () => `Over goes ${D.any()}! The fireflies gasp.`,
        () => `Alas, ${D.any()} is down!`,
        () => `${D.any()} falls with a clank and a clatter!`,
        () => `Timber! Down tumbles ${D.any()}!`,
      ] };
    }
    case "ko": {
      const L = P(e.loser), W = P(other(e.loser));
      return { key: "ko", must: true, chance: 1, tpls: [
        () => `And lo, ${L.title} falls!`,
        () => `${L.any()}'s runes flicker, and fade. ${W.any()} stands alone!`,
        () => `The last spark leaves ${L.any()}. Victory to ${W.any()}!`,
        () => `${L.any()} sleeps once more. ${W.any()} is victorious!`,
        () => `Silence in the fairy ring. ${L.any()} will not rise.`,
        () => `The fairy magic fades from ${L.any()}. ${W.any()} triumphs!`,
        () => `Down for good! The round belongs to ${W.any()}!`,
      ] };
    }
    case "round": {
      const W = P(e.winner);
      return { key: "round", must: true, chance: 1, tpls: [
        () => `The round goes to ${W.full}!`,
        () => `So ends the round. ${W.any()} prevails!`,
        () => `The fairies cheer for ${W.any()}!`,
        () => `A chapter won by ${W.full}!`,
      ] };
    }
    case "round_start": {
      const A = P(1), B = P(2);
      const r = Math.max(1, Math.round(Number(e.round)) || 1);
      const n = number(r);
      if (r === 1) return { key: "start:1", must: true, chance: 1, tpls: [
        () => `Once upon a time, two old automatons woke to duel.`,
        () => `Once upon a time, ${A.name} met ${B.name} in the fairy ring.`,
        () => `Our tale begins! ${A.subj} faces ${B.full}.`,
        () => `Gather close. The fairy ring glows, and the duel begins!`,
        () => `Chapter one! ${A.any()} and ${B.any()} bow beneath the moon.`,
      ] };
      if (r === ROUNDS_TO_WIN * 2 - 1) return { key: "start:final", must: true, chance: 1, tpls: [
        () => `The final chapter! Only one shall be champion.`,
        () => `Round ${n}, the last page of our tale!`,
        () => `One round remains. Let the ending be written!`,
        () => `The moon climbs high for the final chapter.`,
      ] };
      return { key: "start:mid", must: true, chance: 1, tpls: [
        () => `Chapter ${n}! The fairy ring glows anew.`,
        () => `Turn the page. Round ${n} begins!`,
        () => `The tale goes on. Round ${n}!`,
        () => `A new chapter, and the fireflies hold their breath.`,
      ] };
    }
    case "match_end": {
      const W = P(e.winner);
      return { key: "match", must: true, chance: 1, tpls: [
        () => `And so ${W.subj} won the duel. The end.`,
        () => `${W.subj} is champion of the fairy ring!`,
        () => `Thus ends our tale: victory to ${W.any()}!`,
        () => `Long shall the fireflies sing of ${W.any()}!`,
        () => (W.nick ? `Well fought, ${W.nick}! ${W.any()} is champion.` : null),
        () => `The book closes. ${W.any()} rules the fairy ring!`,
      ] };
    }
    case "move":
      return moveTemplates(e.player, e.move, ctx);
  }
  return null;
}

function moveTemplates(p: Player, m: MoveSpec, ctx: NarrationContext): Pick | null {
  if (!m) return null;
  const A = who(ctx, p);
  const M = spellName(m.name);
  const T = TYPE_NAME[typeOf(m.type)];
  const creator = clean(m.creator);
  // The player's own Forge move (1.5x power).
  if (m.signature) {
    const N = A.nick || creator || A.name;
    return { key: "move:signature", must: true, chance: 1, tpls: [
      () => `Behold! ${N}'s very own ${M}!`,
      () => `${M}! A spell of ${N}'s own making!`,
      () => `${A.any()} unleashes ${N}'s signature spell, ${M}!`,
      () => `${N} invented this one: ${M}, at full fury!`,
      () => `${M}! Forged by ${N}, and fiercer for it!`,
    ] };
  }
  // A live wildcard on its first outing: the spell was born seconds ago (its creator is the caster).
  if (m.source === "live" && !((m.uses ?? 0) > 1)) {
    const C = creator || A.nick || A.name;
    return { key: "move:live", must: true, chance: 1, tpls: [
      () => `Never before seen! ${M}, conjured by ${C}!`,
      () => `A brand-new spell, born this very moment: ${M}!`,
      () => `The fairies write a new page: ${M}, by ${C}!`,
      () => `From thin air, ${C} dreams up ${M}!`,
      () => `${M}? No such spell existed, until now!`,
    ] };
  }
  // A move this player invented earlier, played again without the signature bonus.
  if (creator && creator === A.nick) return { key: "move:own", must: true, chance: 1, tpls: [
    () => `${creator}'s own ${M} returns!`,
    () => `${M}! A spell of ${creator}'s own making!`,
    () => `${creator} invented this one: ${M}!`,
    () => `${A.any()} casts ${M}, a spell ${creator} dreamed up!`,
  ] };
  if (creator) return { key: "move:credit", must: true, chance: 1, tpls: [
    () => `${A.any()} casts ${M}, a spell first woven by ${creator}!`,
    () => `${M}! A spell dreamed up by ${creator}.`,
    () => `From the spellbook of ${creator}: ${M}!`,
    () => `${A.any()} borrows ${creator}'s ${M}!`,
    () => `${M}, invented by ${creator}! ${A.any()} casts it well.`,
  ] };
  const byKind: Record<Kind, Tpl[]> = {
    melee: [
      () => `${A.any()} swings in with ${M}!`,
      () => `${M}! ${A.any()} closes in.`,
      () => `Up close, ${A.any()} tries ${M}!`,
    ],
    projectile: [
      () => `${A.any()} hurls ${M} across the ring!`,
      () => `Away it flies: ${M}!`,
      () => `${M} streaks across the fairy ring!`,
    ],
    strike: [
      () => `From the sky, ${M} descends!`,
      () => `${A.any()} calls ${M} down from the stars!`,
      () => `Look up! ${M} falls from above!`,
    ],
    shockwave: [
      () => `The ground trembles: ${M}!`,
      () => `${A.any()} shakes the fairy ring with ${M}!`,
      () => `${M} ripples outward!`,
    ],
    defend: [
      () => `${A.any()} raises ${M}!`,
      () => `${M}! ${A.any()} braces behind it.`,
      () => `${A.any()} hides behind ${M}!`,
    ],
  };
  const kind: Kind = Object.hasOwn(byKind, m.kind) ? m.kind : "melee";
  return { key: `move:${kind}`, must: false, chance: 0.4, tpls: [
    ...byKind[kind],
    () => `${A.any()} weaves a spell of ${T}: ${M}!`,
    () => `${M}! ${T} gathers around ${A.any()}.`,
    () => `${A.any()} whispers the words... ${M}!`,
    () => `${A.any()} calls forth ${M}!`,
  ] };
}

// "a blow of Might", "a burst of Flame"... built on config.TYPE_NAME so the in-game names live in one place.
const NOUN: Record<MoveType, string> = { physical: "a blow of", fire: "a burst of", ice: "a bite of", lightning: "a crack of", shadow: "a lash of" };
const FLAVOR: Record<MoveType, ((t: string) => string)[]> = {
  physical: [() => "Thorns and petals fly!", () => "Briar and iron clash!", (t) => `Such ${t}!`],
  fire: [() => "Embers scatter!", () => "The hearth-fire roars!", (t) => `${t} kisses cold iron!`],
  ice: [() => "Frost crystals bloom!", () => "A winter's bite!", (t) => `${t} creeps over iron!`],
  lightning: [() => "Wisp-light crackles!", () => "Sparks dance like fireflies!", (t) => `A crackle of ${t}!`],
  shadow: [() => "Moonlit smoke curls!", () => "A chill wind whispers!", (t) => `${t} nips at iron!`],
};
const typeOf = (t: unknown): MoveType => (MOVE_TYPES.includes(t as MoveType) ? (t as MoveType) : "physical");
const typeNoun = (t: MoveType) => `${NOUN[t]} ${TYPE_NAME[t]}`;
const flavor = (t: MoveType) => rnd(FLAVOR[t])(TYPE_NAME[t]);

const other = (p: Player): Player => (p === 1 ? 2 : 1);
const rnd = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
const NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const number = (n: number) => NUMBERS[n] ?? String(n);

function who(ctx: NarrationContext, p: Player): Who {
  const nm = clean(ctx?.names?.[p]), ti = clean(ctx?.titles?.[p]), nick = clean(ctx?.nicknames?.[p]);
  const name = nm || ti || nick || (p === 1 ? "the first automaton" : "the second automaton");
  const title = ti || name;
  return {
    name, title, nick,
    any: () => (title !== name && Math.random() < 0.4 ? title : name),
    full: title !== name ? `${name}, ${title}` : name,
    subj: title !== name ? `${name}, ${title},` : name, // the full form before a verb
  };
}

// Live wildcards arrive as raw transcripts ("summon the crab king"), shouted names in caps: title-case those.
const SMALL = new Set(["a", "an", "and", "the", "of", "in", "on", "to", "for", "at", "by", "with", "or"]);
function spellName(raw: unknown): string {
  const s = clean(raw).replace(/^["'“”]+|["'“”]+$/g, "");
  if (!s) return "a nameless spell";
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s;
  return s.toLowerCase().split(" ").map((w, i) => (i && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\s+([,.!?:])/g, "$1").trim()
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
}
const words = (s: string) => s.split(" ").length;

// Next template from the key's shuffle bag: every line gets a turn before any repeats.
function draw(key: string, n: number): number {
  let bag = bags.get(key);
  if (!bag || !bag.length || bag.some((i) => i >= n)) {
    bag = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    if (n > 1 && bag[n - 1] === lastIdx.get(key)) [bag[0], bag[n - 1]] = [bag[n - 1], bag[0]];
    bags.set(key, bag);
  }
  const i = bag.pop()!;
  lastIdx.set(key, i);
  return i;
}

function choose(key: string, tpls: Tpl[]): string | null {
  let best: string | null = null;
  for (let tries = 0; tries < tpls.length * 2; tries++) {
    const raw = tpls[draw(key, tpls.length)]();
    if (!raw) continue;
    const line = tidy(raw);
    if (line === lastLine) continue; // never the same line twice in a row
    if (words(line) <= MAX_WORDS) return line;
    if (!best || words(line) < words(best)) best = line; // long names: settle for the shortest
  }
  return best;
}
