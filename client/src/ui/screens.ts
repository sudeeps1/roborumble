// Full-screen storybook pages: loading, lobby (QR code + room code + character select), match end.
// The lobby leaves the middle of the screen open so the two automatons stand in the fairy ring between
// the pages; picking a character re-dresses the robot behind it live.
import { toCanvas } from "qrcode";
import type { LeaderboardEntry, LibraryStats, Player } from "../contract";
import { CHARACTERS, TYPE_NAME, type CharacterId } from "../config";
import { FLOURISH, LAUREL, PHONE, RUNE_RING, STAR, TYPE_GLYPH, emblemSvg } from "./art";
import { ROMAN, TYPE_INK, art, button, fmtInt, h, hexCss } from "./dom";
import type { Seat } from "./hud";
import { LibraryCounter } from "./library";

export interface LobbyInfo {
  code: string;                         // room code, e.g. "KQZD"
  joinUrl: string;                      // URL encoded in the QR code
  seats: Record<Player, Seat | null>;   // null = nobody joined yet
  leaderboard: LeaderboardEntry[];      // most used player-made moves (may be empty)
  stats: LibraryStats | null;           // library counter
  canStart: boolean;                    // both seats filled
  help: string[];                       // extra lines (keyboard help in mock mode)
}

type PageName = "loading" | "error" | "lobby" | "matchEnd";

interface SeatView { root: HTMLElement; emblem: HTMLElement; nick: HTMLElement; who: HTMLElement; dot: HTMLElement; charId: string; filled: boolean | null; }
interface CardView { root: HTMLElement; picks: Record<Player, HTMLButtonElement>; tags: Record<Player, HTMLElement>; }
interface LobbyView {
  root: HTMLElement; code: HTMLElement; url: HTMLElement; qr: HTMLCanvasElement; qrBox: HTMLElement; qrUrl: string;
  seats: Record<Player, SeatView>; cards: Map<CharacterId, CardView>;
  start: HTMLButtonElement; startLabel: HTMLElement; lib: LibraryCounter;
  board: HTMLElement; boardKey: string; help: HTMLElement; helpKey: string;
}
interface MatchEndView {
  root: HTMLElement; emblem: HTMLElement; medal: HTMLElement; title: HTMLElement; who: HTMLElement;
  n1: HTMLElement; n2: HTMLElement; w1: HTMLElement; w2: HTMLElement;
}

// Where the fighters stand on screen in the lobby, from stage.ts's camera: fov 38, distance ~3.67 m
// (2.9 + 0.75 x chest gap), heads ~0.59 m either side of center. Used to hang the seat plates over them.
const CAM_TAN = Math.tan((19 * Math.PI) / 180), CAM_DIST = 3.67, HEAD_X = 0.592;

export class Screens {
  private readonly root: HTMLElement;
  private readonly pages = new Map<PageName, HTMLElement>();
  private current: PageName | null = null;
  private pickCb: ((p: Player, id: CharacterId) => void) | null = null;
  private startCb: (() => void) | null = null;
  private rematchCb: (() => void) | null = null;
  private loadingText: HTMLElement | null = null;
  private errorText: HTMLElement | null = null;
  private lobby: LobbyView | null = null;
  private matchEnd: MatchEndView | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add("ui-screens");
    addEventListener("resize", () => this.placeSeats());
  }

  /** Loading page with a status line. */
  showLoading(text: string): void {
    this.page("loading", () => this.buildLoading());
    this.loadingText!.textContent = text;
    this.show("loading");
  }

  /** Error page (e.g. server unreachable) with a retry hint. */
  showError(text: string): void {
    this.page("error", () => this.buildError());
    this.errorText!.textContent = text;
    this.show("error");
  }

  /** Lobby page. Called again whenever anything in `info` changes; must update in place (no flicker, keep the QR). */
  showLobby(info: LobbyInfo): void {
    this.page("lobby", () => this.buildLobby());
    this.updateLobby(info);
    this.show("lobby");
  }

  /** Clicking a character portrait in the lobby picks it for that player. */
  onPick(cb: (p: Player, id: CharacterId) => void): void {
    this.pickCb = cb;
  }

  /** Clicking the start button (only enabled when info.canStart). */
  onStart(cb: () => void): void {
    this.startCb = cb;
  }

  /** Match-end page: "<name> wins the duel", with a rematch prompt (Enter or click). */
  showMatchEnd(winner: Player, seats: Record<Player, Seat>, wins: Record<Player, number>, onRematch: () => void): void {
    this.rematchCb = onRematch;
    this.page("matchEnd", () => this.buildMatchEnd());
    const v = this.matchEnd!;
    const w = seats[winner];
    v.title.textContent = `${w.nickname} wins the duel!`;
    v.title.className = `me-title ${w.nickname.length > 14 ? "long" : ""}`;
    v.who.textContent = `${w.character.name}, ${w.character.title}`;
    v.emblem.innerHTML = emblemSvg(w.character.id);
    v.root.style.setProperty("--glow", hexCss(w.character.glow));
    v.root.style.setProperty("--seat", `var(--p${winner})`);
    v.n1.textContent = seats[1].nickname;
    v.n2.textContent = seats[2].nickname;
    v.w1.textContent = String(wins[1] ?? 0);
    v.w2.textContent = String(wins[2] ?? 0);
    v.n1.parentElement!.classList.toggle("won", winner === 1);
    v.n2.parentElement!.classList.toggle("won", winner === 2);
    this.show("matchEnd");
  }

  /** Hide every full-screen page (the fight is on). */
  hide(): void {
    this.show(null);
  }

  // ---------- pages ----------
  private page(name: PageName, build: () => HTMLElement): HTMLElement {
    let pg = this.pages.get(name);
    if (!pg) {
      pg = build();
      pg.classList.add("page", `pg-${name}`);
      this.pages.set(name, pg);
      this.root.append(pg);
    }
    return pg;
  }

  private show(name: PageName | null) {
    if (name === this.current) return;
    this.current = name;
    for (const [n, pg] of this.pages) pg.classList.toggle("on", n === name);
    if (name === "lobby") this.placeSeats();
  }

  private buildLoading(): HTMLElement {
    const pg = h("div");
    pg.append(h("div", "night"), dust(22));
    const c = h("div", "ld-center");
    const ring = h("div", "ld-ring");
    ring.append(art(RUNE_RING, "ring-a"), art(RUNE_RING, "ring-b"), h("div", "ld-core"));
    this.loadingText = h("p", "ld-status");
    c.append(ring, h("h1", "title-gold ld-title", "Infinite Fighter"), art(FLOURISH, "orn"), this.loadingText);
    pg.append(c);
    return pg;
  }

  private buildError(): HTMLElement {
    const pg = h("div");
    pg.append(h("div", "night"));
    const panel = h("div", "err-panel parch orn-corners");
    const seal = h("div", "err-seal", "!");
    this.errorText = h("p", "err-text");
    const retry = button("btn btn-gold", () => location.reload());
    retry.textContent = "Try again";
    panel.append(seal, h("h1", "err-title", "Alas, the spell is broken"), art(FLOURISH, "orn"), this.errorText,
      h("p", "err-hint", "Check that the server is running and this laptop is on the same network, then try again."), retry);
    pg.append(panel);
    return pg;
  }

  private buildLobby(): HTMLElement {
    const pg = h("div");
    pg.append(h("div", "lobby-vignette"));

    // Title over the fairy ring.
    const title = h("header", "lb-title");
    title.append(h("h1", "title-gold lb-h1", "Infinite Fighter"), art(FLOURISH, "orn"),
      h("p", "lb-pitch", "Every move you invent teaches a real robot how to move."));

    // Left page: join.
    const left = h("section", "lb-left parch orn-corners");
    const qrBox = h("div", "qr-box");
    const qr = h("canvas", "qr");
    qrBox.append(qr);
    const code = h("div", "code", "····");
    const url = h("div", "join-url");
    const help = h("div", "help-box");
    const joinHead = h("div", "lb-head");
    joinHead.append(h("h2", "", "Join the duel"));
    const scan = h("div", "lb-sub");
    scan.append(art(PHONE, "ico"), h("span", "", "Scan with your phone"));
    const codeWrap = h("div", "code-wrap");
    codeWrap.append(h("div", "code-label", "Room code"), code);
    left.append(joinHead, scan, qrBox, codeWrap, url, help);

    // Right page: library, legends, begin.
    const right = h("section", "lb-right parch orn-corners");
    const lib = new LibraryCounter("block");
    const board = h("div", "board");
    const start = button("btn btn-gold btn-start", () => this.startCb?.());
    const startLabel = h("span", "", "Waiting for duelists…");
    start.append(startLabel, h("span", "kbd", "Enter"));
    const keys = h("div", "keys");
    keys.append(
      h("span", "kseat k1", "P1"), h("span", "kbd", "A"), " / ", h("span", "kbd", "D"), h("span", "kgap", ""),
      h("span", "kseat k2", "P2"), h("span", "kbd", "J"), " / ", h("span", "kbd", "L"), h("span", "kgap", ""),
      h("span", "kbd", "Enter"), " to begin");
    right.append(lib.el, board, start, keys);

    // Seat plates hang over each fighter.
    const seats = { 1: this.buildSeat(1), 2: this.buildSeat(2) };

    // Character picker across the bottom.
    const choose = h("div", "lb-choose");
    choose.append(h("span", "", "Choose your automaton"));
    const strip = h("div", "cards");
    const cards = new Map<CharacterId, CardView>();
    for (const c of CHARACTERS) {
      const card = h("div", `card parch ty-${c.strongType}`);
      card.style.setProperty("--glow", hexCss(c.glow));
      card.style.setProperty("--ti", TYPE_INK[c.strongType]);
      const emb = h("div", "card-emb medal-ring");
      emb.append(art(emblemSvg(c.id)));
      const ty = h("div", "card-type");
      ty.append(art(TYPE_GLYPH[c.strongType], "ty-ico"), h("span", "", `Strong in ${TYPE_NAME[c.strongType]}`));
      const picks = h("div", "card-picks");
      const pick = (p: Player) => {
        const b = button(`pick s${p}`, () => this.pickCb?.(p, c.id));
        b.textContent = `P${p}`;
        b.title = `Pick ${c.name} for player ${p}`;
        return b;
      };
      const b1 = pick(1), b2 = pick(2);
      picks.append(b1, b2);
      const t1 = h("div", "card-tag t1"), t2 = h("div", "card-tag t2");
      card.append(t1, t2, emb, h("div", "card-name", c.name), h("div", "card-title", c.title), h("div", "card-costume", c.costume), ty, picks);
      strip.append(card);
      cards.set(c.id, { root: card, picks: { 1: b1, 2: b2 }, tags: { 1: t1, 2: t2 } });
    }

    pg.append(title, left, right, seats[1].root, seats[2].root, choose, strip);
    this.lobby = { root: pg, code, url, qr, qrBox, qrUrl: "", seats, cards, start, startLabel, lib, board, boardKey: "?", help, helpKey: "?" };
    return pg;
  }

  private buildSeat(p: Player): SeatView {
    const root = h("div", `seat s${p}`);
    const plate = h("div", "seat-plate parch");
    const emblem = h("div", "seat-emb medal-ring");
    const text = h("div", "seat-text");
    const label = h("div", "seat-label");
    const dot = h("span", "dot");
    label.append(h("span", "", `Player ${p}`), dot);
    const nick = h("div", "seat-nick");
    const who = h("div", "seat-who");
    text.append(label, nick, who);
    const empty = h("div", "seat-empty");
    const et = h("div", "seat-empty-text");
    et.append(h("span", "seat-label", `Player ${p}`), h("span", "", "Scan to join"));
    empty.append(art(PHONE, "ico"), et);
    plate.append(emblem, text, empty);
    root.append(plate, h("div", "seat-pointer"));
    // People click "Scan to join": show a big QR code for that seat (and a link to join from this computer).
    plate.addEventListener("click", () => { if (!root.classList.contains("filled")) this.showJoin(p); });
    return { root, emblem, nick, who, dot, charId: "", filled: null };
  }

  private showJoin(p: Player) {
    const url = this.lobby?.qrUrl;
    if (!url) return;
    const modal = h("div", "join-modal");
    const box = h("div", "join-box parch");
    const qr = document.createElement("canvas");
    const here = h("div", "join-here", "or open it on this computer");
    box.append(h("div", "join-title", `Player ${p}: scan with your phone camera`), qr,
      h("div", "join-url", url.replace(/^https?:\/\//, "")), here, h("div", "join-close", "click anywhere to close"));
    modal.append(box);
    const close = () => { modal.remove(); removeEventListener("keydown", onKey); };
    const onKey = (e: KeyboardEvent) => { if (e.code === "Escape") close(); };
    modal.addEventListener("click", close);
    here.addEventListener("click", (e) => { e.stopPropagation(); window.open(url, "_blank"); close(); });
    addEventListener("keydown", onKey);
    this.root.append(modal);
    void toCanvas(qr, url, { margin: 1, scale: 12, errorCorrectionLevel: "M", color: { dark: "#2b1d0eff", light: "#f8efd8ff" } })
      .then(() => { qr.style.width = ""; qr.style.height = ""; });
  }

  private updateLobby(info: LobbyInfo) {
    const v = this.lobby!;
    v.code.textContent = info.code || "····";
    if (info.joinUrl !== v.qrUrl) {
      v.qrUrl = info.joinUrl;
      v.url.textContent = info.joinUrl.replace(/^https?:\/\//, "");
      v.qrBox.classList.remove("failed");
      toCanvas(v.qr, info.joinUrl, { margin: 1, scale: 8, errorCorrectionLevel: "M", color: { dark: "#2b1d0eff", light: "#f8efd8ff" } })
        .then(() => { v.qr.style.width = ""; v.qr.style.height = ""; }) // qrcode sets pixel sizes inline; CSS sizes it
        .catch((e: unknown) => { console.warn("QR code failed", e); v.qrBox.classList.add("failed"); });
    }

    for (const p of [1, 2] as const) {
      const s = info.seats[p], sv = v.seats[p];
      const filled = !!s;
      if (filled !== sv.filled) {
        sv.filled = filled;
        sv.root.classList.toggle("filled", filled);
        if (filled) sv.root.animate?.([{ transform: "translateX(-50%) scale(.85)", opacity: 0.4 }, { transform: "translateX(-50%) scale(1.06)" }, { transform: "translateX(-50%) scale(1)", opacity: 1 }], { duration: 480, easing: "ease-out" });
      }
      if (s) {
        sv.nick.textContent = s.nickname;
        const n = s.nickname.length;
        sv.nick.className = `seat-nick ${n > 15 ? "xxs" : n > 11 ? "xs" : n > 8 ? "sm" : ""}`;
        sv.who.textContent = `${s.character.name}, ${s.character.title}`;
        sv.dot.classList.toggle("on", s.connected);
        sv.root.classList.toggle("away", !s.connected);
        if (sv.charId !== s.character.id) {
          sv.charId = s.character.id;
          sv.emblem.innerHTML = emblemSvg(s.character.id);
          sv.root.style.setProperty("--glow", hexCss(s.character.glow));
        }
      }
    }

    for (const [id, cv] of v.cards) {
      for (const p of [1, 2] as const) {
        const s = info.seats[p];
        const on = !!s && s.character.id === id;
        cv.root.classList.toggle(`sel${p}`, on);
        cv.picks[p].classList.toggle("on", on);
        cv.picks[p].disabled = !s;
        cv.picks[p].title = s ? `Pick for ${s.nickname}` : `Player ${p} hasn't joined yet`;
        if (on) cv.tags[p].textContent = s!.nickname;
      }
    }

    v.start.disabled = !info.canStart;
    v.startLabel.textContent = info.canStart ? "Begin the duel" : info.seats[1] || info.seats[2] ? "Waiting for a rival…" : "Waiting for duelists…";
    v.lib.set(info.stats);
    this.renderBoard(info.leaderboard ?? []);
    this.renderHelp(info.help ?? []);
  }

  private renderBoard(list: LeaderboardEntry[]) {
    const v = this.lobby!;
    const top = list.filter((e) => e && e.name).slice(0, 5);
    const key = JSON.stringify(top.map((e) => [e.name, e.creator, e.uses, e.type]));
    if (key === v.boardKey) return;
    v.boardKey = key;
    v.board.replaceChildren();
    const head = h("div", "board-head");
    head.append(art(STAR, "ico"), h("span", "", "Legends of the library"));
    v.board.append(head);
    if (!top.length) {
      v.board.classList.add("empty");
      v.board.append(h("p", "board-cta", "No player spells cast yet. Forge one on your phone: act it out, name it, and it joins the library with your name on it."));
      return;
    }
    v.board.classList.remove("empty");
    const ol = h("ol", "board-list");
    top.forEach((e, i) => {
      const li = h("li");
      if (e.type && TYPE_INK[e.type]) li.style.setProperty("--ti", TYPE_INK[e.type]);
      const main = h("div", "bl-main");
      main.append(h("span", "bl-name", e.name), h("span", "bl-by", `by ${e.creator || "a stranger"}`));
      const uses = Math.max(0, Math.round(Number(e.uses) || 0));
      li.append(h("span", "bl-rank", ROMAN[i]), main, h("span", "bl-uses", `${fmtInt(uses)} ${uses === 1 ? "cast" : "casts"}`));
      ol.append(li);
    });
    v.board.append(ol);
  }

  private renderHelp(lines: string[]) {
    const v = this.lobby!;
    const key = lines.join("\n");
    if (key === v.helpKey) return;
    v.helpKey = key;
    v.help.replaceChildren(...lines.map((l) => h("div", "", l)));
    v.help.hidden = !lines.length;
  }

  private placeSeats() {
    const v = this.lobby;
    if (!v) return;
    const k = HEAD_X / (CAM_DIST * CAM_TAN * (innerWidth / Math.max(1, innerHeight)));
    v.root.style.setProperty("--x1", `${(50 - 50 * k).toFixed(2)}%`);
    v.root.style.setProperty("--x2", `${(50 + 50 * k).toFixed(2)}%`);
  }

  private buildMatchEnd(): HTMLElement {
    const pg = h("div");
    pg.append(h("div", "me-vignette"), dust(16));
    const panel = h("div", "me-panel parch orn-corners");
    const medal = h("div", "me-medal");
    const emblem = h("div", "me-emb medal-ring");
    medal.append(art(LAUREL, "me-laurel"), emblem);
    const title = h("h1", "me-title");
    const who = h("div", "me-who");
    const side = (p: Player) => {
      const s = h("div", `me-side s${p}`);
      const n = h("span", "me-name"), w = h("span", "me-wins");
      s.append(n, w);
      return { s, n, w };
    };
    const a = side(1), b = side(2);
    const tally = h("div", "me-tally");
    tally.append(a.s, h("span", "me-dash", "–"), b.s);
    const actions = h("div", "me-actions");
    const rematch = button("btn btn-gold", () => this.rematchCb?.());
    rematch.append(h("span", "", "Rematch"), h("span", "kbd", "Enter"));
    // No lobby callback in the interface: main.ts already maps Esc to "back to the lobby".
    const lobby = button("btn btn-plain", () => dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape" })));
    lobby.append(h("span", "", "Lobby"), h("span", "kbd", "Esc"));
    actions.append(rematch, lobby);
    panel.append(h("div", "me-kicker", "Thus ends the duel"), medal, title, who, art(FLOURISH, "orn"), tally, actions);
    pg.append(panel);
    this.matchEnd = { root: pg, emblem, medal, title, who, n1: a.n, n2: b.n, w1: a.w, w2: b.w };
    return pg;
  }
}

/** Drifting fairy-dust specks (pure CSS animation, positions fixed at build time). */
function dust(n: number): HTMLElement {
  const box = h("div", "dust");
  for (let i = 0; i < n; i++) {
    const s = h("i");
    s.style.left = `${(Math.random() * 100).toFixed(1)}%`;
    s.style.top = `${(30 + Math.random() * 70).toFixed(1)}%`;
    s.style.animationDelay = `${(-Math.random() * 9).toFixed(2)}s`;
    s.style.animationDuration = `${(6 + Math.random() * 6).toFixed(2)}s`;
    s.style.setProperty("--s", (0.5 + Math.random()).toFixed(2));
    box.append(s);
  }
  return box;
}
