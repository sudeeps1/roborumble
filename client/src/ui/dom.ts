// Tiny DOM helpers for the UI. Dynamic text always goes through textContent (move names come from players).
import type { MoveType } from "../contract";

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** A span holding trusted static SVG markup from art.ts. */
export function art(markup: string, cls = ""): HTMLSpanElement {
  const s = h("span", `art ${cls}`.trim());
  s.innerHTML = markup;
  return s;
}

/** A button that never keeps focus, so Enter/Space keep going to main.ts's keyboard handler. */
export function button(cls: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", cls);
  b.type = "button";
  b.tabIndex = -1;
  b.addEventListener("pointerdown", (e) => e.preventDefault());
  b.addEventListener("click", () => { b.blur(); if (!b.disabled) onClick(); });
  return b;
}

const NF = new Intl.NumberFormat("en-US");
export const fmtInt = (n: number) => NF.format(Math.round(n));
export const hexCss = (n: number) => `#${(n >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

/** Darker type colors that stay readable on parchment (config.TYPE_CSS is tuned for the night scene). */
export const TYPE_INK: Record<MoveType, string> = { physical: "#b02c5a", fire: "#c04a12", ice: "#1f7a9a", lightning: "#8f6a00", shadow: "#6243b8" };

/** Restart a CSS animation class on an element. */
export function replay(el: HTMLElement, cls: string) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** Current root font size in px (the UI is laid out in rem; 1rem = 1% of a 16:9 viewport width). */
export function remPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 12.8;
}
