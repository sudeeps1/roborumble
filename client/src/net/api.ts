// HTTP side of the server (CLAUDE.md "Server endpoints"). The only place that parses HTTP responses.
import { API } from "../config";
import type { LeaderboardEntry, LibraryStats, Motion, MoveSpec, MoveType, Source } from "../contract";

export interface JobResult { status: "running" | "done" | "rejected" | string; move?: MoveSpec; motion?: Motion; check?: string; }

export interface Api {
  idle(): Promise<Motion>;
  /** Cached: motions never change once generated. */
  motion(id: string): Promise<Motion>;
  stats(): Promise<LibraryStats>;
  leaderboard(): Promise<LeaderboardEntry[]>;
  job(id: string): Promise<JobResult>;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export function httpApi(): Api {
  const motions = new Map<string, Promise<Motion>>();
  return {
    idle: () => getJson<Motion>("/idle").then(checkMotion),
    motion(id) {
      let m = motions.get(id);
      if (!m) {
        m = getJson<Motion>(`/motion/${encodeURIComponent(id)}`).then(checkMotion);
        m.catch(() => motions.delete(id)); // don't cache failures
        motions.set(id, m);
      }
      return m;
    },
    stats: () => getJson<unknown>("/library/stats").then(normalizeStats),
    leaderboard: () => getJson<unknown>("/leaderboard").then((r) => (Array.isArray(r) ? r : (r as { moves?: LeaderboardEntry[] })?.moves ?? []) as LeaderboardEntry[]),
    job: (id) => getJson<JobResult>(`/job/${encodeURIComponent(id)}`),
  };
}

export function checkMotion(m: Motion): Motion {
  if (!m || !Array.isArray(m.qpos) || !Array.isArray(m.joint_names) || !m.qpos.length) throw new Error(`bad motion ${m?.id ?? "?"}`);
  if (m.qpos[0].length !== 7 + m.joint_names.length) {
    console.warn(`motion ${m.id}: rows have ${m.qpos[0].length} values, expected 7 + ${m.joint_names.length} joints`);
  }
  return m;
}

// The stats shape isn't in a contract yet; accept a few likely spellings.
export function normalizeStats(raw: unknown): LibraryStats {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((k) => r[k]).find((v) => v && typeof v === "object") as Record<string, number> | undefined;
  const byType = (pick("by_type", "per_type", "types", "type") ?? {}) as Partial<Record<MoveType, number>>;
  const bySource = (pick("by_source", "per_source", "sources", "source") ?? {}) as Partial<Record<Source, number>>;
  const total = Number(r.total ?? r.total_moves ?? r.count ?? Object.values(bySource).reduce((a, b) => a + (b ?? 0), 0)) || 0;
  return { total, by_type: byType, by_source: bySource };
}
