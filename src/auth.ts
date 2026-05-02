import { GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged, type User } from 'firebase/auth';
import { auth } from './firebase';

const provider = new GoogleAuthProvider();

// Safari (including iOS) blocks the cross-origin auth iframe Firebase uses for
// token sharing, so signInWithPopup silently fails to authenticate RTDB.
// Use redirect flow instead, which stores the token on the app's own origin.
function needsRedirect(): boolean {
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/Chrome/.test(ua) && !/Chromium/.test(ua);
}

export let currentUser: User | null = null;

export function initAuth(onChange: (u: User | null) => void): void {
  onAuthStateChanged(auth, u => {
    currentUser = u;
    onChange(u);
  });
}

export function signInWithGoogle(): Promise<void> {
  if (needsRedirect()) {
    sessionStorage.setItem('kbbq_pendingLobby', '1');
    return signInWithRedirect(auth, provider);
  }
  return signInWithPopup(auth, provider).then(() => {});
}

// Call once on app load to finalize any pending redirect sign-in.
// Returns true if we just came back from a redirect-based sign-in.
export async function checkRedirectResult(): Promise<boolean> {
  try {
    const result = await getRedirectResult(auth);
    return result !== null;
  } catch (e) {
    console.warn('[auth] redirect result error', e);
    return false;
  }
}

export function signOutUser(): Promise<void> {
  return signOut(auth);
}
