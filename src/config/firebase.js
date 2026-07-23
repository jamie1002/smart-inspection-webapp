// Firebase 初始化 + 背景匿名登入（取代 04 文件的初始化片段）
// ⚠️ 部署後記得到 Firebase Console → Authentication → 已授權網域，
//   加入部署網域（GitHub Pages / Firebase Hosting），否則匿名登入被拒。

import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: "ai-car-inspection-system.firebaseapp.com",
  projectId: "ai-car-inspection-system",
  storageBucket: "ai-car-inspection-system.firebasestorage.app",
  messagingSenderId: "126041459634",
  appId: "1:126041459634:web:2479e78b8d58716c75b2ab",
  measurementId: "G-1DG0J1S1KJ",
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const storage = getStorage(app);
export const auth = getAuth(app);
export const STORAGE_BUCKET = firebaseConfig.storageBucket;

// 背景匿名登入（使用者無感）
// authError：登入失敗時記錄旗標，避免 upload.js 的 `await authReady` 永遠卡住卻不報錯
// （交接單 §3：匿名登入若被 Firebase Console 停用，signInAnonymously 會 reject，
//  但沒有這個旗標的話呼叫端完全看不出「卡住」與「失敗」的差異）。
let authReadyResolve;
export const authReady = new Promise((resolve) => {
  authReadyResolve = resolve;
});

export let authError = null;

onAuthStateChanged(auth, (user) => {
  if (user) {
    authError = null;
    authReadyResolve(user);
  }
});

signInAnonymously(auth).catch((err) => {
  authError = err;
  console.error("匿名登入失敗（請確認 Firebase Console → Authentication → Anonymous 是否已啟用）", err);
});
