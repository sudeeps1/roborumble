// The fight screen's HUD: HTML over the canvas. Two plates (portrait, name, title, HP with a
// recent-damage trail, balance), a centre medallion (timer, round, wins), and floating pieces pinned
// over the fighters: spell callouts, the channeling tag, damage numbers, plus full-screen banners.
// Spells are shown from their data only (name, type, kind, power, new), so any of 500+ fit.
import { TYPE_COLORS } from "./fx.ts";

export type Side = 0 | 1;
export interface SpellInfo { name: string; type?: string; kind?: string; power?: number; isNew?: boolean }

/** In-game names of the spell types and kinds. */
export const TYPE_NAME: Record<string, string> = { physical: "Might", fire: "Flame", ice: "Frost", lightning: "Storm", shadow: "Shadow" };
const KIND_NAME: Record<string, string> = { melee: "Melee", projectile: "Bolt", strike: "Smite", shockwave: "Quake", defend: "Ward" };
// one glyph per type (inline SVG paths, 24x24), so a callout reads at a glance
const GLYPH: Record<string, string> = {
  fire: "M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-4-1-6 1-9z",
  ice: "M11 1h2v7l5-4 1 2-6 4 6 4-1 2-5-4v7h-2v-7l-5 4-1-2 6-4-6-4 1-2 5 4z",
  lightning: "M14 1 4 14h6l-2 9 10-13h-6z",
  shadow: "M15 2a10 10 0 1 0 7 15A8 8 0 0 1 15 2z",
  physical: "M12 2 3 6v6c0 5 4 9 9 10 5-1 9-5 9-10V6z",
};
const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
const svg = (type: string) => `<svg viewBox="0 0 24 24"><path d="${GLYPH[type] ?? GLYPH.physical}"/></svg>`;
const el = (cls: string, html = "", tag = "div") => { const e = document.createElement(tag); e.className = cls; e.innerHTML = html; return e; };

interface Plate { root: HTMLElement; hp: HTMLElement; trail: HTMLElement; poise: HTMLElement; num: HTMLElement; pips: HTMLElement; tag: HTMLElement; hpShown: number; trailShown: number; trailHoldUntil: number }

export class Hud {
  readonly root: HTMLElement;
  private plates: Plate[] = [];
  private timer: HTMLElement;
  private round: HTMLElement;
  private banner: HTMLElement;
  private floats: HTMLElement;
  private callouts: (HTMLElement | null)[] = [null, null];
  private calloutUntil = [0, 0];
  private channelEls: HTMLElement[] = [];
  private anchors: { x: number; y: number }[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  private now = 0;
  private bannerUntil = 0;

  constructor(root: HTMLElement, fighters: { name: string; title: string; color: string; portrait: string }[]) {
    this.root = root;
    root.innerHTML = "";
    const top = el("top");
    fighters.forEach((f, i) => {
      const p = el(`plate p${i + 1}`);
      p.style.setProperty("--team", f.color);
      p.innerHTML = `
        <div class="crest"><img alt="" src="${f.portrait}"></div>
        <div class="bars">
          <div class="who"><span class="name">${f.name}</span><span class="title">${f.title}</span></div>
          <div class="hpframe"><div class="trail"></div><div class="hp"></div><div class="shine"></div><span class="num">100</span></div>
          <div class="under"><div class="poisebar"><div class="poise"></div></div><span class="poiselabel">Balance</span><div class="pips"><i></i><i></i></div></div>
          <div class="tag"></div>
        </div>`;
      top.append(p);
      this.plates.push({ root: p, hp: p.querySelector(".hp")!, trail: p.querySelector(".trail")!, poise: p.querySelector(".poise")!, num: p.querySelector(".num")!, pips: p.querySelector(".pips")!, tag: p.querySelector(".tag")!, hpShown: 100, trailShown: 100, trailHoldUntil: 0 });
    });
    const medal = el("medal", `<div class="round">Round 1</div><div class="timer">60</div>`);
    top.insertBefore(medal, top.children[1]);
    this.timer = medal.querySelector(".timer")!;
    this.round = medal.querySelector(".round")!;
    this.floats = el("floats");
    this.banner = el("banner");
    root.append(top, this.floats, this.banner);
    for (let i = 0; i < 2; i++) { const c = el("channel"); this.floats.append(c); this.channelEls.push(c); }
    root.hidden = false;
  }

  // ---------------------------------------------------------------- state

  /** HP 0..max: the bar snaps, the white trail holds a beat then drains after it. */
  hp(i: Side, hp: number, max = 100) {
    const p = this.plates[i], v = Math.max(0, Math.min(1, hp / max)) * 100;
    if (v < p.hpShown - 0.01) { p.trailHoldUntil = this.now + 0.55; p.root.classList.remove("hurt"); void p.root.offsetWidth; p.root.classList.add("hurt"); }
    if (v > p.trailShown) p.trailShown = v;
    p.hpShown = v;
    p.hp.style.width = `${v}%`;
    p.num.textContent = String(Math.ceil(hp));
    p.root.classList.toggle("low", v <= 25);
  }
  poise(i: Side, v: number) {
    const p = this.plates[i];
    p.poise.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
    p.root.classList.toggle("dizzy", v < 0.3);
  }
  wins(w: [number, number]) {
    this.plates.forEach((p, i) => p.pips.querySelectorAll("i").forEach((pip, k) => pip.classList.toggle("on", k < w[i])));
  }
  clock(seconds: number | null, round: number) {
    this.timer.textContent = seconds === null ? "∞" : String(Math.max(0, Math.ceil(seconds)));
    this.timer.classList.toggle("hurry", seconds !== null && seconds <= 10);
    this.round.textContent = `Round ${round}`;
  }
  /** Small status under a plate: "BLOCK", "STAGGERED", "DOWN!"; null clears. */
  status(i: Side, text: string | null) {
    const t = this.plates[i].tag;
    if ((t.textContent || null) === text) return;
    t.textContent = text ?? "";
    t.classList.toggle("on", !!text);
  }

  /** Where each fighter's head is on screen (CSS px), for the floating pieces. */
  anchor(i: Side, x: number, y: number) { this.anchors[i].x = x; this.anchors[i].y = y; }

  // ---------------------------------------------------------------- moments

  /** A spell's name, big, over its caster: type glyph and colour, kind, power, NEW. */
  callout(i: Side, s: SpellInfo) {
    this.callouts[i]?.remove();
    const type = s.type && TYPE_COLORS[s.type] ? s.type : "physical";
    const c = TYPE_COLORS[type];
    const len = s.name.length;
    const size = len <= 10 ? "s1" : len <= 18 ? "s2" : len <= 28 ? "s3" : "s4";
    const pow = Math.max(1, Math.min(3, Math.round(s.power ?? 1)));
    const e = el(`callout ${size} side${i}`, `
      ${s.isNew ? `<div class="new">New spell!</div>` : ""}
      <div class="spellname">${s.name.replace(/</g, "&lt;")}</div>
      <div class="meta"><span class="glyph">${svg(type)}</span><span>${TYPE_NAME[type]}</span>${s.kind ? `<span class="dot">◆</span><span>${KIND_NAME[s.kind] ?? s.kind}</span>` : ""}<span class="dot">◆</span><span class="power">${"★".repeat(pow)}<b>${"★".repeat(3 - pow)}</b></span></div>`);
    e.style.setProperty("--glow", hex(c.glow));
    e.style.setProperty("--core", hex(c.core));
    this.floats.append(e);
    this.callouts[i] = e;
    this.calloutUntil[i] = this.now + 1.9;
  }

  /** The words a player spoke while their spell is being made (null: done). */
  channel(i: Side, words: string | null) {
    const e = this.channelEls[i];
    e.classList.toggle("on", !!words);
    if (words) e.innerHTML = `<span class="lbl">Channeling</span><span class="words">“${words.replace(/</g, "&lt;")}”</span>`;
  }

  /** A damage number at a screen point, with tags (COUNTER!, BLOCKED, CLEAN). */
  damage(x: number, y: number, amount: number, tags: string[], big: boolean, color = "#fff") {
    const e = el(`dmg${big ? " big" : ""}`, `${amount >= 0.5 ? `<b>-${Math.round(amount)}</b>` : ""}${tags.map((t) => `<i>${t}</i>`).join("")}`);
    e.style.left = `${x}px`; e.style.top = `${y}px`;
    e.style.setProperty("--c", color);
    this.floats.append(e);
    setTimeout(() => e.remove(), 1100);
  }

  /** A full-screen banner ("ROUND 2", "FIGHT!", "K.O.") for `seconds`. */
  show(title: string, sub = "", seconds = 1.4, kind = "") {
    this.banner.className = `banner on ${kind}`;
    this.banner.innerHTML = `<div class="t">${title}</div>${sub ? `<div class="s">${sub}</div>` : ""}`;
    this.bannerUntil = this.now + seconds;
  }
  hideBanner() { this.banner.className = "banner"; this.bannerUntil = 0; }

  update(dt: number) {
    this.now += dt;
    for (const p of this.plates) {
      if (this.now > p.trailHoldUntil && p.trailShown > p.hpShown) p.trailShown = Math.max(p.hpShown, p.trailShown - 45 * dt);
      p.trail.style.width = `${p.trailShown}%`;
    }
    // pinned over the fighter's head, but kept whole on screen
    const pin = (e: HTMLElement, a: { x: number; y: number }) => {
      const half = e.offsetWidth / 2 + innerWidth * 0.015;
      const x = Math.min(Math.max(a.x, half), innerWidth - half);
      e.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.max(a.y, e.offsetHeight + innerHeight * 0.2))}px)`;
    };
    for (let i = 0; i < 2; i++) {
      const a = this.anchors[i];
      const c = this.callouts[i];
      if (c) {
        if (this.now > this.calloutUntil[i]) { c.classList.add("out"); this.callouts[i] = null; setTimeout(() => c.remove(), 300); }
        else pin(c, a);
      }
      pin(this.channelEls[i], a);
    }
    if (this.bannerUntil && this.now > this.bannerUntil) this.hideBanner();
  }
}
