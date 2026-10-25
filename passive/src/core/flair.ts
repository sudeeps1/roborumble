// Flair: makes a shouted spell's clip look magical. Pure function over world-space REF_HZ frames
// (36 numbers: root xyz, root quat w-first, 29 hinges in MuJoCo order), used by Fighter.castKin
// before its glide. Bigger joint swings, a snappy wind-up with a hit-stop, hovering casts,
// leaping melee, and a spin-and-slam shockwave. Defies physics on purpose: kinematic playback.
import { type Frame, REF_HZ } from "./reference.ts";

export const FLAIR = {
  on: true,
  /** joint gain around the clip's rest pose: legs (0-11), waist (12-14), arms (15-28) */
  gainLegs: 1.15, gainWaist: 1.3, gainArms: 1.45,
  /** play speed into the hit, the freeze at the hit (s), and the speed of the follow-through */
  speedIn: 1.3, hitStop: 0.1, speedOut: 0.9,
  /** hover height for projectile / strike / shockwave / defend: base + per power (m) */
  hoverBase: 0.14, hoverPerPower: 0.08,
  /** melee leap height: base + per power (m); it lands on the hit */
  hopBase: 0.1, hopPerPower: 0.04,
  /** shockwave: full turns spun on the way up before the slam */
  spinTurns: 1,
};

const smooth = (a: number) => { const x = Math.min(1, Math.max(0, a)); return x * x * (3 - 2 * x); };
const fin = (x: number, d: number) => (Number.isFinite(x) ? x : d);

function lerpFrame(A: Frame, B: Frame, a: number): Frame {
  const o = new Float64Array(36);
  for (let j = 0; j < 36; j++) o[j] = A[j] + (B[j] - A[j]) * a;
  // quats: nlerp on the short way round
  const s = A[3] * B[3] + A[4] * B[4] + A[5] * B[5] + A[6] * B[6] < 0 ? -1 : 1;
  for (let j = 3; j < 7; j++) o[j] = A[j] + (s * B[j] - A[j]) * a;
  return o;
}

function normQuat(f: Frame) {
  const n = Math.hypot(f[3], f[4], f[5], f[6]);
  if (n > 1e-9 && Number.isFinite(n)) for (let j = 3; j < 7; j++) f[j] /= n;
  else { f[3] = 1; f[4] = f[5] = f[6] = 0; }
}

/**
 * Returns new frames and the moved hit time (s from the first frame). Never throws; on bad input
 * or FLAIR.on false it hands the frames back unchanged. lo/hi (MuJoCo order, rad) clamp joints.
 */
export function flair(
  frames: Frame[], spec: { kind: string; type: string; power: number }, hitT: number,
  lo?: ArrayLike<number>, hi?: ArrayLike<number>,
): { frames: Frame[]; hitT: number } {
  if (!FLAIR.on || frames.length < 3) return { frames, hitT };
  try {
    const n = frames.length, dur = (n - 1) / REF_HZ;
    const hT = Math.min(dur, Math.max(0, fin(hitT, dur * 0.45)));
    const power = Math.min(3, Math.max(1, fin(spec.power, 2)));

    // 1. amplify joints around the rest pose (mean of the first 3 frames)
    const rest = new Float64Array(29);
    for (let k = 0; k < 3; k++) for (let j = 0; j < 29; j++) rest[j] += frames[k][7 + j] / 3;
    const amp = frames.map((f) => {
      const o = Float64Array.from(f);
      for (let j = 0; j < 29; j++) {
        const g = j < 12 ? FLAIR.gainLegs : j < 15 ? FLAIR.gainWaist : FLAIR.gainArms;
        let v = rest[j] + g * (f[7 + j] - rest[j]);
        if (lo && hi) v = Math.min(hi[j], Math.max(lo[j], v));
        o[7 + j] = fin(v, f[7 + j]);
      }
      return o;
    });

    // 2. time warp: faster in, hold at the hit, slower out
    const tIn = hT / FLAIR.speedIn, hold = hT > 0 && hT < dur ? FLAIR.hitStop : 0;
    const tOut = (dur - hT) / FLAIR.speedOut, total = tIn + hold + tOut;
    const m = Math.max(2, Math.round(total * REF_HZ) + 1);
    const out: Frame[] = [];
    for (let k = 0; k < m; k++) {
      const t = k / REF_HZ;
      const src = t < tIn ? t * FLAIR.speedIn : t < tIn + hold ? hT : hT + (t - tIn - hold) * FLAIR.speedOut;
      const x = Math.min(n - 1, Math.max(0, src * REF_HZ)), i = Math.min(n - 2, Math.floor(x));
      out.push(lerpFrame(amp[i], amp[i + 1], x - i));
    }
    const newHit = tIn, tEnd = (m - 1) / REF_HZ;

    // 3. magic root: hover / leap / spin-and-slam
    const x0 = out[0][0], y0 = out[0][1];
    for (let k = 0; k < m; k++) {
      const t = k / REF_HZ, f = out[k];
      let lift = 0;
      if (spec.kind === "melee") {
        // a leaping lunge that lands on the hit
        const a = newHit > 0 ? (t - newHit * 0.15) / (newHit * 0.85) : -1;
        if (a > 0 && a < 1) lift = (FLAIR.hopBase + FLAIR.hopPerPower * power) * Math.sin(Math.PI * a);
      } else {
        const h = FLAIR.hoverBase + FLAIR.hoverPerPower * power;
        if (spec.kind === "shockwave" && newHit >= 0.35) {
          // rise while spinning, then slam down on the hit
          const up = smooth(t / Math.max(1e-3, newHit * 0.75));
          const slam = t <= newHit * 0.75 ? 1 : 1 - smooth((t - newHit * 0.75) / Math.max(1e-3, newHit * 0.25));
          lift = h * up * slam;
          const spin = 2 * Math.PI * FLAIR.spinTurns * smooth((t - newHit * 0.1) / Math.max(1e-3, newHit * 0.75));
          if (spin !== 0) {
            const c = Math.cos(spin), s = Math.sin(spin), dx = f[0] - x0, dy = f[1] - y0;
            f[0] = x0 + c * dx - s * dy; f[1] = y0 + s * dx + c * dy;
            // world yaw on the left: qz * q
            const zw = Math.cos(spin / 2), zz = Math.sin(spin / 2), [w, qx, qy, qz] = [f[3], f[4], f[5], f[6]];
            f[3] = zw * w - zz * qz; f[4] = zw * qx - zz * qy; f[5] = zw * qy + zz * qx; f[6] = zw * qz + zz * w;
          }
        } else {
          // float up into the cast (never faster than 0.35 s), hang through the hit, drift down by the end
          const R = Math.max(0.35, newHit), F = Math.max(newHit + hold, Math.min(R, tEnd - 0.3));
          const rise = smooth(t / R);
          const fall = 1 - smooth((t - F) / Math.max(0.2, tEnd - F));
          lift = h * rise * Math.min(1, fall);
        }
      }
      f[2] += fin(lift, 0);
      normQuat(f);
      for (let j = 0; j < 36; j++) if (!Number.isFinite(f[j])) return { frames, hitT };
    }
    return { frames: out, hitT: newHit };
  } catch {
    return { frames, hitT };
  }
}
