import { initInput, flushFrame, input, virtualKeyDown, virtualKeyUp, keys } from './input';
import { createGame, tickGame } from './game';
import { initRenderer, render, resizeRenderer, drawNameEntry, drawLeaderboard, drawPauseMenu, drawControlsOverlay } from './renderer';
import type { GameState, CookSlot } from './types';
import { LEVELS, STARTING_MONEY } from './config';
import { loadLeaderboard, saveEntry, type LeaderboardEntry } from './leaderboard';
import { initAuth, signInWithGoogle, signOutUser } from './auth';
import type { User } from 'firebase/auth';
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
  type P2InputData, type PresenceUser,
} from './netplay';

// ─── Canvas setup ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
const menu   = document.getElementById('menu')!;
const GAME_W = 1183, GAME_H = 680;
canvas.width = GAME_W; canvas.height = GAME_H;
resizeRenderer(canvas);
initInput();
initRenderer(canvas);

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

initAuth(u => {
  user = u;
  updateAuthUI();
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
  } else {
    authOut.style.display = 'flex'; authIn.style.display = 'none';
  }
}

document.getElementById('signInBtn')!.addEventListener('click', () => signInWithGoogle().catch(console.error));
document.getElementById('signOutBtn')!.addEventListener('click', () => signOutUser().catch(console.error));

// ─── Game state ───────────────────────────────────────────────────────────────

let gs: GameState | null = null;
let currentLevel = 1;
let lastTime = 0;
let isCoop = false;

type Screen = 'game' | 'name_entry' | 'leaderboard';
let screen: Screen = 'game';
let isPaused = false, pauseMenuIdx = 0;
let pauseSubScreen: 'controls' | null = null;
let leaderboardReturn: 'menu' | 'pause' = 'menu';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ';
let nameChars = ['A','A','A'], nameCursor = 0;
let leaderboardEntries: LeaderboardEntry[] = [];
let lastGameScore = 0, lastGameLevel = 1;

// ─── Online co-op state ───────────────────────────────────────────────────────

let isOnlineGame = false, isOnlineHost = false;
let activeLobbyId: string | null = null;
let remoteGs: GameState | null = null;
let guestInteractSeq = 0, hostP2Seq = 0;
let lastSentInput: P2InputData | null = null;
let unsubHostLobby: (() => void) | null = null;

// ─── Lobby state ──────────────────────────────────────────────────────────────

let unsubGlobalChat: (() => void) | null = null;
let unsubPresence:   (() => void) | null = null;
let unsubInvites:    (() => void) | null = null;
let unsubSentInvite: (() => void) | null = null;
let pendingInviteId: string | null = null;      // invite I sent
let pendingInviteLobbyId: string | null = null; // lobby I created for invite
let receivedInvites: InviteData[] = [];         // invites I received
let onlineUsers: PresenceUser[] = [];

// ─── Menu helpers ─────────────────────────────────────────────────────────────

const menuBtns = ['startBtn','coopBtn','lobbyBtn','fsBtn'].map(id => document.getElementById(id) as HTMLButtonElement);
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
  const entries = loadLeaderboard();
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
  if (isOnlineGame && isOnlineHost) cleanupOnlineGame();
  lastGameScore = g.score; lastGameLevel = g.level;
  nameChars = ['A','A','A']; nameCursor = 0;
  screen = 'name_entry';
}

function handleNameEntry(): void {
  if (input.menuPickUp   || input.p2MenuPickUp)   { const i = CHARS.indexOf(nameChars[nameCursor]); nameChars[nameCursor] = CHARS[(i+1)%CHARS.length]; }
  if (input.menuPickDown || input.p2MenuPickDown) { const i = CHARS.indexOf(nameChars[nameCursor]); nameChars[nameCursor] = CHARS[(i-1+CHARS.length)%CHARS.length]; }
  if ((input.menuPickRight||input.p2MenuPickRight) && nameCursor < 2) nameCursor++;
  if ((input.menuPickLeft ||input.p2MenuPickLeft)  && nameCursor > 0) nameCursor--;
  if (input.interactPressed || input.p2InteractPressed) {
    const name = nameChars.join('').trim() || 'AAA';
    leaderboardEntries = saveEntry(name, lastGameScore, lastGameLevel);
    if (user) saveCloudScore(user.uid, user.displayName??'', user.photoURL??'', name, lastGameScore, lastGameLevel).catch(()=>{});
    screen = 'leaderboard';
  }
}

// ─── Level management ─────────────────────────────────────────────────────────

function startLevel(n: number, carryScore = 0, smokerSlots?: CookSlot[], carryFailed = 0, thresholdsUnlocked = 0): void {
  currentLevel = n; screen = 'game'; isPaused = false;
  gs = createGame(n, carryScore, isCoop, smokerSlots, carryFailed, thresholdsUnlocked);
  menu.style.display = 'none';
  touchControls.classList.add('game-active');
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

// ─── Online co-op ─────────────────────────────────────────────────────────────

function handleP2FromNet(inp: P2InputData): void {
  if (inp.up) keys.add('ArrowUp'); else keys.delete('ArrowUp');
  if (inp.down) keys.add('ArrowDown'); else keys.delete('ArrowDown');
  if (inp.left) keys.add('ArrowLeft'); else keys.delete('ArrowLeft');
  if (inp.right) keys.add('ArrowRight'); else keys.delete('ArrowRight');
  if (inp.interactSeq !== hostP2Seq) { hostP2Seq = inp.interactSeq; input.p2InteractPressed = true; }
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
  touchControls.classList.remove('game-active');
}

function startOnlineGame(lobbyId: string, asHost: boolean): void {
  closeLobbyScreen();
  isOnlineGame = true; isOnlineHost = asHost; activeLobbyId = lobbyId;
  if (asHost) {
    isCoop = true; hostP2Seq = 0;
    startHostSync(lobbyId, () => gs, handleP2FromNet);
    startLevel(1, STARTING_MONEY);
  } else {
    guestInteractSeq = 0; lastSentInput = null;
    menu.style.display = 'none';
    touchControls.classList.add('game-active');
    remoteGs = null;
    startGuestSync(lobbyId, gs => { remoteGs = gs; });
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
  lastTime = now;
  if (input.restartPressed) { cleanupOnlineGame(); flushFrame(); showMenu(); return; }
  if (input.interactPressed) guestInteractSeq++;
  const inp: P2InputData = {
    up: keys.has('KeyW'), down: keys.has('KeyS'),
    left: keys.has('KeyA'), right: keys.has('KeyD'),
    interactSeq: guestInteractSeq,
  };
  if (!lastSentInput ||
      inp.up !== lastSentInput.up || inp.down !== lastSentInput.down ||
      inp.left !== lastSentInput.left || inp.right !== lastSentInput.right ||
      inp.interactSeq !== lastSentInput.interactSeq) {
    lastSentInput = inp; pushGuestInput(inp);
  }
  if (remoteGs) {
    render(remoteGs);
  } else {
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0a0804'; ctx.fillRect(0, 0, GAME_W, GAME_H);
    ctx.fillStyle = '#f84'; ctx.font = 'bold 22px monospace'; ctx.textAlign = 'center';
    ctx.fillText('CONNECTING TO HOST...', GAME_W/2, GAME_H/2);
  }
  flushFrame();
  requestAnimationFrame(guestLoop);
}

// ─── Main game loop ───────────────────────────────────────────────────────────

function loop(now: number): void {
  const dt = Math.min(now - lastTime, 100); lastTime = now;
  if (input.restartPressed) {
    if (isOnlineGame) cleanupOnlineGame();
    flushFrame(); screen = 'game'; showMenu(); return;
  }
  if (screen === 'name_entry') {
    handleNameEntry(); if (gs) render(gs); drawNameEntry(nameChars, nameCursor, lastGameScore, lastGameLevel);
    flushFrame(); requestAnimationFrame(loop); return;
  }
  if (screen === 'leaderboard') {
    if (input.interactPressed || input.p2InteractPressed) {
      screen = 'game'; flushFrame();
      if (leaderboardReturn === 'pause') requestAnimationFrame(loop); else showMenu();
      return;
    }
    if (gs) render(gs); drawLeaderboard(leaderboardEntries, lastGameScore);
    flushFrame(); requestAnimationFrame(loop); return;
  }
  if (!gs) return;
  if (isPaused && gs.phase === 'playing') {
    lastTime = now;
    if (pauseSubScreen === 'controls') {
      if (input.interactPressed || input.p2InteractPressed) pauseSubScreen = null;
    } else {
      if (input.menuPickUp   || input.p2MenuPickUp)   pauseMenuIdx = (pauseMenuIdx-1+5)%5;
      if (input.menuPickDown || input.p2MenuPickDown) pauseMenuIdx = (pauseMenuIdx+1)%5;
      if (input.interactPressed || input.p2InteractPressed) {
        switch (pauseMenuIdx) {
          case 0: isPaused = false; pauseSubScreen = null; break;
          case 1: case 2: isPaused = false; flushFrame(); if (isOnlineGame) cleanupOnlineGame(); showMenu(); return;
          case 3: pauseSubScreen = 'controls'; break;
          case 4: leaderboardEntries = loadLeaderboard(); leaderboardReturn = 'pause'; screen = 'leaderboard'; break;
        }
      }
    }
    render(gs);
    if (pauseSubScreen === 'controls') drawControlsOverlay(); else drawPauseMenu(pauseMenuIdx);
    flushFrame(); requestAnimationFrame(loop); return;
  }
  tickGame(gs, dt);
  if (gs.phase === 'level_end' && (gs.levelEndTimer <= 0 || input.p2InteractPressed || input.interactPressed)) {
    if (gs.level < LEVELS.length) {
      const smoker = gs.stations.find(s => s.kind === 'smoker');
      startLevel(gs.level+1, gs.score, smoker?.slots.map(sl=>({...sl})), Math.max(0,gs.failed-1), gs.thresholdsUnlocked);
      return;
    }
    goToNameEntry(gs); requestAnimationFrame(loop); return;
  }
  if (gs.phase === 'game_over') {
    if (gs.levelEndTimer <= 0) { goToNameEntry(gs); requestAnimationFrame(loop); return; }
    render(gs); flushFrame(); requestAnimationFrame(loop); return;
  }
  render(gs); flushFrame(); requestAnimationFrame(loop);
}

// ─── Lobby screen ─────────────────────────────────────────────────────────────

const lobbyScreen = document.getElementById('lobbyScreen')!;

function openLobbyScreen(): void {
  menu.style.display = 'none';
  lobbyScreen.style.display = 'flex';
  if (!user) {
    document.getElementById('lobbyAuthRequired')!.style.display = 'flex';
    document.getElementById('lobbyContent')!.style.display      = 'none';
    return;
  }
  document.getElementById('lobbyAuthRequired')!.style.display = 'none';
  document.getElementById('lobbyContent')!.style.display      = 'flex';

  setPresence(user.uid, user.displayName ?? 'Player', user.photoURL ?? '');
  unsubPresence   = watchPresence(users => { onlineUsers = users; renderOnlineUsers(); });
  unsubGlobalChat = watchGlobalChat(renderGlobalChat);
  unsubInvites    = watchIncomingInvites(user.uid, handleIncomingInvites);
}

function closeLobbyScreen(): void {
  lobbyScreen.style.display = 'none';
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
}

// Online users panel
function renderOnlineUsers(): void {
  const el = document.getElementById('onlineList')!;
  const others = onlineUsers.filter(u => u.uid !== user?.uid);
  if (others.length === 0) {
    el.innerHTML = '<div class="online-empty">no one else online</div>';
  } else {
    el.innerHTML = others.map(u => {
      const canInvite = !pendingInviteId;
      return `<div class="online-row">
        ${u.photo ? `<img class="online-photo" src="${u.photo}" />` : '<div class="online-photo-ph"></div>'}
        <span class="online-name">${escHtml(u.name)}</span>
        ${canInvite
          ? `<button class="invite-btn" data-uid="${u.uid}" data-name="${escHtml(u.name)}">INVITE</button>`
          : pendingInviteId ? '<span class="invite-waiting">waiting...</span>' : ''}
      </div>`;
    }).join('');
    el.querySelectorAll('.invite-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const uid  = (btn as HTMLElement).dataset.uid!;
        const name = (btn as HTMLElement).dataset.name!;
        handleSendInvite(uid, name);
      });
    });
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
async function handleSendInvite(toUid: string, toName: string): Promise<void> {
  if (!user || pendingInviteId) return;
  const lobbyId  = await createLobby(user.uid, user.displayName ?? 'Player', user.photoURL ?? '');
  const inviteId = await sendInvite(user.uid, user.displayName ?? 'Player', user.photoURL ?? '', toUid, lobbyId);
  pendingInviteId      = inviteId;
  pendingInviteLobbyId = lobbyId;
  renderOnlineUsers(); // update buttons to show "waiting..."

  // Watch for response
  unsubSentInvite?.();
  unsubSentInvite = watchSentInvite(inviteId, invite => {
    if (!invite || invite.status === 'declined') {
      // Declined or deleted
      pendingInviteId = null;
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
          pendingInviteId = null; pendingInviteLobbyId = null;
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

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Wire up lobby buttons ────────────────────────────────────────────────────

document.getElementById('lobbyBack')!.addEventListener('click', () => { closeLobbyScreen(); showMenu(); });
document.getElementById('lobbySignIn')!.addEventListener('click', () =>
  signInWithGoogle().then(() => openLobbyScreen()).catch(console.error));
document.getElementById('globalChatSend')!.addEventListener('click', handleGlobalSend);
document.getElementById('globalChatInput')!.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleGlobalSend();
});

// ─── Menu buttons ─────────────────────────────────────────────────────────────

document.getElementById('startBtn')!.addEventListener('click', () => { isCoop = false; startLevel(1, STARTING_MONEY); });
document.getElementById('coopBtn')!.addEventListener('click', () => { isCoop = true;  startLevel(1, STARTING_MONEY); });
document.getElementById('lobbyBtn')!.addEventListener('click', openLobbyScreen);

function toggleFullscreen(): void {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(()=>{});
  else document.exitFullscreen().catch(()=>{});
}
document.getElementById('fsBtn')!.addEventListener('click', toggleFullscreen);

window.addEventListener('keydown', e => {
  if (e.repeat) return;
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

updateMenuLeaderboard();
setTimeout(() => focusMenuBtn(0), 0);
