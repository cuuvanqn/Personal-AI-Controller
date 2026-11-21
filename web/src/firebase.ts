import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

// Firebase web config của project otter-aeccc (lấy từ landing-page.html hiện tại).
// Đây là config phía client công khai của Firebase Web — bảo mật nằm ở
// Firebase Auth + Security Rules phía server, không nằm ở apiKey này.
const firebaseConfig = {
  apiKey: "AIzaSyBmRwlVmrO1qX6Og_2clEeD4dSH1k6Hdjc",
  authDomain: "otter-aeccc.firebaseapp.com",
  projectId: "otter-aeccc",
  storageBucket: "otter-aeccc.firebasestorage.app",
  messagingSenderId: "413906945210",
  appId: "1:413906945210:web:43656df9009fbe29476e83",
  measurementId: "G-XL2SVB2GRK",
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
