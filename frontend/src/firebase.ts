import { initializeApp } from "firebase/app";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

const firebaseConfig = {
  apiKey: "AIzaSyDQBL7TWPuSNxvWQJ4yOBnvhkDKMVVjnHo",
  authDomain: "skifin-ccpro.firebaseapp.com",
  projectId: "skifin-ccpro",
  storageBucket: "skifin-ccpro.firebasestorage.app",
  messagingSenderId: "114792777692",
  appId: "1:114792777692:web:f8268142f056f21502f119",
};

export const app = initializeApp(firebaseConfig);
export const functions = getFunctions(app);

if (import.meta.env.DEV) {
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}
