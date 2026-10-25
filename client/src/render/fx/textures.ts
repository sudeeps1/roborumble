// Procedural canvas textures for effects. Everything is drawn white; the shaders tint it.
// Textures use premultiplied alpha so mipmaps don't get dark fringes.
import * as THREE from "three";

/** Sprite cells in the 4x4 particle atlas. Elongated sprites (Thorn, Shard, Streak, Flame) point along +X. */
export const SPR = {
  Dot: 0, Spark: 1, Star4: 2, Burst: 3,
  Petal: 4, Thorn: 5, Leaf: 6, Crystal: 7,
  Shard: 8, Smoke: 9, Streak: 10, Ring: 11,
  Flame: 12, Crescent: 13, Star8: 14, Flare: 15,
} as const;
export const ATLAS_GRID = 4;

const CELL = 256;

export interface FxTextures {
  atlas: THREE.Texture;
  runeCircle: THREE.Texture; // big magic circle with glyph band and hexagram
  runeRing: THREE.Texture;   // simpler dashed ring, counter-rotates inside the big one
  shockRing: THREE.Texture;  // soft ring band for ground shockwaves
  glowDisc: THREE.Texture;   // soft round ground glow
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return [c, c.getContext("2d")!];
}

function toTexture(c: HTMLCanvasElement): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.premultiplyAlpha = true;
  t.colorSpace = THREE.NoColorSpace; // masks, not colors
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Radial gradient with a gaussian-ish falloff. `k` sharpens it. */
function gauss(ctx: CanvasRenderingContext2D, r: number, k = 3, peak = 1, cx = 0, cy = 0) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  for (let i = 0; i <= 10; i++) {
    const x = i / 10;
    g.addColorStop(x, `rgba(255,255,255,${(peak * Math.exp(-x * x * k) * (1 - x)).toFixed(4)})`);
  }
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

// ---------- atlas cells (drawn centered, radius R) ----------
type Cell = (ctx: CanvasRenderingContext2D, R: number, r: () => number) => void;

const dot: Cell = (ctx, R) => gauss(ctx, R, 4.5);

const spark: Cell = (ctx, R) => {
  ctx.globalCompositeOperation = "lighter";
  gauss(ctx, R, 6, 0.45);
  gauss(ctx, R * 0.32, 3, 1);
};

function spike(ctx: CanvasRenderingContext2D, len: number, width: number, angle: number, peak = 1) {
  ctx.save();
  ctx.rotate(angle);
  ctx.scale(1, width / len);
  gauss(ctx, len, 2.2, peak);
  ctx.restore();
}

const star4: Cell = (ctx, R) => {
  ctx.globalCompositeOperation = "lighter";
  spike(ctx, R, R * 0.07, 0);
  spike(ctx, R, R * 0.07, Math.PI / 2);
  gauss(ctx, R * 0.42, 3, 0.9);
};

const star8: Cell = (ctx, R) => {
  ctx.globalCompositeOperation = "lighter";
  spike(ctx, R, R * 0.06, 0);
  spike(ctx, R, R * 0.06, Math.PI / 2);
  spike(ctx, R * 0.55, R * 0.05, Math.PI / 4, 0.8);
  spike(ctx, R * 0.55, R * 0.05, -Math.PI / 4, 0.8);
  gauss(ctx, R * 0.4, 3, 0.9);
};

const burst: Cell = (ctx, R, r) => {
  ctx.globalCompositeOperation = "lighter";
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (r() - 0.5) * 0.25;
    const len = R * (i % 2 ? 0.55 + r() * 0.2 : 0.85 + r() * 0.15);
    const w = R * (0.035 + r() * 0.03);
    ctx.save();
    ctx.rotate(a);
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.6, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -w);
    ctx.lineTo(len, 0);
    ctx.lineTo(0, w);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  gauss(ctx, R * 0.5, 3.5, 1);
};

const petal: Cell = (ctx, R) => {
  ctx.save();
  ctx.filter = "blur(1.5px)";
  ctx.beginPath();
  ctx.moveTo(0, R * 0.85);
  ctx.bezierCurveTo(R * 0.75, R * 0.45, R * 0.7, -R * 0.55, R * 0.18, -R * 0.82);
  ctx.quadraticCurveTo(0, -R * 0.62, -R * 0.18, -R * 0.82);
  ctx.bezierCurveTo(-R * 0.7, -R * 0.55, -R * 0.75, R * 0.45, 0, R * 0.85);
  const g = ctx.createRadialGradient(0, -R * 0.2, R * 0.05, 0, R * 0.1, R * 0.95);
  g.addColorStop(0, "rgb(255,255,255)");
  g.addColorStop(0.7, "rgb(235,235,235)");
  g.addColorStop(1, "rgb(170,170,170)");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
};

const thorn: Cell = (ctx, R) => {
  ctx.save();
  ctx.filter = "blur(1px)";
  ctx.beginPath();
  ctx.moveTo(-R * 0.95, -R * 0.2);
  ctx.quadraticCurveTo(R * 0.1, -R * 0.12, R * 0.95, R * 0.06); // hooked tip
  ctx.quadraticCurveTo(R * 0.05, R * 0.05, -R * 0.95, R * 0.2);
  ctx.closePath();
  const g = ctx.createLinearGradient(-R, 0, R, 0);
  g.addColorStop(0, "rgb(150,150,150)");
  g.addColorStop(0.7, "rgb(235,235,235)");
  g.addColorStop(1, "rgb(255,255,255)");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
};

const leaf: Cell = (ctx, R) => {
  ctx.save();
  ctx.filter = "blur(1px)";
  ctx.beginPath();
  ctx.moveTo(0, R * 0.9);
  ctx.bezierCurveTo(R * 0.7, R * 0.3, R * 0.55, -R * 0.5, 0, -R * 0.92);
  ctx.bezierCurveTo(-R * 0.55, -R * 0.5, -R * 0.7, R * 0.3, 0, R * 0.9);
  const g = ctx.createLinearGradient(-R * 0.6, 0, R * 0.6, 0);
  g.addColorStop(0, "rgb(200,200,200)");
  g.addColorStop(0.5, "rgb(255,255,255)");
  g.addColorStop(1, "rgb(185,185,185)");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = "rgba(90,90,90,0.9)";
  ctx.lineWidth = R * 0.05;
  ctx.beginPath();
  ctx.moveTo(0, R * 0.9);
  ctx.lineTo(0, -R * 0.75);
  for (let i = 0; i < 4; i++) {
    const y = R * (0.45 - i * 0.32);
    ctx.moveTo(0, y);
    ctx.lineTo(R * 0.32, y - R * 0.22);
    ctx.moveTo(0, y);
    ctx.lineTo(-R * 0.32, y - R * 0.22);
  }
  ctx.stroke();
  ctx.restore();
};

const crystal: Cell = (ctx, R) => {
  ctx.save();
  ctx.strokeStyle = "white";
  ctx.lineCap = "round";
  ctx.shadowColor = "white";
  ctx.shadowBlur = R * 0.12;
  for (let pass = 0; pass < 2; pass++) {
    ctx.lineWidth = pass ? R * 0.045 : R * 0.075;
    ctx.globalAlpha = pass ? 1 : 0.55;
    for (let i = 0; i < 6; i++) {
      ctx.save();
      ctx.rotate((i / 6) * Math.PI * 2);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -R * 0.88);
      for (const [y, l] of [[0.38, 0.26], [0.62, 0.2]] as const) {
        ctx.moveTo(0, -R * y);
        ctx.lineTo(R * l, -R * (y + l * 0.9));
        ctx.moveTo(0, -R * y);
        ctx.lineTo(-R * l, -R * (y + l * 0.9));
      }
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
  ctx.globalCompositeOperation = "lighter";
  gauss(ctx, R * 0.3, 3, 0.8);
};

const shard: Cell = (ctx, R) => {
  ctx.save();
  ctx.filter = "blur(0.8px)";
  ctx.beginPath();
  ctx.moveTo(-R * 0.95, 0);
  ctx.lineTo(-R * 0.25, -R * 0.24);
  ctx.lineTo(R * 0.95, 0);
  ctx.closePath();
  ctx.fillStyle = "rgb(255,255,255)";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-R * 0.95, 0);
  ctx.lineTo(-R * 0.25, R * 0.24);
  ctx.lineTo(R * 0.95, 0);
  ctx.closePath();
  ctx.fillStyle = "rgb(175,175,175)";
  ctx.fill();
  ctx.restore();
};

const smoke: Cell = (ctx, R, r) => {
  ctx.save();
  for (let i = 0; i < 16; i++) {
    const a = r() * Math.PI * 2, d = r() * R * 0.42;
    gauss(ctx, R * (0.3 + r() * 0.28), 2.2, 0.22, Math.cos(a) * d, Math.sin(a) * d);
  }
  // round off the edge
  ctx.globalCompositeOperation = "destination-in";
  const g = ctx.createRadialGradient(0, 0, R * 0.3, 0, 0, R);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-R, -R, R * 2, R * 2);
  ctx.restore();
};

const streak: Cell = (ctx, R) => {
  ctx.globalCompositeOperation = "lighter";
  spike(ctx, R, R * 0.16, 0, 0.6);
  spike(ctx, R * 0.9, R * 0.05, 0, 1);
};

const ring: Cell = (ctx, R) => {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.62, "rgba(255,255,255,0.04)");
  g.addColorStop(0.8, "rgba(255,255,255,0.9)");
  g.addColorStop(0.86, "rgba(255,255,255,0.75)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fill();
};

const flame: Cell = (ctx, R) => {
  ctx.save();
  ctx.filter = `blur(${(R * 0.06).toFixed(1)}px)`;
  ctx.beginPath();
  ctx.arc(-R * 0.3, 0, R * 0.42, Math.PI * 0.5, Math.PI * 1.5);
  ctx.bezierCurveTo(R * 0.2, -R * 0.42, R * 0.5, -R * 0.2, R * 0.92, 0);
  ctx.bezierCurveTo(R * 0.5, R * 0.2, R * 0.2, R * 0.42, -R * 0.3, R * 0.42);
  const g = ctx.createRadialGradient(-R * 0.3, 0, 0, -R * 0.1, 0, R * 0.95);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(235,235,235,0.85)");
  g.addColorStop(1, "rgba(160,160,160,0.0)");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
};

const crescent: Cell = (ctx, R) => {
  const [c2, x2] = canvas(CELL);
  x2.translate(CELL / 2, CELL / 2);
  x2.fillStyle = "white";
  x2.beginPath();
  x2.arc(0, 0, R * 0.62, 0, Math.PI * 2);
  x2.fill();
  x2.globalCompositeOperation = "destination-out";
  x2.beginPath();
  x2.arc(R * 0.3, -R * 0.14, R * 0.56, 0, Math.PI * 2);
  x2.fill();
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.filter = `blur(${(R * 0.12).toFixed(1)}px)`;
  ctx.drawImage(c2, -CELL / 2, -CELL / 2);
  ctx.restore();
  ctx.drawImage(c2, -CELL / 2, -CELL / 2);
};

const flare: Cell = (ctx, R) => {
  ctx.globalCompositeOperation = "lighter";
  gauss(ctx, R, 3.2, 0.55);
  gauss(ctx, R * 0.35, 3, 1);
};

const CELLS: Cell[] = [dot, spark, star4, burst, petal, thorn, leaf, crystal, shard, smoke, streak, ring, flame, crescent, star8, flare];

function buildAtlas(): THREE.Texture {
  const [c, ctx] = canvas(CELL * ATLAS_GRID);
  const r = rng(7);
  CELLS.forEach((draw, i) => {
    ctx.save();
    ctx.translate((i % ATLAS_GRID) * CELL + CELL / 2, Math.floor(i / ATLAS_GRID) * CELL + CELL / 2);
    ctx.beginPath();
    ctx.rect(-CELL / 2, -CELL / 2, CELL, CELL);
    ctx.clip();
    draw(ctx, CELL * 0.46, r);
    ctx.restore();
  });
  return toTexture(c);
}

// ---------- rune circles ----------
/** A rune: a stave with a few straight branches, like carved futhark letters (original, procedural). */
function glyph(ctx: CanvasRenderingContext2D, h: number, r: () => number) {
  ctx.beginPath();
  ctx.moveTo(0, -h / 2);
  ctx.lineTo(0, h / 2);
  const kind = Math.floor(r() * 5);
  if (kind === 0) { // diamond on the stave
    const y = (r() - 0.5) * h * 0.4, d = h * 0.22;
    ctx.moveTo(0, y - d); ctx.lineTo(d, y); ctx.lineTo(0, y + d); ctx.lineTo(-d, y); ctx.closePath();
  } else if (kind === 1) { // twin staves joined
    ctx.moveTo(h * 0.36, -h / 2); ctx.lineTo(h * 0.36, h / 2);
    ctx.moveTo(0, -h * 0.2); ctx.lineTo(h * 0.36, h * 0.15);
  } else {
    const n = kind - 1;
    for (let i = 0; i < n; i++) {
      const y = -h / 2 + h * (0.1 + 0.8 * r());
      const dir = r() < 0.5 ? -1 : 1;
      ctx.moveTo(0, y);
      ctx.lineTo(dir * h * 0.36, y + (r() < 0.5 ? -1 : 1) * h * 0.3);
    }
  }
  ctx.stroke();
}

function ringStroke(ctx: CanvasRenderingContext2D, rad: number, w: number, alpha = 1, dash?: number[]) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = w;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.arc(0, 0, rad, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function glowStyle(ctx: CanvasRenderingContext2D, blur: number) {
  ctx.strokeStyle = "white";
  ctx.fillStyle = "white";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "white";
  ctx.shadowBlur = blur;
}

function buildRuneCircle(): THREE.Texture {
  const S = 1024;
  const [c, ctx] = canvas(S);
  const r = rng(42);
  ctx.translate(S / 2, S / 2);
  glowStyle(ctx, 14);
  // soft inner glow so the circle reads as light on the ground
  ctx.save();
  ctx.shadowBlur = 0;
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 500);
  g.addColorStop(0, "rgba(255,255,255,0.10)");
  g.addColorStop(0.7, "rgba(255,255,255,0.05)");
  g.addColorStop(0.95, "rgba(255,255,255,0.16)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-S / 2, -S / 2, S, S);
  ctx.restore();

  ringStroke(ctx, 486, 12);
  ringStroke(ctx, 458, 4, 0.9);
  ringStroke(ctx, 362, 6);
  ringStroke(ctx, 340, 3, 0.8);
  // dots between the outer rings
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * 472, Math.sin(a) * 472, i % 5 === 0 ? 5 : 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // glyph band
  ctx.lineWidth = 7;
  const n = 22;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ctx.save();
    ctx.rotate(a);
    ctx.translate(0, -410);
    glyph(ctx, 62, r);
    ctx.restore();
  }
  // hexagram
  ctx.lineWidth = 5;
  for (let k = 0; k < 2; k++) {
    ctx.beginPath();
    for (let i = 0; i <= 3; i++) {
      const a = (i / 3) * Math.PI * 2 + k * Math.PI + Math.PI / 2;
      const x = Math.cos(a) * 336, y = Math.sin(a) * 336;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ringStroke(ctx, 194, 5);
  ringStroke(ctx, 168, 2.5, 0.8, [14, 10]);
  // small circles on the hexagram points
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 2;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * 336, Math.sin(a) * 336, 20, 0, Math.PI * 2);
    ctx.stroke();
  }
  // inner glyphs and a center star
  ctx.lineWidth = 5;
  for (let i = 0; i < 8; i++) {
    ctx.save();
    ctx.rotate((i / 8) * Math.PI * 2);
    ctx.translate(0, -120);
    glyph(ctx, 38, r);
    ctx.restore();
  }
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rad = i % 2 ? 26 : 70;
    if (i === 0) ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad); else ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  ctx.stroke();
  return toTexture(c);
}

function buildRuneRing(): THREE.Texture {
  const S = 512;
  const [c, ctx] = canvas(S);
  const r = rng(99);
  ctx.translate(S / 2, S / 2);
  glowStyle(ctx, 8);
  ringStroke(ctx, 238, 6, 1, [30, 14]);
  ringStroke(ctx, 214, 2.5, 0.85);
  ringStroke(ctx, 150, 3, 0.9);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.save();
    ctx.rotate(a);
    ctx.translate(0, -226);
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(7, 0); ctx.lineTo(0, 9); ctx.lineTo(-7, 0); ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.lineWidth = 4;
  for (let i = 0; i < 10; i++) {
    ctx.save();
    ctx.rotate((i / 10) * Math.PI * 2 + 0.3);
    ctx.translate(0, -182);
    glyph(ctx, 34, r);
    ctx.restore();
  }
  return toTexture(c);
}

function buildShockRing(): THREE.Texture {
  const S = 512;
  const [c, ctx] = canvas(S);
  ctx.translate(S / 2, S / 2);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, S / 2);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.55, "rgba(255,255,255,0.05)");
  g.addColorStop(0.8, "rgba(255,255,255,0.35)");
  g.addColorStop(0.9, "rgba(255,255,255,1)");
  g.addColorStop(0.95, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-S / 2, -S / 2, S, S);
  return toTexture(c);
}

function buildGlowDisc(): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S);
  ctx.translate(S / 2, S / 2);
  gauss(ctx, S / 2, 3.5, 1);
  return toTexture(c);
}

export function buildTextures(): FxTextures {
  return { atlas: buildAtlas(), runeCircle: buildRuneCircle(), runeRing: buildRuneRing(), shockRing: buildShockRing(), glowDisc: buildGlowDisc() };
}
