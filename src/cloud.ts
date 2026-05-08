import {
  collection, addDoc, doc, getDoc, updateDoc, deleteDoc,
  query, orderBy, limit, where, onSnapshot, serverTimestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';

// ── Leaderboard ──────────────────────────────────────────────────────────────

export interface CloudEntry {
  uid: string; displayName: string; photoURL: string;
  name: string; score: number; level: number;
}

export async function saveCloudScore(
  uid: string, displayName: string, photoURL: string,
  name: string, score: number, level: number,
): Promise<void> {
  await addDoc(collection(db, 'scores'), {
    uid, displayName, photoURL, name, score, level, timestamp: serverTimestamp(),
  });
}

import { getDocs } from 'firebase/firestore';
export async function loadCloudLeaderboard(): Promise<CloudEntry[]> {
  const q = query(collection(db, 'scores'), orderBy('score', 'desc'), limit(10));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data() as CloudEntry);
}

// ── Lobbies (game coordination) ───────────────────────────────────────────────

export interface LobbyData {
  id: string;
  hostUid: string; hostName: string; hostPhoto: string;
  guestUid:  string | null; guestName:  string | null; guestPhoto:  string | null;  // slot 2
  guest2Uid: string | null; guest2Name: string | null; guest2Photo: string | null;  // slot 3
  guest3Uid: string | null; guest3Name: string | null; guest3Photo: string | null;  // slot 4
  maxPlayers: number;
  status: 'waiting' | 'starting' | 'closed';
}

export async function createLobby(uid: string, name: string, photo: string, maxPlayers = 4): Promise<string> {
  const ref = await addDoc(collection(db, 'lobbies'), {
    hostUid: uid, hostName: name, hostPhoto: photo,
    guestUid: null, guestName: null, guestPhoto: null,
    guest2Uid: null, guest2Name: null, guest2Photo: null,
    guest3Uid: null, guest3Name: null, guest3Photo: null,
    maxPlayers, status: 'waiting', createdAt: serverTimestamp(),
  });
  return ref.id;
}

// Returns the slot number taken (2, 3, or 4), or 0 if the lobby is full / not found.
export async function joinLobby(lobbyId: string, uid: string, name: string, photo: string): Promise<number> {
  const r = doc(db, 'lobbies', lobbyId);
  const snap = await getDoc(r);
  if (!snap.exists()) return 0;
  const data = snap.data() as LobbyData;
  if (data.hostUid === uid || data.status !== 'waiting') return 0;
  const maxPlayers = data.maxPlayers ?? 2;
  if (!data.guestUid && maxPlayers >= 2) {
    await updateDoc(r, { guestUid: uid, guestName: name, guestPhoto: photo });
    return 2;
  }
  if (!data.guest2Uid && maxPlayers >= 3) {
    await updateDoc(r, { guest2Uid: uid, guest2Name: name, guest2Photo: photo });
    return 3;
  }
  if (!data.guest3Uid && maxPlayers >= 4) {
    await updateDoc(r, { guest3Uid: uid, guest3Name: name, guest3Photo: photo });
    return 4;
  }
  return 0;
}

export async function deleteLobby(lobbyId: string): Promise<void> {
  await deleteDoc(doc(db, 'lobbies', lobbyId));
}

export async function setLobbyStatus(lobbyId: string, status: 'waiting' | 'starting' | 'closed'): Promise<void> {
  await updateDoc(doc(db, 'lobbies', lobbyId), { status });
}

export function watchLobby(lobbyId: string, cb: (data: LobbyData | null) => void): Unsubscribe {
  return onSnapshot(doc(db, 'lobbies', lobbyId), snap => {
    cb(snap.exists() ? ({ id: snap.id, ...snap.data() } as LobbyData) : null);
  });
}

// ── Global chat ───────────────────────────────────────────────────────────────

export interface GlobalChatMsg {
  id: string; uid: string; name: string; photo: string; text: string;
}

export async function sendGlobalMessage(uid: string, name: string, photo: string, text: string): Promise<void> {
  await addDoc(collection(db, 'globalChat'), { uid, name, photo, text, timestamp: serverTimestamp() });
}

export function watchGlobalChat(cb: (msgs: GlobalChatMsg[]) => void): Unsubscribe {
  const q = query(collection(db, 'globalChat'), orderBy('timestamp', 'desc'), limit(60));
  return onSnapshot(q, snap => {
    cb(snap.docs.reverse().map(d => ({ id: d.id, ...d.data() } as GlobalChatMsg)));
  });
}

// ── Invites ───────────────────────────────────────────────────────────────────

export interface InviteData {
  id: string;
  fromUid: string; fromName: string; fromPhoto: string;
  toUid: string;
  lobbyId: string;
  status: 'pending' | 'accepted' | 'declined';
  type?: 'invite' | 'join_request';
}

export async function sendInvite(
  fromUid: string, fromName: string, fromPhoto: string,
  toUid: string, lobbyId: string,
  type: 'invite' | 'join_request' = 'invite',
): Promise<string> {
  const ref = await addDoc(collection(db, 'invites'), {
    fromUid, fromName, fromPhoto, toUid, lobbyId, type,
    status: 'pending', createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function respondToInvite(inviteId: string, status: 'accepted' | 'declined'): Promise<void> {
  await updateDoc(doc(db, 'invites', inviteId), { status });
}

export async function deleteInvite(inviteId: string): Promise<void> {
  await deleteDoc(doc(db, 'invites', inviteId)).catch(() => {});
}

export function watchIncomingInvites(toUid: string, cb: (invites: InviteData[]) => void): Unsubscribe {
  const q = query(collection(db, 'invites'), where('toUid', '==', toUid));
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() } as InviteData))
      .filter(i => i.status === 'pending'));
  });
}

export function watchSentInvite(inviteId: string, cb: (invite: InviteData | null) => void): Unsubscribe {
  return onSnapshot(doc(db, 'invites', inviteId), snap => {
    cb(snap.exists() ? ({ id: snap.id, ...snap.data() } as InviteData) : null);
  });
}
