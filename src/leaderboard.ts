const ROOKIE_KEY = 'kbb-leaderboard-rookie-v1';
const PRO_KEY    = 'kbb-leaderboard-pro-v1';

export type LeaderboardMode = 'rookie' | 'pro';

export interface LeaderboardEntry {
  name: string;
  score: number;       // total sales (same as sales; kept for old-entry compat)
  level: number;
  sales?: number;      // total sales — primary sort key
  profitPct?: number;  // tiebreaker 1 (higher is better)
  expenses?: number;   // labor + COGS — tiebreaker 2 (lower is better)
}

export function loadLeaderboard(mode: LeaderboardMode = 'rookie'): LeaderboardEntry[] {
  try {
    const raw = localStorage.getItem(mode === 'pro' ? PRO_KEY : ROOKIE_KEY);
    return raw ? (JSON.parse(raw) as LeaderboardEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveEntry(
  name: string, score: number, level: number,
  profitPct: number, expenses: number,
  mode: LeaderboardMode = 'rookie',
): LeaderboardEntry[] {
  const entries = loadLeaderboard(mode);
  entries.push({
    name: name.toUpperCase().padEnd(3, ' ').slice(0, 3),
    score, level, sales: score, profitPct, expenses,
  });
  entries.sort((a, b) => {
    const as_ = a.sales ?? a.score, bs = b.sales ?? b.score;
    if (bs !== as_) return bs - as_;
    const ap = a.profitPct ?? 0, bp = b.profitPct ?? 0;
    if (bp !== ap) return bp - ap;
    return (a.expenses ?? 0) - (b.expenses ?? 0);
  });
  const top = entries.slice(0, 10);
  try { localStorage.setItem(mode === 'pro' ? PRO_KEY : ROOKIE_KEY, JSON.stringify(top)); } catch { /* storage unavailable */ }
  return top;
}
