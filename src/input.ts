export const keys: Set<string> = new Set();

// Dash detection — event-level (reliable; not frame-by-frame)
// Rule: press → release (tap < MAX_TAP_MS) → re-press within DASH_WIN → dash.
// Press timestamps are exported so game.ts can use them for moonwalk detection.
export const wasdPressTime  = { up: 0, down: 0, left: 0, right: 0 };
export const arrowPressTime = { up: 0, down: 0, left: 0, right: 0 };
const _wasdRel  = { up: 0, down: 0, left: 0, right: 0 };
const _arrowRel = { up: 0, down: 0, left: 0, right: 0 };
const DASH_WIN   = 80;   // ms: max gap between release and re-press
const MAX_TAP_MS = 150;  // ms: first press must be this short to count as a tap
const DDASH_WIN  = 400;  // ms window after a dash ends to allow double-dash

export const wasdDash  = { dx: 0, dy: 0, active: false };
export const arrowDash = { dx: 0, dy: 0, active: false };

// Double-dash: game.ts calls notifyDashEnd when a dash completes; the next
// keydown in the same direction within DDASH_WIN fires another dash.
export const dashEnded = [
  { dx: 0, dy: 0, t: 0 },  // P1
  { dx: 0, dy: 0, t: 0 },  // P2
];
export function notifyDashEnd(pNum: 0 | 1, dx: number, dy: number): void {
  dashEnded[pNum] = { dx, dy, t: Date.now() };
}

// Jump state (ShiftLeft = P1, ShiftRight = P2)
export const jumpPressed = { p1: false, p2: false };
let _jump1Down = false, _jump2Down = false;
export function isJump1Held(): boolean { return _jump1Down; }
export function isJump2Held(): boolean { return _jump2Down; }

export const input = {
  interactPressed: false,
  interactHeld: false,
  spacePressed: false,

  menuPickUp:    false,
  menuPickLeft:  false,
  menuPickRight: false,
  menuPickDown:  false,
  // Player 2 (P=up, L=left, ;=down, '=right, [=interact)
  p2InteractPressed: false,
  p2MenuPickUp:    false,
  p2MenuPickLeft:  false,
  p2MenuPickRight: false,
  p2MenuPickDown:  false,
  // Players 3 & 4 — always remote (online co-op), set by net handlers
  p3InteractPressed: false,
  p3MenuPickUp: false, p3MenuPickLeft: false, p3MenuPickRight: false, p3MenuPickDown: false,
  p4InteractPressed: false,
  p4MenuPickUp: false, p4MenuPickLeft: false, p4MenuPickRight: false, p4MenuPickDown: false,
};

let _interactDown = false;
let _spaceDown = false;

export function initInput(): void {
  window.addEventListener('keydown', e => {
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'KeyE') {
      _interactDown = true;
      input.interactPressed = true;
    }

    if (e.code === 'KeyW' || e.code === 'ArrowUp')    input.menuPickUp    = true;
    if (e.code === 'KeyA' || e.code === 'ArrowLeft')  input.menuPickLeft  = true;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') input.menuPickRight = true;
    if (e.code === 'KeyS' || e.code === 'ArrowDown')  input.menuPickDown  = true;
    // P2
    if (e.code === 'Space') { _spaceDown = true; input.interactPressed = true; input.p2InteractPressed = true; input.spacePressed = true; }
    if (e.code === 'ArrowUp')    input.p2MenuPickUp    = true;
    if (e.code === 'ArrowLeft')  input.p2MenuPickLeft  = true;
    if (e.code === 'ArrowRight') input.p2MenuPickRight = true;
    if (e.code === 'ArrowDown')  input.p2MenuPickDown  = true;

    // Jump keys
    if (e.code === 'ShiftLeft')  { _jump1Down = true; jumpPressed.p1 = true; }
    if (e.code === 'ShiftRight') { _jump2Down = true; jumpPressed.p2 = true; }

    // Dash: check BEFORE updating press time so tap-duration uses the PREVIOUS press.
    const _t = Date.now();
    if (e.code === 'KeyW'       && _t - _wasdRel.up    < DASH_WIN && _wasdRel.up    - wasdPressTime.up    < MAX_TAP_MS) { wasdDash.dx=0;  wasdDash.dy=-1; wasdDash.active=true; }
    if (e.code === 'KeyS'       && _t - _wasdRel.down  < DASH_WIN && _wasdRel.down  - wasdPressTime.down  < MAX_TAP_MS) { wasdDash.dx=0;  wasdDash.dy=1;  wasdDash.active=true; }
    if (e.code === 'KeyA'       && _t - _wasdRel.left  < DASH_WIN && _wasdRel.left  - wasdPressTime.left  < MAX_TAP_MS) { wasdDash.dx=-1; wasdDash.dy=0;  wasdDash.active=true; }
    if (e.code === 'KeyD'       && _t - _wasdRel.right < DASH_WIN && _wasdRel.right - wasdPressTime.right < MAX_TAP_MS) { wasdDash.dx=1;  wasdDash.dy=0;  wasdDash.active=true; }
    if (e.code === 'ArrowUp'    && _t - _arrowRel.up    < DASH_WIN && _arrowRel.up    - arrowPressTime.up    < MAX_TAP_MS) { arrowDash.dx=0;  arrowDash.dy=-1; arrowDash.active=true; }
    if (e.code === 'ArrowDown'  && _t - _arrowRel.down  < DASH_WIN && _arrowRel.down  - arrowPressTime.down  < MAX_TAP_MS) { arrowDash.dx=0;  arrowDash.dy=1;  arrowDash.active=true; }
    if (e.code === 'ArrowLeft'  && _t - _arrowRel.left  < DASH_WIN && _arrowRel.left  - arrowPressTime.left  < MAX_TAP_MS) { arrowDash.dx=-1; arrowDash.dy=0;  arrowDash.active=true; }
    if (e.code === 'ArrowRight' && _t - _arrowRel.right < DASH_WIN && _arrowRel.right - arrowPressTime.right < MAX_TAP_MS) { arrowDash.dx=1;  arrowDash.dy=0;  arrowDash.active=true; }

    // Double-dash: fires when a dash recently ended in this direction
    if (e.code === 'KeyW'       && dashEnded[0].dy < 0 && _t - dashEnded[0].t < DDASH_WIN) { wasdDash.dx=0;  wasdDash.dy=-1; wasdDash.active=true; dashEnded[0].t=0; }
    if (e.code === 'KeyS'       && dashEnded[0].dy > 0 && _t - dashEnded[0].t < DDASH_WIN) { wasdDash.dx=0;  wasdDash.dy=1;  wasdDash.active=true; dashEnded[0].t=0; }
    if (e.code === 'KeyA'       && dashEnded[0].dx < 0 && _t - dashEnded[0].t < DDASH_WIN) { wasdDash.dx=-1; wasdDash.dy=0;  wasdDash.active=true; dashEnded[0].t=0; }
    if (e.code === 'KeyD'       && dashEnded[0].dx > 0 && _t - dashEnded[0].t < DDASH_WIN) { wasdDash.dx=1;  wasdDash.dy=0;  wasdDash.active=true; dashEnded[0].t=0; }
    if (e.code === 'ArrowUp'    && dashEnded[1].dy < 0 && _t - dashEnded[1].t < DDASH_WIN) { arrowDash.dx=0;  arrowDash.dy=-1; arrowDash.active=true; dashEnded[1].t=0; }
    if (e.code === 'ArrowDown'  && dashEnded[1].dy > 0 && _t - dashEnded[1].t < DDASH_WIN) { arrowDash.dx=0;  arrowDash.dy=1;  arrowDash.active=true; dashEnded[1].t=0; }
    if (e.code === 'ArrowLeft'  && dashEnded[1].dx < 0 && _t - dashEnded[1].t < DDASH_WIN) { arrowDash.dx=-1; arrowDash.dy=0;  arrowDash.active=true; dashEnded[1].t=0; }
    if (e.code === 'ArrowRight' && dashEnded[1].dx > 0 && _t - dashEnded[1].t < DDASH_WIN) { arrowDash.dx=1;  arrowDash.dy=0;  arrowDash.active=true; dashEnded[1].t=0; }

    // Update press times AFTER dash check
    if (e.code === 'KeyW')       wasdPressTime.up    = _t;
    if (e.code === 'KeyS')       wasdPressTime.down  = _t;
    if (e.code === 'KeyA')       wasdPressTime.left  = _t;
    if (e.code === 'KeyD')       wasdPressTime.right = _t;
    if (e.code === 'ArrowUp')    arrowPressTime.up    = _t;
    if (e.code === 'ArrowDown')  arrowPressTime.down  = _t;
    if (e.code === 'ArrowLeft')  arrowPressTime.left  = _t;
    if (e.code === 'ArrowRight') arrowPressTime.right = _t;
  });
  window.addEventListener('keyup', e => {
    keys.delete(e.code);
    if (e.code === 'KeyE')       _interactDown = false;
    if (e.code === 'Space')      _spaceDown    = false;
    if (e.code === 'ShiftLeft')  _jump1Down    = false;
    if (e.code === 'ShiftRight') _jump2Down    = false;
    const _t = Date.now();
    if (e.code === 'KeyW')       _wasdRel.up    = _t;
    if (e.code === 'KeyS')       _wasdRel.down  = _t;
    if (e.code === 'KeyA')       _wasdRel.left  = _t;
    if (e.code === 'KeyD')       _wasdRel.right = _t;
    if (e.code === 'ArrowUp')    _arrowRel.up    = _t;
    if (e.code === 'ArrowDown')  _arrowRel.down  = _t;
    if (e.code === 'ArrowLeft')  _arrowRel.left  = _t;
    if (e.code === 'ArrowRight') _arrowRel.right = _t;
  });
}

export function virtualKeyDown(code: string): void {
  if (keys.has(code)) return;
  keys.add(code);
  if (code === 'KeyE') { _interactDown = true; input.interactPressed = true; }
  if (code === 'KeyW' || code === 'ArrowUp')    input.menuPickUp    = true;
  if (code === 'KeyA' || code === 'ArrowLeft')  input.menuPickLeft  = true;
  if (code === 'KeyD' || code === 'ArrowRight') input.menuPickRight = true;
  if (code === 'KeyS' || code === 'ArrowDown')  input.menuPickDown  = true;
  if (code === 'Space') { input.p2InteractPressed = true; input.spacePressed = true; }
}

export function virtualKeyUp(code: string): void {
  keys.delete(code);
  if (code === 'KeyE') _interactDown = false;
}

export function flushFrame(): void {
  input.interactPressed = false;
  input.spacePressed    = false;
  wasdDash.active  = false;
  arrowDash.active = false;
  jumpPressed.p1   = false;
  jumpPressed.p2   = false;

  input.menuPickUp      = false;
  input.menuPickLeft    = false;
  input.menuPickRight   = false;
  input.menuPickDown    = false;
  input.interactHeld    = _interactDown || _spaceDown;
  input.p2InteractPressed = false;
  input.p2MenuPickUp    = false;
  input.p2MenuPickLeft  = false;
  input.p2MenuPickRight = false;
  input.p2MenuPickDown  = false;
  input.p3InteractPressed = false;
  input.p3MenuPickUp = false; input.p3MenuPickLeft = false; input.p3MenuPickRight = false; input.p3MenuPickDown = false;
  input.p4InteractPressed = false;
  input.p4MenuPickUp = false; input.p4MenuPickLeft = false; input.p4MenuPickRight = false; input.p4MenuPickDown = false;
}
