// The library counter (a CLAUDE.md demo moment): agent moves + player moves, counting up when it changes.
// Used by the HUD (bottom ribbon) and the lobby (a block on the right page).
import type { LibraryStats } from "../contract";
import { BOOK } from "./art";
import { art, fmtInt, h, replay } from "./dom";

interface Counts { total: number; agent: number; players: number; }

/** Players' moves are Forge moves plus live wildcards (both carry a player's name). */
export function libraryCounts(s: LibraryStats): Counts & { split: boolean } {
  const src = s.by_source ?? {};
  const players = (src.forge ?? 0) + (src.live ?? 0);
  const split = src.agent != null || src.forge != null || src.live != null;
  const total = s.total || (src.agent ?? 0) + players;
  return { total, agent: src.agent ?? Math.max(0, total - players), players, split };
}

export class LibraryCounter {
  readonly el: HTMLElement;
  private readonly nTotal: HTMLElement;
  private readonly nAgent: HTMLElement;
  private readonly nPlayers: HTMLElement;
  private readonly unit: HTMLElement;
  private readonly splitEls: HTMLElement[];
  private cur: Counts = { total: 0, agent: 0, players: 0 };
  private from: Counts = { total: 0, agent: 0, players: 0 };
  private to: Counts = { total: -1, agent: -1, players: -1 };
  private shown = "";
  private t0 = 0;
  private dur = 1600;
  private raf = 0;
  private seen = false;

  constructor(variant: "ribbon" | "block") {
    this.el = h("div", `lib lib-${variant} empty`);
    this.nTotal = h("span", "lib-n lib-total", "0");
    this.nAgent = h("span", "lib-n", "0");
    this.nPlayers = h("span", "lib-n lib-players", "0");
    this.unit = h("span", "lib-unit", "spells");
    const head = h("span", "lib-head");
    head.append(art(BOOK, "lib-book"), h("span", "", "The Library"));
    const agent = h("span", "lib-part");
    agent.append(this.nAgent, " by the agent");
    const players = h("span", "lib-part lib-part-players");
    players.append(this.nPlayers, " by players");
    const wait = h("span", "lib-wait", "gathering spells…");
    if (variant === "ribbon") {
      const sep = () => h("span", "lib-sep", "✦");
      const total = h("span", "lib-part lib-part-total");
      total.append(this.nTotal, " ", this.unit);
      const s1 = sep(), s2 = sep(), s3 = sep();
      const body = h("div", "lib-body");
      body.append(head, s1, total, wait, s2, agent, s3, players);
      this.el.append(h("i", "rb-tail l"), h("i", "rb-tail r"), body);
      this.splitEls = [s2, agent, s3, players];
    } else {
      const big = h("div", "lib-big");
      big.append(this.nTotal, " ", this.unit);
      const split = h("div", "lib-split");
      split.append(agent, h("span", "lib-sep", "✦"), players);
      this.el.append(head, big, wait, split);
      this.splitEls = [split];
    }
  }

  set(stats: LibraryStats | null) {
    if (!stats) return;
    const c = libraryCounts(stats);
    this.el.classList.remove("empty");
    for (const e of this.splitEls) e.hidden = !c.split;
    if (c.total === this.to.total && c.agent === this.to.agent && c.players === this.to.players) return;
    const grew = this.seen && c.total > this.to.total;
    const playersGrew = this.seen && c.players > this.to.players;
    const delta = c.total - this.to.total;
    this.from = { ...this.cur };
    this.to = { total: c.total, agent: c.agent, players: c.players };
    this.dur = this.seen ? 1100 : 1700;
    this.t0 = performance.now();
    this.seen = true;
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
    if (grew) {
      replay(this.el, "glow");
      if (playersGrew) replay(this.nPlayers, "bump");
      const plus = h("span", "lib-plus", `+${fmtInt(delta)} ${delta === 1 ? "spell" : "spells"}`);
      this.el.append(plus);
      setTimeout(() => plus.remove(), 2200);
    }
  }

  private tick = (now: number) => {
    const k = Math.min(1, (now - this.t0) / this.dur);
    const e = 1 - Math.pow(1 - k, 3);
    this.cur.total = this.from.total + (this.to.total - this.from.total) * e;
    this.cur.agent = this.from.agent + (this.to.agent - this.from.agent) * e;
    this.cur.players = this.from.players + (this.to.players - this.from.players) * e;
    const t = Math.round(this.cur.total), a = Math.round(this.cur.agent), p = Math.round(this.cur.players);
    const key = `${t}|${a}|${p}`;
    if (key !== this.shown) {
      this.shown = key;
      this.nTotal.textContent = fmtInt(t);
      this.nAgent.textContent = fmtInt(a);
      this.nPlayers.textContent = fmtInt(p);
      this.unit.textContent = t === 1 ? "spell" : "spells";
    }
    this.raf = k < 1 ? requestAnimationFrame(this.tick) : 0;
  };
}
