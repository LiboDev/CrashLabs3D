/** v2: damage was rescaled (max ~ $1M per run), so v1 best scores are reset on migration. */
export const SAVE_VERSION = 2 as const;

export type SaveV2 = {
  version: typeof SAVE_VERSION;
  bestDamage: number;
  totalScrap: number;
  runs: number;
  bestTier: number;
  /** Rewarded "start one tier higher" boost waiting for the next run. */
  pendingBoost: boolean;
  /** In-game mute (YouTube's own mute always wins). */
  muted: boolean;
};

/** Alias kept so callers don't care about the current version number. */
export type SaveV1 = SaveV2;

export function defaultSave(): SaveV2 {
  return { version: SAVE_VERSION, bestDamage: 0, totalScrap: 0, runs: 0, bestTier: 0, pendingBoost: false, muted: false };
}

const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, Number.MAX_SAFE_INTEGER) : d;
};

/** Parses any raw string (empty, corrupt, old, future) into a valid save. */
export function parseSave(raw: string): SaveV2 {
  if (!raw) return defaultSave();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return defaultSave();
  }
  if (!value || typeof value !== 'object') return defaultSave();
  const r = value as Record<string, unknown>;
  const oldScale = r.version === 1;
  return {
    version: SAVE_VERSION,
    bestDamage: oldScale ? 0 : Math.floor(num(r.bestDamage)),
    totalScrap: Math.floor(num(r.totalScrap)),
    runs: Math.floor(num(r.runs)),
    bestTier: Math.floor(num(r.bestTier)),
    pendingBoost: r.pendingBoost === true,
    muted: r.muted === true,
  };
}
