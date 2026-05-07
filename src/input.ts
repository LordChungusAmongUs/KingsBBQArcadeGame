export const keys: Set<string> = new Set();
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
  });
  window.addEventListener('keyup', e => {
    keys.delete(e.code);
    if (e.code === 'KeyE') _interactDown = false;
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
