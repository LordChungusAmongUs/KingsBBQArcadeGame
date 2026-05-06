const ROOKIE_KEY = 'kbb-leaderboard-rookie-v1';
const PRO_KEY    = 'kbb-leaderboard-pro-v1';

export type LeaderboardMode = 'rookie' | 'pro';

export interface LeaderboardEntry {
  name: string;   // 3 chars, uppercase
  score: number;  // cents
  level: number;  // highest level reached
}

export function loadLeaderboard(mode: LeaderboardMode = 'rookie'): LeaderboardEntry[] {
  try {
    const raw = localStorage.getItem(mode === 'pro' ? PRO_KEY : ROOKIE_KEY);
    return raw ? (JSON.parse(raw) as LeaderboardEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveEntry(name: string, score: number, level: number, mode: LeaderboardMode = 'rookie'): LeaderboardEntry[] {
  const entries = loadLeaderboard(mode);
  entries.push({ name: name.toUpperCase().padEnd(3, ' ').slice(0, 3), score, level });
  entries.sort((a, b) => b.score - a.score);
  const top = entries.slice(0, 10);
  try { localStorage.setItem(mode === 'pro' ? PRO_KEY : ROOKIE_KEY, JSON.stringify(top)); } catch { /* storage unavailable */ }
  return top;
}
