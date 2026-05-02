// ─── Music system ─────────────────────────────────────────────────────────────
// HTML Audio for music (streams well for long tracks).
// Browsers block autoplay until first user gesture — we queue and retry.

const _music = new Audio();
_music.volume = 0.5;

let _pendingTrack: string | null = null;
let _unlocked = false;
let _playlist: string[] = [];
let _playlistIdx = 0;
let _isPlaylist = false;

_music.addEventListener('ended', () => {
  if (_isPlaylist && _playlist.length > 0) {
    _playlistIdx = (_playlistIdx + 1) % _playlist.length;
    _loadAndPlay(_playlist[_playlistIdx]);
  }
});

function _loadAndPlay(src: string): void {
  _music.src = src;
  _music.currentTime = 0;
  _music.play().then(() => {
    _unlocked = true;
    _pendingTrack = null;
  }).catch(() => {
    // Autoplay still blocked; will retry on next gesture
  });
}

function _tryPlay(): void {
  if (!_pendingTrack) return;
  _loadAndPlay(_pendingTrack);
}

// Call once at app start to register the first-gesture unlock
export function initAudio(): void {
  const unlock = () => { if (_pendingTrack && !_unlocked) _tryPlay(); };
  document.addEventListener('click',      unlock);
  document.addEventListener('keydown',    unlock);
  document.addEventListener('touchstart', unlock);
}

// Play a single looping track (menu / score screen)
export function playMusic(src: string): void {
  _isPlaylist = false;
  _music.loop = true;
  if (!_music.paused && _music.src.endsWith(src)) return;
  _pendingTrack = src;
  _tryPlay();
}

// Play a shuffled playlist that auto-advances (in-game tracks)
export function playPlaylist(tracks: string[]): void {
  if (!tracks.length) return;
  _isPlaylist = true;
  _music.loop = false;
  _playlist = tracks.slice();
  for (let i = _playlist.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [_playlist[i], _playlist[j]] = [_playlist[j], _playlist[i]];
  }
  _playlistIdx = 0;
  _pendingTrack = _playlist[0];
  _tryPlay();
}

export function stopMusic(): void {
  _isPlaylist = false;
  _pendingTrack = null;
  _music.pause();
  _music.currentTime = 0;
}

export function setMusicVolume(v: number): void {
  _music.volume = Math.max(0, Math.min(1, v));
}
