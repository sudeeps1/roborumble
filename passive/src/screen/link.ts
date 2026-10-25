// The screen's side of the three devices: the game server's room (contract/ws.md and api.md on
// vaibhav/server). Phones talk only to the server; the server relays joins and taps, pushes the moves
// players shout (play), live wildcards being made (charge, then ready) and narrator lines to the screen,
// and relays the screen's state (about 10/s) and events back to the phones and the narrator.
//
//   phone --join/tap (WS), shout (POST /voice)--> server --join/tap/play/charge/ready/narrate--> screen
//   phone <------------- state/event ------------- server <------------- state/event ----------- screen
//
// This file only talks: the connection, reconnects, and turning the server's moves and motions into what
// the sim plays. main.ts decides what happens.
import { JOINTS } from "../core/g1.ts";
import { type MoveSpec, specFromLibrary } from "../core/spells.ts";

/** A move as the server sends it (contract/api.md, Move). */
export interface ServerMove {
  id: string; name: string; type?: string; kind?: string; effect?: string; power?: number; hit_joint?: string; hit_frame?: number;
  stability?: number; source?: "agent" | "forge" | "live"; creator?: string | null; signature?: boolean; uses?: number;
}
/** A motion as the server sends it: Kimodo's G1 qpos, root xyz + quat (w first) + 29 hinges in joint_names order. */
export interface ServerMotion { id?: string; fps?: number; joint_names?: string[]; qpos: number[][] }

/** Server -> screen (contract/ws.md). */
export type ServerMsg =
  | { type: "join"; player: 1 | 2; nickname: string; character?: string }
  | { type: "leave"; player: 1 | 2 }
  | { type: "tap"; player: 1 | 2; action: "jump" | "dodge_left" | "dodge_right" | "block" }
  | { type: "play"; player: 1 | 2; move: ServerMove; loudness?: number; transcript?: string; motion: ServerMotion | null }
  | { type: "charge"; player: 1 | 2; job: string; guess?: { name?: string; type?: string }; transcript?: string }
  | { type: "ready"; player: 1 | 2; job: string; move: ServerMove; loudness?: number; motion: ServerMotion | null }
  | { type: "narrate"; text: string };

/** Events the screen sends (contract/ws.md GameEvent), players 1 and 2. */
export type GameEvent =
  | { kind: "hit"; attacker: 1 | 2; defender: 1 | 2; damage: number; type: string; clean: boolean; point: number[]; move: string }
  | { kind: "blocked"; defender: 1 | 2; point: number[] }
  | { kind: "dodged"; defender: 1 | 2 }
  | { kind: "down"; player: 1 | 2 }
  | { kind: "ko"; loser: 1 | 2 }
  | { kind: "round"; winner: 1 | 2 | null }
  | { kind: "round_start"; round: number }
  | { kind: "match_end"; winner: 1 | 2 }
  | { kind: "cast"; player: 1 | 2; move: string; new: boolean }   // a shouted move started playing
  | { kind: "fizzle"; player: 1 | 2; move: string; why: string }; // a move that couldn't be played

export type LinkStatus = "connecting" | "open" | "closed";

/** The game server's address: ?server=, else VITE_GAME_SERVER, else the team's GPU server. */
export function serverUrl(params: URLSearchParams): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return (params.get("server") || env?.VITE_GAME_SERVER || "https://kr2vjwse2bhd6t-8000.proxy.runpod.net").replace(/\/+$/, "");
}

/** A room code: ?room=ABCD, or a fresh one (four letters that can't be misread). */
export function roomCode(params: URLSearchParams): string {
  const asked = (params.get("room") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (asked) return asked;
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ";
  return Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
}

/** The room WebSocket as the game screen. Reconnects by itself; send() drops messages while it's down. */
export class RoomLink {
  readonly server: string;
  readonly code: string;
  status: LinkStatus = "connecting";
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;
  private onMessage: (m: ServerMsg) => void;
  private onStatus: (s: LinkStatus) => void;

  constructor(server: string, code: string, onMessage: (m: ServerMsg) => void, onStatus: (s: LinkStatus) => void = () => {}) {
    this.server = server;
    this.code = code;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.connect();
  }

  /** Where phones join (the server serves the phone page). */
  get joinUrl() { return `${this.server}/phone/?room=${this.code}`; }

  private connect() {
    if (this.closed) return;
    const url = `${this.server.replace(/^http/, "ws")}/room/${encodeURIComponent(this.code)}?role=game`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.set("connecting");
    ws.onopen = () => { this.retry = 0; this.set("open"); };
    ws.onmessage = (ev) => {
      let m: unknown;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m && typeof m === "object" && typeof (m as { type?: unknown }).type === "string") {
        try { this.onMessage(m as ServerMsg); } catch (e) { console.error("room message", m, e); }
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.set("closed");
      const wait = Math.min(5000, 400 * 2 ** this.retry++);
      setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => ws.close();
  }

  private set(s: LinkStatus) { if (s !== this.status) { this.status = s; this.onStatus(s); } }

  send(m: object): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  close() { this.closed = true; this.ws?.close(); }

  /** Drops the connection as a network blip would (it reconnects by itself). For tests. */
  drop() { this.ws?.close(); }
}

/** The sim's spec for a server move (it already uses the library's field names). */
export function specFromMove(m: ServerMove): MoveSpec {
  return specFromLibrary({ ...m, name: m.name || "spell" });
}

/**
 * The motion's rows in the sim's joint order (MuJoCo / Menagerie: core/g1.ts JOINTS). Kimodo-G1 writes
 * that order already; if the server ever names its columns differently they're mapped by name. Null when
 * the motion is unusable (no rows, wrong width, unknown joints, not finite).
 */
export function rowsFromMotion(m: ServerMotion | null | undefined): { qpos: number[][]; fps: number } | null {
  const rows = m?.qpos;
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const names = m!.joint_names;
  let order: number[] | null = null;
  if (Array.isArray(names) && names.length === JOINTS.length && names.some((n, i) => n !== JOINTS[i])) {
    order = JOINTS.map((j) => names.indexOf(j));
    if (order.some((k) => k < 0)) return null;
  }
  const out: number[][] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 7 + JOINTS.length) return null;
    const row = order ? [...r.slice(0, 7), ...order.map((k) => r[7 + k])] : r.slice(0, 7 + JOINTS.length);
    if (!row.every(Number.isFinite)) return null;
    out.push(row);
  }
  const fps = Number(m!.fps);
  return { qpos: out, fps: Number.isFinite(fps) && fps > 0 ? fps : 30 };
}
