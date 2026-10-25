import type { Effect, MoveType, Player } from "./contract";

const params = new URLSearchParams(location.search);

// MOCK fakes the server and both phones in the browser. On with `npm run mock` or ?mock in the URL.
export const MOCK = import.meta.env.VITE_MOCK === "1" || params.has("mock");

// The server is reached through Vite's /api proxy (vite.config.ts), so no CORS and the same origin for the WebSocket.
export const API = "/api";
export const POLL_MS = 250;
export const STATS_POLL_MS = 5000;
export const STATE_PUSH_MS = 100; // game -> phones `state` rate

// Where phones go to join. {code} is replaced with the room code. Must be reachable from a phone, so not localhost.
// A built client is served by the game server (or Caddy) next to /phone/, so it defaults to its own origin;
// the dev server guesses the game server on :8000 of this host.
export const JOIN_URL = params.get("join") ?? import.meta.env.VITE_JOIN_URL
  ?? (import.meta.env.PROD ? `${location.origin}/phone/?room={code}` : `${location.protocol}//${location.hostname}:8000/phone/?room={code}`);
// Fixed room code from ?room=ABCD, otherwise a random one. main.ts writes it back into the URL, so a reload
// (or a crashed tab coming back) rejoins the same room and the phones keep their seats.
export const ROOM_CODE = (params.get("room") ?? randomCode()).toUpperCase();

export const ROUND_SECONDS = 60;
export const ROUNDS_TO_WIN = 2; // best of 3
export const FIGHTER_GAP = 1.2; // meters between fighters at the start (CLAUDE.md)

function randomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O, they read as 1 and 0
  let s = "";
  for (let i = 0; i < 4; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}

// ---------- characters (CLAUDE.md "Characters") ----------
export type CharacterId = "bramble" | "marigold" | "flicker" | "rime" | "hush";

export interface CharacterDef {
  id: CharacterId;
  name: string;     // "Sir Bramble"
  title: string;    // "the Thorn Knight"
  costume: string;  // short description, for the select screen
  strongType: MoveType;
  color: number;    // body tint
  glow: number;     // runes, charging glow, UI accent
}

export const CHARACTERS: CharacterDef[] = [
  { id: "bramble", name: "Sir Bramble", title: "the Thorn Knight", costume: "mossy iron armor wrapped in briar roses", strongType: "physical", color: 0x6f7a5a, glow: 0xff5f7e },
  { id: "marigold", name: "Marigold", title: "the Hearth Witch", costume: "pointed lantern hat, ember-stitched cloak", strongType: "fire", color: 0x7a4a3a, glow: 0xffa040 },
  { id: "flicker", name: "Flicker", title: "the Storm Sprite", costume: "crackling dragonfly wings", strongType: "lightning", color: 0x8a8a6a, glow: 0xffe46b },
  { id: "rime", name: "Rime", title: "the Winter Stag", costume: "antlered frost-crystal helm, pale blue glow", strongType: "ice", color: 0x9fb4c8, glow: 0x9fe8ff },
  { id: "hush", name: "Hush", title: "the Moon Wolf", costume: "wolf hood, starry night cloak, violet glow", strongType: "shadow", color: 0x2a2838, glow: 0xb47cff },
];
export const characterById = (id: string): CharacterDef => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
// Neither default deals 0.5x physical: most Forge moves and keyword wildcards come out physical, and with
// Thorn Knight vs Moon Wolf a judge on P2 did a quarter of P1's damage with them (9 vs 36 for a roundhouse kick).
export const DEFAULT_CHARACTERS: Record<Player, CharacterId> = { 1: "flicker", 2: "rime" };

// ---------- move types: in-game names (CLAUDE.md "Look and feel"); code keeps the ids ----------
export const TYPE_NAME: Record<MoveType, string> = { physical: "Might", fire: "Flame", ice: "Frost", lightning: "Storm", shadow: "Shadow" };
export const TYPE_COLOR: Record<MoveType, number> = { physical: 0xff7aa2, fire: 0xff8a2a, ice: 0x8fe3ff, lightning: 0xfff07a, shadow: 0xa98bff };
export const TYPE_CSS: Record<MoveType, string> = { physical: "#ff7aa2", fire: "#ff8a2a", ice: "#8fe3ff", lightning: "#fff07a", shadow: "#a98bff" };
// Effect used when a move's `effect` is missing or unknown.
export const TYPE_EFFECT: Record<MoveType, Effect> = { physical: "thorn_burst", fire: "ember_orb", ice: "frost_crystals", lightning: "wisp_bolt", shadow: "moon_smoke" };
export const KNOWN_EFFECTS: Effect[] = ["ember_orb", "wisp_bolt", "frost_crystals", "moon_smoke", "thorn_burst", "fairy_dust", "shockwave", "earth_wall", "spiral_orb", "none"];
