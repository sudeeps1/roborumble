// In-fight overlay styled as an illuminated storybook: parchment panels, gold trim, serif display font.
// In-game type names: Might, Flame, Frost, Storm, Shadow (config.TYPE_NAME). Code keeps the ids.
import type { LibraryStats, MoveSpec, MoveType, Player, Status } from "../contract";
import { ROUNDS_TO_WIN, TYPE_CSS, TYPE_NAME, type CharacterDef } from "../config";
import { FLOURISH, PUFF, RUNE_RING, SEAL, SPARK, STAR, TYPE_GLYPH, emblemSvg } from "./art";
import { art, clamp, h, hexCss, remPx } from "./dom";
import { LibraryCounter } from "./library";

export interface Seat { nickname: string; character: CharacterDef; connected: boolean; }
export interface ScreenPoint { x: number; y: number; }

const FLASH_MS = 1650;
const FIZZLE_MS = 1900;
const TOP_SAFE_REM = 10.4;   // floating things stay below the corner plates and the timer medallion
const BOTTOM_SAFE_REM = 5;   // ...and above the library ribbon

const STATUS_HINT: Partial<Record<Status, [string, string]>> = {
  charging: ["Summoning…", "st-charge"],
  stunned: ["Dazed", "st-dazed"],
  down: ["Down!", "st-down"],
  ko: ["Knocked out", "st-ko"],
  blocking: ["Guarding", "st-guard"],
  dodging: ["Dodging", "st-dodge"],
};

interface Plate {
  root: HTMLElement; body: HTMLElement; emblem: HTMLElement; nick: HTMLElement; dot: HTMLElement; who: HTMLElement;
  status: HTMLElement; hp: HTMLElement; trail: HTMLElement; en: HTMLElement;
  charId: string; hpShown: number; enShown: number; statusShown: string; low: boolean;
}

/** A floating element that follows a fighter's overhead anchor. */
interface Tracked {
  el: HTMLElement; p: Player; kind: "flash" | "charge" | "fizzle";
  w: number; h: number; ay: number; dy: number; x: number; y: number; timer: number;
}

interface Anchor { x: number; y: number; vis: boolean; init: boolean; }

const nameSize = (s: string) => (s.length <= 9 ? "n1" : s.length <= 14 ? "n2" : s.length <= 20 ? "n3" : s.length <= 28 ? "n4" : "n5");
const bannerSize = (s: string) => (s.length <= 6 ? "b1" : s.length <= 12 ? "b2" : s.length <= 20 ? "b3" : "b4");
const visible = (a: ScreenPoint) => (a as ScreenPoint & { visible?: boolean }).visible !== false && Number.isFinite(a.x) && Number.isFinite(a.y);

export class Hud {
  private readonly root: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly plates: Record<Player, Plate>;
  private readonly medal: HTMLElement;
  private readonly timerEl: HTMLElement;
  private readonly roundEl: HTMLElement;
  private readonly pips: Record<Player, HTMLElement[]>;
  private readonly lib = new LibraryCounter("ribbon");
  private readonly captionEl: HTMLElement;
  private readonly captionText: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly floats: HTMLElement;
  private readonly over: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly toastTimers = new Map<HTMLElement, number>();

  private readonly anchor: Record<Player, Anchor> = { 1: { x: 0, y: 0, vis: true, init: false }, 2: { x: 0, y: 0, vis: true, init: false } };
  private lastAnchorT = 0;
  private tracked: Tracked[] = [];
  private flash: Record<Player, Tracked | null> = { 1: null, 2: null };
  private charge: Record<Player, Tracked | null> = { 1: null, 2: null };
  private fizz: Record<Player, Tracked | null> = { 1: null, 2: null };
  private glow: Record<Player, string> = { 1: "#ff5f7e", 2: "#b47cff" };
  private timerShown: number | null = -1;
  private wins: Record<Player, number> = { 1: 0, 2: 0 };
  private bannerTimer = 0;
  private captionTimer = 0;
  private rem = remPx();

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add("ui-hud");
    this.layer = h("div", "hud-layer");

    this.plates = { 1: this.buildPlate(1), 2: this.buildPlate(2) };

    // Center: timer medallion, round ribbon, round pips (best of 3 -> two per side).
    this.medal = h("div", "medal medal-ring idle");
    this.timerEl = h("div", "medal-t");
    this.medal.append(h("div", "medal-orn", "✦"), this.timerEl);
    this.roundEl = h("div", "round-tag", "Round 1");
    const pipRow = (p: Player) => {
      const row = h("div", `pips p${p}`);
      const list = Array.from({ length: ROUNDS_TO_WIN }, () => art(STAR, "pip"));
      row.append(...(p === 1 ? [...list].reverse() : list));
      return { row, list };
    };
    const r1 = pipRow(1), r2 = pipRow(2);
    this.pips = { 1: r1.list, 2: r2.list };

    this.over = h("div", "over");
    this.floats = h("div", "floats");

    this.captionEl = h("div", "caption");
    this.captionText = h("div", "caption-text");
    this.captionEl.append(h("i", "rb-tail l"), h("i", "rb-tail r"), this.captionText);

    this.bannerEl = h("div", "banner");
    this.bannerTitle = h("div", "banner-title");
    this.bannerSub = h("div", "banner-sub");
    this.bannerEl.append(this.bannerTitle, art(FLOURISH, "banner-orn"), this.bannerSub);

    this.lib.el.classList.add("hud-lib");

    this.layer.append(this.plates[1].root, this.plates[2].root, r1.row, r2.row, this.medal, this.roundEl,
      this.lib.el, this.captionEl, this.over, this.floats, this.bannerEl);
    this.toasts = h("div", "toasts");
    root.append(this.layer, this.toasts);

    addEventListener("resize", () => { this.rem = remPx(); });
    // Fonts arrive after first layout; re-measure anything already floating.
    document.fonts?.ready.then(() => { this.rem = remPx(); for (const t of this.tracked) this.measure(t); }).catch(() => {});
  }

  /** Show/hide the whole HUD (hidden in the lobby and on the match-end screen). */
  setVisible(on: boolean): void {
    this.layer.classList.toggle("hidden", !on);
  }

  /** Names, character titles and connection dots for both corners. */
  setPlayers(seats: Record<Player, Seat>): void {
    for (const p of [1, 2] as const) {
      const s = seats[p], pl = this.plates[p];
      if (!s) continue;
      pl.nick.textContent = s.nickname;
      pl.who.textContent = `${s.character.name}, ${s.character.title}`;
      pl.dot.classList.toggle("on", s.connected);
      pl.dot.title = s.connected ? "Phone connected" : "Phone disconnected";
      if (pl.charId !== s.character.id) {
        pl.charId = s.character.id;
        pl.emblem.innerHTML = emblemSvg(s.character.id);
        this.glow[p] = hexCss(s.character.glow);
        pl.root.style.setProperty("--glow", this.glow[p]);
        const c = this.charge[p];
        if (c) c.el.style.setProperty("--glow", this.glow[p]);
      }
    }
  }

  /** Every frame. hp and energy are 0..100. cooldowns: seconds remaining keyed by move id or action. */
  setVitals(p: Player, v: { hp: number; energy: number; status: Status; cooldowns: Record<string, number> }): void {
    const pl = this.plates[p];
    if (!pl) return;
    const hp = Math.round(clamp(Number(v.hp) || 0, 0, 100) * 10) / 10;
    if (hp !== pl.hpShown) {
      const heal = hp > pl.hpShown;
      const hit = pl.hpShown - hp;
      pl.trail.style.transitionDuration = heal ? "0.25s" : "0.7s";
      pl.trail.style.transitionDelay = heal ? "0s" : "0.45s";
      pl.hp.style.width = `${hp}%`;
      pl.trail.style.width = `${hp}%`;
      pl.hpShown = hp;
      const low = hp > 0 && hp <= 25;
      if (low !== pl.low) { pl.low = low; pl.root.classList.toggle("low", low); }
      pl.root.classList.toggle("empty", hp <= 0);
      if (hit >= 2 && pl.body.animate) {
        const s = Math.min(1, hit / 15) * 0.5 * (p === 1 ? 1 : -1);
        pl.body.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-s}rem)` }, { transform: `translateX(${s * 0.6}rem)` }, { transform: "translateX(0)" }], { duration: 260, easing: "ease-out" });
      }
    }
    const en = Math.round(clamp(Number(v.energy) || 0, 0, 100));
    if (en !== pl.enShown) {
      pl.en.style.width = `${en}%`;
      pl.enShown = en;
    }
    const hint = STATUS_HINT[v.status];
    const key = hint ? hint[0] : "";
    if (key !== pl.statusShown) {
      pl.statusShown = key;
      pl.status.textContent = key;
      pl.status.className = hint ? `plate-status on ${hint[1]}` : "plate-status";
    }
  }

  /** Round number and round wins (best of 3 -> two pips per side). */
  setRound(round: number, wins: Record<Player, number>): void {
    this.roundEl.textContent = `Round ${round}`;
    for (const p of [1, 2] as const) {
      const n = wins[p] ?? 0;
      this.pips[p].forEach((pip, i) => {
        const won = i < n;
        if (won && !pip.classList.contains("won") && i >= (this.wins[p] ?? 0)) {
          pip.classList.add("won");
          pip.animate?.([{ transform: "scale(2.2) rotate(-40deg)", opacity: 0 }, { transform: "scale(1) rotate(0)", opacity: 1 }], { duration: 520, easing: "cubic-bezier(.2,.9,.3,1.25)" });
        } else pip.classList.toggle("won", won);
      });
    }
    this.wins = { 1: wins[1] ?? 0, 2: wins[2] ?? 0 };
  }

  /** Seconds left in the round, or null to hide the timer. */
  setTimer(seconds: number | null): void {
    if (seconds == null || !Number.isFinite(seconds)) {
      if (this.timerShown !== null) {
        this.timerShown = null;
        this.timerEl.textContent = "";
        this.medal.classList.add("idle");
        this.medal.classList.remove("urgent");
      }
      return;
    }
    const s = Math.max(0, Math.ceil(seconds - 1e-6));
    if (s === this.timerShown) return;
    this.timerShown = s;
    this.medal.classList.remove("idle");
    this.timerEl.textContent = String(s);
    const urgent = s <= 10;
    this.medal.classList.toggle("urgent", urgent);
    if (urgent && s > 0) this.timerEl.animate?.([{ transform: "scale(1.45)" }, { transform: "scale(1)" }], { duration: 450, easing: "cubic-bezier(.2,.9,.3,1.2)" });
  }

  /** The library counter: agent moves + player moves (a demo moment). Animate changes. */
  setLibrary(stats: LibraryStats): void {
    this.lib.set(stats);
  }

  /** Every frame: CSS-pixel points just above each fighter's head, for things that float over them. */
  setAnchors(a1: ScreenPoint, a2: ScreenPoint): void {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.lastAnchorT) / 1000));
    this.lastAnchorT = now;
    const k = 1 - Math.exp(-dt * 16); // light smoothing: rides out camera shake
    this.ease(this.anchor[1], a1, k);
    this.ease(this.anchor[2], a2, k);
    if (this.tracked.length) this.place();
  }

  /**
   * A move just started: its name and type flash HUGE over the fighter ("GORILLA SMASH"), with
   * "invented by <creator>" when creator is set and a signature badge when move.signature.
   */
  flashMove(p: Player, move: MoveSpec): void {
    if (!move) return;
    this.drop(this.flash[p], true);
    this.drop(this.charge[p], true); // a fading "Summoning…" would show through the new name
    this.drop(this.fizz[p], true);
    const type: MoveType = move.type;
    const el = h("div", `flash p${p} ty-${type}`);
    el.style.setProperty("--tc", TYPE_CSS[type] ?? "#fff4d6");
    const inner = h("div", "flash-in");
    const badges = h("div", "flash-badges");
    if (move.source === "live") {
      const b = h("span", "badge b-wild");
      b.append(art(SPARK, "b-ico"), h("span", "", "Wild magic!"), art(SPARK, "b-ico"));
      badges.append(b);
    }
    if (move.signature) {
      const b = h("span", "badge b-sig");
      b.append(art(SEAL, "b-ico"), h("span", "", "Signature ×1.5"));
      badges.append(b);
    }
    if (badges.childElementCount) inner.append(badges);
    const name = h("div", `flash-name ${nameSize(move.name ?? "")}`, move.name || "???");
    const typeLine = h("div", "flash-type");
    typeLine.append(art(TYPE_GLYPH[type] ?? "", "ty-ico"), h("span", "", TYPE_NAME[type] ?? String(type)), art(TYPE_GLYPH[type] ?? "", "ty-ico"));
    inner.append(name, typeLine);
    if (move.creator) inner.append(h("div", "flash-credit", `invented by ${move.creator}`));
    el.append(inner);
    const t = this.track(el, p, "flash", 0, name);
    this.flash[p] = t;
    this.place(); // the other fighter's flash may now have to move over to its own half
    t.timer = window.setTimeout(() => this.drop(t, false), FLASH_MS);
  }

  /** A live wildcard is generating for this player (guess may be null); off when on=false. */
  charging(p: Player, guess: string | null, on: boolean): void {
    if (!on) {
      this.drop(this.charge[p], false);
      return;
    }
    let t = this.charge[p];
    if (!t) {
      const el = h("div", `charge p${p}`);
      el.style.setProperty("--glow", this.glow[p]);
      const inner = h("div", "charge-in");
      const ring = h("div", "charge-ring");
      ring.append(art(RUNE_RING, "ring-a"), art(RUNE_RING, "ring-b"));
      inner.append(ring, h("div", "charge-lbl", "Summoning…"), h("div", "charge-guess"));
      el.append(inner);
      t = this.track(el, p, "charge", -0.6);
      this.charge[p] = t;
    }
    const g = t.el.querySelector(".charge-guess") as HTMLElement;
    g.textContent = guess ? `“${guess}”` : "a brand-new spell";
    this.measure(t);
    this.place();
  }

  /** The player shouted but can't act (cooldown, energy, stunned). */
  fizzle(p: Player, why: string): void {
    this.drop(this.fizz[p], true);
    const el = h("div", `fizzle p${p}`);
    const inner = h("div", "fizzle-in");
    const head = h("div", "fz-head");
    head.append(art(PUFF, "fz-ico"), h("span", "", "The magic fizzles"));
    inner.append(head);
    // flow.ts may already say "the spell fizzled (<failed check>)": keep just the reason
    const reason = (why ?? "").trim().replace(/^the spell fizzled\s*/i, "").replace(/^\((.*)\)$/, "$1").trim();
    if (reason) inner.append(h("div", "fz-why", reason));
    el.append(inner);
    const t = this.track(el, p, "fizzle", 2.6);
    this.fizz[p] = t;
    this.place();
    t.timer = window.setTimeout(() => this.drop(t, true), FIZZLE_MS);
  }

  /** Clears move-name flashes and fizzles (round over). Charging pills go away with their charge. */
  clearFloating(): void {
    for (const t of [...this.tracked]) if (t.kind !== "charge") this.drop(t, true);
  }

  /** Damage number at a screen point. */
  damage(at: ScreenPoint, amount: number, type: MoveType, clean: boolean): void {
    if (!visible(at)) return;
    const el = h("div", `dmg${clean ? " clean" : ""}`);
    el.style.setProperty("--tc", TYPE_CSS[type] ?? "#fff4d6");
    const inner = h("div", "dmg-in");
    inner.style.setProperty("--dx", `${((Math.random() * 2 - 1) * 1.8).toFixed(2)}rem`);
    if (clean) inner.append(h("div", "dmg-clean", "Clean!"));
    inner.append(h("div", "dmg-n", String(Math.max(1, Math.round(amount || 0)))));
    el.append(inner);
    this.floatAt(el, at, clean ? 1350 : 1150);
  }

  /** Short floating word at a point: "Blocked!", "Dodged!", "Down!". */
  floatText(at: ScreenPoint, text: string): void {
    if (!visible(at)) return;
    const v = /^block/i.test(text) ? "ft-block" : /^dodg/i.test(text) ? "ft-dodge" : /^down|k\.?o/i.test(text) ? "ft-down" : "ft-gold";
    const el = h("div", `ftext ${v}`);
    const inner = h("div", "ftext-in", text);
    el.append(inner);
    this.floatAt(el, at, 1250);
  }

  /** The storybook narrator's line, shown as a caption while it is spoken. */
  caption(text: string): void {
    const t = (text ?? "").trim();
    if (!t) return;
    clearTimeout(this.captionTimer);
    this.captionText.textContent = t;
    this.captionEl.classList.remove("show", "out");
    void this.captionEl.offsetWidth;
    this.captionEl.classList.add("show");
    this.captionTimer = window.setTimeout(() => this.captionEl.classList.add("out"), Math.min(7500, 2400 + t.length * 60));
  }

  /** Big centered banner ("Round 2", "Fight!", "K.O."), auto-hides after ms. */
  banner(text: string, sub?: string, ms = 1800): void {
    clearTimeout(this.bannerTimer);
    const b = this.bannerEl;
    b.classList.remove("show", "out");
    this.bannerTitle.textContent = text;
    this.bannerTitle.className = `banner-title ${bannerSize(text)}`;
    this.bannerSub.textContent = sub ?? "";
    this.bannerSub.hidden = !sub;
    b.classList.toggle("ko", /k\.\s*o/i.test(text));
    b.classList.toggle("fight", /^fight/i.test(text));
    void b.offsetWidth; // restart the entrance animation
    b.classList.add("show");
    this.bannerTimer = window.setTimeout(() => b.classList.add("out"), Math.max(400, ms));
  }

  /** Small transient message (errors, hints). */
  toast(text: string): void {
    const t = (text ?? "").trim();
    if (!t) return;
    let el = [...this.toasts.children].find((c) => (c as HTMLElement).dataset.text === t) as HTMLElement | undefined;
    if (el) el.classList.remove("out");
    else {
      el = h("div", "toast parch", t);
      el.dataset.text = t;
      this.toasts.append(el);
      while (this.toasts.childElementCount > 4) {
        const old = this.toasts.firstElementChild as HTMLElement;
        clearTimeout(this.toastTimers.get(old));
        this.toastTimers.delete(old);
        old.remove();
      }
    }
    const node = el;
    clearTimeout(this.toastTimers.get(node));
    this.toastTimers.set(node, window.setTimeout(() => {
      node.classList.add("out");
      this.toastTimers.set(node, window.setTimeout(() => { node.remove(); this.toastTimers.delete(node); }, 450));
    }, Math.min(7000, 2800 + t.length * 40)));
  }

  // ---------- internals ----------
  private buildPlate(p: Player): Plate {
    const root = h("div", `plate p${p}`);
    const medal = h("div", "plate-medal medal-ring");
    const emblem = h("div", "plate-emblem");
    medal.append(emblem, h("div", "plate-tag", `P${p}`));
    const body = h("div", "plate-body parch");
    const row = h("div", "plate-row");
    const nick = h("div", "plate-nick", `Player ${p}`);
    const dot = h("span", "dot");
    const status = h("div", "plate-status");
    row.append(nick, dot, status);
    const who = h("div", "plate-who", "");
    const hpBar = h("div", "bar hp");
    const trail = h("div", "bar-trail");
    const hp = h("div", "bar-fill");
    hpBar.append(trail, hp, h("div", "bar-ticks"));
    const enBar = h("div", "bar en");
    const en = h("div", "bar-fill");
    enBar.append(en, h("div", "bar-ticks"));
    body.append(row, who, hpBar, enBar);
    root.append(body, medal);
    return { root, body, emblem, nick, dot, who, status, hp, trail, en, charId: "", hpShown: 100, enShown: 100, statusShown: "", low: false };
  }

  private track(el: HTMLElement, p: Player, kind: Tracked["kind"], dyRem: number, nameEl?: HTMLElement): Tracked {
    el.style.transform = "translate3d(-9999px, -9999px, 0)";
    this.over.append(el);
    const t: Tracked = { el, p, kind, w: 0, h: 0, ay: 0, dy: dyRem, x: -1e4, y: -1e4, timer: 0 };
    this.measure(t, nameEl);
    this.tracked.push(t);
    if (!this.anchor[p].init) this.defaultAnchor(p);
    this.place();
    return t;
  }

  private measure(t: Tracked, nameEl?: HTMLElement) {
    t.w = t.el.offsetWidth;
    t.h = t.el.offsetHeight;
    const name = nameEl ?? (t.el.querySelector(".flash-name") as HTMLElement | null);
    // Flashes hang from the middle of the name line; everything else from its own middle.
    t.ay = name ? name.offsetTop + name.offsetHeight / 2 : t.h / 2;
    t.x = t.y = -1e4;
  }

  private drop(t: Tracked | null, fast: boolean) {
    if (!t) return;
    clearTimeout(t.timer);
    this.tracked = this.tracked.filter((x) => x !== t);
    const slot = t.kind === "flash" ? this.flash : t.kind === "charge" ? this.charge : this.fizz;
    if (slot[t.p] === t) slot[t.p] = null;
    if (t.kind === "flash" && !fast) { t.el.remove(); return; } // its CSS life animation already faded it out
    t.el.classList.add(fast ? "gone-fast" : "gone");
    setTimeout(() => t.el.remove(), fast ? 160 : 420);
  }

  private defaultAnchor(p: Player) {
    const a = this.anchor[p];
    a.x = innerWidth * (p === 1 ? 0.37 : 0.63);
    a.y = innerHeight * 0.27;
    a.init = true;
  }

  private ease(s: Anchor, a: ScreenPoint, k: number) {
    if (!a) return;
    s.vis = visible(a);
    if (!s.vis) return;
    if (!s.init || Math.abs(a.x - s.x) > 260 || Math.abs(a.y - s.y) > 260) {
      s.x = a.x; s.y = a.y; s.init = true;
    } else {
      s.x += (a.x - s.x) * k;
      s.y += (a.y - s.y) * k;
    }
  }

  private place() {
    const W = innerWidth, H = innerHeight, rem = this.rem;
    const margin = 1.2 * rem, top = TOP_SAFE_REM * rem, bottom = H - BOTTOM_SAFE_REM * rem;
    // Two passes: fizzles go last so they can tuck under that fighter's flash or charging ring.
    for (let pass = 0; pass < 2; pass++) {
      for (const t of this.tracked) {
        if ((t.kind === "fizzle") !== (pass === 1)) continue;
        const a = this.anchor[t.p];
        let lo = margin, hi = W - margin;
        // Both fighters flashing at once: each keeps to its own half so the names never overlap.
        if (t.kind === "flash" && this.flash[t.p === 1 ? 2 : 1]) {
          if (t.p === 1) hi = Math.min(hi, W * 0.5 - 0.4 * rem);
          else lo = Math.max(lo, W * 0.5 + 0.4 * rem);
        }
        const x = clamp(a.x - t.w / 2, lo, Math.max(lo, hi - t.w));
        let y = a.y - t.ay + t.dy * rem;
        if (t.kind === "fizzle") {
          const c = this.charge[t.p], f = this.flash[t.p];
          if (c && c.y > -1e3) y = Math.max(y, c.y + c.h + 0.3 * rem);
          if (f && f.y > -1e3) y = Math.max(y, f.y + f.h + 0.3 * rem);
        }
        y = clamp(y, top, Math.max(top, bottom - t.h));
        if (Math.abs(x - t.x) > 0.3 || Math.abs(y - t.y) > 0.3) {
          t.x = x; t.y = y;
          t.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
        }
      }
    }
  }

  private floatAt(el: HTMLElement, at: ScreenPoint, ms: number) {
    const x = clamp(at.x, 3 * this.rem, innerWidth - 3 * this.rem);
    const y = clamp(at.y, TOP_SAFE_REM * this.rem, innerHeight - BOTTOM_SAFE_REM * this.rem);
    el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
    this.floats.append(el);
    while (this.floats.childElementCount > 24) this.floats.firstElementChild!.remove();
    setTimeout(() => el.remove(), ms);
  }
}
