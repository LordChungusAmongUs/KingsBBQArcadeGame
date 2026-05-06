const ROOKIE_KEY    = 'kbb-leaderboard-rookie-v1';
const PRO_SOLO_KEY  = 'kbb-leaderboard-pro-solo-v1';
const PRO_COOP_KEY  = 'kbb-leaderboard-pro-coop-v1';

export type LeaderboardMode = 'rookie' | 'pro_solo' | 'pro_coop';

export interface LeaderboardEntry {
  name: string;
  score: number;           // total sales (primary sort key; legacy field kept for compat)
  level: number;
  sales?: number;          // total sales — primary sort key
  profitPct?: number;      // tiebreaker 1 (higher is better)
  expenses?: number;       // labor + COGS — tiebreaker 2 (lower is better)
  satisfactionPct?: number; // orders served % — tiebreaker 3 (higher is better)
}

function storageKey(mode: LeaderboardMode): string {
  if (mode === 'pro_solo')  return PRO_SOLO_KEY;
  if (mode === 'pro_coop')  return PRO_COOP_KEY;
  return ROOKIE_KEY;
}

export function loadLeaderboard(mode: LeaderboardMode = 'rookie'): LeaderboardEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(mode));
    return raw ? (JSON.parse(raw) as LeaderboardEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveEntry(
  name: string, score: number, level: number,
  profitPct: number, expenses: number, satisfactionPct: number,
  mode: LeaderboardMode = 'rookie',
): LeaderboardEntry[] {
  const entries = loadLeaderboard(mode);
  entries.push({
    name: name.toUpperCase().padEnd(3, ' ').slice(0, 3),
    score, level, sales: score, profitPct, expenses, satisfactionPct,
  });
  entries.sort((a, b) => {
    const as_ = a.sales ?? a.score, bs = b.sales ?? b.score;
    if (bs !== as_) return bs - as_;
    const ap = a.profitPct ?? 0, bp = b.profitPct ?? 0;
    if (bp !== ap) return bp - ap;
    const ae = a.expenses ?? 0, be = b.expenses ?? 0;
    if (ae !== be) return ae - be; // lower expenses wins
    return (b.satisfactionPct ?? 0) - (a.satisfactionPct ?? 0);
  });
  const top = entries.slice(0, 10);
  try { localStorage.setItem(storageKey(mode), JSON.stringify(top)); } catch { /* storage unavailable */ }
  return top;
}
