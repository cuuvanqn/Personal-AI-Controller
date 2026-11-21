/**
 * Lớp gọi API của Otter daemon cho Dashboard.
 *
 * Xác thực: daemon miễn trừ mạng tin cậy (localhost/LAN/Tailscale) khi chưa đặt
 * OTTER_API_KEY; truy cập từ Internet qua tunnel cần token. Dashboard nhận token
 * qua tham số ?token= trên URL, lưu vào sessionStorage và gửi kèm mọi request.
 */

const TOKEN_KEY = "otter_dashboard_token";

export function initTokenFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  const t = params.get("token");
  if (t) {
    sessionStorage.setItem(TOKEN_KEY, t);
    params.delete("token");
    const q = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : "") + window.location.hash);
  }
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) msg = String(data.error);
    } catch {}
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export const apiGet = <T = any>(path: string) => api<T>(path);
export const apiPost = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

/* ── Kiểu dữ liệu theo API daemon ─────────────────────────────── */

export interface HealthInfo {
  status: string;
  service: string;
  version: string;
  platform: string;
  uptime: number;
  port: number;
  tailscaleIp: string | null;
  tunnelStatus: string;
  socialBotConnected: boolean;
  externalMcpServers: { total: number; connected: number };
}

export interface TunnelInfo {
  status: string;
  url: string | null;
  mcpUrl: string | null;
  sseUrl: string | null;
  error: string | null;
}

export interface LicenseInfo {
  licensed: boolean;
  reason?: string;
  payload?: { license_type?: string } | null;
  supportCode: string;
  isLeased?: boolean;
  isGracePeriod?: boolean;
}

export interface ToolGroupInfo {
  id: string;
  nameVi: string;
  nameEn: string;
  descVi: string;
  descEn: string;
  toolCount: number;
  estTokens: number;
  enabled: boolean;
  liveToolCount: number;
}

export interface ToolGroupsResponse {
  groups: ToolGroupInfo[];
  totalTools: number;
  enabledTools: number;
  totalEstTokens: number;
  enabledEstTokens: number;
  liveSessions: number;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  mandatory: boolean;
  downloadUrl: string | null;
  sha256: string | null;
  changelog: string | null;
  lastCheckedAt: string | null;
  autoUpdateEnabled: boolean;
  isCompiledBinary: boolean;
  lastError: string | null;
}

export interface OAuthClientInfo {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
  activeTokens: number;
  lastIssuedAt: number | null;
}
