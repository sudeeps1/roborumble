// The room WebSocket (CLAUDE.md: all traffic goes through the server; the game screen opens a room).
import { API } from "../config";
import type { RoomIn, RoomOut } from "../contract";

/** "replaced": another game screen opened this room, so this one stopped (no reconnect ping-pong). */
export type RoomStatus = "connecting" | "open" | "closed" | "replaced";

export interface Room {
  readonly code: string;
  onMessage(cb: (m: RoomIn) => void): void;
  onStatus(cb: (s: RoomStatus) => void): void;
  send(m: RoomOut): void;
  close(): void;
}

/** ws(s)://<this host>/api/room/{code}?role=game, proxied by Vite to the server. Reconnects on drop. */
export function wsRoom(code: string): Room {
  const msgCbs: ((m: RoomIn) => void)[] = [];
  const statusCbs: ((s: RoomStatus) => void)[] = [];
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const setStatus = (s: RoomStatus) => statusCbs.forEach((cb) => cb(s));
  const reconnect = (ms = Math.min(5000, 300 * 2 ** Math.min(++retry, 4))) => {
    clearTimeout(timer);
    timer = setTimeout(connect, ms);
  };

  // The server closes a game socket cleanly (1000) when a second game screen opens the same room. Reconnecting
  // would take the room back, and the two screens would knock each other off forever. Ask the server first.
  const takenByAnother = async (): Promise<boolean> => {
    try {
      const res = await fetch(`${API}/room/${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(4000) });
      return res.ok && (await res.json())?.game_connected === true;
    } catch {
      return false;
    }
  };

  function connect() {
    if (closed) return;
    setStatus("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${proto}//${location.host}${API}/room/${encodeURIComponent(code)}?role=game`);
    ws = sock;
    sock.onopen = () => { retry = 0; setStatus("open"); };
    sock.onmessage = (ev) => {
      let m: RoomIn;
      try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { console.warn("room: bad message", ev.data); return; }
      if (m && typeof m === "object" && typeof (m as { type?: unknown }).type === "string") msgCbs.forEach((cb) => cb(m));
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return; // an old socket we already dropped
      if (closed || ev.code !== 1000) {
        setStatus("closed");
        if (!closed) reconnect();
        return;
      }
      void takenByAnother().then((taken) => {
        if (closed || ws !== sock) return;
        if (taken) closed = true;
        setStatus(taken ? "replaced" : "closed");
        if (!taken) reconnect();
      });
    };
    sock.onerror = () => sock.close();
  }
  connect();

  // The laptop's Wi-Fi came back: the old socket may be half-open (looks open, delivers nothing). Start over now.
  addEventListener("online", () => {
    if (closed) return;
    const old = ws;
    ws = null;
    if (old) { old.onclose = null; old.onmessage = null; try { old.close(); } catch { /* already gone */ } }
    setStatus("closed");
    retry = 0;
    reconnect(200);
  });

  return {
    code,
    onMessage: (cb) => void msgCbs.push(cb),
    onStatus: (cb) => void statusCbs.push(cb),
    send(m) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
    close() {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
