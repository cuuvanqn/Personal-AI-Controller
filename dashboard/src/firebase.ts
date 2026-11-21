import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

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
