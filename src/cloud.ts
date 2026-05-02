import {
  collection, addDoc, doc, getDoc, getDocs, updateDoc, deleteDoc,
  query, orderBy, limit, onSnapshot, serverTimestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';

// ── Leaderboard ──────────────────────────────────────────────────────────────

export interface CloudEntry {
  uid: string;
  displayName: string;
  photoURL: string;
  name: string;
  score: number;
  level: number;
}

export async function saveCloudScore(
  uid: string, displayName: string, photoURL: string,
  name: string, score: number, level: number,
): Promise<void> {
  await addDoc(collection(db, 'scores'), {
    uid, displayName, photoURL, name, score, level, timestamp: serverTimestamp(),
  });
}

export async function loadCloudLeaderboard(): Promise<CloudEntry[]> {
  const q = query(collection(db, 'scores'), orderBy('score', 'desc'), limit(10));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data() as CloudEntry);
}

// ── Lobbies ──────────────────────────────────────────────────────────────────

export interface LobbyData {
  id: string;
  hostUid: string;
  hostName: string;
  hostPhoto: string;
  guestUid: string | null;
  guestName: string | null;
  guestPhoto: string | null;
  status: 'waiting' | 'starting' | 'closed';
}

export async function createLobby(uid: string, name: string, photo: string): Promise<string> {
  const ref = await addDoc(collection(db, 'lobbies'), {
    hostUid: uid, hostName: name, hostPhoto: photo,
    guestUid: null, guestName: null, guestPhoto: null,
    status: 'waiting', createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function joinLobby(lobbyId: string, uid: string, name: string, photo: string): Promise<boolean> {
  const ref = doc(db, 'lobbies', lobbyId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return false;
  const data = snap.data() as LobbyData;
  if (data.hostUid === uid || data.guestUid || data.status !== 'waiting') return false;
  await updateDoc(ref, { guestUid: uid, guestName: name, guestPhoto: photo });
  return true;
}

export async function leaveLobby(lobbyId: string, uid: string): Promise<void> {
  const ref = doc(db, 'lobbies', lobbyId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data() as LobbyData;
  if (data.hostUid === uid) {
    await deleteDoc(ref);
  } else {
    await updateDoc(ref, { guestUid: null, guestName: null, guestPhoto: null });
  }
}

export async function deleteLobby(lobbyId: string): Promise<void> {
  await deleteDoc(doc(db, 'lobbies', lobbyId));
}

export async function setLobbyStatus(lobbyId: string, status: 'waiting' | 'starting' | 'closed'): Promise<void> {
  await updateDoc(doc(db, 'lobbies', lobbyId), { status });
}

export function watchLobbies(cb: (lobbies: LobbyData[]) => void): Unsubscribe {
  const q = query(collection(db, 'lobbies'), orderBy('createdAt', 'desc'), limit(20));
  return onSnapshot(q, snap => {
    cb(snap.docs
      .map(d => ({ id: d.id, ...d.data() } as LobbyData))
      .filter(l => l.status !== 'closed'));
  });
}

export function watchLobby(lobbyId: string, cb: (data: LobbyData | null) => void): Unsubscribe {
  return onSnapshot(doc(db, 'lobbies', lobbyId), snap => {
    cb(snap.exists() ? ({ id: snap.id, ...snap.data() } as LobbyData) : null);
  });
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  uid: string;
  name: string;
  text: string;
}

export async function sendMessage(lobbyId: string, uid: string, name: string, text: string): Promise<void> {
  await addDoc(collection(db, 'lobbies', lobbyId, 'messages'), {
    uid, name, text, timestamp: serverTimestamp(),
  });
}

export function watchMessages(lobbyId: string, cb: (msgs: ChatMessage[]) => void): Unsubscribe {
  const q = query(
    collection(db, 'lobbies', lobbyId, 'messages'),
    orderBy('timestamp', 'asc'),
    limit(50),
  );
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() } as ChatMessage)));
  });
}
