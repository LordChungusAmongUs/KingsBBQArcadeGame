const LS_KEY = 'kbb-leaderboard-v1';

export interface LeaderboardEntry {
  name: string;   // 3 chars, uppercase
  score: number;  // cents
  level: number;  // highest level reached
}

export function loadLeaderboard(): LeaderboardEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as LeaderboardEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveEntry(name: string, score: number, level: number): LeaderboardEntry[] {
  const entries = loadLeaderboard();
  entries.push({ name: name.toUpperCase().padEnd(3, ' ').slice(0, 3), score, level });
  entries.sort((a, b) => b.score - a.score);
  const top = entries.slice(0, 10);
  try { localStorage.setItem(LS_KEY, JSON.stringify(top)); } catch { /* storage unavailable */ }
  return top;
}
