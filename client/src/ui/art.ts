// Original inline-SVG art for the storybook UI, drawn here (no image files): character emblems,
// type glyphs, flourishes, rune ring, laurel. Static trusted markup only: never interpolate player text.
import type { MoveType } from "../contract";

const INK = "#2b1d0e";
const r2 = (n: number) => Math.round(n * 100) / 100;
const polar = (cx: number, cy: number, R: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [r2(cx + R * Math.cos(a)), r2(cy + R * Math.sin(a))];
};
const open = (vb = "0 0 100 100", extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" ${extra}>`;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// Sir Bramble: a heraldic briar rose on a thorny vine.
function bramble(): string {
  const petals = (R: number, r: number, a0: number) =>
    range(5).map((k) => { const [x, y] = polar(50, 44, R, a0 + k * 72); return `<circle cx="${x}" cy="${y}" r="${r}"/>`; }).join("");
  const barbs = range(5).map((k) => {
    const ang = -54 + k * 72;
    const [x, y] = polar(50, 44, 23, ang);
    return `<path d="M0 -9Q5.5 -1 0 6Q-5.5 -1 0 -9Z" transform="translate(${x} ${y}) rotate(${ang + 90})"/>`;
  }).join("");
  const vine = "M10 88C28 70 72 70 90 88";
  return `${open()}
<path d="${vine}" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>
<path d="${vine}" fill="none" stroke="#5c8a3c" stroke-width="3.6" stroke-linecap="round"/>
<g fill="#5c8a3c" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"><path d="M21.2 80.4 20.8 72.9 25.8 78.5Z"/><path d="M38.2 75.3 41.5 82 43.2 74.7Z"/><path d="M56.8 74.7 60.1 68 61.8 75.3Z"/><path d="M74.2 78.4 73.8 85.9 78.8 80.4Z"/></g>
<g fill="#628f40" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round">${barbs}</g>
<g fill="#c8324a" stroke="${INK}" stroke-width="2">${petals(14.5, 12.5, -90)}</g>
<g fill="#e65b6d" stroke="${INK}" stroke-width="1.6">${petals(6.8, 6.6, -54)}</g>
<circle cx="50" cy="44" r="4.6" fill="#f0c95e" stroke="${INK}" stroke-width="1.4"/>
</svg>`;
}

// Marigold: a crooked witch hat with a little lantern hanging from its tip.
function marigold(): string {
  return `${open()}
<circle cx="77" cy="34" r="15" fill="#ffc94d" opacity=".32"/>
<circle cx="77" cy="34" r="8.5" fill="#ffd36b" opacity=".45"/>
<path d="M30 70C38 50 42 34 50 24C56 16 64 11 73 10C66 16 61 24 59 34C57 46 62 58 70 70Z" fill="#5a3050" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/>
<path d="M40 50C43 40 47 32 53 25" fill="none" stroke="#83507a" stroke-width="1.8" stroke-linecap="round"/>
<path d="M33 55C44 51.5 56 51.5 66 55L68.5 64.5C56 61 44 61 31 64.5Z" fill="#ff9a3c" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>
<g stroke="#ffe08a" stroke-width="1.5" stroke-linecap="round"><path d="M37.5 56.6l2 2.4M45 55.2l2 2.4M53 55.2l2 2.4M60.5 56.6l2 2.4"/></g>
<ellipse cx="50" cy="72" rx="39" ry="8.5" fill="#4a2442" stroke="${INK}" stroke-width="2.4"/>
<path d="M17 73.5C31 78 69 78 83 73.5" fill="none" stroke="#6f3c64" stroke-width="1.5" stroke-linecap="round"/>
<path d="M73 10.5 77 24" stroke="${INK}" stroke-width="1.5"/>
<path d="M72.5 27H81.5L79.5 24H74.5Z" fill="#c8963c" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/>
<rect x="72.5" y="27" width="9" height="13" rx="2" fill="#ffd56e" stroke="${INK}" stroke-width="1.6"/>
<path d="M77 30.5C79.4 33 79.4 36 77 37.6C74.6 36 74.6 33 77 30.5Z" fill="#ff7a1a"/>
<path d="M77 27V40" stroke="${INK}" stroke-width=".9" opacity=".7"/>
<rect x="72" y="40" width="10" height="2.6" rx="1" fill="#c8963c" stroke="${INK}" stroke-width="1.2"/>
<g fill="#ff9a3c"><circle cx="20" cy="55" r="1.7"/><circle cx="25" cy="45" r="1.1"/><circle cx="88" cy="55" r="1.4"/><circle cx="16" cy="40" r=".9"/></g>
</svg>`;
}

// Flicker: a dragonfly with veined wings and a spark.
function flicker(): string {
  const wings = [
    "M47 33C36 21 15 15 7 21C3 27 20 37 47 38Z",
    "M53 33C64 21 85 15 93 21C97 27 80 37 53 38Z",
    "M47 42C33 43 13 50 11 59C14 64 34 55 47 46Z",
    "M53 42C67 43 87 50 89 59C86 64 66 55 53 46Z",
  ];
  const veins = "M45 35C34 29 20 24 10 22.5M30 27.5 26 33.5M20 24.5 18 31M38 31.5 35.5 36.5M45 44C34 48 22 53 13 58.5M33 47.8 36 52.5M23 52.5 26.5 56.5";
  return `${open()}
<g fill="#fff3a6" fill-opacity=".92" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round">${wings.map((d) => `<path d="${d}"/>`).join("")}</g>
<g fill="none" stroke="#c9a640" stroke-width="1" stroke-linecap="round"><path d="${veins}"/><path d="${veins}" transform="translate(100 0) scale(-1 1)"/></g>
<path d="M50 44V88" stroke="${INK}" stroke-width="7.4" stroke-linecap="round"/>
<path d="M50 44V88" stroke="#4fb6c4" stroke-width="3.8" stroke-linecap="round"/>
<path d="M47.6 54h4.8M47.6 62h4.8M47.6 70h4.8M47.6 78h4.8" stroke="${INK}" stroke-width="1.2"/>
<ellipse cx="50" cy="38" rx="5.6" ry="8" fill="#3f8fa0" stroke="${INK}" stroke-width="1.8"/>
<circle cx="50" cy="25.5" r="5.9" fill="#3a6f80" stroke="${INK}" stroke-width="1.8"/>
<circle cx="47.5" cy="24.6" r="2.1" fill="#ffe46b"/><circle cx="52.5" cy="24.6" r="2.1" fill="#ffe46b"/>
<path d="M75 64 67.5 76H73L68.5 87 80 72.5H74.5L79 64Z" fill="#ffe46b" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round"/>
<path d="M27 67 23.5 73H26.5L24 79.5 30.5 71.5H27.6L29.8 67Z" fill="#ffe46b" stroke="${INK}" stroke-width="1.1" stroke-linejoin="round"/>
</svg>`;
}

// Rime: a stag's head with antlers, a frost crystal between them.
function rime(): string {
  const antler = "M45 60C41 50 33 43 29 32C27 24 28 16 31 9M35 46C27 45 20 41 15 33M29 31C23 29 18 25 16 19M29.5 19.5C33 16 36 12 37 6";
  const both = `<path d="${antler}"/><path d="${antler}" transform="translate(100 0) scale(-1 1)"/>`;
  const arms = range(6).map((k) => `<path d="M0 0V-10.5M-3.2 -7.2 0 -4.2 3.2 -7.2" transform="rotate(${k * 60})"/>`).join("");
  return `${open()}
<g fill="none" stroke-linecap="round" stroke-linejoin="round">
<g stroke="${INK}" stroke-width="7.6">${both}</g>
<g stroke="#e3f6ff" stroke-width="4">${both}</g>
</g>
<path d="M40 64Q29 60 24 67Q32 72 40.5 70Z" fill="#9db6ca" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>
<path d="M60 64Q71 60 76 67Q68 72 59.5 70Z" fill="#9db6ca" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>
<path d="M40 62Q50 55 60 62L61 72Q58 86 50 94Q42 86 39 72Z" fill="#b3cadb" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"/>
<path d="M50 62 53 74 50 87 47 74Z" fill="#e8f6fd" opacity=".85"/>
<circle cx="44.5" cy="70.5" r="1.9" fill="${INK}"/><circle cx="55.5" cy="70.5" r="1.9" fill="${INK}"/>
<ellipse cx="50" cy="90" rx="3.4" ry="2.3" fill="${INK}"/>
<g transform="translate(50 33)" fill="none" stroke-linecap="round" stroke-linejoin="round">
<g stroke="${INK}" stroke-width="4.6">${arms}</g>
<g stroke="#8fe3ff" stroke-width="2.2">${arms}</g>
</g>
</svg>`;
}

// Hush: a wolf's head against the night sky, its ear in front of the full moon.
function hush(): string {
  const head = "M50 30 60 34 72 12 77 40 86 55 77 60 81 67 68 75 59 85 50 92 41 85 32 75 19 67 23 60 14 55 23 40 28 12 40 34Z";
  const star = (x: number, y: number, s: number) => `<path d="M${x} ${y - s}L${x + s * .3} ${y - s * .3}L${x + s} ${y}L${x + s * .3} ${y + s * .3}L${x} ${y + s}L${x - s * .3} ${y + s * .3}L${x - s} ${y}L${x - s * .3} ${y - s * .3}Z"/>`;
  return `${open()}
<circle cx="50" cy="50" r="41" fill="#26305f" stroke="${INK}" stroke-width="2.2"/>
<circle cx="50" cy="50" r="38" fill="none" stroke="#3a4680" stroke-width="1.2"/>
<circle cx="71" cy="27" r="12.5" fill="#f6eecb"/>
<g fill="#e6dab0"><circle cx="66.5" cy="24" r="2.6"/><circle cx="74" cy="32" r="1.8"/><circle cx="75" cy="22.5" r="1.3"/></g>
<g fill="#f6eecb">${star(27, 26, 3.2)}${star(37, 16, 2)}${star(84, 50, 2.4)}${star(19, 47, 1.6)}</g>
<g transform="translate(50 60) scale(.78) translate(-50 -52)">
<path d="${head}" fill="#6f5f9e" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
<path d="M30 19 37 34 30.5 37Z" fill="#9d8cd0"/><path d="M70 19 63 34 69.5 37Z" fill="#9d8cd0"/>
<path d="M50 58 58 66 56 78 50 84 44 78 42 66Z" fill="#8e7fbf"/>
<path d="M37.5 48.5 46 51M62.5 48.5 54 51" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>
<path d="M36.5 52.5 45.5 55 38 57.5Z" fill="#f2e6ff"/><path d="M63.5 52.5 54.5 55 62 57.5Z" fill="#f2e6ff"/>
<path d="M45.5 77H54.5L50 82.5Z" fill="#15101f"/>
</g>
</svg>`;
}

export const EMBLEMS: Record<string, string> = {
  bramble: bramble(),
  marigold: marigold(),
  flicker: flicker(),
  rime: rime(),
  hush: hush(),
};
export const emblemSvg = (id: string): string => EMBLEMS[id] ?? EMBLEMS.bramble;

// Type glyphs, 24x24, drawn in currentColor.
export const TYPE_GLYPH: Record<MoveType, string> = {
  physical: `${open("0 0 24 24")}<g fill="currentColor">${range(5).map((k) => { const [x, y] = polar(12, 12, 5.3, -90 + k * 72); return `<circle cx="${x}" cy="${y}" r="4.1"/>`; }).join("")}</g><circle cx="12" cy="12" r="2.4" fill="${INK}" opacity=".5"/></svg>`,
  fire: `${open("0 0 24 24")}<path fill="currentColor" d="M12 1.5c1.2 4.2 6.5 6.6 6.5 12.5a6.5 6.5 0 0 1-13 0c0-3.4 1.8-5.1 3.3-7.2.1 2.3 1 3.4 2.2 4C11 8.3 12.2 5.3 12 1.5z"/></svg>`,
  ice: `${open("0 0 24 24")}<g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${[0, 60, 120, 180, 240, 300].map((a) => `<path d="M12 12V2.6M9.2 4.6 12 7.3l2.8-2.7" transform="rotate(${a} 12 12)"/>`).join("")}</g></svg>`,
  lightning: `${open("0 0 24 24")}<path fill="currentColor" d="M13.8 1.5 4.8 13.6h6.1L9.3 22.5l9.9-12.9h-6.2l2.3-8.1z"/></svg>`,
  shadow: `${open("0 0 24 24")}<path fill="currentColor" d="M14.5 2.5a9.5 9.5 0 1 0 7 13.2A7.5 7.5 0 0 1 14.5 2.5z"/></svg>`,
};

// Small UI glyphs.
export const BOOK = `${open("0 0 24 24", 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"')}<path d="M12 6C9 4.5 5 4.2 2.5 5v14c2.5-.8 6.5-.5 9.5 1 3-1.5 7-1.8 9.5-1V5C19 4.2 15 4.5 12 6z"/><path d="M12 6v14"/><path d="M5 8.2c1.8-.3 3.6-.1 5 .6M5 11.6c1.8-.3 3.6-.1 5 .6M14 8.8c1.4-.7 3.2-.9 5-.6M14 12.2c1.4-.7 3.2-.9 5-.6" stroke-width="1" opacity=".7"/></svg>`;
export const PHONE = `${open("0 0 24 24", 'fill="none" stroke="currentColor" stroke-width="1.7"')}<rect x="6.5" y="2.5" width="11" height="19" rx="2.3"/><path d="M10.5 18.6h3" stroke-linecap="round"/></svg>`;
export const SPARK = `${open("0 0 24 24")}<path fill="currentColor" d="M12 1l2.1 8.9L23 12l-8.9 2.1L12 23l-2.1-8.9L1 12l8.9-2.1z"/></svg>`;
export const STAR = `${open("0 0 24 24")}<path d="M12 1.8l2.9 6.6 7.2.7-5.4 4.8 1.6 7.1L12 17.3 5.7 21l1.6-7.1-5.4-4.8 7.2-.7z"/></svg>`;
export const PUFF = `${open("0 0 24 24", 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"')}<path d="M5 16c-2.2 0-3-2.6-1.2-3.8C3.4 9.6 6.6 8.4 8 10c.6-3 5.2-3.4 6.2-.4 2-1.4 5 .2 4.4 2.8 2.4.4 2.4 3.6 0 3.6H5z"/><path d="M8 20h3M14 20h1.5" opacity=".7"/></svg>`;
export const SEAL = `${open("0 0 24 24")}<g fill="currentColor">${range(12).map((k) => { const [x, y] = polar(12, 12, 8.6, k * 30); return `<circle cx="${x}" cy="${y}" r="2.6"/>`; }).join("")}<circle cx="12" cy="12" r="8.6"/></g><circle cx="12" cy="12" r="5.6" fill="none" stroke="${INK}" stroke-width="1" opacity=".45"/></svg>`;

// Ornamental divider for titles and banners.
export const FLOURISH = `${open("0 0 320 32", 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"')}
<path d="M10 16H112M208 16H310" stroke-width="1.6"/>
<path d="M112 16C122 16 124 6 134 6C141 6 144 13 139 15.5C135 17.5 131 14 134 11.5" stroke-width="1.8"/>
<path d="M208 16C198 16 196 6 186 6C179 6 176 13 181 15.5C185 17.5 189 14 186 11.5" stroke-width="1.8"/>
<path d="M112 16C122 16 124 26 134 26C140 26 143 21 140 19M208 16C198 16 196 26 186 26C180 26 177 21 180 19" stroke-width="1.2" opacity=".8"/>
<path d="M160 4 169 16 160 28 151 16Z" fill="currentColor" stroke="none"/>
<g fill="currentColor" stroke="none"><circle cx="146" cy="16" r="2.4"/><circle cx="174" cy="16" r="2.4"/><circle cx="6" cy="16" r="2.3"/><circle cx="314" cy="16" r="2.3"/><circle cx="60" cy="16" r="1.6"/><circle cx="260" cy="16" r="1.6"/></g>
</svg>`;

// Rotating rune circle (charging, loading).
export const RUNE_RING = (() => {
  const glyphs = ["M0 -4V4M0 -1 3 -4", "M-2.6 4 0 -4 2.6 4", "M0 -4 3 0 0 4 -3 0Z", "M-2.4 -4V4M-2.4 0 2.6 -4M-2.4 0 2.6 4", "M0 -4V4M-3 -1 0 -4 3 -1", "M-3 -4 3 4M3 -4 -3 4"];
  const marks = range(12).map((i) => `<path d="${glyphs[i % glyphs.length]}" transform="rotate(${i * 30} 50 50) translate(50 16)"/>`).join("");
  return `${open("0 0 100 100", 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"')}
<circle cx="50" cy="50" r="46.5" stroke-width="1.4" stroke-dasharray="1.6 4.6"/>
<circle cx="50" cy="50" r="40.5" stroke-width="2.3"/>
<circle cx="50" cy="50" r="27" stroke-width="1.2" opacity=".7"/>
<g stroke-width="1.9">${marks}</g>
</svg>`;
})();

// Laurel wreath around a medallion (match end).
export const LAUREL = (() => {
  let leaves = "";
  for (let i = 0; i < 9; i++) {
    const th = 112 + i * 16.5;
    for (const side of [-1, 1]) {
      const [x, y] = polar(50, 50, 45 + side * 3.6, th + side * 4);
      leaves += `<ellipse cx="${x}" cy="${y}" rx="6.2" ry="2.5" transform="rotate(${r2(th + 90 - side * 32)} ${x} ${y})"/>`;
    }
  }
  const branch = `<path d="M44 97C22 92 6 72 5.5 50C5.4 36 10 24 18 15" fill="none" stroke="#8a5f1a" stroke-width="1.6" stroke-linecap="round"/><g fill="#e2b85a" stroke="#6b4612" stroke-width=".9">${leaves}</g>`;
  return `${open("0 0 100 100")}${branch}<g transform="translate(100 0) scale(-1 1)">${branch}</g></svg>`;
})();
