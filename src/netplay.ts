import { ref, set, remove, onValue, off, onDisconnect, runTransaction } from 'firebase/database';
import { collection, doc, setDoc, deleteDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { rtdb, db } from './firebase';
import type { GameState } from './types';
import { buildStations } from './kitchen';

// ── Presence (Firestore — works on Safari; RTDB auth iframe is blocked by ITP) ─

export interface PresenceUser {
  uid: string; name: string; photo: string;
}

let _presenceHeartbeat: ReturnType<typeof setInterval> | null = null;

export function setPresence(uid: string, name: string, photo: string): void {
  const r = doc(db, 'presence', uid);
  const write = () => setDoc(r, { uid, name, photo, ts: serverTimestamp() }).catch(e => console.warn('[presence] setPresence failed:', e));
  write();
  if (_presenceHeartbeat) clearInterval(_presenceHeartbeat);
  _presenceHeartbeat = setInterval(write, 60_000); // refresh so stale entries expire
}

export function clearPresence(uid: string): void {
  if (_presenceHeartbeat) { clearInterval(_presenceHeartbeat); _presenceHeartbeat = null; }
  deleteDoc(doc(db, 'presence', uid)).catch(() => {});
}

export function watchPresence(cb: (users: PresenceUser[]) => void): () => void {
  const staleMs = 3 * 60 * 1000; // treat entries older than 3 min as offline
  return onSnapshot(collection(db, 'presence'), snap => {
    const now = Date.now();
    const users = snap.docs
      .map(d => d.data() as PresenceUser & { ts?: { toMillis(): number } })
      .filter(u => !u.ts || now - u.ts.toMillis() < staleMs);
    cb(users);
  });
}

// ── Matchmaking ───────────────────────────────────────────────────────────────

export interface MatchmakingEntry { uid: string; name: string; photo: string; }

// Atomically join the matchmaking queue.
// Returns the entry we claimed (caller becomes host), or null (caller is now waiting as guest).
export async function seekMatch(
  uid: string, name: string, photo: string,
): Promise<MatchmakingEntry | null> {
  const seekRef = ref(rtdb, 'matchmaking/seeking');
  let claimed: MatchmakingEntry | null = null;
  await runTransaction(seekRef, current => {
    if (!current) {
      return { uid, name, photo };           // slot empty → wait here
    } else if (current.uid === uid) {
      return current;                        // already in queue
    } else {
      claimed = { uid: current.uid, name: current.name, photo: current.photo };
      return null;                           // claim the waiting player, clear slot
    }
  });
  if (!claimed) onDisconnect(seekRef).remove(); // auto-clean if we disconnect while waiting
  return claimed;
}

// Host calls this to tell the guest which lobby to join.
export function notifyMatch(toUid: string, lobbyId: string): Promise<void> {
  const r = ref(rtdb, `matchmaking/match/${toUid}`);
  onDisconnect(r).remove();
  return set(r, { lobbyId });
}

// Guest calls this to watch for the host's lobby notification.
// Returns a cancel function.
export function watchForMatch(uid: string, cb: (lobbyId: string) => void): () => void {
  const r = ref(rtdb, `matchmaking/match/${uid}`);
  onValue(r, snap => {
    const val = snap.val() as { lobbyId: string } | null;
    if (val?.lobbyId) { off(r); remove(r).catch(() => {}); cb(val.lobbyId); }
  });
  return () => { off(r); remove(r).catch(() => {}); };
}

// Remove self from matchmaking (cancel or cleanup).
export function leaveMatchmaking(uid: string): void {
  runTransaction(ref(rtdb, 'matchmaking/seeking'), cur => {
    if (cur?.uid === uid) return null;
    return cur;
  }).catch(() => {});
  remove(ref(rtdb, `matchmaking/match/${uid}`)).catch(() => {});
}

// ── P2 input / game sync ──────────────────────────────────────────────────────

export interface P2InputData {
  up: boolean; down: boolean; left: boolean; right: boolean; interactSeq: number;
  ix?: number; iy?: number; // P2 position at moment of interact press
}

export interface GameSnapshot {
  p:  { x: number; y: number; held: GameState['player']['held']; facing: number; walkFrame: number };
  p2: { x: number; y: number; held: GameState['player']['held']; facing: number; walkFrame: number } | null;
  stations: Array<{ id: string; slots: GameState['stations'][0]['slots'] }>;
  orders: GameState['orders'];
  plates: GameState['plates'];
  staged: GameState['staged'];
  score: number; level: number; levelTimer: number;
  completed: number; failed: number; phase: string;
  levelEndTimer: number; prepTimer: number;
  chopStored: number; chopProgress: number; chopOutput: number;
  activeMenu: GameState['activeMenu'];
  maxFails: number; thresholdsUnlocked: number;
  levelSales: number; levelCOGS: number; levelLabor: number; levelWaste: number;
  salesByItem: GameState['salesByItem'];
}

let _syncInterval: ReturnType<typeof setInterval> | null = null;
let _p2InputRef: ReturnType<typeof ref> | null = null;
let _stateRef:   ReturnType<typeof ref> | null = null;

// ── Host ──────────────────────────────────────────────────────────────────────

export function startHostSync(
  lobbyId: string,
  getState: () => GameState | null,
  onP2Input: (inp: P2InputData) => void,
): void {
  _stateRef   = ref(rtdb, `games/${lobbyId}/state`);
  _p2InputRef = ref(rtdb, `games/${lobbyId}/p2input`);
  onDisconnect(ref(rtdb, `games/${lobbyId}`)).remove();
  onValue(_p2InputRef, snap => {
    const val = snap.val() as P2InputData | null;
    if (val) onP2Input(val);
  });
  _syncInterval = setInterval(() => {
    const gs = getState();
    if (!gs || !_stateRef) return;
    set(_stateRef, buildSnapshot(gs)).catch(() => {});
  }, 30);
}

export function stopHostSync(lobbyId: string): void {
  if (_syncInterval) { clearInterval(_syncInterval); _syncInterval = null; }
  if (_p2InputRef)   { off(_p2InputRef); _p2InputRef = null; }
  set(ref(rtdb, `games/${lobbyId}`), null).catch(() => {});
}

// ── Guest ─────────────────────────────────────────────────────────────────────

export function startGuestSync(lobbyId: string, onState: (gs: GameState) => void): void {
  _stateRef   = ref(rtdb, `games/${lobbyId}/state`);
  _p2InputRef = ref(rtdb, `games/${lobbyId}/p2input`);
  onValue(_stateRef, snap => {
    const val = snap.val() as GameSnapshot | null;
    if (val) onState(snapshotToGameState(val));
  });
}

export function stopGuestSync(): void {
  if (_stateRef)   { off(_stateRef);   _stateRef   = null; }
  _p2InputRef = null;
}

export function pushGuestInput(inp: P2InputData): void {
  if (_p2InputRef) set(_p2InputRef, inp).catch(() => {});
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────

// RTDB strips null array elements and returns {0:a, 2:c} instead of [a,null,c].
// toArr handles dense arrays; toSparseArr restores null gaps for station slots.
function toArr<T>(v: unknown): T[] {
  if (!v) return [];
  if (Array.isArray(v)) return v as T[];
  if (typeof v === 'object') {
    const obj = v as Record<string, T>;
    return Object.keys(obj).sort((a, b) => +a - +b).map(k => obj[k]);
  }
  return [];
}

function toSparseArr<T>(v: unknown, len: number): (T | null)[] {
  if (!v) return Array(len).fill(null);
  if (Array.isArray(v)) {
    while (v.length < len) v.push(null);
    return v as (T | null)[];
  }
  const result: (T | null)[] = Array(len).fill(null);
  const obj = v as Record<string, T>;
  for (const k of Object.keys(obj)) {
    const i = +k;
    if (i >= 0 && i < len) result[i] = obj[k];
  }
  return result;
}

function buildSnapshot(gs: GameState): GameSnapshot {
  return {
    p:  { x: gs.player.x,  y: gs.player.y,  held: gs.player.held,  facing: gs.player.facing,  walkFrame: gs.player.walkFrame },
    p2: gs.player2 ? { x: gs.player2.x, y: gs.player2.y, held: gs.player2.held, facing: gs.player2.facing, walkFrame: gs.player2.walkFrame } : null,
    stations: gs.stations.map(s => ({ id: s.id, slots: s.slots })),
    orders: gs.orders, plates: gs.plates, staged: gs.staged,
    score: gs.score, level: gs.level, levelTimer: gs.levelTimer,
    completed: gs.completed, failed: gs.failed, phase: gs.phase,
    levelEndTimer: gs.levelEndTimer, prepTimer: gs.prepTimer,
    chopStored: gs.chopStored, chopProgress: gs.chopProgress, chopOutput: gs.chopOutput,
    activeMenu: gs.activeMenu, maxFails: gs.maxFails, thresholdsUnlocked: gs.thresholdsUnlocked,
    levelSales: gs.levelSales, levelCOGS: gs.levelCOGS, levelLabor: gs.levelLabor,
    levelWaste: gs.levelWaste, salesByItem: gs.salesByItem,
  };
}

function snapshotToGameState(snap: GameSnapshot): GameState {
  const stations = buildStations();
  for (const ss of toArr<{ id: string; slots: unknown }>(snap.stations)) {
    const st = stations.find(s => s.id === ss.id);
    if (st) st.slots = toSparseArr(ss.slots, st.slots.length) as GameState['stations'][0]['slots'];
  }
  return {
    player:  { ...snap.p,  held: snap.p.held  ?? null, vx: 0, vy: 0, radius: 18 },
    player2: snap.p2 ? { ...snap.p2, held: snap.p2.held ?? null, vx: 0, vy: 0, radius: 18 } : null,
    coop: true, stations,
    orders: toArr(snap.orders).map((o: any) => ({ ...o, items: toArr(o.items) })) as GameState['orders'],
    plates: toArr(snap.plates), staged: toArr(snap.staged),
    score: snap.score, level: snap.level, levelTimer: snap.levelTimer, nextOrderIn: 0,
    completed: snap.completed, failed: snap.failed,
    phase: snap.phase as GameState['phase'],
    levelEndTimer: snap.levelEndTimer, prepTimer: snap.prepTimer, laborAccum: 0,
    chopStored: snap.chopStored, chopProgress: snap.chopProgress, chopOutput: snap.chopOutput,
    activeMenu: snap.activeMenu ?? null, maxFails: snap.maxFails, thresholdsUnlocked: snap.thresholdsUnlocked,
    levelSales: snap.levelSales, levelCOGS: snap.levelCOGS, levelLabor: snap.levelLabor,
    levelWaste: snap.levelWaste, salesByItem: snap.salesByItem ?? {},
  };
}
