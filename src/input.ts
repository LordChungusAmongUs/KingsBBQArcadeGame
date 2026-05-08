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

export const wasdDash  = { dx: 0, dy: 0, active: false };
export const arrowDash = { dx: 0, dy: 0, active: false };

export const input = {
  interactPressed: false,
  interactHeld: false,
  spacePressed: false,  // raw Space press, unambiguous (not shared with network P2 signal)

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
    if (e.code === 'Space') { input.p2InteractPressed = true; input.spacePressed = true; }
    if (e.code === 'ArrowUp')    input.p2MenuPickUp    = true;
    if (e.code === 'ArrowLeft')  input.p2MenuPickLeft  = true;
    if (e.code === 'ArrowRight') input.p2MenuPickRight = true;
    if (e.code === 'ArrowDown')  input.p2MenuPickDown  = true;

    // Dash: check BEFORE updating press time so tap-duration uses the PREVIOUS press.
    // (Updating press time first would make the tap-duration check always near-zero.)
    const _t = Date.now();
    if (e.code === 'KeyW'       && _t - _wasdRel.up    < DASH_WIN && _wasdRel.up    - wasdPressTime.up    < MAX_TAP_MS) { wasdDash.dx=0;  wasdDash.dy=-1; wasdDash.active=true; }
    if (e.code === 'KeyS'       && _t - _wasdRel.down  < DASH_WIN && _wasdRel.down  - wasdPressTime.down  < MAX_TAP_MS) { wasdDash.dx=0;  wasdDash.dy=1;  wasdDash.active=true; }
    if (e.code === 'KeyA'       && _t - _wasdRel.left  < DASH_WIN && _wasdRel.left  - wasdPressTime.left  < MAX_TAP_MS) { wasdDash.dx=-1; wasdDash.dy=0;  wasdDash.active=true; }
    if (e.code === 'KeyD'       && _t - _wasdRel.right < DASH_WIN && _wasdRel.right - wasdPressTime.right < MAX_TAP_MS) { wasdDash.dx=1;  wasdDash.dy=0;  wasdDash.active=true; }
    if (e.code === 'ArrowUp'    && _t - _arrowRel.up    < DASH_WIN && _arrowRel.up    - arrowPressTime.up    < MAX_TAP_MS) { arrowDash.dx=0;  arrowDash.dy=-1; arrowDash.active=true; }
    if (e.code === 'ArrowDown'  && _t - _arrowRel.down  < DASH_WIN && _arrowRel.down  - arrowPressTime.down  < MAX_TAP_MS) { arrowDash.dx=0;  arrowDash.dy=1;  arrowDash.active=true; }
    if (e.code === 'ArrowLeft'  && _t - _arrowRel.left  < DASH_WIN && _arrowRel.left  - arrowPressTime.left  < MAX_TAP_MS) { arrowDash.dx=-1; arrowDash.dy=0;  arrowDash.active=true; }
    if (e.code === 'ArrowRight' && _t - _arrowRel.right < DASH_WIN && _arrowRel.right - arrowPressTime.right < MAX_TAP_MS) { arrowDash.dx=1;  arrowDash.dy=0;  arrowDash.active=true; }

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
    if (e.code === 'KeyE') _interactDown = false;
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

  input.menuPickUp      = false;
  input.menuPickLeft    = false;
  input.menuPickRight   = false;
  input.menuPickDown    = false;
  input.interactHeld    = _interactDown;
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
