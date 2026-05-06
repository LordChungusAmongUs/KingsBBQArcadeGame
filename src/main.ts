import { initAudio, playMusic, playPlaylist, stopMusic } from './audio';

// ── In-game soundtrack playlist (drop files in public/audio/) ──────────────
const GAME_TRACKS = [
  '/audio/game1.mp3',
  '/audio/game2.mp3',
  '/audio/game3.mp3',
  '/audio/game4.mp3',
];
import { initInput, flushFrame, input, virtualKeyDown, virtualKeyUp, keys } from './input';
import { createGame, tickGame, resolveCollisions } from './game';
import { initRenderer, render, resizeRenderer, loadSprites, drawNameEntry, drawLeaderboard, drawPauseMenu, drawControlsOverlay, drawRestaurantMenu, drawTutorialHint, drawTutorialModal } from './renderer';
import type { GameState, CookSlot } from './types';
import { LEVELS, STARTING_MONEY, PLAYER_SPEED, STAGED_SPOIL_TIME } from './config';
import { loadLeaderboard, saveEntry, type LeaderboardEntry, type LeaderboardMode } from './leaderboard';
import { initAuth, signInWithGoogle, signOutUser, checkRedirectResult } from './auth';
import type { User } from 'firebase/auth';
import {
  loadProfile, clearProfile, flushSession, getProfile,
  setOnLevelUp, setOnEarlyLevelUp, setOnAchievementUnlocked,
  incrementStat, recordMaxStat,
  xpProgress, ACHIEVEMENTS,
  type UserProfile,
} from './profile';
import {
  saveCloudScore, loadCloudLeaderboard,
  createLobby, joinLobby, deleteLobby, setLobbyStatus, watchLobby,
  sendGlobalMessage, watchGlobalChat, type GlobalChatMsg,
  sendInvite, respondToInvite, deleteInvite, watchIncomingInvites, watchSentInvite,
  type InviteData,
} from './cloud';
import {
  startHostSync, stopHostSync, startGuestSync, stopGuestSync, pushGuestInput,
  setPresence, clearPresence, watchPresence,
  seekMatch, notifyMatch, watchForMatch, leaveMatchmaking,
  type P2InputData, type PresenceUser,
} from './netplay';

// ─── Canvas setup ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
const menu   = document.getElementById('menu')!;
const GAME_W = 1183, GAME_H = 680;
canvas.width = GAME_W; canvas.height = GAME_H;
resizeRenderer(canvas);
initAudio();
initInput();
initRenderer(canvas);
loadSprites();

// ─── Touch controls ───────────────────────────────────────────────────────────

const touchControls = document.getElementById('touchControls')!;

function initTouchControls(): void {
  if (!('ontouchstart' in window) && navigator.maxTouchPoints === 0) return;
  touchControls.classList.add('touch-visible');
  function bindKey(id: string, code: string): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', e => { e.preventDefault(); virtualKeyDown(code); }, { passive: false });
    el.addEventListener('touchend',   e => { e.preventDefault(); virtualKeyUp(code); },   { passive: false });
    el.addEventListener('touchcancel',e => { e.preventDefault(); virtualKeyUp(code); },   { passive: false });
  }
  bindKey('dUp','KeyW'); bindKey('dDown','KeyS'); bindKey('dLeft','KeyA'); bindKey('dRight','KeyD');
  bindKey('dInteract','KeyE');
  document.getElementById('dPause')?.addEventListener('touchstart', e => {
    e.preventDefault();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true }));
  }, { passive: false });
}
initTouchControls();

// ─── Auth ─────────────────────────────────────────────────────────────────────

let user: User | null = null;

// Must be called before any auth state is read; resolves any pending redirect sign-in.
checkRedirectResult().catch(console.error);

initAuth(u => {
  user = u;
  if (u) {
    loadProfile(u.uid).then(() => {
      updateAuthUI();
      // Use localStorage (not sessionStorage) — iOS Safari clears sessionStorage
      // during cross-origin redirect navigation, losing the pending-lobby flag.
      // Always clear the pending-lobby flag — player must choose mode from the main menu
      localStorage.removeItem('kbbq_pendingLobby');
      if (lobbyScreen.style.display !== 'none' && !unsubPresence) {
        // Auth resolved after the user already opened the lobby (race on slow
        // iOS connections) — re-init now that we have a valid user.
        openLobbyScreen();
      }
    }).catch(console.error);
  } else {
    clearProfile();
    updateAuthUI();
  }
  updateMenuLeaderboard();
});

function updateAuthUI(): void {
  const authOut = document.getElementById('authOut')!;
  const authIn  = document.getElementById('authIn')!;
  if (user) {
    authOut.style.display = 'none'; authIn.style.display = 'flex';
    const photo = document.getElementById('userPhoto') as HTMLImageElement;
    photo.src = user.photoURL ?? ''; photo.style.display = user.photoURL ? 'block' : 'none';
    document.getElementById('userName')!.textContent = user.displayName ?? user.email ?? '';
    const prof = getProfile();
    const lvlEl = document.getElementById('userLevel')!;
    lvlEl.textContent = prof ? (prof.level >= 20 ? 'Lv MAX' : `Lv ${prof.level}`) : '';
  } else {
    authOut.style.display = 'flex'; authIn.style.display = 'none';
    document.getElementById('userLevel')!.textContent = '';
  }
}

document.getElementById('signInBtn')!.addEventListener('click', () => signInWithGoogle().catch(console.error));
document.getElementById('signOutBtn')!.addEventListener('click', () => signOutUser().catch(console.error));

// ─── Toast system ─────────────────────────────────────────────────────────────

const toastQueue: { title: string; sub: string }[] = [];
let toastActive = false;

function showToast(title: string, sub: string): void {
  toastQueue.push({ title, sub });
  if (!toastActive) _nextToast();
}

function _nextToast(): void {
  if (toastQueue.length === 0) { toastActive = false; return; }
  toastActive = true;
  const { title, sub } = toastQueue.shift()!;
  const el = document.getElementById('achievementToast')!;
  document.getElementById('toastTitle')!.textContent = title;
  document.getElementById('toastSub')!.textContent   = sub;
  el.classList.add('toast-show');
  setTimeout(() => {
    el.classList.remove('toast-show');
    setTimeout(_nextToast, 400);
  }, 3200);
}

// Fires immediately during gameplay when XP crosses a threshold → in-game toast
setOnEarlyLevelUp((_, newLv) => {
  showToast('LEVEL UP!', `You are now Level ${newLv >= 20 ? 'MAX' : newLv}`);
});

// Fires at session end (flushSession) → update UI with the now-official level
setOnLevelUp((_, newLv) => {
  updateAuthUI();
  updateLobbyXPBar();
});

setOnAchievementUnlocked((id, tier, name) => {
  const TIER_LABELS = ['I','II','III','IV','V','VI','VII','VIII','IX','X'];
  showToast('ACHIEVEMENT UNLOCKED', `${name} — Tier ${TIER_LABELS[tier] ?? tier + 1}`);
});

// ─── Game state ───────────────────────────────────────────────────────────────

let gs: GameState | null = null;
let currentLevel = 1;
let lastTime = 0;
let isCoop = false;

// ─── Tutorial state ───────────────────────────────────────────────────────────
let isTutorial = false;
let tutorialStep = 0;
let tutorialHintTimer = 0;
let tutorialBaseCompleted = 0;
let tutorialPlayerMoved = false;
let tutorialModalActive = false;

type Screen = 'game' | 'name_entry' | 'leaderboard';
let screen: Screen = 'game';
let isPaused = false, pauseMenuIdx = 0;
let pauseSubScreen: 'controls' | 'restaurant_menu' | null = null;
let leaderboardReturn: 'menu' | 'pause' = 'menu';
let leaderboardMode: LeaderboardMode = 'rookie';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ';
let nameChars = ['A','A','A'], nameCursor = 0;
let leaderboardEntries: LeaderboardEntry[] = [];
let lastGameWasCoop = false;
let lastGameWasOnline = false;
let lastGameScore = 0, lastGameLevel = 1;
let isProMode = false;
let lastGameWasPro = false;
let pgFocusIdx = 0;

// ─── Online co-op state ───────────────────────────────────────────────────────

let isOnlineGame = false, isOnlineHost = false;
let activeLobbyId: string | null = null;
let remoteGs: GameState | null = null;
let guestInteractSeq = 0, hostP2Seq = 0;
let lastSentInput: P2InputData | null = null;
let unsubHostLobby: (() => void) | null = null;
// Guest-side P2 prediction (so guest sees their own movement instantly)
let p2PredX: number | null = null;
let p2PredY: number | null = null;
let p2PredFacing = 0, p2PredWalk = 0;
// Last authoritative P2 position received from host (used only when standing still)
let p2AuthX: number | null = null;
let p2AuthY: number | null = null;
// Frames P2 has been stopped; correction is delayed until auth catches up
let p2StoppedFrames = 0;
// Guest-side P1 interpolation (smooth P1 between snapshots)
type P1Sample = { x: number; y: number; facing: number; walkFrame: number; t: number };
let p1Prev: P1Sample | null = null;
let p1Curr: P1Sample | null = null;
// Previous P2 network input — for rising-edge menu-nav detection on host
let _prevP2: P2InputData = { up: false, down: false, left: false, right: false, interactSeq: 0 };

// ─── Lobby state ──────────────────────────────────────────────────────────────

let unsubGlobalChat: (() => void) | null = null;
let unsubPresence:   (() => void) | null = null;
let unsubInvites:    (() => void) | null = null;
let unsubSentInvite: (() => void) | null = null;
let pendingInviteId: string | null = null;      // invite I sent
let pendingInviteLobbyId: string | null = null; // lobby I created for invite
let pendingInviteToUid: string | null = null;   // uid of the player I invited
let isMatchmaking = false;
let stopMatchwatch: (() => void) | null = null;
let receivedInvites: InviteData[] = [];         // invites I received
let onlineUsers: PresenceUser[] = [];

// ─── Menu helpers ─────────────────────────────────────────────────────────────

const menuBtns = ['tutorialBtn','startBtn','lobbyBtn'].map(id => document.getElementById(id) as HTMLButtonElement);
let menuFocusIdx = 0;

function focusMenuBtn(idx: number): void {
  menuFocusIdx = (idx + menuBtns.length) % menuBtns.length;
  menuBtns[menuFocusIdx].focus();
}

function enterFullscreenLandscape(): void {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  (window.screen.orientation as any)?.lock?.('landscape').catch(() => {});
}

function showMenu(): void {
  gs = null;
  menu.style.display = 'flex';
  touchControls.classList.remove('game-active');
  updateMenuLeaderboard();
  setTimeout(() => focusMenuBtn(0), 0);
  enterFullscreenLandscape();
  playMusic('/audio/theme.mp3');
}

function recordLevelStats(g: GameState): void {
  incrementStat('total_sales',     g.levelSales);
  incrementStat('total_food_cost', g.levelCOGS);
  incrementStat('total_labor',     g.levelLabor);
  incrementStat('total_waste',     g.levelWaste);
  const profit = Math.max(0, g.levelSales - g.levelCOGS - g.levelLabor - g.levelWaste);
  incrementStat('total_profit', profit);
  recordMaxStat('max_stage', g.level);
}

function updateLobbyXPBar(): void {
  const prof = getProfile();
  const barEl  = document.getElementById('selfXPBar');
  const lblEl  = document.getElementById('selfLevelLabel');
  const fillEl = document.getElementById('selfXPFill');
  const txtEl  = document.getElementById('selfXPText');
  if (!barEl || !lblEl || !fillEl) return;
  if (!prof) { barEl.style.display = 'none'; return; }
  barEl.style.display = 'block';
  const { current, needed, level } = xpProgress(prof.xp);
  lblEl.textContent = level >= 20 ? 'LEVEL MAX' : `LEVEL ${level}`;
  fillEl.style.width = level >= 20 ? '100%' : `${Math.round((current / needed) * 100)}%`;
  if (txtEl) {
    txtEl.textContent = level >= 20
      ? 'MAX LEVEL'
      : `${current.toLocaleString()} / ${needed.toLocaleString()} XP`;
  }
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

async function updateMenuLeaderboard(): Promise<void> {
  const list = document.getElementById('hiscores-list');
  if (!list) return;
  try {
    const entries = await loadCloudLeaderboard();
    if (entries.length > 0) {
      list.innerHTML = entries.map((e, i) =>
        `<div class="hs-row">
          <span class="hs-rank">${String(i+1).padStart(2,'0')}.</span>
          ${e.photoURL ? `<img class="hs-photo" src="${e.photoURL}" />` : ''}
          <span class="hs-name">${e.name}</span>
          <span class="hs-score">${e.score < 0 ? '-' : ''}$${(Math.abs(e.score)/100).toFixed(2)}</span>
          <span class="hs-level">LVL ${e.level}</span>
        </div>`
      ).join('');
      return;
    }
  } catch { /* fall through */ }
  const entries = loadLeaderboard('rookie');
  list.innerHTML = entries.length === 0
    ? '<div class="hs-empty">no scores yet — get cooking!</div>'
    : entries.map((e,i) =>
        `<div class="hs-row">
          <span class="hs-rank">${String(i+1).padStart(2,'0')}.</span>
          <span class="hs-name">${e.name}</span>
          <span class="hs-score">${e.score<0?'-':''}$${(Math.abs(e.score)/100).toFixed(2)}</span>
          <span class="hs-level">LVL ${e.level}</span>
        </div>`
      ).join('');
}

// ─── Name entry ───────────────────────────────────────────────────────────────

function goToNameEntry(g: GameState): void {
  lastGameWasCoop = isCoop;
  lastGameWasOnline = isOnlineGame;
  lastGameWasPro = isProMode;
  if (isOnlineGame && isOnlineHost) cleanupOnlineGame();
  recordLevelStats(g);
  flushSession().catch(console.error);
  lastGameScore = g.score; lastGameLevel = g.level;
  nameChars = ['A','A','A']; nameCursor = 0;
  screen = 'name_entry';
  // Pre-fill from Google display name if available
  if (user?.displayName) {
    const initials = user.displayName.slice(0, 3).toUpperCase().replace(/[^A-Z ]/g, 'A');
    for (let i = 0; i < 3; i++) nameChars[i] = CHARS.includes(initials[i]) ? initials[i] : 'A';
  }
  showMobileNameEntry();
}

function handleNameEntry(): void {
  if (input.menuPickUp   || input.p2MenuPickUp)   { const i = CHARS.indexOf(nameChars[nameCursor]); nameChars[nameCursor] = CHARS[(i+1)%CHARS.length]; }
  if (input.menuPickDown || input.p2MenuPickDown) { const i = CHARS.indexOf(nameChars[nameCursor]); nameChars[nameCursor] = CHARS[(i-1+CHARS.length)%CHARS.length]; }
  if ((input.menuPickRight||input.p2MenuPickRight) && nameCursor < 2) nameCursor++;
  if ((input.menuPickLeft ||input.p2MenuPickLeft)  && nameCursor > 0) nameCursor--;
  if (input.interactPressed || input.p2InteractPressed) submitName();
}

function submitName(): void {
  const name = nameChars.join('').trim() || 'AAA';
  hideMobileNameEntry();
  leaderboardMode = lastGameWasPro ? 'pro' : 'rookie';
  leaderboardEntries = saveEntry(name, lastGameScore, lastGameLevel, leaderboardMode);
  if (user) saveCloudScore(user.uid, user.displayName??'', user.photoURL??'', name, lastGameScore, lastGameLevel).catch(()=>{});
  enterLeaderboard();
}

function enterLeaderboard(): void {
  screen = 'leaderboard';
  if (leaderboardReturn !== 'menu') return;
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (isTouch) document.getElementById('lbTapHint')!.style.display = 'flex';
  playMusic('/audio/score.mp3');
}

function dismissLeaderboard(): void {
  if (screen !== 'leaderboard') return;
  document.getElementById('lbTapHint')!.style.display = 'none';
  if (leaderboardReturn === 'pause') {
    screen = 'game'; flushFrame(); requestAnimationFrame(loop);
  } else {
    showPostgameOverlay();
  }
}

function showPostgameOverlay(): void {
  const sign = lastGameScore < 0 ? '-' : '';
  document.getElementById('pgScoreDisplay')!.textContent =
    `SCORE: ${sign}$${(Math.abs(lastGameScore)/100).toFixed(2)}  ·  STAGE ${lastGameLevel}`;
  const btn = document.getElementById('pgPlayAgain')!;
  if (lastGameWasCoop && lastGameWasOnline) {
    btn.textContent = 'PLAY CO-OP AGAIN';
  } else if (lastGameWasCoop) {
    btn.textContent = 'PLAY LOCAL CO-OP AGAIN';
  } else {
    btn.textContent = 'PLAY SOLO AGAIN';
  }
  document.getElementById('pgLobby')!.style.display = lastGameWasPro ? '' : 'none';
  pgFocusIdx = 0;
  document.getElementById('postgameOverlay')!.style.display = 'flex';
  screen = 'game'; // stop leaderboard loop so loop() doesn't interfere
  requestAnimationFrame(() => (document.getElementById('pgPlayAgain') as HTMLButtonElement).focus());
}

function hidePostgameOverlay(): void {
  document.getElementById('postgameOverlay')!.style.display = 'none';
}

function showMobileNameEntry(): void {
  const el = document.getElementById('nameEntryMobile')!;
  if (!('ontouchstart' in window) && navigator.maxTouchPoints === 0) return;
  const inp = document.getElementById('neInput') as HTMLInputElement;
  inp.value = nameChars.join('').trim();
  const scoreEl = document.getElementById('neScore')!;
  const sign = lastGameScore < 0 ? '-' : '';
  scoreEl.textContent = `SCORE: ${sign}$${(Math.abs(lastGameScore)/100).toFixed(2)}`;
  el.style.display = 'flex';
  setTimeout(() => inp.focus(), 50);
}

function hideMobileNameEntry(): void {
  document.getElementById('nameEntryMobile')!.style.display = 'none';
}

// ─── Level management ─────────────────────────────────────────────────────────

function startLevel(n: number, carryScore = 0, smokerSlots?: CookSlot[], carryFailed = 0, thresholdsUnlocked = 0): void {
  if (n === 1) {
    incrementStat(isCoop ? 'coop_sessions' : 'solo_sessions', 1);
    // Small delay so the Play-button click unlocks audio before we switch tracks
    setTimeout(() => playPlaylist(GAME_TRACKS), 80);
  }
  currentLevel = n; screen = 'game'; isPaused = false;
  gs = createGame(n, carryScore, isCoop, smokerSlots, carryFailed, thresholdsUnlocked);
  menu.style.display = 'none';
  touchControls.classList.add('game-active');
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

// ─── Online co-op ─────────────────────────────────────────────────────────────

function handleP2FromNet(inp: P2InputData): void {
  if (inp.up)    keys.add('ArrowUp');    else keys.delete('ArrowUp');
  if (inp.down)  keys.add('ArrowDown');  else keys.delete('ArrowDown');
  if (inp.left)  keys.add('ArrowLeft');  else keys.delete('ArrowLeft');
  if (inp.right) keys.add('ArrowRight'); else keys.delete('ArrowRight');
  // Rising-edge detection for menu navigation (keys Set bypass doesn't fire event listeners)
  if (inp.up    && !_prevP2.up)    input.p2MenuPickUp    = true;
  if (inp.down  && !_prevP2.down)  input.p2MenuPickDown  = true;
  if (inp.left  && !_prevP2.left)  input.p2MenuPickLeft  = true;
  if (inp.right && !_prevP2.right) input.p2MenuPickRight = true;
  if (inp.interactSeq !== hostP2Seq) {
    hostP2Seq = inp.interactSeq;
    // Warp P2 to where the guest was standing when they pressed interact.
    // Without this, position drift causes nearestStation to pick the wrong station.
    if (gs?.player2 && inp.ix !== undefined) {
      gs.player2.x = inp.ix;
      gs.player2.y = inp.iy!;
    }
    input.p2InteractPressed = true;
  }
  _prevP2 = { ...inp };
}

function cleanupOnlineGame(): void {
  unsubHostLobby?.(); unsubHostLobby = null;
  if (isOnlineHost && activeLobbyId) {
    stopHostSync(activeLobbyId);
    deleteLobby(activeLobbyId).catch(()=>{});
  } else {
    stopGuestSync();
  }
  isOnlineGame = false; isOnlineHost = false; activeLobbyId = null;
  remoteGs = null; lastSentInput = null;
  p2PredX = null; p2PredY = null; p2AuthX = null; p2AuthY = null; p2StoppedFrames = 0;
  p1Prev = null; p1Curr = null;
  _prevP2 = { up: false, down: false, left: false, right: false, interactSeq: 0 };
  touchControls.classList.remove('game-active');
}

function startOnlineGame(lobbyId: string, asHost: boolean): void {
  closeLobbyScreen();
  isOnlineGame = true; isOnlineHost = asHost; activeLobbyId = lobbyId; isProMode = true;
  if (asHost) {
    isCoop = true; hostP2Seq = 0;
    startHostSync(lobbyId, () => gs, handleP2FromNet);
    startLevel(1, STARTING_MONEY);
  } else {
    incrementStat('coop_sessions', 1);
    guestInteractSeq = 0; lastSentInput = null;
    p2PredX = null; p2PredY = null; p2AuthX = null; p2AuthY = null; p2StoppedFrames = 0;
    menu.style.display = 'none';
    touchControls.classList.add('game-active');
    remoteGs = null;
    startGuestSync(lobbyId, gs => {
      remoteGs = gs;
      if (gs.player2) {
        if (p2PredX === null) {
          // First snapshot: initialise prediction from authoritative position
          p2PredX = gs.player2.x; p2PredY = gs.player2.y;
          p2PredFacing = gs.player2.facing; p2PredWalk = gs.player2.walkFrame;
        }
        // Always track the auth reference — correction applied in guestLoop only
        // when P2 is standing still, so movement is never pulled backward.
        p2AuthX = gs.player2.x; p2AuthY = gs.player2.y;
      }
      // Feed P1 interpolation: lerp from previous sample toward this one
      p1Prev = p1Curr ?? { x: gs.player.x, y: gs.player.y, facing: gs.player.facing, walkFrame: gs.player.walkFrame, t: Date.now() };
      p1Curr = { x: gs.player.x, y: gs.player.y, facing: gs.player.facing, walkFrame: gs.player.walkFrame, t: Date.now() };
    });
    // Return to menu if host disconnects
    unsubHostLobby = watchLobby(lobbyId, data => {
      if (!data) { cleanupOnlineGame(); showMenu(); }
    });
    lastTime = performance.now();
    requestAnimationFrame(guestLoop);
  }
}

function guestLoop(now: number): void {
  if (!isOnlineGame || isOnlineHost) return;
  const dt = Math.min(now - lastTime, 100);
  lastTime = now;
  let justInteracted = false;
  if (input.interactPressed) { guestInteractSeq++; justInteracted = true; }
  const inp: P2InputData = {
    up: keys.has('KeyW'), down: keys.has('KeyS'),
    left: keys.has('KeyA'), right: keys.has('KeyD'),
    interactSeq: guestInteractSeq,
    // Send interact position so host can warp P2 to the right spot
    ...(justInteracted && p2PredX !== null ? { ix: p2PredX, iy: p2PredY! } : {}),
  };
  if (!lastSentInput ||
      inp.up !== lastSentInput.up || inp.down !== lastSentInput.down ||
      inp.left !== lastSentInput.left || inp.right !== lastSentInput.right ||
      inp.interactSeq !== lastSentInput.interactSeq) {
    lastSentInput = inp; pushGuestInput(inp);
  }
  if (remoteGs) {
    let displayGs = remoteGs;

    // P1 interpolation: lerp between last two snapshots for smooth P1 movement
    if (p1Prev && p1Curr && p1Curr.t !== p1Prev.t) {
      const interval = p1Curr.t - p1Prev.t;
      const t = Math.min(1, (Date.now() - p1Curr.t) / interval);
      let df = p1Curr.facing - p1Prev.facing;
      if (df > Math.PI) df -= 2 * Math.PI; if (df < -Math.PI) df += 2 * Math.PI;
      displayGs = { ...displayGs, player: { ...displayGs.player,
        x: p1Prev.x + (p1Curr.x - p1Prev.x) * t,
        y: p1Prev.y + (p1Curr.y - p1Prev.y) * t,
        facing:    p1Prev.facing + df * t,
        walkFrame: p1Prev.walkFrame + (p1Curr.walkFrame - p1Prev.walkFrame) * t,
      }};
    }

    // P2 local prediction: advance position at 60fps so guest sees their movement instantly
    if (displayGs.player2 && p2PredX !== null) {
      if (remoteGs.activeMenu?.owner === 2) {
        // P2's cooler/freezer menu is open on host — freeze P2 in place
        p2PredWalk = 0;
      } else {
        let dx = 0, dy = 0;
        if (inp.up)    dy -= 1;
        if (inp.down)  dy += 1;
        if (inp.left)  dx -= 1;
        if (inp.right) dx += 1;
        if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }
        if (dx !== 0 || dy !== 0) { p2PredFacing = Math.atan2(dy, dx); p2PredWalk += dt / 180; }
        const spd = PLAYER_SPEED * dt / 1000;
        p2PredX = Math.max(40, Math.min(1060, p2PredX! + dx * spd));
        p2PredY = Math.max(155, Math.min(690, p2PredY! + dy * spd));
        // Apply same collision resolution as host so P2 stops cleanly at walls/stations
        const p2tmp = { x: p2PredX, y: p2PredY, radius: 18 } as any;
        resolveCollisions(p2tmp, remoteGs.stations);
        p2PredX = p2tmp.x; p2PredY = p2tmp.y;
      }
      // Only reconcile while standing still so movement is never pulled backward.
      // Wait 12 frames after stopping before correcting — gives auth position time
      // to catch up from its latency lag, preventing a backward bounce on stop.
      const isMoving = inp.up || inp.down || inp.left || inp.right;
      if (isMoving) {
        p2StoppedFrames = 0;
      } else {
        p2StoppedFrames++;
      }
      if (!isMoving && p2StoppedFrames > 12 && p2AuthX !== null) {
        const err = Math.hypot(p2PredX! - p2AuthX, p2PredY! - p2AuthY!);
        if (err > 120) {
          // Only hard-snap for extreme drift (e.g. server-side teleport / interaction)
          p2PredX = p2AuthX; p2PredY = p2AuthY!;
        } else if (err > 3) {
          p2PredX = p2PredX! + (p2AuthX - p2PredX!) * 0.1;
          p2PredY = p2PredY! + (p2AuthY! - p2PredY!) * 0.1;
        }
      }
      displayGs = { ...displayGs, player2: { ...displayGs.player2,
        x: p2PredX!, y: p2PredY!, facing: p2PredFacing, walkFrame: p2PredWalk,
      }};
    }

    try { render(displayGs); } catch (e) { console.error('[guest render]', e); }
  } else {
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0a0804'; ctx.fillRect(0, 0, GAME_W, GAME_H);
    ctx.fillStyle = '#f84'; ctx.font = 'bold 22px monospace'; ctx.textAlign = 'center';
    ctx.fillText('CONNECTING TO HOST...', GAME_W/2, GAME_H/2);
  }
  flushFrame();
  requestAnimationFrame(guestLoop);
}

// ─── Tutorial ────────────────────────────────────────────────────────────────

interface TutorialStep {
  title: string;
  sub: string;
  done?: (gs: GameState) => boolean;
  timedMs?: number;
  onEnter?: (gs: GameState) => void;
  minLevel?: number;  // step only runs/shows at this level or higher
}

const TUTORIAL_STEPS: TutorialStep[] = [
  // ── Level 1 ──────────────────────────────────────────────────────────────────
  { title: 'WELCOME!',
    sub: 'Use the arrow buttons to move around the kitchen.',
    done: () => tutorialPlayerMoved,
    timedMs: 4000 },
  { title: 'PREP TIME',
    sub: 'In a real run you get 15 seconds to prep before orders start coming in. Use it wisely!',
    timedMs: 5000 },
  { title: 'OPEN THE COOLER',
    sub: 'Walk to the blue COOLER (back wall). Tap or press SPACE to open and close.',
    done: gs => gs.activeMenu?.stationId === 'cooler' },
  { title: 'GET RAW PORK',
    sub: 'Press the corresponding arrow button on screen to select Raw Pork.',
    done: gs => gs.player.held?.food === 'raw_pork' },
  { title: 'START THE SMOKER',
    sub: 'Walk to the SMOKER (far left wall). Tap or press SPACE to place the pork.',
    done: gs => gs.stations.some(s => s.kind === 'smoker' && s.slots.some(sl => sl.food !== null)) },
  { title: 'PORK IS SMOKING!',
    sub: 'It will be ready at the start of Level 2. Now let\'s take some orders!',
    timedMs: 3000 },
  { title: 'ORDER 1: HAMBURGER',
    sub: 'Get a RAW PATTY from COOLER. Walk to GRILL (top wall). Tap or SPACE to place.',
    onEnter: gs => { gs.tutorialOrderQueue.push('Hamburger'); gs.nextOrderIn = 0; },
    done: gs => gs.stations.some(s => s.kind === 'grill' && s.slots.some(sl => sl.food !== null)) },
  { title: 'WAIT & PICK UP',
    sub: 'Green bar fills, then blinks when done. Tap or SPACE to pick up the patty.',
    done: gs => !!(gs.player.held?.food === 'patty' && !gs.player.held!.burned) },
  { title: 'PREP & DELIVER',
    sub: 'Tap/SPACE at PREP TABLE to stage. Grab the plate, walk to COUNTER to serve.',
    done: gs => gs.completed >= 1 },
  { title: 'ORDER 2: SM FRIES',
    sub: 'Walk to the FREEZER (back wall, far right). Tap or SPACE to open it.',
    onEnter: gs => { gs.tutorialOrderQueue.push('Sm Fry'); gs.nextOrderIn = 0; },
    done: gs => gs.activeMenu?.stationId === 'freezer' },
  { title: 'GRAB RAW FRIES',
    sub: 'Press the corresponding arrow button on screen to select. Walk to FRYER.',
    done: gs => gs.stations.some(s => s.kind === 'fryer' && s.slots.some(sl => sl.food !== null)) },
  { title: 'FRIES COOK FAST',
    sub: 'Pick up when blinking. Stage on PREP TABLE and deliver!',
    done: gs => gs.completed >= 2 },
  // Inject a near-spoil fry; modal shows immediately, auto-advances when it spoils (~4s)
  { title: 'HEADS UP: FOOD SPOILS!',
    sub: 'That leftover fry is going bad — watch the timer bar on the prep table!',
    onEnter: gs => {
      gs.staged = gs.staged.filter(s => s.food !== 'fries');
      gs.staged.push({ food: 'fries', spoilTimer: STAGED_SPOIL_TIME - 4000, spoiled: false, count: 1 });
    },
    done: gs => gs.staged.some(s => s.food === 'fries' && s.spoiled) },
  // Modal auto-pops when fries spoil; player must pick them up and trash them
  { title: 'FOOD SPOILED!',
    sub: 'Empty hands → PREP TABLE to pick it up → TRASH (bottom right) to discard.',
    done: gs => !gs.staged.some(s => s.food === 'fries') && !(gs.player.held?.food === 'fries' && gs.player.held?.burned) },
  { title: 'ORDER 3: CHEESEBURGER',
    sub: 'Cook a PATTY on grill. Then get CHEESE from COOLER.',
    onEnter: gs => { gs.tutorialOrderQueue.push('Cheeseburger'); gs.nextOrderIn = 0; },
    done: gs => gs.player.held?.food === 'cheese' },
  { title: 'MELT THE CHEESE',
    sub: 'Walk to a READY patty on grill. Tap or SPACE to melt cheese on it.',
    done: gs => gs.player.held?.food === 'cheese_patty' },
  { title: 'SERVE CHEESEBURGER',
    sub: 'Stage on PREP TABLE and deliver at COUNTER!',
    done: gs => gs.completed >= 3 },
  { title: 'ORDER 4: COMBO MEAL',
    sub: 'Cheeseburger + Sm Pups! Cook the cheese patty AND pups. Stage both.',
    onEnter: gs => { gs.tutorialOrderQueue.push('Cheeseburger+Sm Pup'); gs.nextOrderIn = 0; },
    done: gs => gs.completed >= 4 },
  { title: 'TIP: BURNED FOOD',
    sub: 'Red slot = burned! Grab it, walk to TRASH (bottom-right corner), drop it.',
    timedMs: 5000 },
  { title: 'CLOSING TIME!',
    sub: 'At closing time all extra food is discarded — except pork in the smoker. Clean it up!',
    onEnter: gs => { gs.levelTimer = 0; },
    done: gs => !gs.stations.some(st => st.slots.some(sl => sl.state === 'burned')) &&
                !gs.staged.some(si => si.spoiled) },
  // ── Level 2 (minLevel: 2 — blocked from running or showing during Level 1) ────
  { title: 'PORK IS READY!',
    sub: 'The pork should be finishing up soon. Walk to the SMOKER (far left) and pick it up when ready!',
    done: gs => gs.player.held?.food === 'whole_pork',
    minLevel: 2 },
  { title: 'CHOP TABLE',
    sub: 'Place on CHOP TABLE (bottom left). Tap or SPACE again to chop it up.',
    done: gs => gs.player.held?.food === 'pork',
    minLevel: 2 },
  { title: 'GET HOT DOGS READY',
    sub: 'Pick up 2 RAW HOT DOGS from COOLER. Grill them and move to the WARMER BOX. Extra pork just finished in the SMOKER too — pick it up and chop it for the BBQ Plate order!',
    onEnter: gs => {
      const smoker = gs.stations.find(s => s.kind === 'smoker');
      const empty = smoker?.slots.find(sl => sl.food === null);
      if (empty) { empty.food = 'whole_pork'; empty.state = 'done'; empty.cookTimer = 0; }
    },
    done: gs => gs.stations.some(s => s.kind === 'warmer' && s.slots.filter(sl => sl.food === 'hotdog').length >= 2),
    minLevel: 2 },
  { title: '4 ORDERS ARE IN!',
    sub: 'BBQ Sand., BBQ Plate, Hotdog+Fry, Hotdog+Pups! Start with the BBQ orders using your pulled pork.',
    onEnter: gs => { gs.tutorialOrderQueue.push('BBQ Sand.', 'BBQ Plate', 'Hotdog+Sm Fry', 'Hotdog+Sm Pup'); gs.nextOrderIn = 0; },
    done: gs => gs.completed > tutorialBaseCompleted + 1,
    minLevel: 2 },
  { title: 'FINISH THE RUSH!',
    sub: 'Grab hotdogs from the WARMER and fry the sides to complete the combos. Deliver all 4!',
    done: gs => gs.orders.length === 0 && gs.tutorialOrderQueue.length === 0,
    minLevel: 2 },
];

function tickTutorial(gs: GameState, dt: number): void {
  if (!tutorialPlayerMoved && (keys.has('KeyW') || keys.has('KeyA') || keys.has('KeyS') || keys.has('KeyD') ||
      keys.has('ArrowUp') || keys.has('ArrowDown') || keys.has('ArrowLeft') || keys.has('ArrowRight'))) {
    tutorialPlayerMoved = true;
  }
  if (tutorialModalActive) {
    if (input.interactPressed || input.p2InteractPressed) { tutorialModalActive = false; tutorialHintTimer = 0; }
    return;
  }
  if (tutorialStep >= TUTORIAL_STEPS.length) {
    // All steps done — end the level once nothing is in-flight
    if (gs.tutorialOrderQueue.length === 0 && gs.orders.length === 0 &&
        gs.plates.length === 0 && gs.staged.length === 0 && gs.phase === 'playing') {
      gs.levelTimer = 0;
    }
    return;
  }
  const step = TUTORIAL_STEPS[tutorialStep];
  // Level gate: Level 2 steps don't run or show while still in Level 1 — end Level 1 first
  if (step.minLevel && gs.level < step.minLevel) {
    if (gs.tutorialOrderQueue.length === 0 && gs.orders.length === 0 &&
        gs.plates.length === 0 && gs.staged.length === 0 && gs.phase === 'playing') {
      gs.levelTimer = 0;
    }
    return;
  }
  const advance = (): void => {
    tutorialStep++; tutorialHintTimer = 0;
    if (tutorialStep < TUTORIAL_STEPS.length) {
      const next = TUTORIAL_STEPS[tutorialStep];
      next.onEnter?.(gs);
      // Only show modal for action-required steps (not timed/informational ones)
      if (next.timedMs === undefined && (!next.minLevel || gs.level >= next.minLevel)) tutorialModalActive = true;
    }
  };
  if (step.timedMs !== undefined) {
    tutorialHintTimer += dt;
    if (tutorialHintTimer >= step.timedMs || step.done?.(gs)) advance();
  } else if (step.done?.(gs)) {
    advance();
  }
  // Suppress random order spawning — only scripted orders (via onEnter) may appear
  if (gs.tutorialOrderQueue.length === 0) gs.nextOrderIn = 9999999;
}

// ─── Main game loop ───────────────────────────────────────────────────────────

function loop(now: number): void {
  const dt = Math.min(now - lastTime, 100); lastTime = now;
  // In solo mode, Space bar acts as the primary interact key (clears p2 flag to avoid double-trigger)
  if (!isCoop && input.p2InteractPressed) { input.interactPressed = true; input.p2InteractPressed = false; }
  if (screen === 'name_entry') {
    handleNameEntry(); if (gs) render(gs); drawNameEntry(nameChars, nameCursor, lastGameScore, lastGameLevel);
    flushFrame(); requestAnimationFrame(loop); return;
  }
  if (screen === 'leaderboard') {
    if (input.interactPressed || input.p2InteractPressed) { dismissLeaderboard(); return; }
    if (gs) render(gs); drawLeaderboard(leaderboardEntries, lastGameScore, leaderboardMode);
    flushFrame(); requestAnimationFrame(loop); return;
  }
  // Post-game overlay — arrow key navigation
  if (document.getElementById('postgameOverlay')!.style.display !== 'none') {
    const pgBtns = (['pgPlayAgain', 'pgLobby', 'pgMainMenu'] as const)
      .map(id => document.getElementById(id) as HTMLButtonElement)
      .filter(btn => btn.style.display !== 'none');
    if ((input.menuPickUp || input.p2MenuPickUp) && pgBtns.length > 0) {
      pgFocusIdx = (pgFocusIdx - 1 + pgBtns.length) % pgBtns.length;
      pgBtns[pgFocusIdx].focus();
    }
    if ((input.menuPickDown || input.p2MenuPickDown) && pgBtns.length > 0) {
      pgFocusIdx = (pgFocusIdx + 1) % pgBtns.length;
      pgBtns[pgFocusIdx].focus();
    }
    if ((input.interactPressed || input.p2InteractPressed) && pgBtns.length > 0) {
      pgBtns[pgFocusIdx].click();
    }
    flushFrame(); requestAnimationFrame(loop); return;
  }
  if (!gs) return;
  if (isPaused && gs.phase === 'playing') {
    lastTime = now;
    if (pauseSubScreen === 'controls' || pauseSubScreen === 'restaurant_menu') {
      if (input.interactPressed || input.p2InteractPressed) pauseSubScreen = null;
    } else {
      if (input.menuPickUp   || input.p2MenuPickUp)   pauseMenuIdx = (pauseMenuIdx-1+5)%5;
      if (input.menuPickDown || input.p2MenuPickDown) pauseMenuIdx = (pauseMenuIdx+1)%5;
      if (input.interactPressed || input.p2InteractPressed) {
        switch (pauseMenuIdx) {
          case 0: isPaused = false; pauseSubScreen = null; break;
          case 1: isPaused = false; flushFrame(); if (isOnlineGame) cleanupOnlineGame(); showMenu(); return;
          case 2: pauseSubScreen = 'restaurant_menu'; break;
          case 3: pauseSubScreen = 'controls'; break;
          case 4: leaderboardMode = isProMode ? 'pro' : 'rookie'; leaderboardEntries = loadLeaderboard(leaderboardMode); leaderboardReturn = 'pause'; screen = 'leaderboard'; break;
        }
      }
    }
    render(gs);
    if (pauseSubScreen === 'controls') drawControlsOverlay();
    else if (pauseSubScreen === 'restaurant_menu') drawRestaurantMenu();
    else drawPauseMenu(pauseMenuIdx);
    flushFrame(); requestAnimationFrame(loop); return;
  }
  if (!(isTutorial && tutorialModalActive)) tickGame(gs, dt);
  if (isTutorial) tickTutorial(gs, dt);
  if (gs.phase === 'level_end' && (gs.levelEndTimer <= 0 || input.p2InteractPressed || input.interactPressed)) {
    recordLevelStats(gs);
    if (isTutorial && gs.level === 2) {
      isTutorial = false; tutorialStep = 0; tutorialModalActive = false;
      goToNameEntry(gs); requestAnimationFrame(loop); return;
    }
    if (gs.level < LEVELS.length) {
      const smoker = gs.stations.find(s => s.kind === 'smoker');
      startLevel(gs.level+1, gs.score, smoker?.slots.map(sl=>({...sl})), Math.max(0,gs.failed-1), gs.thresholdsUnlocked);
      if (isTutorial && gs) {
        gs.tutorialOrderQueue = [];
        gs.levelTimer = 9999999;
        tutorialBaseCompleted = gs.completed;
        TUTORIAL_STEPS[tutorialStep]?.onEnter?.(gs);
        tutorialModalActive = true;
      }
      return;
    }
    goToNameEntry(gs); requestAnimationFrame(loop); return;
  }
  if (gs.phase === 'game_over') {
    if (gs.levelEndTimer <= 0) { goToNameEntry(gs); requestAnimationFrame(loop); return; }
    render(gs);
    if (isTutorial) drawTutorialHint(tutorialStep, TUTORIAL_STEPS);
    flushFrame(); requestAnimationFrame(loop); return;
  }
  render(gs);
  if (isTutorial) {
    if (tutorialModalActive) drawTutorialModal(tutorialStep, TUTORIAL_STEPS);
    else drawTutorialHint(tutorialStep, TUTORIAL_STEPS);
  }
  flushFrame(); requestAnimationFrame(loop);
}

// ─── Lobby screen ─────────────────────────────────────────────────────────────

const lobbyScreen = document.getElementById('lobbyScreen')!;

// Mobile name entry submit
document.getElementById('neSubmit')?.addEventListener('click', () => {
  const inp = document.getElementById('neInput') as HTMLInputElement;
  const raw = inp.value.toUpperCase().replace(/[^A-Z ]/g, '').slice(0, 3).padEnd(3, 'A');
  for (let i = 0; i < 3; i++) nameChars[i] = raw[i] ?? 'A';
  submitName();
});
document.getElementById('neInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('neSubmit')?.click();
});

// Achievements overlay
function openAchievementsOverlay(): void {
  const overlay = document.getElementById('achievementsOverlay')!;
  const list    = document.getElementById('achievementsList')!;
  const prof    = getProfile();
  const ROMAN   = ['I','II','III','IV','V','VI','VII','VIII','IX','X'];
  const isDollar = (stat: string) => stat.startsWith('total_');
  const fmt = (v: number, dollar: boolean) =>
    dollar ? `$${(v / 100).toLocaleString()}` : v.toLocaleString();

  list.innerHTML = ACHIEVEMENTS.map(ach => {
    const cur    = prof?.achievements[ach.id] ?? -1;
    const stat   = prof?.stats[ach.stat] ?? 0;
    const dollar = isDollar(ach.stat);
    const maxed  = cur >= ach.tiers.length - 1;
    const nextTier = maxed ? ach.tiers[ach.tiers.length - 1] : ach.tiers[cur + 1];
    const pct    = maxed ? 100 : Math.min(100, Math.round((stat / nextTier) * 100));

    const tiers = ach.tiers.map((t, i) => {
      const unlocked = i <= cur;
      const label = t >= 100000 ? `$${(t / 100).toLocaleString()}` : t.toLocaleString();
      return `<span class="ach-tier${unlocked ? ' unlocked' : ''}" title="Tier ${ROMAN[i]}: ${label}">${ROMAN[i] ?? i + 1}</span>`;
    }).join('');

    const progressLabel = maxed
      ? 'ALL TIERS COMPLETE'
      : `${fmt(stat, dollar)} / ${fmt(nextTier, dollar)}`;

    const nextTierIndex = cur + 1;
    const descSuffix = maxed
      ? ' (All Tiers Unlocked)'
      : ` (Tier ${ROMAN[nextTierIndex] ?? nextTierIndex + 1}: ${fmt(nextTier, dollar)})`;

    return `<div class="ach-row${cur >= 0 ? ' ach-has' : ''}">
      <div class="ach-row-top">
        <span class="ach-name">${ach.name}</span>
        <div class="ach-tiers">${tiers}</div>
      </div>
      <div class="ach-desc">${ach.desc}${descSuffix}</div>
      <div class="ach-progress">
        <div class="ach-bar"><div class="ach-bar-fill" style="width:${pct}%"></div></div>
        <span class="ach-progress-text">${progressLabel}</span>
      </div>
    </div>`;
  }).join('');
  overlay.style.display = 'flex';
}

function closeAchievementsOverlay(): void {
  document.getElementById('achievementsOverlay')!.style.display = 'none';
}

document.getElementById('achievementsClose')?.addEventListener('click', closeAchievementsOverlay);
document.getElementById('lobbyAchievements')?.addEventListener('click', openAchievementsOverlay);

function openLobbyScreen(): void {
  menu.style.display = 'none';
  lobbyScreen.style.display = 'flex';
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  (window.screen.orientation as any)?.lock?.('landscape').catch(() => {});
  if (!user) {
    document.getElementById('lobbyAuthRequired')!.style.display = 'flex';
    document.getElementById('lobbyToolbar')!.style.display      = 'none';
    document.getElementById('lobbyContent')!.style.display      = 'none';
    return;
  }
  document.getElementById('lobbyAuthRequired')!.style.display = 'none';
  document.getElementById('lobbyToolbar')!.style.display      = 'flex';
  document.getElementById('lobbyContent')!.style.display      = 'flex';
  renderMatchmakingUI();

  updateLobbyXPBar();
  setPresence(user.uid, user.displayName ?? 'Player', user.photoURL ?? '');
  unsubPresence   = watchPresence(users => { onlineUsers = users; renderOnlineUsers(); });
  unsubGlobalChat = watchGlobalChat(renderGlobalChat);
  unsubInvites    = watchIncomingInvites(user.uid, handleIncomingInvites);
}

function closeLobbyScreen(): void {
  lobbyScreen.style.display = 'none';
  cancelMatchmakingFn();
  if (user) clearPresence(user.uid);
  unsubGlobalChat?.(); unsubGlobalChat = null;
  unsubPresence?.();   unsubPresence   = null;
  unsubInvites?.();    unsubInvites    = null;
  unsubSentInvite?.(); unsubSentInvite = null;
  // Cancel any pending invite we sent
  if (pendingInviteId) {
    deleteInvite(pendingInviteId).catch(()=>{});
    pendingInviteId = null;
  }
  if (pendingInviteLobbyId) {
    deleteLobby(pendingInviteLobbyId).catch(()=>{});
    pendingInviteLobbyId = null;
  }
  pendingInviteToUid = null;
}

// Online users panel
function renderOnlineUsers(): void {
  const el = document.getElementById('onlineList')!;
  const others = onlineUsers.filter(u => u.uid !== user?.uid);
  if (others.length === 0) {
    el.innerHTML = '<div class="online-empty">no one else online</div>';
  } else {
    el.innerHTML = others.map(u => {
      const isInvited = pendingInviteToUid === u.uid;
      const canInvite = !pendingInviteId;
      return `<div class="online-row">
        ${u.photo ? `<img class="online-photo" src="${u.photo}" />` : '<div class="online-photo-ph"></div>'}
        <span class="online-name">${escHtml(u.name)}</span>
        ${isInvited
          ? `<button class="cancel-invite-btn">CANCEL</button>`
          : canInvite
            ? `<button class="invite-btn" data-uid="${u.uid}" data-name="${escHtml(u.name)}">INVITE</button>`
            : ''}
      </div>`;
    }).join('');
    el.querySelectorAll('.invite-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const uid  = (btn as HTMLElement).dataset.uid!;
        const name = (btn as HTMLElement).dataset.name!;
        handleSendInvite(uid, name);
      });
    });
    el.querySelector('.cancel-invite-btn')?.addEventListener('click', handleCancelInvite);
  }
  // Also show ourselves
  if (user) {
    const me = onlineUsers.find(u => u.uid === user!.uid);
    const selfEl    = document.getElementById('onlineSelf')!;
    const selfPhoto = document.getElementById('onlineSelfPhoto') as HTMLImageElement;
    const selfName  = document.getElementById('onlineSelfName')!;
    selfEl.style.display = 'flex';
    selfPhoto.src = user.photoURL ?? '';
    selfPhoto.style.display = user.photoURL ? '' : 'none';
    selfName.textContent = me ? me.name : (user.displayName ?? '');
  }
}

// Global chat
function renderGlobalChat(msgs: GlobalChatMsg[]): void {
  const box = document.getElementById('globalChatMessages')!;
  if (msgs.length === 0) {
    box.innerHTML = '<div class="chat-empty">say something!</div>';
    return;
  }
  box.innerHTML = msgs.map(m =>
    `<div class="chat-msg ${m.uid === user?.uid ? 'chat-mine' : ''}">
      <span class="chat-name">${escHtml(m.name)}</span>
      <span class="chat-text">${escHtml(m.text)}</span>
    </div>`
  ).join('');
  box.scrollTop = box.scrollHeight;
}

async function handleGlobalSend(): Promise<void> {
  if (!user) return;
  const inp = document.getElementById('globalChatInput') as HTMLInputElement;
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  await sendGlobalMessage(user.uid, user.displayName ?? 'Player', user.photoURL ?? '', text);
}

// Invites
async function handleCancelInvite(): Promise<void> {
  unsubSentInvite?.(); unsubSentInvite = null;
  if (pendingInviteId) { deleteInvite(pendingInviteId).catch(() => {}); pendingInviteId = null; }
  if (pendingInviteLobbyId) { deleteLobby(pendingInviteLobbyId).catch(() => {}); pendingInviteLobbyId = null; }
  pendingInviteToUid = null;
  renderOnlineUsers();
}

async function handleSendInvite(toUid: string, toName: string): Promise<void> {
  if (!user || pendingInviteId) return;
  const lobbyId  = await createLobby(user.uid, user.displayName ?? 'Player', user.photoURL ?? '');
  const inviteId = await sendInvite(user.uid, user.displayName ?? 'Player', user.photoURL ?? '', toUid, lobbyId);
  pendingInviteId      = inviteId;
  pendingInviteLobbyId = lobbyId;
  pendingInviteToUid   = toUid;
  renderOnlineUsers(); // update buttons to show CANCEL

  // Watch for response
  unsubSentInvite?.();
  unsubSentInvite = watchSentInvite(inviteId, invite => {
    if (!invite || invite.status === 'declined') {
      // Declined or deleted
      pendingInviteId = null; pendingInviteToUid = null;
      if (pendingInviteLobbyId) { deleteLobby(pendingInviteLobbyId).catch(()=>{}); pendingInviteLobbyId = null; }
      unsubSentInvite?.(); unsubSentInvite = null;
      renderOnlineUsers();
      showInviteBanner(null);
    } else if (invite.status === 'accepted') {
      // Guest accepted — watch the lobby for 'starting'
      unsubSentInvite?.(); unsubSentInvite = null;
      unsubHostLobby?.();
      unsubHostLobby = watchLobby(invite.lobbyId, data => {
        if (data?.status === 'starting') {
          unsubHostLobby?.(); unsubHostLobby = null;
          pendingInviteId = null; pendingInviteLobbyId = null; pendingInviteToUid = null;
          startOnlineGame(invite.lobbyId, true);
        }
      });
    }
  });
}

function handleIncomingInvites(invites: InviteData[]): void {
  receivedInvites = invites;
  showInviteBanner(invites[0] ?? null);
}

function showInviteBanner(invite: InviteData | null): void {
  const banner = document.getElementById('inviteBanner')!;
  if (!invite) { banner.style.display = 'none'; return; }
  banner.style.display = 'flex';
  document.getElementById('inviteText')!.textContent =
    `🍖 ${invite.fromName} wants to cook with you!`;
  document.getElementById('inviteAcceptBtn')!.onclick  = () => handleAcceptInvite(invite);
  document.getElementById('inviteDeclineBtn')!.onclick = () => handleDeclineInvite(invite);
}

async function handleAcceptInvite(invite: InviteData): Promise<void> {
  if (!user) return;
  showInviteBanner(null);
  const ok = await joinLobby(invite.lobbyId, user.uid, user.displayName ?? 'Player', user.photoURL ?? '');
  if (!ok) return;
  await respondToInvite(invite.id, 'accepted');
  await setLobbyStatus(invite.lobbyId, 'starting');
  startOnlineGame(invite.lobbyId, false);
}

async function handleDeclineInvite(invite: InviteData): Promise<void> {
  showInviteBanner(null);
  await respondToInvite(invite.id, 'declined');
}

// ─── Matchmaking ─────────────────────────────────────────────────────────────

function renderMatchmakingUI(): void {
  document.getElementById('lobbyActions')!.style.display      = isMatchmaking ? 'none' : 'flex';
  document.getElementById('matchmakingStatus')!.style.display = isMatchmaking ? 'flex' : 'none';
}

async function startMatchmakingFn(): Promise<void> {
  if (!user || isMatchmaking) return;
  isMatchmaking = true;
  renderMatchmakingUI();
  try {
    const claimed = await seekMatch(user.uid, user.displayName ?? 'Player', user.photoURL ?? '');
    if (!isMatchmaking) return; // cancelled during async await
    if (claimed) {
      // We claimed a waiting player — we're the host
      const lobbyId = await createLobby(user.uid, user.displayName ?? 'Player', user.photoURL ?? '');
      await notifyMatch(claimed.uid, lobbyId);
      isMatchmaking = false;
      startOnlineGame(lobbyId, true);
    } else {
      // We're now waiting in the queue — watch for host to notify us
      stopMatchwatch = watchForMatch(user.uid, lobbyId => {
        isMatchmaking = false;
        stopMatchwatch = null;
        startOnlineGame(lobbyId, false);
      });
    }
  } catch {
    isMatchmaking = false;
    renderMatchmakingUI();
  }
}

function cancelMatchmakingFn(): void {
  if (!isMatchmaking) return;
  isMatchmaking = false;
  stopMatchwatch?.(); stopMatchwatch = null;
  if (user) leaveMatchmaking(user.uid);
  renderMatchmakingUI();
}

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Wire up lobby buttons ────────────────────────────────────────────────────

document.getElementById('lobbyBack')!.addEventListener('click', () => { closeLobbyScreen(); showMenu(); });
document.getElementById('lobbySignIn')!.addEventListener('click', () =>
  signInWithGoogle().then(() => openLobbyScreen()).catch(console.error));

// Show iOS hint in the auth-required section for Safari users
if (/Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)) {
  const hint = document.getElementById('iosHint');
  if (hint) hint.style.display = 'block';
}
document.getElementById('globalChatSend')!.addEventListener('click', handleGlobalSend);
document.getElementById('globalChatInput')!.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleGlobalSend();
});
document.getElementById('lobbyPlaySolo')!.addEventListener('click', () => {
  closeLobbyScreen(); isCoop = false; isProMode = true; startLevel(1, STARTING_MONEY);
});
document.getElementById('lobbyPlayCoop')!.addEventListener('click', startMatchmakingFn);
document.getElementById('cancelMatchmakingBtn')!.addEventListener('click', cancelMatchmakingFn);

// ─── Post-game overlay buttons ────────────────────────────────────────────────

document.getElementById('lbTapHint')!.addEventListener('click', dismissLeaderboard);
document.getElementById('pgMainMenu')!.addEventListener('click', () => {
  hidePostgameOverlay(); showMenu();
});
document.getElementById('pgLobby')!.addEventListener('click', () => {
  hidePostgameOverlay(); openLobbyScreen();
});
document.getElementById('pgPlayAgain')!.addEventListener('click', () => {
  hidePostgameOverlay();
  if (lastGameWasCoop && lastGameWasOnline) {
    openLobbyScreen();
  } else {
    isCoop = lastGameWasCoop;
    startLevel(1, STARTING_MONEY);
  }
});

// ─── Menu buttons ─────────────────────────────────────────────────────────────

document.getElementById('tutorialBtn')!.addEventListener('click', () => {
  isCoop = false; isTutorial = true; tutorialStep = 0; tutorialHintTimer = 0;
  tutorialPlayerMoved = false; tutorialBaseCompleted = 0; tutorialModalActive = false;
  startLevel(1, STARTING_MONEY);
  if (gs) { gs.tutorialOrderQueue = []; gs.levelTimer = 9999999; TUTORIAL_STEPS[0]?.onEnter?.(gs); }
  // Flush interact flags so the click/keypress that opened this screen doesn't dismiss the first modal
  input.interactPressed = false; input.p2InteractPressed = false;
});
document.getElementById('startBtn')!.addEventListener('click', () => { isCoop = false; isTutorial = false; isProMode = false; startLevel(1, STARTING_MONEY); });
document.getElementById('lobbyBtn')!.addEventListener('click', openLobbyScreen);

function toggleFullscreen(): void {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(()=>{});
  else document.exitFullscreen().catch(()=>{});
}

window.addEventListener('keydown', e => {
  if (e.repeat) return;
  { const s = document.getElementById('splashScreen'); if (s && s.style.display !== 'none') { s.style.display = 'none'; showMenu(); return; } }
  if (e.code === 'KeyF') toggleFullscreen();
  if (e.code === 'KeyP' && screen === 'game' && gs?.phase === 'playing') {
    isPaused = !isPaused;
    if (isPaused) { pauseMenuIdx = 0; pauseSubScreen = null; } else pauseSubScreen = null;
  }
  if (menu.style.display === 'none') return;
  if (e.code === 'ArrowLeft'  || e.code === 'ArrowUp')   { e.preventDefault(); focusMenuBtn(menuFocusIdx-1); }
  if (e.code === 'ArrowRight' || e.code === 'ArrowDown') { e.preventDefault(); focusMenuBtn(menuFocusIdx+1); }
  if (e.code === 'Space' || e.code === 'Enter')          { e.preventDefault(); menuBtns[menuFocusIdx].click(); }
});

// ── Splash screen ─────────────────────────────────────────────────────────────
const splashEl = document.getElementById('splashScreen')!;
menu.style.display = 'none';

function dismissSplash(): void {
  if (splashEl.style.display === 'none') return;
  splashEl.style.display = 'none';
  showMenu(); // showMenu() handles fullscreen + landscape
}

splashEl.addEventListener('click', dismissSplash);
// Use touchend + preventDefault to avoid tap-through onto menu buttons below
splashEl.addEventListener('touchend', (e) => { e.preventDefault(); dismissSplash(); });

playMusic('/audio/theme.mp3');

window.addEventListener('beforeunload', () => {
  if (user) clearPresence(user.uid);
});
