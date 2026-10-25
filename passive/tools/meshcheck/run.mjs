// Headless driver: measure every character (?char=...), then screenshot requested frames.
//   node run.mjs BASEURL OUTDIR [shots.json]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
const [base, out, shots] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const exe = process.env.CHROME;
const browser = await puppeteer.launch({ executablePath: exe, headless: true, protocolTimeout: 900000, args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page1 = async (url, done) => {
  const p = await browser.newPage();
  p.on("pageerror", (e) => console.log("pageerror", url, e.message));
  await p.goto(url, { waitUntil: "load", timeout: 120000 });
  await p.waitForFunction(done, { timeout: 900000, polling: 500 });
  return p;
};
if (!shots) {
  await Promise.all(["elf", "knight", "sorceress", "wizard", "frog"].map(async (ch) => {
    const p = await page1(`${base}?char=${ch}`, "window.__result");
    const r = await p.evaluate(() => window.__result);
    writeFileSync(`${out}/${ch}.json`, JSON.stringify(r, null, 1));
    console.log(ch, "done in", r.seconds.toFixed(0), "s");
    await p.close();
  }));
} else {
  for (const s of JSON.parse(readFileSync(shots, "utf8"))) {
    const p = await page1(`${base}?char=${s.char}&clip=${s.clip}&frame=${s.frame}&view=${s.view ?? "front"}`, "window.__shot");
    await p.setViewport({ width: 640, height: 640 });
    const el = await p.$("canvas");
    await el.screenshot({ path: `${out}/${s.char}_${s.clip}_${s.frame}_${s.view ?? "front"}.png` });
    await p.close();
  }
}
await browser.close();
