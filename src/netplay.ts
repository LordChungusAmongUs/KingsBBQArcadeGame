import { ref, set, remove, onValue, off, onDisconnect } from 'firebase/database';
import { rtdb } from './firebase';
import type { GameState } from './types';
import { buildStations } from './kitchen';

// ── Presence ──────────────────────────────────────────────────────────────────

export interface PresenceUser {
  uid: string; name: string; photo: string;
}

export function setPresence(uid: string, name: string, photo: string): void {
  const r = ref(rtdb, `presence/${uid}`);
  set(r, { name, photo });
  onDisconnect(r).remove();
}

export function clearPresence(uid: string): void {
  remove(ref(rtdb, `presence/${uid}`)).catch(() => {});
}

export function watchPresence(cb: (users: PresenceUser[]) => void): () => void {
  const r = ref(rtdb, 'presence');
  onValue(r, snap => {
    const data = snap.val() ?? {};
    cb(Object.entries(data).map(([uid, v]) => ({ uid, ...(v as any) } as PresenceUser)));
  });
  return () => off(r);
}

// ── P2 input / game sync ──────────────────────────────────────────────────────

export interface P2InputData {
  up: boolean; down: boolean; left: boolean; right: boolean; interactSeq: number;
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
  }, 200);
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
  for (const ss of snap.stations ?? []) {
    const st = stations.find(s => s.id === ss.id);
    if (st) st.slots = ss.slots;
  }
  return {
    player:  { ...snap.p,  vx: 0, vy: 0, radius: 18 },
    player2: snap.p2 ? { ...snap.p2, vx: 0, vy: 0, radius: 18 } : null,
    coop: true, stations,
    orders: snap.orders ?? [], plates: snap.plates ?? [], staged: snap.staged ?? [],
    score: snap.score, level: snap.level, levelTimer: snap.levelTimer, nextOrderIn: 0,
    completed: snap.completed, failed: snap.failed,
    phase: snap.phase as GameState['phase'],
    levelEndTimer: snap.levelEndTimer, prepTimer: snap.prepTimer, laborAccum: 0,
    chopStored: snap.chopStored, chopProgress: snap.chopProgress, chopOutput: snap.chopOutput,
    activeMenu: snap.activeMenu, maxFails: snap.maxFails, thresholdsUnlocked: snap.thresholdsUnlocked,
    levelSales: snap.levelSales, levelCOGS: snap.levelCOGS, levelLabor: snap.levelLabor,
    levelWaste: snap.levelWaste, salesByItem: snap.salesByItem ?? {},
  };
}
