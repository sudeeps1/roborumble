// A pretend phone, for testing the three devices without people. It joins a room seat on the game server
// the way the phone page does (WebSocket, role=phone), shouts moves through POST /match (the typed path:
// the server handles it exactly like a voice shout, minus speech to text), taps defenses, and records
// everything the screen sends back (state, events).
//   node scripts/phone-bot.ts --room ABCD [--server URL] [--nickname test-bot] [--every 2.5] [--wild "summon a crab"]
// scripts/full-game.ts runs two of these against the real screen.

export const DEFAULT_SERVER = "https://kr2vjwse2bhd6t-8000.proxy.runpod.net";
const TAPS = ["block", "dodge_left", "dodge_right", "jump"] as const;

export interface Shout { text: string; wild: boolean; at: number; result?: string; move?: string; score?: number; job?: string; error?: string }
export interface BotOptions {
  server: string;
  room: string;
  nickname: string;
  /** Library move names to shout. */
  names: string[];
  /** Seconds between shouts (jittered ±40%). */
  every?: number;
  /** Phrases that aren't in the library (live wildcards), each shouted once. */
  wild?: string[];
  /** Defense taps per second while fighting. */
  taps?: number;
  seed?: number;
  log?: (s: string) => void;
}

/** A tiny seeded random. */
function rng(seed: number) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

export class PhoneBot {
  readonly o: Required<Omit<BotOptions, "log">> & { log: (s: string) => void };
  player: 1 | 2 | null = null;
  /** The last state the screen sent. */
  state: Record<string, any> | null = null;
  states = 0;
  /** Longest wait between two states while joined (ms), and when it ended. */
  maxStateGap = 0;
  maxStateGapAt = 0;
  /** States in which this player's fighter was blocking or dodging (a tap that took). */
  defending = 0;
  events: { at: number; event: Record<string, any> }[] = [];
  shouts: Shout[] = [];
  taps = 0;
  private ws: WebSocket | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private rand: () => number;
  private nextShout = 0;
  private lastState = 0;
  private wildLeft: string[];
  private stopped = false;

  constructor(o: BotOptions) {
    this.o = { every: 2.5, wild: [], taps: 0.15, seed: 1, log: () => {}, ...o };
    this.rand = rng(this.o.seed);
    this.wildLeft = [...this.o.wild];
  }

  /** Times this phone dropped and came back, and the seat it got back. */
  rejoins: (1 | 2)[] = [];

  /** Joins a seat; resolves with the player number. */
  start(): Promise<1 | 2> {
    return this.connect().then((p) => { this.loop = setInterval(() => this.tick(), 100); return p; });
  }

  /** Drops the connection like a phone losing Wi-Fi, and comes back after `ms` with the same phone id. */
  async blip(ms: number) {
    this.o.log(`${this.o.nickname}: drops off for ${ms} ms`);
    const old = this.ws;
    this.ws = null;
    old?.close();
    await new Promise((r) => setTimeout(r, ms));
    this.lastState = 0; // the gap while away isn't the screen's
    const p = await this.connect();
    this.rejoins.push(p);
    this.o.log(`${this.o.nickname}: back in seat ${p}`);
  }

  private connect(): Promise<1 | 2> {
    return new Promise((resolve, reject) => {
      const url = `${this.o.server.replace(/^http/, "ws")}/room/${encodeURIComponent(this.o.room)}?role=phone`;
      const ws = new WebSocket(url);
      this.ws = ws;
      const timeout = setTimeout(() => reject(new Error(`${this.o.nickname}: no seat after 15 s`)), 15000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", nickname: this.o.nickname, phone_id: `${this.o.nickname}-${this.o.seed}` }));
      ws.onmessage = (ev) => {
        let m: Record<string, any>;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.type === "joined") { this.player = m.player; clearTimeout(timeout); this.o.log(`${this.o.nickname}: seat ${m.player}`); resolve(m.player); }
        else if (m.type === "full") { clearTimeout(timeout); reject(new Error(`${this.o.nickname}: room full`)); }
        else if (m.type === "state") this.onState(m);
        else if (m.type === "event" && m.event) { this.events.push({ at: Date.now(), event: m.event }); this.onEvent(m.event); }
      };
      ws.onclose = () => { if (!this.stopped && this.ws === ws) this.o.log(`${this.o.nickname}: socket closed`); };
    });
  }

  private onState(s: Record<string, any>) {
    const now = Date.now();
    if (this.lastState && now - this.lastState > this.maxStateGap) { this.maxStateGap = now - this.lastState; this.maxStateGapAt = now; }
    const me = s.players?.[this.player ?? 0];
    if (me?.status === "blocking" || me?.status === "dodging") this.defending++;
    this.lastState = now;
    this.state = s;
    this.states++;
  }

  private onEvent(e: Record<string, any>) {
    // a player who sees the other side cast reaches for a defense now and then
    if (e.kind === "cast" && e.player !== this.player && this.rand() < this.o.taps * 2) {
      setTimeout(() => this.tap(TAPS[Math.floor(this.rand() * TAPS.length)]), 150 + 300 * this.rand());
    }
    if (e.kind === "round_start") this.o.log(`${this.o.nickname}: round ${e.round}`);
    if (e.kind === "match_end") this.o.log(`${this.o.nickname}: match over, ${e.winner === this.player ? "won" : "lost"}`);
  }

  private tick() {
    if (!this.player || this.state?.phase !== "fight") return;
    if (this.state.players?.[this.player]?.status === "charging") return; // a player waits for the spell they're making
    const now = Date.now();
    if (now >= this.nextShout) {
      this.nextShout = now + this.o.every * 1000 * (0.6 + 0.8 * this.rand());
      // a wildcard now and then (each once), otherwise a library move
      const wild = this.wildLeft.length > 0 && this.rand() < 0.2;
      const text = wild ? this.wildLeft.shift()! : this.o.names[Math.floor(this.rand() * this.o.names.length)];
      void this.shout(text, wild);
    }
    if (this.rand() < this.o.taps / 10) this.tap(TAPS[Math.floor(this.rand() * TAPS.length)]);
  }

  /** Shouts like the phone's typed backup: POST /match with the room and seat. */
  async shout(text: string, wild = false): Promise<Shout> {
    const s: Shout = { text, wild, at: Date.now() };
    this.shouts.push(s);
    try {
      const r = await fetch(`${this.o.server}/match`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, room: this.o.room, player: this.player, loudness: 0.5 + 0.5 * this.rand() }),
      });
      const b = await r.json() as Record<string, any>;
      if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b).slice(0, 120)}`);
      s.result = b.result; s.move = b.move?.name ?? b.guess?.name; s.score = b.score; s.job = b.job;
    } catch (e) { s.error = e instanceof Error ? e.message : String(e); }
    this.o.log(`${this.o.nickname}: "${text}" -> ${s.error ? `error ${s.error}` : `${s.result} ${s.move ?? ""}`}`);
    return s;
  }

  tap(action: (typeof TAPS)[number]) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "tap", action }));
    this.taps++;
  }

  stop() { this.stopped = true; if (this.loop) clearInterval(this.loop); this.ws?.close(); }
}

/** Library move names worth shouting: attacks, short names. */
export async function libraryNames(server: string): Promise<string[]> {
  const moves = await (await fetch(`${server}/library/moves`)).json() as { name: string; kind?: string; source?: string }[];
  return moves.filter((m) => m.kind !== "defend" && m.name && m.name.length <= 32 && m.source !== "live").map((m) => m.name);
}

// ---------------------------------------------------------------- CLI: one bot, until Ctrl-C
if (import.meta.main) {
  const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const server = arg("server", DEFAULT_SERVER)!.replace(/\/+$/, "");
  const room = arg("room");
  if (!room) { console.error("usage: node scripts/phone-bot.ts --room ABCD [--server URL] [--nickname N] [--every 2.5] [--wild phrase]"); process.exit(2); }
  const bot = new PhoneBot({ server, room: room.toUpperCase(), nickname: arg("nickname", "test-bot")!, names: await libraryNames(server),
    every: Number(arg("every", "2.5")), wild: arg("wild") ? [arg("wild")!] : [], seed: Date.now() % 1e6, log: (s) => console.log(s) });
  await bot.start();
  process.on("SIGINT", () => { bot.stop(); process.exit(0); });
}
