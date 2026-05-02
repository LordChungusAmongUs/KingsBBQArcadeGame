// ─── Music player ─────────────────────────────────────────────────────────────
// Uses an HTML Audio element for music (good for long looping tracks).
// Browsers block autoplay until first user gesture — we retry on interaction.

const _music = new Audio();
_music.loop = true;
_music.volume = 0.5;

let _pendingTrack: string | null = null;
let _unlocked = false;

function _tryPlay(): void {
  if (!_pendingTrack) return;
  _music.src = _pendingTrack;
  _music.play().then(() => {
    _unlocked = true;
    _pendingTrack = null;
  }).catch(() => {
    // Still blocked — will retry on next user gesture
  });
}

// Call once at app start to hook the first-gesture unlock
export function initAudio(): void {
  const unlock = () => {
    if (_pendingTrack && !_unlocked) _tryPlay();
  };
  document.addEventListener('click',   unlock, { once: false });
  document.addEventListener('keydown', unlock, { once: false });
  document.addEventListener('touchstart', unlock, { once: false });
}

export function playMusic(src: string): void {
  // Already playing this track — do nothing
  if (!_music.paused && _music.src.endsWith(src)) return;
  _pendingTrack = src;
  _tryPlay();
}

export function stopMusic(): void {
  _pendingTrack = null;
  _music.pause();
  _music.currentTime = 0;
}

export function pauseMusic(): void {
  _music.pause();
}

export function resumeMusic(src?: string): void {
  if (src) playMusic(src);
  else _music.play().catch(() => {});
}

export function setMusicVolume(v: number): void {
  _music.volume = Math.max(0, Math.min(1, v));
}
