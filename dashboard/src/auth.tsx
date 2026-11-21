import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import { auth, googleProvider } from "./firebase";
import { apiPost } from "./api";

interface AuthState {
  user: User | null;
  isLoading: boolean;
  signInGoogle: () => Promise<void>;
  signInEmail: (email: string, password: string) => Promise<void>;
  registerEmail: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsLoading(false);
      // Đồng bộ trạng thái người dùng đang hoạt động về Otter daemon cục bộ (bỏ qua lỗi nếu daemon đang tắt)
      if (u) {
        apiPost("/api/system/telemetry/user", {
          uid: u.uid,
          email: u.email,
          displayName: u.displayName,
        }).catch(() => {});
      }
    });
    return unsub;
  }, []);

  const value: AuthState = {
    user,
    isLoading,
    signInGoogle: async () => {
      await signInWithPopup(auth, googleProvider);
    },
    signInEmail: async (email, password) => {
      await signInWithEmailAndPassword(auth, email, password);
    },
    registerEmail: async (email, password) => {
      await createUserWithEmailAndPassword(auth, email, password);
    },
    logout: async () => {
      await signOut(auth);
      apiPost("/api/system/telemetry/user", { clear: true }).catch(() => {});
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export function firebaseErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code || "";
  switch (code) {
    case "auth/invalid-email":
      return "Địa chỉ email không hợp lệ.";
    case "auth/user-not-found":
    case "auth/invalid-credential":
    case "auth/wrong-password":
      return "Email hoặc mật khẩu không đúng.";
    case "auth/email-already-in-use":
      return "Email này đã được đăng ký. Hãy đăng nhập thay vì tạo tài khoản mới.";
    case "auth/weak-password":
      return "Mật khẩu quá yếu — cần ít nhất 6 ký tự.";
    case "auth/popup-closed-by-user":
      return "Bạn đã đóng cửa sổ đăng nhập Google.";
    case "auth/network-request-failed":
      return "Không kết nối được tới máy chủ đăng nhập. Kiểm tra mạng rồi thử lại.";
    case "auth/too-many-requests":
      return "Thử quá nhiều lần. Đợi một lúc rồi thử lại.";
    default:
      return "Đăng nhập thất bại. Vui lòng thử lại.";
  }
}
