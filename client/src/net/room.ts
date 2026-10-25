// The room WebSocket (CLAUDE.md: all traffic goes through the server; the game screen opens a room).
import { API } from "../config";
import type { RoomIn, RoomOut } from "../contract";

export type RoomStatus = "connecting" | "open" | "closed";

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
  const setStatus = (s: RoomStatus) => statusCbs.forEach((cb) => cb(s));

  const connect = () => {
    setStatus("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}${API}/room/${encodeURIComponent(code)}?role=game`);
    ws.onopen = () => { retry = 0; setStatus("open"); };
    ws.onmessage = (ev) => {
      let m: RoomIn;
      try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { console.warn("room: bad message", ev.data); return; }
      if (m && typeof m === "object" && typeof (m as { type?: unknown }).type === "string") msgCbs.forEach((cb) => cb(m));
    };
    ws.onclose = () => {
      setStatus("closed");
      if (closed) return;
      retry++;
      setTimeout(connect, Math.min(5000, 300 * 2 ** Math.min(retry, 4)));
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  return {
    code,
    onMessage: (cb) => void msgCbs.push(cb),
    onStatus: (cb) => void statusCbs.push(cb),
    send(m) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}
