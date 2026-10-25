// Synthesized fairy-tale sounds (Web Audio, no asset files): chimes, whooshes, thuds.
// One AudioContext, made on the first user gesture. Voices -> dry bus + reverb send -> compressor
// -> duck (dips under narration) -> master gain -> soft clip -> speakers. Every call is a no-op until
// unlock() and while muted.
import { MOVE_TYPES, type Kind, type MoveType } from "../contract";

type Player = 1 | 2;
type Partial3 = readonly [ratio: number, amp: number, decay: number];
type Timer = ReturnType<typeof setTimeout>;

interface ChargeLoop {
  level: GainNode;              // fade in/out
  pan: StereoPannerNode | null; // leans toward whoever is charging
  sparks: GainNode;             // sparkle pings mix in here
  sources: AudioScheduledSourceNode[];
  started: number;              // audio time
  nextSpark: number;            // audio time of the next sparkle
  timer: Timer | undefined;     // sparkle scheduler
  kill: Timer | undefined;      // stop after the fade-out
  stopping: boolean;
}

interface Engine {
  ac: BaseAudioContext;
  live: boolean;                // false while rendering offline
  master: GainNode;
  duck: GainNode;               // dips the effects while the narrator speaks
  dry: GainNode;
  wet: GainNode;                // reverb send
  white: AudioBuffer;
  pink: AudioBuffer;
  crackle: AudioBuffer;
  last: Map<string, number>;    // last start time per sound, to drop accidental double triggers
  warm: number;                 // audio time when the compressor has settled (it starts fully clamped)
  loop: ChargeLoop | null;
}

const LEVEL = 0.8; // master gain
const HIT = 0.55;    // hit loudness trim (the others are tuned around it)
const DUCK = 0.6;    // effects level under narration (about -4.4 dB)
const WARMUP = 0.25; // Chrome's compressor starts clamped and releases over ~0.2 s: nothing plays before that
let eng: Engine | null = null;
let enabled = true;
let tock = false;
const charging = new Set<Player>();

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];

// Notes (Hz). Chimes stay in E major pentatonic so overlapping sounds never clash.
const Gs3 = 207.65, E4 = 329.63, Gs4 = 415.3, A4 = 440, B4 = 493.88, Cs5 = 554.37, Ds5 = 622.25, E5 = 659.26, Fs5 = 739.99,
  Gs5 = 830.61, B5 = 987.77, Cs6 = 1108.73, E6 = 1318.51, Fs6 = 1479.98, Gs6 = 1661.22, B6 = 1975.53, Cs7 = 2217.46,
  E7 = 2637.02, Gs7 = 3322.44;
const ICE = [E6, Fs6, Gs6, B6, Cs7, E7, Gs7];

// Partials as [frequency ratio, amplitude, decay multiplier].
const BAR: readonly Partial3[] = [[1, 1, 1], [2.756, 0.4, 0.5], [5.404, 0.16, 0.28]];  // glockenspiel / music box
const BAR2 = BAR.slice(0, 2);
const METAL: readonly Partial3[] = [[1, 1, 1], [2.32, 0.55, 0.75], [4.25, 0.3, 0.5], [6.63, 0.16, 0.35]]; // shield
const DEEP: readonly Partial3[] = [[0.5, 0.45, 1.3], [1, 1, 1], [1.19, 0.4, 0.75], [1.5, 0.25, 0.6], [2, 0.3, 0.45]]; // old bell: hum, prime, minor tierce, fifth, nominal

// ---------- engine ----------
function makeEngine(ac: BaseAudioContext, live: boolean): Engine {
  // A gentle safety limiter: transparent below about -10 dB, so big moments stay bigger than small ones.
  const master = ac.createGain();
  master.gain.value = !live || enabled ? LEVEL : 0;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -6;
  comp.knee.value = 6;
  comp.ratio.value = 8;
  comp.attack.value = 0.002;
  comp.release.value = 0.2;
  const clip = ac.createWaveShaper();
  clip.curve = softClip();
  const duck = ac.createGain();
  const dry = ac.createGain(), wet = ac.createGain(), verbOut = ac.createGain();
  const verb = ac.createConvolver();
  verb.buffer = impulse(ac, 1.6);
  verbOut.gain.value = 1.5;
  dry.connect(comp);
  wet.connect(verb);
  verb.connect(verbOut);
  verbOut.connect(comp);
  comp.connect(duck);
  duck.connect(master);
  master.connect(clip);
  clip.connect(ac.destination);
  return { ac, live, master, duck, dry, wet, white: whiteNoise(ac), pink: pinkNoise(ac), crackle: crackleNoise(ac), last: new Map(), warm: ac.currentTime + WARMUP, loop: null };
}

// Linear up to 0.7, then a tanh knee that never passes ~0.93: transparent normally, no hard clipping when sounds pile up.
function softClip(): Float32Array<ArrayBuffer> {
  const n = 2048, knee = 0.7, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
    c[i] = ax <= knee ? x : Math.sign(x) * (knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee)));
  }
  return c;
}

function whiteNoise(ac: BaseAudioContext): AudioBuffer {
  const n = Math.floor(ac.sampleRate * 2), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

// Pink noise (Paul Kellet's filter): softer than white, the base of every whoosh.
function pinkNoise(ac: BaseAudioContext): AudioBuffer {
  const n = Math.floor(ac.sampleRate * 2), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    peak = Math.max(peak, Math.abs(d[i]));
  }
  for (let i = 0; i < n; i++) d[i] /= peak;
  return b;
}

// Sparse pops for fire and sparks: mostly tiny ticks, a few big snaps.
function crackleNoise(ac: BaseAudioContext): AudioBuffer {
  const rate = ac.sampleRate, n = Math.floor(rate * 2), b = ac.createBuffer(1, n, rate), d = b.getChannelData(0);
  for (let i = Math.floor(rate * 0.005); i < n; i += Math.floor(rate * rand(0.004, 0.035))) {
    const len = Math.floor(rate * rand(0.0006, 0.004)), amp = 0.15 + 0.85 * Math.random() ** 3;
    for (let j = 0; j < len && i + j < n; j++) d[i + j] += (Math.random() * 2 - 1) * amp * Math.exp((-5 * j) / len);
  }
  return b;
}

// Reverb tail: decaying noise that darkens as it fades, a forest clearing rather than a stone hall.
function impulse(ac: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ac.sampleRate, n = Math.floor(rate * seconds), pre = Math.floor(rate * 0.012);
  const b = ac.createBuffer(2, n, rate), k = Math.exp(-6.9 / (n - pre));
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let amp = 1, lp = 0;
    for (let i = pre; i < n; i++) {
      const smooth = 0.15 + 0.75 * (i / n);
      lp += (Math.random() * 2 - 1 - lp) * (1 - smooth);
      d[i] = lp * amp;
      amp *= k;
    }
  }
  return b;
}

/** The engine if a sound may play now (unlocked, running, not muted, not a double trigger). */
function ready(name: string, gap: number): Engine | null {
  const e = eng;
  if (!e || !enabled) return null;
  if (!e.live) return e;
  if ((e.ac as AudioContext).state !== "running") return null;
  const t = e.ac.currentTime;
  if (t - (e.last.get(name) ?? -1) < gap) return null;
  e.last.set(name, t);
  return e;
}

const at = (e: Engine) => Math.max(e.ac.currentTime + 0.01, e.warm);

// ---------- building blocks ----------
/** A gain routed to the dry bus plus a reverb send, optionally panned (or swept pan0 -> pan1). */
function out(e: Engine, wet: number, pan0 = 0, pan1 = pan0, sweep = 0): GainNode {
  const ac = e.ac, g = ac.createGain();
  let node: AudioNode = g;
  if ((pan0 || pan1) && typeof ac.createStereoPanner === "function") {
    const p = ac.createStereoPanner(), t = at(e);
    p.pan.setValueAtTime(clamp(pan0, -1, 1), t);
    if (pan1 !== pan0) p.pan.linearRampToValueAtTime(clamp(pan1, -1, 1), t + sweep);
    g.connect(p);
    node = p;
  }
  node.connect(e.dry);
  if (wet > 0) {
    const s = ac.createGain();
    s.gain.value = wet;
    node.connect(s);
    s.connect(e.wet);
  }
  return g;
}

/** Fresh gain with a percussive envelope: 0 -> peak over `a`, exponential fall over `d`. */
function env(e: Engine, to: AudioNode, t: number, peak: number, a: number, d: number): GainNode {
  const g = e.ac.createGain(), p = g.gain;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(Math.max(peak, 1e-4), t + a);
  p.exponentialRampToValueAtTime(1e-4, t + a + d);
  p.setValueAtTime(0, t + a + d + 0.005);
  g.connect(to);
  return g;
}

function tone(e: Engine, to: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, glide: number, peak: number, a: number, d: number): OscillatorNode {
  const o = e.ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + Math.max(0.005, glide));
  o.connect(env(e, to, t, peak, a, d));
  o.start(t);
  o.stop(t + a + d + 0.02);
  return o;
}

/** Struck bell/bar: sine partials, the high ones dying first. */
function bell(e: Engine, to: AudioNode, t: number, f: number, peak: number, d: number, partials: readonly Partial3[] = BAR) {
  for (const [r, amp, dm] of partials) {
    if (f * r < 12000) tone(e, to, t, "sine", f * r, f * r, 0, peak * amp, 0.002, d * dm);
  }
}

/** Filtered noise burst with an optional filter glide f0 -> f1. */
function noise(e: Engine, to: AudioNode, t: number, buf: AudioBuffer, dur: number, type: BiquadFilterType, f0: number, f1: number, q: number, peak: number, a = 0.004) {
  const ac = e.ac, src = ac.createBufferSource(), flt = ac.createBiquadFilter();
  src.buffer = buf;
  flt.type = type;
  flt.Q.value = q;
  flt.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
  src.connect(flt);
  flt.connect(env(e, to, t, peak, a, Math.max(0.01, dur - a)));
  src.start(t, Math.random() * Math.max(0, buf.duration - dur - 0.05));
  src.stop(t + dur + 0.02);
}

/** Noise swell whose filter rises f0 -> fPeak while it swells, then falls to f1. */
function whoosh(e: Engine, to: AudioNode, t: number, dur: number, type: BiquadFilterType, f0: number, fPeak: number, f1: number, q: number, peak: number, attack: number) {
  const ac = e.ac, src = ac.createBufferSource(), flt = ac.createBiquadFilter();
  src.buffer = e.pink;
  flt.type = type;
  flt.Q.value = q;
  flt.frequency.setValueAtTime(f0, t);
  flt.frequency.exponentialRampToValueAtTime(fPeak, t + attack);
  flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
  src.connect(flt);
  flt.connect(env(e, to, t, peak, attack, Math.max(0.01, dur - attack)));
  src.start(t, Math.random() * Math.max(0, e.pink.duration - dur - 0.05));
  src.stop(t + dur + 0.02);
}

/** Leaves and petals: a few short bright noise grains. */
function rustle(e: Engine, to: AudioNode, t: number, dur: number, grains: number, peak: number) {
  for (let i = 0; i < grains; i++) {
    const f = rand(2600, 5600);
    noise(e, to, t + ((i + Math.random()) / grains) * dur, e.white, rand(0.03, 0.07), "bandpass", f, f * 0.8, 1.4, peak * rand(0.5, 1), 0.006);
  }
}

function crackle(e: Engine, to: AudioNode, t: number, dur: number, f: number, q: number, peak: number) {
  noise(e, to, t, e.crackle, dur, "bandpass", f, f * 0.8, q, peak, 0.003);
}

/** Oscillator with a vibrato LFO on its detune (cents), for whistles and sad slides. */
function wobble(e: Engine, to: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, glide: number, rate: number, cents: number, dur: number): OscillatorNode {
  const ac = e.ac, o = ac.createOscillator(), lfo = ac.createOscillator(), depth = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + glide);
  lfo.frequency.value = rate;
  depth.gain.setValueAtTime(cents * 0.2, t);
  depth.gain.linearRampToValueAtTime(cents, t + dur);
  lfo.connect(depth);
  depth.connect(o.detune);
  o.connect(to);
  o.start(t);
  lfo.start(t);
  o.stop(t + dur + 0.02);
  lfo.stop(t + dur + 0.02);
  return o;
}

// ---------- hits, by type ----------
function hitMight(e: Engine, t: number, s: number, lv: number) { // wooden thunk + leafy rustle
  const o = out(e, 0.1), p = 1.12 - 0.1 * s; // bigger blows sit lower
  tone(e, o, t, "sine", 200 * p, 68 * p, 0.09, 0.75 * lv, 0.002, 0.14 + 0.06 * s);
  tone(e, o, t, "triangle", 840 * p, 560 * p, 0.04, 0.42 * lv, 0.001, 0.06);
  noise(e, o, t, e.white, 0.014, "lowpass", 3800, 1800, 0.7, 0.65 * lv, 0.001);
  rustle(e, out(e, 0.25), t + 0.025, 0.2 + 0.1 * s, 5, 0.32 * lv);
  if (s > 0.9) tone(e, o, t, "sine", 85, 42, 0.12, 0.35 * (s - 0.6) * lv, 0.002, 0.25);
}

function hitFlame(e: Engine, t: number, s: number, lv: number) { // whoomp + crackle
  const o = out(e, 0.15);
  whoosh(e, o, t, 0.36 + 0.1 * s, "lowpass", 220, 1700, 260, 1.2, 1.45 * lv, 0.03);
  tone(e, o, t, "sine", 150, 55, 0.12, 0.5 * lv, 0.003, 0.22 + 0.05 * s);
  crackle(e, out(e, 0.2), t + 0.03, 0.5 + 0.25 * s, 2600, 0.7, 0.6 * lv);
}

function hitFrost(e: Engine, t: number, s: number, lv: number) { // crystalline shatter, chime cluster
  const o = out(e, 0.15), glass = out(e, 0.4);
  noise(e, o, t, e.white, 0.05, "highpass", 4500, 6000, 0.7, 0.3 * lv, 0.001);
  tone(e, o, t, "sine", 320, 150, 0.06, 0.5 * lv, 0.002, 0.1);
  const n = 5 + Math.round(2 * s);
  for (let i = 0; i < n; i++) bell(e, glass, t + i * 0.022 + rand(0, 0.02), pick(ICE), rand(0.12, 0.19) * lv, rand(0.25, 0.55), BAR2);
  if (s > 0.9) tone(e, o, t, "sine", 120, 60, 0.1, 0.35 * (s - 0.6) * lv, 0.002, 0.2);
}

function hitStorm(e: Engine, t: number, s: number, lv: number) { // zap + spark crackle
  const ac = e.ac, o = out(e, 0.12);
  const osc = ac.createOscillator(), lp = ac.createBiquadFilter(), fm = ac.createOscillator(), fmAmt = ac.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(1700, t);
  osc.frequency.exponentialRampToValueAtTime(140, t + 0.14);
  fm.type = "square";
  fm.frequency.value = 58;
  fmAmt.gain.setValueAtTime(180, t);
  fmAmt.gain.linearRampToValueAtTime(40, t + 0.15);
  fm.connect(fmAmt);
  fmAmt.connect(osc.frequency);
  lp.type = "lowpass";
  lp.frequency.value = 3200;
  lp.Q.value = 0.8;
  osc.connect(lp);
  lp.connect(env(e, o, t, 0.36 * lv, 0.002, 0.18));
  osc.start(t);
  fm.start(t);
  osc.stop(t + 0.22);
  fm.stop(t + 0.22);
  noise(e, o, t, e.white, 0.02, "highpass", 2200, 2200, 0.7, 0.45 * lv, 0.001);
  const sparks = out(e, 0.25);
  crackle(e, sparks, t + 0.01, 0.42 + 0.15 * s, 3200, 0.9, 1.5 * lv);
  crackle(e, sparks, t + 0.03, 0.3, 1400, 0.8, 0.8 * lv);
  tone(e, o, t, "sine", 130, 60, 0.08, 0.6 * lv, 0.002, 0.16);
  bell(e, out(e, 0.45), t + 0.02, E7, 0.06 * lv, 0.3, BAR2); // a wisp of light
}

function hitShadow(e: Engine, t: number, s: number, lv: number) { // deep whoosh + low chime
  const o = out(e, 0.18);
  whoosh(e, o, t, 0.5 + 0.1 * s, "bandpass", 160, 650, 150, 0.9, 1.6 * lv, 0.07);
  tone(e, o, t, "sine", 72, 46, 0.4, 0.42 * lv, 0.05, 0.4);
  bell(e, out(e, 0.5), t + 0.05, Gs3, 0.26 * lv, 0.9, DEEP);
}

const HITS: Record<MoveType, (e: Engine, t: number, s: number, lv: number) => void> = {
  physical: hitMight, fire: hitFlame, ice: hitFrost, lightning: hitStorm, shadow: hitShadow,
};

// ---------- casts: a gesture per kind, a little chime per type ----------
const CAST_KIND: Record<Kind, (e: Engine, t: number) => void> = {
  melee(e, t) { // quick swish
    whoosh(e, out(e, 0.12), t, 0.2, "bandpass", 700, 2800, 1500, 1.8, 1.05, 0.07);
  },
  projectile(e, t) { // launch whoosh
    const o = out(e, 0.2);
    whoosh(e, o, t, 0.32, "bandpass", 380, 2300, 1200, 1.2, 0.7, 0.16);
    tone(e, o, t, "triangle", 260, 780, 0.18, 0.12, 0.01, 0.2);
  },
  strike(e, t) { // rising whistle, the vibrato growing as it climbs
    const o = out(e, 0.3), g = e.ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.13, t + 0.08);
    g.gain.setValueAtTime(0.13, t + 0.36);
    g.gain.exponentialRampToValueAtTime(1e-4, t + 0.55);
    g.connect(o);
    wobble(e, g, t, "sine", 620, 2100, 0.45, 7, 40, 0.56);
    whoosh(e, o, t, 0.5, "bandpass", 600, 2000, 2100, 6, 0.6, 0.4);
  },
  shockwave(e, t) { // low swell
    const o = out(e, 0.2), g = e.ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.3);
    g.gain.exponentialRampToValueAtTime(1e-4, t + 0.6);
    g.connect(o);
    tone(e, g, t, "sine", 55, 75, 0.35, 0.45, 0.005, 0.6);
    tone(e, g, t, "triangle", 110, 150, 0.35, 0.12, 0.005, 0.6);
    whoosh(e, o, t, 0.55, "lowpass", 180, 900, 200, 0.9, 0.5, 0.3);
  },
  defend(e, t) { // shield shimmer
    const o = out(e, 0.4);
    bell(e, o, t, B5, 0.1, 0.5);
    bell(e, o, t + 0.04, Fs6, 0.07, 0.45);
    whoosh(e, o, t, 0.3, "highpass", 2500, 4000, 3000, 0.7, 0.12, 0.12);
  },
};

const CAST_TYPE: Record<MoveType, (e: Engine, t: number) => void> = {
  physical(e, t) { // a wooden tok and a low bell
    const o = out(e, 0.25);
    tone(e, o, t, "triangle", 720, 540, 0.05, 0.14, 0.002, 0.07);
    bell(e, o, t + 0.02, E5, 0.07, 0.35);
  },
  fire(e, t) { // warm hearth chime and a few embers
    const o = out(e, 0.35);
    tone(e, o, t, "triangle", E5, E5, 0, 0.07, 0.01, 0.4);
    tone(e, o, t + 0.05, "triangle", Gs5, Gs5, 0, 0.06, 0.01, 0.35);
    crackle(e, o, t, 0.3, 2400, 0.7, 0.3);
  },
  ice(e, t) { // glassy sparkle
    const o = out(e, 0.5);
    [B6, E7, Gs7].forEach((f, i) => bell(e, o, t + i * 0.045, f, 0.06, 0.3, BAR2));
  },
  lightning(e, t) { // zap chirp and a ping
    const o = out(e, 0.25);
    tone(e, o, t, "sine", 2400, 500, 0.07, 0.1, 0.002, 0.08);
    crackle(e, o, t + 0.02, 0.16, 3400, 1, 0.35);
    bell(e, out(e, 0.4), t + 0.05, B6, 0.05, 0.3, BAR2);
  },
  shadow(e, t) { // breathy dark whoosh, a minor chime
    const o = out(e, 0.4);
    whoosh(e, o, t, 0.34, "lowpass", 200, 600, 180, 1, 0.18, 0.15);
    bell(e, o, t + 0.04, Cs5, 0.06, 0.5);
    bell(e, o, t + 0.09, E5, 0.05, 0.45);
  },
};

// ---------- charge loop ----------
const PAD: readonly [number, number, OscillatorType][] = [[E4, 0.45, "sine"], [B4, 0.24, "triangle"], [E5, 0.3, "sine"], [Gs5, 0.12, "triangle"], [B5, 0.1, "sine"]];
const SPARK = [E6, Gs6, B6, Cs7, E7];
const RISE = 2 ** (2 / 12); // the shimmer climbs two semitones as it charges

function startLoop(e: Engine): ChargeLoop {
  const ac = e.ac, t = at(e) + 0.01;
  const level = ac.createGain();
  level.gain.value = 0;
  const pan = typeof ac.createStereoPanner === "function" ? ac.createStereoPanner() : null;
  const dest = out(e, 0.45);
  if (pan) { level.connect(pan); pan.connect(dest); } else level.connect(dest);

  const filt = ac.createBiquadFilter(); // opens up as power builds
  filt.type = "lowpass";
  filt.Q.value = 3;
  filt.frequency.setValueAtTime(700, t);
  filt.frequency.setTargetAtTime(3800, t, 1.8);
  const trem = ac.createGain();
  trem.gain.value = 0.65;
  filt.connect(trem);
  trem.connect(level);

  const sources: AudioScheduledSourceNode[] = [];
  const lfo = (freq: number, depth: number, ...targets: AudioParam[]) => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = freq;
    g.gain.value = depth;
    o.connect(g);
    for (const p of targets) g.connect(p);
    o.start(t);
    sources.push(o);
    return o;
  };
  lfo(4.5, 0.32, trem.gain).frequency.setTargetAtTime(9, t, 2.5); // tremolo quickens
  lfo(0.13, 500, filt.frequency); // slow breathing once it is open

  const voices = PAD.map(([f, amp, type]) => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.frequency.setTargetAtTime(f * RISE, t + 0.3, 1.2);
    o.detune.value = rand(-6, 6);
    g.gain.value = amp;
    o.connect(g);
    g.connect(filt);
    o.start(t);
    sources.push(o);
    return o;
  });
  lfo(5.3, 7, ...voices.map((o) => o.detune)); // gentle vibrato

  const hiss = ac.createBufferSource(), hf = ac.createBiquadFilter(), hg = ac.createGain(); // fairy-dust hiss
  hiss.buffer = e.pink;
  hiss.loop = true;
  hf.type = "bandpass";
  hf.frequency.value = 6500;
  hf.Q.value = 0.9;
  hg.gain.value = 0.05;
  hiss.connect(hf);
  hf.connect(hg);
  hg.connect(trem);
  hiss.start(t);
  sources.push(hiss);

  const sparks = ac.createGain();
  sparks.connect(level);
  const L: ChargeLoop = { level, pan, sparks, sources, started: t, nextSpark: t + 0.15, timer: undefined, kill: undefined, stopping: false };
  if (e.live) {
    sparkle(e, L, t + 0.3);
    L.timer = setInterval(() => sparkle(e, L, at(e) + 0.3), 100);
  } else sparkle(e, L, t + 10);
  return L;
}

// Schedule sparkle pings up to `until`: sparse at first, denser as the charge builds.
function sparkle(e: Engine, L: ChargeLoop, until: number) {
  while (L.nextSpark < until) {
    const age = L.nextSpark - L.started;
    const rise = RISE ** (age > 0.3 ? 1 - Math.exp(-(age - 0.3) / 1.2) : 0); // follow the pad's climb
    bell(e, out2(e, L.sparks, rand(-0.6, 0.6)), L.nextSpark, pick(SPARK) * rise, rand(0.05, 0.09), rand(0.18, 0.38), BAR2);
    L.nextSpark += (0.2 - 0.13 * Math.min(1, age / 5)) * rand(0.6, 1.4);
  }
}

// A panned input into `to` (for sparkles inside the loop).
function out2(e: Engine, to: AudioNode, pan: number): AudioNode {
  if (typeof e.ac.createStereoPanner !== "function") return to;
  const p = e.ac.createStereoPanner();
  p.pan.value = pan;
  p.connect(to);
  return p;
}

function stopLoop(e: Engine, L: ChargeLoop) {
  clearInterval(L.timer);
  clearTimeout(L.kill);
  const t = e.ac.currentTime;
  for (const s of L.sources) {
    try { s.stop(t + 0.05); } catch { /* already stopped */ }
  }
  setTimeout(() => { try { L.level.disconnect(); } catch { /* gone */ } }, 200);
  if (e.loop === L) e.loop = null;
}

// Smoothly retarget a param from wherever it is now.
function glideTo(p: AudioParam, v: number, t: number, tau: number) {
  const cur = p.value;
  p.cancelScheduledValues(t);
  p.setValueAtTime(cur, t);
  p.setTargetAtTime(v, t, tau);
}

function syncCharge() {
  const e = eng;
  if (!e || (e.live && (e.ac as AudioContext).state !== "running")) return;
  const t = at(e), n = charging.size;
  if (n > 0) {
    const L = e.loop ?? (e.loop = startLoop(e));
    L.stopping = false;
    clearTimeout(L.kill);
    glideTo(L.level.gain, n > 1 ? 0.17 : 0.12, t, 0.18); // fades in over ~0.5 s
    if (L.pan) glideTo(L.pan.pan, n > 1 ? 0 : charging.has(1) ? -0.35 : 0.35, t, 0.25);
  } else if (e.loop && !e.loop.stopping) {
    const L = e.loop;
    L.stopping = true;
    glideTo(L.level.gain, 0, t, 0.12); // fades out over ~0.5 s
    L.kill = setTimeout(() => { if (L.stopping) stopLoop(e, L); }, 900);
  }
}

// ---------- the API ----------
function safe<A extends unknown[]>(f: (...a: A) => void): (...a: A) => void {
  return (...a: A) => {
    try { f(...a); } catch (err) { if (import.meta.env?.DEV) console.warn("sfx:", err); }
  };
}

export const sfx = {
  /** Create/resume the AudioContext. Call from a user gesture. */
  unlock: safe((): void => {
    if (eng?.live && (eng.ac as AudioContext).state === "running") return;
    if (!eng) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ac = new AC({ latencyHint: "interactive" });
      eng = makeEngine(ac, true);
      ac.addEventListener("statechange", () => syncCharge());
    }
    const ac = eng.ac as AudioContext;
    if (ac.state !== "running") Promise.resolve(ac.resume()).then(syncCharge, () => {});
    else syncCharge();
  }),

  setEnabled: safe((on: boolean): void => {
    enabled = !!on;
    if (!eng?.live) return;
    const g = eng.master.gain, t = eng.ac.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(enabled ? LEVEL : 0, t + 0.08);
  }),

  /** Dip the effects while the narrator speaks, so the story cuts through the fight. */
  duck: safe((on: boolean): void => {
    if (!eng?.live) return;
    glideTo(eng.duck.gain, on ? DUCK : 1, eng.ac.currentTime, on ? 0.06 : 0.25);
  }),

  /** strength ~0.3 (light) .. 1.5 (huge). */
  hit: safe((type: MoveType, strength: number, clean: boolean): void => {
    const e = ready("hit", 0.03);
    if (!e) return;
    const t = at(e), s = clamp(Number.isFinite(strength) ? strength : 0.8, 0.2, 2);
    const lv = HIT * (0.35 + 0.45 * Math.min(s, 1.5)); // light taps are ~6 dB below huge blows
    HITS[MOVE_TYPES.includes(type) ? type : "physical"](e, t, s, lv);
    if (clean) { // a bright bell on a clean blow
      const o = out(e, 0.45);
      bell(e, o, t + 0.01, E6 * rand(0.99, 1.01), 0.32 * lv, 0.7);
      bell(e, o, t + 0.045, B6 * rand(0.99, 1.01), 0.16 * lv, 0.5);
    }
  }),

  block: safe((): void => { // metallic shield ting
    const e = ready("block", 0.05);
    if (!e) return;
    const t = at(e), o = out(e, 0.3);
    noise(e, o, t, e.white, 0.018, "bandpass", 4000, 3000, 1.4, 0.35, 0.001);
    tone(e, o, t, "sine", 230, 140, 0.05, 0.25, 0.002, 0.08);
    bell(e, o, t, 1250 * rand(0.97, 1.03), 0.17, 0.55, METAL);
  }),

  dodge: safe((): void => { // airy whoosh, swept across the stereo field
    const e = ready("dodge", 0.08);
    if (!e) return;
    const t = at(e), o = out(e, 0.2, -0.6, 0.6, 0.32);
    whoosh(e, o, t, 0.34, "bandpass", 450, 2400, 800, 1.3, 1.4, 0.14);
    tone(e, o, t, "sine", 900, 1700, 0.2, 0.035, 0.08, 0.18);
  }),

  down: safe((): void => { // heavy thud, a clockwork clank, gears rattling, leaves
    const e = ready("down", 0.2);
    if (!e) return;
    const t = at(e), o = out(e, 0.15), gears = out(e, 0.3);
    tone(e, o, t, "sine", 120, 38, 0.22, 0.5, 0.003, 0.45);
    noise(e, o, t, e.pink, 0.32, "lowpass", 420, 110, 0.8, 0.55, 0.003);
    bell(e, out(e, 0.25), t + 0.01, 620, 0.12, 0.18, METAL);
    for (let i = 0; i < 4; i++) bell(e, gears, t + 0.07 + i * 0.05 + rand(0, 0.03), rand(2000, 3200), 0.045, 0.06, METAL.slice(0, 2));
    rustle(e, out(e, 0.25), t + 0.08, 0.45, 6, 0.2);
  }),

  ko: safe((): void => { // big low boom, then the fairy magic drains away down the scale
    const e = ready("ko", 0.5);
    if (!e) return;
    const t = at(e), o = out(e, 0.3);
    tone(e, o, t, "sine", 95, 30, 0.7, 0.8, 0.004, 0.95);
    tone(e, o, t, "sine", 190, 60, 0.3, 0.25, 0.003, 0.4);
    noise(e, o, t, e.pink, 0.85, "lowpass", 650, 70, 0.7, 1.0, 0.004);
    [E7, Cs7, B6, Gs6, Fs6, E6, Cs6, B5, Gs5, Fs5].forEach((f, i) =>
      bell(e, out(e, 0.55, 0.4 - i * 0.08), t + 0.22 + i * 0.055, f, 0.13 - i * 0.005, 0.32, BAR2));
  }),

  /** A move starts (by type and kind). */
  cast: safe((type: MoveType, kind: Kind): void => {
    const e = ready("cast", 0.05);
    if (!e) return;
    const t = at(e);
    CAST_KIND[Object.hasOwn(CAST_KIND, kind) ? kind : "melee"](e, t);
    CAST_TYPE[MOVE_TYPES.includes(type) ? type : "physical"](e, t);
  }),

  /** Shimmer loop while a fighter charges a live wildcard. Ref-counted per player. */
  charge: safe((player: 1 | 2, on: boolean): void => {
    if (player !== 1 && player !== 2) return;
    if (on) charging.add(player);
    else charging.delete(player);
    syncCharge();
  }),

  fizzle: safe((): void => { // a deflating puff and a sad little slide
    const e = ready("fizzle", 0.1);
    if (!e) return;
    const t = at(e), o = out(e, 0.2);
    whoosh(e, o, t, 0.5, "lowpass", 2400, 2000, 170, 2.2, 0.55, 0.02);
    wobble(e, env(e, o, t, 0.07, 0.02, 0.45), t, "triangle", 540, 140, 0.45, 11, 45, 0.48);
  }),

  roundStart: safe((): void => { // bright chime arpeggio
    const e = ready("roundStart", 0.3);
    if (!e) return;
    const t = at(e), o = out(e, 0.45);
    [E6, Gs6, B6, E7].forEach((f, i) => bell(e, o, t + i * 0.075, f, 0.12 + i * 0.012, i === 3 ? 0.85 : 0.55));
    bell(e, o, t + 0.225, E6 * 1.003, 0.1, 0.8);
    noise(e, out(e, 0.5), t + 0.2, e.white, 0.6, "highpass", 6000, 8000, 0.7, 0.035, 0.15);
  }),

  roundEnd: safe((): void => { // soft music-box cadence: IV, V, I
    const e = ready("roundEnd", 0.3);
    if (!e) return;
    const t = at(e), o = out(e, 0.4);
    const chords = [[A4, Cs5, E5], [B4, Ds5, Fs5], [E4, Gs4, B4, E5]];
    chords.forEach((c, i) => c.forEach((f, j) => bell(e, o, t + i * 0.24 + j * 0.012, f, 0.095, i === 2 ? 0.7 : 0.36, BAR2)));
  }),

  /** Last-seconds timer tick. */
  tick: safe((): void => { // soft wooden tick-tock
    const e = ready("tick", 0.2);
    if (!e) return;
    const t = at(e), o = out(e, 0.08), f = (tock = !tock) ? 1500 : 1950;
    tone(e, o, t, "triangle", f, f * 0.8, 0.02, 0.2, 0.001, 0.05);
    noise(e, o, t, e.white, 0.012, "bandpass", f * 1.6, f * 1.4, 3, 0.45, 0.001);
  }),

  /** A phone joined the room. */
  join: safe((): void => { // a little sparkle chime
    const e = ready("join", 0.1);
    if (!e) return;
    const t = at(e), o = out(e, 0.5);
    bell(e, o, t, E6, 0.11, 0.5);
    [B6, E7, Gs7].forEach((f, i) => bell(e, o, t + 0.05 + i * 0.06, f, 0.12, 0.4, BAR2));
  }),
};

/**
 * Render sfx calls into an OfflineAudioContext through the same output chain, e.g. to check levels:
 * `const buf = await renderSfx(() => sfx.ko(), 2)`. The live context and charge state are untouched.
 */
export async function renderSfx(play: () => void, seconds = 1.5, sampleRate = 48000): Promise<AudioBuffer> {
  const pre = WARMUP + 0.05;
  const ac = new OfflineAudioContext(2, Math.ceil((seconds + pre) * sampleRate), sampleRate);
  const saved = eng, savedOn = enabled, savedCharging = [...charging];
  eng = makeEngine(ac, false);
  eng.warm = pre;
  enabled = true;
  try {
    play();
  } finally {
    const loop = eng.loop;
    if (loop) { clearInterval(loop.timer); clearTimeout(loop.kill); }
    eng = saved;
    enabled = savedOn;
    charging.clear();
    for (const p of savedCharging) charging.add(p);
  }
  const full = await ac.startRendering(), skip = Math.round((pre - 0.01) * sampleRate);
  const buf = new AudioBuffer({ numberOfChannels: 2, length: full.length - skip, sampleRate });
  for (let ch = 0; ch < 2; ch++) buf.copyToChannel(full.getChannelData(ch).subarray(skip), ch);
  return buf;
}
