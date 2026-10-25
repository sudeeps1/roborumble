// The room's join QR code: phones scan it while the screen waits for players.
import { toCanvas } from "qrcode";

export function joinQr(url: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "join-qr";
  const label = document.createElement("div");
  label.className = "join-qr-label";
  label.textContent = "Scan to join";
  const canvas = document.createElement("canvas");
  const link = document.createElement("div");
  link.className = "join-qr-url";
  link.textContent = url.replace(/^https?:\/\//, "");
  el.append(label, canvas, link);
  void toCanvas(canvas, url, { margin: 1, scale: 8, color: { dark: "#1b1430ff", light: "#fbf4e2ff" } });
  document.body.append(el);
  return el;
}
