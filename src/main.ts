import { initInput, flushFrame, input, virtualKeyDown, virtualKeyUp, keys } from './input';
import { createGame, tickGame } from './game';
import { initRenderer, render, resizeRenderer, drawNameEntry, drawLeaderboard, drawPauseMenu, drawControlsOverlay } from './renderer';
import type { GameState, CookSlot } from './types';
import { LEVELS, STARTING_MONEY } from './config';
import { loadLeaderboard, saveEntry, type LeaderboardEntry } from './leaderboard';
import { initAuth, signInWithGoogle, signOutUser, type currentUser as _cu } from './auth';
import type { User } from 'firebase/auth';
import { saveCloudScore, loadCloudLeaderboard, createLobby, joinLobby, leaveLobby, deleteLobby, setLobbyStatus, watchLobbies, watchLobby, sendMessage, watchMessages, type LobbyData, type ChatMessage } from './cloud';
import { startHostSync, stopHostSync, startGuestSync, stopGuestSync, pushGuestInput, type P2InputData } from './netplay';

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
const menu   = document.getElementById('menu')!;

const GAME_W = 1183, GAME_H = 680;
canvas.width  = GAME_W;
canvas.height = GAME_H;
resizeRenderer(canvas);
initInput();
initRenderer(canvas);

// ─── Touch controls ───────────────────────────────────────────────────────────

const touchControls = document.getElementById('touchControls')!;

function initTouchControls(): void {
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (!isTouch) return;
  touchControls.classList.add('touch-visible');

  function bindKey(id: string, code: string): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', e => { e.preventDefault(); virtualKeyDown(code); }, { passive: false });
    el.addEventListener('touchend',   e => { e.preventDefault(); virtualKeyUp(code); },   { passive: false });
    el.addEventListener('touchcancel',e => { e.preventDefault(); virtualKeyUp(code); },   { passive: false });
  }

  bindKey('dUp', 'KeyW'); bindKey('dDown', 'KeyS');
  bindKey('dLeft', 'KeyA'); bindKey('dRight', 'KeyD');
  bindKey('dInteract', 'KeyE');

  document.getElementById('dPause')?.addEventListener('touchstart', e => {
    e.preventDefault();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true }));
  }, { passive: false });
}
initTouchControls();

// ─── Auth state ───────────────────────────────────────────────────────────────

let user: User | null = null;

initAuth(u => {
  user = u;
  updateAuthUI();
  updateMenuLeaderboard();
});

function updateAuthUI(): void {
  const authOut = document.getElementById('authOut')!;
  const authIn  = document.getElementById('authIn')!;
  if (user) {
    authOut.style.display = 'none';
    authIn.style.display  = 'flex';
    const photo = document.getElementById('userPhoto') as HTMLImageElement;
    const name  = document.getElementById('userName')!;
    photo.src    = user.photoURL ?? '';
    photo.style.display = user.photoURL ? 'block' : 'none';
    name.textContent = user.displayName ?? user.email ?? '';
  } else {
    authOut.style.display = 'flex';
    authIn.style.display  = 'none';
  }
}

document.getElementById('signInBtn')!.addEventListener('click', () => signInWithGoogle().catch(console.error));
document.getElementById('signOutBtn')!.addEventListener('click', () => signOutUser().catch(console.error));

// ─── App state ────────────────────────────────────────────────────────────────

let gs: GameState | null = null;
let currentLevel = 1;
let lastTime = 0;
let isCoop = false;

type Screen = 'game' | 'name_entry' | 'leaderboard';
let screen: Screen = 'game';
let isPaused = false;
let pauseMenuIdx = 0;
let pauseSubScreen: 'controls' | null = null;
let leaderboardReturn: 'menu' | 'pause' = 'menu';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ';
let nameChars = ['A', 'A', 'A'];
let nameCursor = 0;
let leaderboardEntries: LeaderboardEntry[] = [];
let lastGameScore = 0;
let lastGameLevel = 1;

// ─── Online co-op state ───────────────────────────────────────────────────────

let isOnlineGame  = false;
let isOnlineHost  = false;
let activeLobbyId: string | null = null;
let remoteGs: GameState | null = null;
let guestInteractSeq = 0;
let hostP2Seq = 0;
let lastSentInput: P2InputData | null = null;

// ─── Lobby state ──────────────────────────────────────────────────────────────

let myLobbyId: string | null = null;
let unsubLobbies: (() => void) | null = null;
let unsubMyLobby: (() => void) | null = null;
let unsubMessages: (() => void) | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const menuBtns = ['startBtn', 'coopBtn', 'lobbyBtn', 'fsBtn']
  .map(id => document.getElementById(id) as HTMLButtonElement);
let menuFocusIdx = 0;

function focusMenuBtn(idx: number): void {
  menuFocusIdx = (idx + menuBtns.length) % menuBtns.length;
  menuBtns[menuFocusIdx].focus();
}

function showMenu(): void {
  gs = null;
  menu.style.display = 'flex';
  touchControls.classList.remove('game-active');
  updateMenuLeaderboard();
  setTimeout(() => focusMenuBtn(0), 0);
}

function goToNameEntry(g: GameState): void {
  if (isOnlineGame && isOnlineHost) cleanupOnlineGame();
  lastGameScore = g.score;
  lastGameLevel = g.level;
  nameChars = ['A', 'A', 'A'];
  nameCursor = 0;
  screen = 'name_entry';
}

function handleNameEntry(): void {
  if (input.menuPickUp   || input.p2MenuPickUp) {
    const idx = CHARS.indexOf(nameChars[nameCursor]);
    nameChars[nameCursor] = CHARS[(idx + 1) % CHARS.length];
  }
  if (input.menuPickDown || input.p2MenuPickDown) {
    const idx = CHARS.indexOf(nameChars[nameCursor]);
    nameChars[nameCursor] = CHARS[(idx - 1 + CHARS.length) % CHARS.length];
  }
  if ((input.menuPickRight || input.p2MenuPickRight) && nameCursor < 2) nameCursor++;
  if ((input.menuPickLeft  || input.p2MenuPickLeft)  && nameCursor > 0) nameCursor--;
  if (input.interactPressed || input.p2InteractPressed) {
    const name = nameChars.join('').trim() || 'AAA';
    leaderboardEntries = saveEntry(name, lastGameScore, lastGameLevel);
    if (user) {
      saveCloudScore(user.uid, user.displayName ?? '', user.photoURL ?? '', name, lastGameScore, lastGameLevel)
        .catch(() => {});
    }
    screen = 'leaderboard';
  }
}

async function updateMenuLeaderboard(): Promise<void> {
  const list = document.getElementById('hiscores-list');
  if (!list) return;

  try {
    const entries = await loadCloudLeaderboard();
    if (entries.length > 0) {
      list.innerHTML = entries.map((e, i) =>
        `<div class="hs-row">
          <span class="hs-rank">${String(i + 1).padStart(2, '0')}.</span>
          ${e.photoURL ? `<img class="hs-photo" src="${e.photoURL}" />` : ''}
          <span class="hs-name">${e.name}</span>
          <span class="hs-score">${e.score < 0 ? '-' : ''}$${(Math.abs(e.score) / 100).toFixed(2)}</span>
          <span class="hs-level">LVL ${e.level}</span>
        </div>`
      ).join('');
      return;
    }
  } catch { /* fall through */ }

  const entries = loadLeaderboard();
  if (entries.length === 0) {
    list.innerHTML = '<div class="hs-empty">no scores yet — get cooking!</div>';
    return;
  }
  list.innerHTML = entries.map((e, i) =>
    `<div class="hs-row">
      <span class="hs-rank">${String(i + 1).padStart(2, '0')}.</span>
      <span class="hs-name">${e.name}</span>
      <span class="hs-score">${e.score < 0 ? '-' : ''}$${(Math.abs(e.score) / 100).toFixed(2)}</span>
      <span class="hs-level">LVL ${e.level}</span>
    </div>`
  ).join('');
}

// ─── Level management ─────────────────────────────────────────────────────────

function startLevel(n: number, carryScore = 0, smokerSlots?: CookSlot[], carryFailed = 0, thresholdsUnlocked = 0): void {
  currentLevel = n;
  screen = 'game';
  isPaused = false;
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
  if (inp.interactSeq !== hostP2Seq) {
    hostP2Seq = inp.interactSeq;
    input.p2InteractPressed = true;
  }
}

function cleanupOnlineGame(): void {
  if (isOnlineHost && activeLobbyId) {
    stopHostSync(activeLobbyId);
    deleteLobby(activeLobbyId).catch(() => {});
  } else {
    stopGuestSync();
  }
  if (unsubMyLobby) { unsubMyLobby(); unsubMyLobby = null; }
  isOnlineGame  = false;
  isOnlineHost  = false;
  activeLobbyId = null;
  remoteGs      = null;
  lastSentInput = null;
  myLobbyId     = null;
  touchControls.classList.remove('game-active');
}

function startOnlineGame(lobbyId: string, asHost: boolean): void {
  hideLobbyScreen();
  isOnlineGame  = true;
  isOnlineHost  = asHost;
  activeLobbyId = lobbyId;

  if (asHost) {
    isCoop = true;
    hostP2Seq = 0;
    startHostSync(lobbyId, () => gs, handleP2FromNet);
    startLevel(1, STARTING_MONEY);
  } else {
    // Guest: render state from host, send inputs
    guestInteractSeq = 0;
    lastSentInput    = null;
    menu.style.display = 'none';
    touchControls.classList.add('game-active');
    remoteGs = null;

    startGuestSync(lobbyId, receivedGs => { remoteGs = receivedGs; });

    // If host disconnects, return to menu
    unsubMyLobby = watchLobby(lobbyId, data => {
      if (!data) { cleanupOnlineGame(); showMenu(); }
    });

    lastTime = performance.now();
    requestAnimationFrame(guestLoop);
  }
}

// Guest game loop — renders host's state, sends P2 inputs
function guestLoop(now: number): void {
  if (!isOnlineGame || isOnlineHost) return;

  lastTime = now;

  if (input.restartPressed) {
    cleanupOnlineGame();
    flushFrame();
    showMenu();
    return;
  }

  // Build and send P2 input
  if (input.interactPressed) guestInteractSeq++;
  const inp: P2InputData = {
    up:    keys.has('KeyW'),
    down:  keys.has('KeyS'),
    left:  keys.has('KeyA'),
    right: keys.has('KeyD'),
    interactSeq: guestInteractSeq,
  };
  if (!lastSentInput ||
      inp.up !== lastSentInput.up || inp.down !== lastSentInput.down ||
      inp.left !== lastSentInput.left || inp.right !== lastSentInput.right ||
      inp.interactSeq !== lastSentInput.interactSeq) {
    lastSentInput = inp;
    pushGuestInput(inp);
  }

  if (remoteGs) {
    render(remoteGs);
  } else {
    // Waiting for first state from host
    const ctx = (canvas as any).getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = '#0a0804';
    ctx.fillRect(0, 0, GAME_W, GAME_H);
    ctx.fillStyle = '#f84';
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('CONNECTING TO HOST...', GAME_W / 2, GAME_H / 2);
  }

  flushFrame();
  requestAnimationFrame(guestLoop);
}

// ─── Main game loop ───────────────────────────────────────────────────────────

function loop(now: number): void {
  const dt = Math.min(now - lastTime, 100);
  lastTime = now;

  if (input.restartPressed) {
    if (isOnlineGame) cleanupOnlineGame();
    flushFrame();
    screen = 'game';
    showMenu();
    return;
  }

  if (screen === 'name_entry') {
    handleNameEntry();
    if (gs) render(gs);
    drawNameEntry(nameChars, nameCursor, lastGameScore, lastGameLevel);
    flushFrame();
    requestAnimationFrame(loop);
    return;
  }

  if (screen === 'leaderboard') {
    if (input.interactPressed || input.p2InteractPressed) {
      screen = 'game';
      flushFrame();
      if (leaderboardReturn === 'pause') {
        requestAnimationFrame(loop);
      } else {
        showMenu();
      }
      return;
    }
    if (gs) render(gs);
    drawLeaderboard(leaderboardEntries, lastGameScore);
    flushFrame();
    requestAnimationFrame(loop);
    return;
  }

  if (!gs) return;

  if (isPaused && gs.phase === 'playing') {
    lastTime = now;
    if (pauseSubScreen === 'controls') {
      if (input.interactPressed || input.p2InteractPressed) pauseSubScreen = null;
    } else {
      if (input.menuPickUp   || input.p2MenuPickUp)   pauseMenuIdx = (pauseMenuIdx - 1 + 5) % 5;
      if (input.menuPickDown || input.p2MenuPickDown) pauseMenuIdx = (pauseMenuIdx + 1) % 5;
      if (input.interactPressed || input.p2InteractPressed) {
        switch (pauseMenuIdx) {
          case 0: isPaused = false; pauseSubScreen = null; break;
          case 1: isPaused = false; flushFrame(); if (isOnlineGame) cleanupOnlineGame(); showMenu(); return;
          case 2: isPaused = false; flushFrame(); if (isOnlineGame) cleanupOnlineGame(); showMenu(); return;
          case 3: pauseSubScreen = 'controls'; break;
          case 4:
            leaderboardEntries = loadLeaderboard();
            leaderboardReturn = 'pause';
            screen = 'leaderboard';
            break;
        }
      }
    }
    render(gs);
    if (pauseSubScreen === 'controls') drawControlsOverlay();
    else drawPauseMenu(pauseMenuIdx);
    flushFrame();
    requestAnimationFrame(loop);
    return;
  }

  tickGame(gs, dt);

  if (gs.phase === 'level_end' && (gs.levelEndTimer <= 0 || input.p2InteractPressed || input.interactPressed)) {
    if (gs.level < LEVELS.length) {
      const smoker = gs.stations.find(s => s.kind === 'smoker');
      const smokerSlots = smoker?.slots.map(sl => ({ ...sl }));
      startLevel(gs.level + 1, gs.score, smokerSlots, Math.max(0, gs.failed - 1), gs.thresholdsUnlocked);
      return;
    }
    goToNameEntry(gs);
    requestAnimationFrame(loop);
    return;
  }

  if (gs.phase === 'game_over') {
    if (gs.levelEndTimer <= 0) {
      goToNameEntry(gs);
      requestAnimationFrame(loop);
      return;
    }
    render(gs);
    flushFrame();
    requestAnimationFrame(loop);
    return;
  }

  render(gs);
  flushFrame();
  requestAnimationFrame(loop);
}

// ─── Lobby screen ─────────────────────────────────────────────────────────────

const lobbyScreen = document.getElementById('lobbyScreen')!;

function showLobbyScreen(): void {
  if (!user) {
    document.getElementById('lobbyAuthRequired')!.style.display = 'flex';
    document.getElementById('lobbyContent')!.style.display = 'none';
  } else {
    document.getElementById('lobbyAuthRequired')!.style.display = 'none';
    document.getElementById('lobbyContent')!.style.display = 'flex';
    subscribeLobbies();
    subscribeGlobalChat();
  }
  menu.style.display = 'none';
  lobbyScreen.style.display = 'flex';
}

function hideLobbyScreen(): void {
  lobbyScreen.style.display = 'none';
  unsubLobbies?.();  unsubLobbies  = null;
  unsubMessages?.(); unsubMessages = null;
}

function subscribeLobbies(): void {
  unsubLobbies?.();
  unsubLobbies = watchLobbies(renderLobbyList);
}

function subscribeGlobalChat(): void {
  // Chat is per-lobby when in one; when browsing, show placeholder
  renderChat([]);
}

function subscribeChat(lobbyId: string): void {
  unsubMessages?.();
  unsubMessages = watchMessages(lobbyId, renderChat);
}

function renderLobbyList(lobbies: LobbyData[]): void {
  const list = document.getElementById('lobbyList')!;
  const open = lobbies.filter(l => l.status === 'waiting');
  if (open.length === 0) {
    list.innerHTML = '<div class="lobby-empty">no open lobbies</div>';
    return;
  }
  list.innerHTML = open.map(l => {
    const isMe = l.hostUid === user?.uid || l.guestUid === user?.uid;
    const full  = !!l.guestUid;
    return `<div class="lobby-row ${full ? 'lobby-full' : ''}">
      <img class="lobby-photo" src="${l.hostPhoto || ''}" />
      <span class="lobby-host-name">${l.hostName}'s lobby</span>
      <span class="lobby-guests">${l.guestUid ? '2/2' : '1/2'}</span>
      ${!isMe && !full ? `<button class="lobby-join-btn" data-id="${l.id}">JOIN</button>` : ''}
      ${isMe ? '<span class="lobby-badge">YOU</span>' : ''}
    </div>`;
  }).join('');

  list.querySelectorAll('.lobby-join-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id!;
      handleJoinLobby(id);
    });
  });
}

async function handleCreateLobby(): Promise<void> {
  if (!user || myLobbyId) return;
  const id = await createLobby(user.uid, user.displayName ?? 'Player', user.photoURL ?? '');
  myLobbyId = id;
  enterMyLobby(id);
}

async function handleJoinLobby(lobbyId: string): Promise<void> {
  if (!user || myLobbyId) return;
  const ok = await joinLobby(lobbyId, user.uid, user.displayName ?? 'Player', user.photoURL ?? '');
  if (ok) { myLobbyId = lobbyId; enterMyLobby(lobbyId); }
}

function enterMyLobby(lobbyId: string): void {
  document.getElementById('lobbyListPane')!.style.display  = 'none';
  document.getElementById('myLobbyPane')!.style.display    = 'flex';
  subscribeChat(lobbyId);

  unsubMyLobby?.();
  unsubMyLobby = watchLobby(lobbyId, data => {
    if (!data) {
      // Lobby was deleted
      myLobbyId = null;
      document.getElementById('myLobbyPane')!.style.display   = 'none';
      document.getElementById('lobbyListPane')!.style.display  = 'flex';
      unsubMyLobby?.(); unsubMyLobby = null;
      subscribeLobbies();
      renderChat([]);
      return;
    }
    renderMyLobby(data);
  });
}

function renderMyLobby(data: LobbyData): void {
  const players = document.getElementById('lobbyPlayersList')!;
  const startBtn = document.getElementById('startOnlineBtn') as HTMLButtonElement;
  const isHost = data.hostUid === user?.uid;

  players.innerHTML = `
    <div class="lobby-player-row">
      <img class="lobby-photo" src="${data.hostPhoto || ''}" />
      <span>👑 ${data.hostName}</span>
    </div>
    <div class="lobby-player-row">
      ${data.guestUid
        ? `<img class="lobby-photo" src="${data.guestPhoto || ''}" /><span>👤 ${data.guestName}</span>`
        : '<span class="waiting-text">waiting for player 2...</span>'}
    </div>
  `;

  startBtn.style.display = (isHost && data.guestUid) ? 'block' : 'none';

  // Detect game start signal
  if (data.status === 'starting') {
    unsubMyLobby?.(); unsubMyLobby = null;
    startOnlineGame(data.id, isHost);
  }
}

async function handleLeaveLobby(): Promise<void> {
  if (!user || !myLobbyId) return;
  await leaveLobby(myLobbyId, user.uid);
  myLobbyId = null;
  unsubMyLobby?.(); unsubMyLobby = null;
  unsubMessages?.(); unsubMessages = null;
  document.getElementById('myLobbyPane')!.style.display   = 'none';
  document.getElementById('lobbyListPane')!.style.display  = 'flex';
  subscribeLobbies();
  renderChat([]);
}

async function handleStartOnline(): Promise<void> {
  if (!user || !myLobbyId) return;
  await setLobbyStatus(myLobbyId, 'starting');
}

function renderChat(msgs: ChatMessage[]): void {
  const box = document.getElementById('chatMessages')!;
  if (msgs.length === 0) {
    box.innerHTML = '<div class="chat-empty">join a lobby to chat</div>';
    return;
  }
  box.innerHTML = msgs.map(m =>
    `<div class="chat-msg ${m.uid === user?.uid ? 'chat-mine' : ''}">
      <span class="chat-name">${m.name}:</span>
      <span class="chat-text">${escapeHtml(m.text)}</span>
    </div>`
  ).join('');
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handleSendMessage(): Promise<void> {
  if (!user || !myLobbyId) return;
  const input_el = document.getElementById('chatText') as HTMLInputElement;
  const text = input_el.value.trim();
  if (!text) return;
  input_el.value = '';
  await sendMessage(myLobbyId, user.uid, user.displayName ?? 'Player', text);
}

// Wire lobby buttons
document.getElementById('lobbyBack')!.addEventListener('click', () => {
  hideLobbyScreen();
  showMenu();
});
document.getElementById('createLobbyBtn')!.addEventListener('click', handleCreateLobby);
document.getElementById('leaveLobbyBtn')!.addEventListener('click', handleLeaveLobby);
document.getElementById('startOnlineBtn')!.addEventListener('click', handleStartOnline);
document.getElementById('chatSend')!.addEventListener('click', handleSendMessage);
document.getElementById('chatText')!.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleSendMessage();
});
document.getElementById('lobbySignIn')!.addEventListener('click', () => signInWithGoogle().then(() => showLobbyScreen()).catch(console.error));

// ─── Menu buttons ─────────────────────────────────────────────────────────────

document.getElementById('startBtn')!.addEventListener('click', () => { isCoop = false; startLevel(1, STARTING_MONEY); });
document.getElementById('coopBtn')!.addEventListener('click', () => { isCoop = true;  startLevel(1, STARTING_MONEY); });
document.getElementById('lobbyBtn')!.addEventListener('click', showLobbyScreen);

function toggleFullscreen(): void {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}
document.getElementById('fsBtn')!.addEventListener('click', toggleFullscreen);

window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.code === 'KeyF') toggleFullscreen();
  if (e.code === 'KeyP' && screen === 'game' && gs?.phase === 'playing') {
    isPaused = !isPaused;
    if (isPaused) { pauseMenuIdx = 0; pauseSubScreen = null; }
    else pauseSubScreen = null;
  }
  if (menu.style.display === 'none') return;
  if (e.code === 'ArrowLeft' || e.code === 'ArrowUp')    { e.preventDefault(); focusMenuBtn(menuFocusIdx - 1); }
  if (e.code === 'ArrowRight' || e.code === 'ArrowDown') { e.preventDefault(); focusMenuBtn(menuFocusIdx + 1); }
  if (e.code === 'Space' || e.code === 'Enter')          { e.preventDefault(); menuBtns[menuFocusIdx].click(); }
});

updateMenuLeaderboard();
setTimeout(() => focusMenuBtn(0), 0);
