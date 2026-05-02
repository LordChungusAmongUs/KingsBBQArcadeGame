import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: 'AIzaSyCdM9jsdkYWG4U_6JYNchTxbOSgj_TMHiQ',
  authDomain: 'kingsbbqbonanza.firebaseapp.com',
  databaseURL: 'https://kingsbbqbonanza-default-rtdb.firebaseio.com',
  projectId: 'kingsbbqbonanza',
  storageBucket: 'kingsbbqbonanza.firebasestorage.app',
  messagingSenderId: '306935882972',
  appId: '1:306935882972:web:269b822a03c1d467360019',
};

const app = initializeApp(firebaseConfig);
export const auth  = getAuth(app);
export const db    = getFirestore(app);
export const rtdb  = getDatabase(app);
