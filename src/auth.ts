import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, type User } from 'firebase/auth';
import { auth } from './firebase';

const provider = new GoogleAuthProvider();

export let currentUser: User | null = null;

export function initAuth(onChange: (u: User | null) => void): void {
  onAuthStateChanged(auth, u => {
    currentUser = u;
    onChange(u);
  });
}

export function signInWithGoogle(): Promise<void> {
  return signInWithPopup(auth, provider).then(() => {});
}

export function signOutUser(): Promise<void> {
  return signOut(auth);
}
