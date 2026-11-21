import { Database } from "bun:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { allowLicenseRequest } from "../daemon/license/rate-limit";
import {
  verifyAdminAuth,
  verifyAdminFirebaseToken,
  createAdminSessionCookie,
  clearAdminSessionCookie,
  getAdminSecret,
} from "./admin-auth";
import { renderAdminLoginPage, renderAdminDashboard } from "./views";

/** Người dùng gửi nhịp trong vòng 10 phút gần nhất được tính là đang online. */
export const ONLINE_WINDOW_MS = 10 * 60 * 1000;

const ALLOWED_REDIRECT_HOSTS = new Set([
  "otter.gpt.io.vn",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export function initLicenseDatabase(dbPath?: string): Database {
  const finalPath = dbPath || path.join(process.cwd(), "data", "license-server.sqlite");
  const dir = path.dirname(finalPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(finalPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");

  db.run(`
    CREATE TABLE IF NOT EXISTS active_users (
      client_id TEXT PRIMARY KEY,
      firebase_uid TEXT,
      email TEXT,
      display_name TEXT,
      app_version TEXT NOT NULL DEFAULT 'unknown',
      platform TEXT NOT NULL DEFAULT 'unknown',
      arch TEXT NOT NULL DEFAULT '',
      hostname TEXT,
      source TEXT NOT NULL DEFAULT 'daemon',
      ip_address TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      heartbeat_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE INDEX IF NOT EXISTS idx_active_users_last_seen ON active_users(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_active_users_email ON active_users(email);
    CREATE INDEX IF NOT EXISTS idx_active_users_platform ON active_users(platform);

    CREATE TABLE IF NOT EXISTS download_events (
      id TEXT PRIMARY KEY,
      component TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'unknown',
      version TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_download_events_created_at ON download_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_download_events_platform ON download_events(platform);
    CREATE INDEX IF NOT EXISTS idx_download_events_component ON download_events(component);

    CREATE TABLE IF NOT EXISTS app_versions (
      component TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      min_supported_version TEXT,
      download_url TEXT NOT NULL,
      changelog TEXT,
      release_date TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  try {
    db.run("ALTER TABLE app_versions ADD COLUMN sha256 TEXT");
  } catch {}

  // Khởi tạo phiên bản mặc định ban đầu nếu chưa có
  try {
    const ext = db.query("SELECT component FROM app_versions WHERE component = 'extension'").get();
    if (!ext) {
      db.run(
        `INSERT INTO app_versions (component, version, min_supported_version, download_url, changelog, release_date, updated_at)
         VALUES ('extension', '2.1.0', '2.0.0', 'https://otter.gpt.io.vn/otter-extension.zip', 'Tiện ích Chrome tùy chọn hỗ trợ thanh HUD trên ChatGPT Web', date('now'), datetime('now'))`
      );
    }
    const daemon = db.query("SELECT component FROM app_versions WHERE component = 'daemon'").get();
    if (!daemon) {
      db.run(
        `INSERT INTO app_versions (component, version, min_supported_version, download_url, changelog, release_date, updated_at)
         VALUES ('daemon', '2.1.0', '2.0.0', 'https://otter.gpt.io.vn/otter-windows-x64.exe', 'Otter Daemon v2.1.0: Dashboard nhúng sẵn, OAuth 2.1, CDP mặc định', date('now'), datetime('now'))`
      );
    }
  } catch {}

  return db;
}

/**
 * So sánh 2 chuỗi Semantic Version (VD: "2.1.0" và "2.0.0")
 * Trả về 1 nếu v1 > v2; -1 nếu v1 < v2; 0 nếu bằng nhau
 */
export function compareSemver(v1: string, v2: string): number {
  const parse = (v: string) =>
    (v || "")
      .replace(/^[^\d]*/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const p1 = parse(v1);
  const p2 = parse(v2);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

/**
 * Khởi tạo Firebase Admin SDK với Service Account key của dự án otter-aeccc
 */
export function initFirebaseAdmin(): boolean {
  if (getApps().length > 0) return true;

  const candidatePaths = [
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    path.join(process.cwd(), "otter-aeccc-firebase-adminsdk-fbsvc-81d80ed7e0.json"),
    path.join(process.cwd(), "config", "firebase-service-account.json"),
  ].filter(Boolean) as string[];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const serviceAccount = JSON.parse(fs.readFileSync(p, "utf-8"));
        initializeApp({ credential: cert(serviceAccount) });
        console.log(`[Firebase Admin] Đã nạp Service Account key từ: ${path.basename(p)}`);
        return true;
      } catch (err: any) {
        console.warn(`[Firebase Admin] Lỗi nạp key từ ${p}:`, err.message);
      }
    }
  }
  return false;
}

/**
 * Xác thực Firebase ID Token qua Firebase Admin SDK hoặc Google Identity Toolkit REST API
 */
export async function verifyFirebaseIdToken(idToken: string): Promise<{
  valid: boolean;
  email?: string;
  email_verified?: boolean;
  name?: string;
  uid?: string;
  error?: string;
}> {
  if (!idToken || typeof idToken !== "string") {
    return { valid: false, error: "Thiếu ID token" };
  }

  initFirebaseAdmin();
  if (getApps().length > 0) {
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      return {
        valid: true,
        email: (decoded.email || "").trim().toLowerCase(),
        email_verified: decoded.email_verified === true,
        name: decoded.name || decoded.email,
        uid: decoded.uid,
      };
    } catch (adminErr: any) {
      console.warn("[Firebase Admin] verifyIdToken lỗi:", adminErr.message);
    }
  }

  const apiKey = process.env.FIREBASE_API_KEY || "AIzaSyBmRwlVmrO1qX6Og_2clEeD4dSH1k6Hdjc";
  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    const data = (await res.json()) as any;
    if (!res.ok || !data.users || data.users.length === 0) {
      return { valid: false, error: data?.error?.message || "Token không hợp lệ hoặc đã hết hạn" };
    }
    const user = data.users[0];
    return {
      valid: true,
      email: (user.email || "").trim().toLowerCase(),
      email_verified: user.emailVerified === true,
      name: user.displayName || user.email,
      uid: user.localId,
    };
  } catch (err: any) {
    return { valid: false, error: `Lỗi kết nối tới Google Auth: ${err.message}` };
  }
}

export interface HeartbeatInput {
  client_id: string;
  firebase_uid?: string | null;
  email?: string | null;
  display_name?: string | null;
  app_version?: string | null;
  platform?: string | null;
  arch?: string | null;
  hostname?: string | null;
  source?: string | null;
  ip_address?: string | null;
  clear_identity?: boolean;
  now?: Date;
}

export function normalizePlatform(raw?: string | null): string {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "unknown";
  if (v === "win32" || v === "win" || v.startsWith("windows")) return "windows";
  if (v === "darwin" || v === "mac" || v.startsWith("macos")) return "macos";
  if (v.startsWith("linux")) return "linux";
  if (v === "chrome" || v === "extension") return "chrome";
  return v.slice(0, 32);
}

function cleanText(raw: unknown, maxLen: number): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s ? s.slice(0, maxLen) : null;
}

export function recordUserHeartbeat(db: Database, input: HeartbeatInput): {
  ok: boolean;
  client_id: string;
  last_seen_at: string;
} {
  const clientId = String(input.client_id || "").trim().slice(0, 128);
  if (!clientId) {
    throw new Error("Thiếu client_id");
  }

  const nowIso = (input.now || new Date()).toISOString();
  const firebaseUid = cleanText(input.firebase_uid, 128);
  const email = cleanText(input.email, 160)?.toLowerCase() || null;
  const displayName = cleanText(input.display_name, 120);
  const appVersion = cleanText(input.app_version, 40) || "unknown";
  const platform = normalizePlatform(input.platform);
  const arch = cleanText(input.arch, 32) || "";
  const hostname = cleanText(input.hostname, 120);
  const source = cleanText(input.source, 32) || "daemon";
  const ipAddress = cleanText(input.ip_address, 64);

  if (input.clear_identity) {
    db.run(
      `INSERT INTO active_users (
        client_id, firebase_uid, email, display_name, app_version, platform, arch, hostname, source, ip_address, first_seen_at, last_seen_at, heartbeat_count, status
      ) VALUES (?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active')
      ON CONFLICT(client_id) DO UPDATE SET
        firebase_uid = NULL,
        email = NULL,
        display_name = NULL,
        app_version = CASE WHEN excluded.app_version != 'unknown' THEN excluded.app_version ELSE active_users.app_version END,
        platform = CASE WHEN excluded.platform != 'unknown' THEN excluded.platform ELSE active_users.platform END,
        arch = CASE WHEN excluded.arch != '' THEN excluded.arch ELSE active_users.arch END,
        hostname = COALESCE(excluded.hostname, active_users.hostname),
        source = excluded.source,
        ip_address = COALESCE(excluded.ip_address, active_users.ip_address),
        last_seen_at = excluded.last_seen_at,
        heartbeat_count = active_users.heartbeat_count + 1`,
      [clientId, appVersion, platform, arch, hostname, source, ipAddress, nowIso, nowIso]
    );
  } else {
    db.run(
      `INSERT INTO active_users (
        client_id, firebase_uid, email, display_name, app_version, platform, arch, hostname, source, ip_address, first_seen_at, last_seen_at, heartbeat_count, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active')
      ON CONFLICT(client_id) DO UPDATE SET
        firebase_uid = COALESCE(excluded.firebase_uid, active_users.firebase_uid),
        email = COALESCE(excluded.email, active_users.email),
        display_name = COALESCE(excluded.display_name, active_users.display_name),
        app_version = CASE WHEN excluded.app_version != 'unknown' THEN excluded.app_version ELSE active_users.app_version END,
        platform = CASE WHEN excluded.platform != 'unknown' THEN excluded.platform ELSE active_users.platform END,
        arch = CASE WHEN excluded.arch != '' THEN excluded.arch ELSE active_users.arch END,
        hostname = COALESCE(excluded.hostname, active_users.hostname),
        source = excluded.source,
        ip_address = COALESCE(excluded.ip_address, active_users.ip_address),
        last_seen_at = excluded.last_seen_at,
        heartbeat_count = active_users.heartbeat_count + 1`,
      [clientId, firebaseUid, email, displayName, appVersion, platform, arch, hostname, source, ipAddress, nowIso, nowIso]
    );
  }

  return { ok: true, client_id: clientId, last_seen_at: nowIso };
}

export interface DownloadEventInput {
  component?: string | null;
  platform?: string | null;
  version?: string | null;
  source?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  now?: Date;
}

export function recordDownloadEvent(db: Database, input: DownloadEventInput): {
  ok: boolean;
  id: string;
  created_at: string;
} {
  const id = crypto.randomUUID();
  const createdAt = (input.now || new Date()).toISOString();
  const component = cleanText(input.component, 40)?.toLowerCase() || "daemon";
  const platform = normalizePlatform(input.platform);
  const version = cleanText(input.version, 40);
  const source = cleanText(input.source, 32)?.toLowerCase() || "web";
  const ipAddress = cleanText(input.ip_address, 64);
  const userAgent = cleanText(input.user_agent, 250);

  db.run(
    `INSERT INTO download_events (id, component, platform, version, source, ip_address, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, component, platform, version, source, ipAddress, userAgent, createdAt]
  );

  return { ok: true, id, created_at: createdAt };
}

export interface TelemetryStats {
  onlineNow: number;
  activeToday: number;
  active7d: number;
  totalUsers: number;
  signedInUsers: number;
  totalDownloads: number;
  downloadsToday: number;
  downloads7d: number;
  usersByPlatform: Array<{ platform: string; count: number }>;
  usersByVersion: Array<{ version: string; count: number }>;
  downloadsByPlatform: Array<{ platform: string; count: number }>;
  downloadsByComponent: Array<{ component: string; count: number }>;
  dailyDownloads7d: Array<{ day: string; count: number }>;
}

export function getTelemetryStats(db: Database, now: Date = new Date()): TelemetryStats {
  const onlineCutoff = new Date(now.getTime() - ONLINE_WINDOW_MS).toISOString();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const cutoff7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const onlineNow = (db.query("SELECT COUNT(*) as c FROM active_users WHERE last_seen_at >= ?").get(onlineCutoff) as any)?.c || 0;
  const activeToday = (db.query("SELECT COUNT(*) as c FROM active_users WHERE last_seen_at >= ?").get(startOfToday) as any)?.c || 0;
  const active7d = (db.query("SELECT COUNT(*) as c FROM active_users WHERE last_seen_at >= ?").get(cutoff7d) as any)?.c || 0;
  const totalUsers = (db.query("SELECT COUNT(*) as c FROM active_users").get() as any)?.c || 0;
  const signedInUsers = (db.query("SELECT COUNT(*) as c FROM active_users WHERE email IS NOT NULL AND email != ''").get() as any)?.c || 0;

  const totalDownloads = (db.query("SELECT COUNT(*) as c FROM download_events").get() as any)?.c || 0;
  const downloadsToday = (db.query("SELECT COUNT(*) as c FROM download_events WHERE created_at >= ?").get(startOfToday) as any)?.c || 0;
  const downloads7d = (db.query("SELECT COUNT(*) as c FROM download_events WHERE created_at >= ?").get(cutoff7d) as any)?.c || 0;

  const usersByPlatform = db
    .query("SELECT platform, COUNT(*) as count FROM active_users GROUP BY platform ORDER BY count DESC")
    .all() as Array<{ platform: string; count: number }>;

  const usersByVersion = db
    .query("SELECT app_version as version, COUNT(*) as count FROM active_users GROUP BY app_version ORDER BY count DESC LIMIT 8")
    .all() as Array<{ version: string; count: number }>;

  const downloadsByPlatform = db
    .query("SELECT platform, COUNT(*) as count FROM download_events GROUP BY platform ORDER BY count DESC")
    .all() as Array<{ platform: string; count: number }>;

  const downloadsByComponent = db
    .query("SELECT component, COUNT(*) as count FROM download_events GROUP BY component ORDER BY count DESC")
    .all() as Array<{ component: string; count: number }>;

  // Xây 7 ngày liên tiếp kể cả ngày có 0 lượt tải
  const rawDaily = db
    .query(
      `SELECT substr(created_at, 1, 10) as day, COUNT(*) as count
       FROM download_events
       WHERE created_at >= ?
       GROUP BY substr(created_at, 1, 10)`
    )
    .all(cutoff7d) as Array<{ day: string; count: number }>;
  const dailyMap = new Map(rawDaily.map((r) => [r.day, Number(r.count) || 0]));
  const dailyDownloads7d: Array<{ day: string; count: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    dailyDownloads7d.push({ day: key, count: dailyMap.get(key) || 0 });
  }

  return {
    onlineNow,
    activeToday,
    active7d,
    totalUsers,
    signedInUsers,
    totalDownloads,
    downloadsToday,
    downloads7d,
    usersByPlatform,
    usersByVersion,
    downloadsByPlatform,
    downloadsByComponent,
    dailyDownloads7d,
  };
}

export interface ActiveUserRow {
  client_id: string;
  firebase_uid: string | null;
  email: string | null;
  display_name: string | null;
  app_version: string;
  platform: string;
  arch: string;
  hostname: string | null;
  source: string;
  ip_address: string | null;
  first_seen_at: string;
  last_seen_at: string;
  heartbeat_count: number;
  is_online: boolean;
}

export function listActiveUsers(
  db: Database,
  opts: { filter?: string; q?: string; limit?: number; now?: Date } = {}
): ActiveUserRow[] {
  const now = opts.now || new Date();
  const onlineCutoff = new Date(now.getTime() - ONLINE_WINDOW_MS).toISOString();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);

  const clauses: string[] = [];
  const params: any[] = [];

  if (opts.filter === "online") {
    clauses.push("last_seen_at >= ?");
    params.push(onlineCutoff);
  } else if (opts.filter === "today") {
    clauses.push("last_seen_at >= ?");
    params.push(startOfToday);
  } else if (opts.filter === "signed_in") {
    clauses.push("email IS NOT NULL AND email != ''");
  }

  const q = (opts.q || "").trim().toLowerCase();
  if (q) {
    const like = `%${q}%`;
    clauses.push(
      "(LOWER(COALESCE(email,'')) LIKE ? OR LOWER(COALESCE(display_name,'')) LIKE ? OR LOWER(client_id) LIKE ? OR LOWER(platform) LIKE ? OR LOWER(app_version) LIKE ? OR LOWER(COALESCE(hostname,'')) LIKE ?)"
    );
    params.push(like, like, like, like, like, like);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .query(`SELECT * FROM active_users ${whereSql} ORDER BY last_seen_at DESC LIMIT ?`)
    .all(...params, limit) as any[];

  return rows.map((r) => ({
    client_id: r.client_id,
    firebase_uid: r.firebase_uid || null,
    email: r.email || null,
    display_name: r.display_name || null,
    app_version: r.app_version || "unknown",
    platform: r.platform || "unknown",
    arch: r.arch || "",
    hostname: r.hostname || null,
    source: r.source || "daemon",
    ip_address: r.ip_address || null,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    heartbeat_count: Number(r.heartbeat_count) || 1,
    is_online: String(r.last_seen_at) >= onlineCutoff,
  }));
}

export function listRecentDownloads(db: Database, limit: number = 50): Array<{
  id: string;
  component: string;
  platform: string;
  version: string | null;
  source: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}> {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 300);
  return db
    .query("SELECT * FROM download_events ORDER BY created_at DESC LIMIT ?")
    .all(safeLimit) as any[];
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
}

function isAllowedRedirectUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    if (!ALLOWED_REDIRECT_HOSTS.has(parsed.hostname.toLowerCase())) return false;
    if (parsed.hostname.toLowerCase() === "github.com" && !parsed.pathname.toLowerCase().startsWith("/ptn1411/otter")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Khởi chạy Otter Telemetry, Downloads & Release Server
 * (giữ tên startLicenseServer để tương thích systemd & script deploy hiện có).
 */
export function startLicenseServer(
  port: number = Number(process.env.LICENSE_SERVER_PORT || process.env.PORT || 1994),
  dbPath?: string
) {
  const db = initLicenseDatabase(dbPath);
  initFirebaseAdmin();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      const securityHeaders = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "X-XSS-Protection": "1; mode=block",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      };

      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
        ...securityHeaders,
      };

      if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }

      // 0. Health check
      if ((url.pathname === "/health" || url.pathname === "/api/health") && req.method === "GET") {
        const stats = getTelemetryStats(db);
        return Response.json(
          {
            status: "ok",
            service: "otter-telemetry-server",
            online_users: stats.onlineNow,
            active_today: stats.activeToday,
            total_users: stats.totalUsers,
            total_downloads: stats.totalDownloads,
          },
          { headers: corsHeaders }
        );
      }

      // 1. Đăng nhập / đăng xuất Quản trị viên (Google Firebase)
      if (url.pathname === "/api/admin/login-firebase" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => ({}))) as any;
          const idToken = String(body.idToken || body.id_token || "").trim();
          const authResult = await verifyAdminFirebaseToken(idToken);
          if (authResult.authorized && authResult.email) {
            return new Response(
              JSON.stringify({
                success: true,
                message: `Chào mừng Quản trị viên: ${authResult.name || authResult.email}!`,
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Set-Cookie": createAdminSessionCookie(`email:${authResult.email}`),
                  ...corsHeaders,
                },
              }
            );
          }
          return Response.json(
            {
              success: false,
              error: authResult.error || "Tài khoản Google không có quyền quản trị viên",
            },
            { status: 403, headers: corsHeaders }
          );
        } catch (err: any) {
          return Response.json({ success: false, error: err.message }, { status: 500, headers: corsHeaders });
        }
      }

      if ((url.pathname === "/api/admin/logout" || url.pathname === "/logout") && (req.method === "POST" || req.method === "GET")) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie": clearAdminSessionCookie(),
            ...corsHeaders,
          },
        });
      }

      // 2. Nhịp hoạt động người dùng (Heartbeat từ Otter Daemon / Dashboard)
      if (
        (url.pathname === "/api/telemetry/heartbeat" ||
          url.pathname === "/api/users/heartbeat" ||
          url.pathname === "/api/heartbeat") &&
        req.method === "POST"
      ) {
        try {
          const clientIp = getClientIp(req);
          if (!allowLicenseRequest(`telemetry-hb:${clientIp}`, 120)) {
            return Response.json({ ok: false, error: "Too many heartbeats" }, { status: 429, headers: corsHeaders });
          }

          const body = (await req.json().catch(() => ({}))) as any;
          const clientId = String(body.client_id || body.clientId || "").trim();
          if (!clientId) {
            return Response.json({ ok: false, error: "Thiếu client_id" }, { status: 400, headers: corsHeaders });
          }

          let email = body.email ?? null;
          let displayName = body.display_name ?? body.displayName ?? null;
          let firebaseUid = body.firebase_uid ?? body.uid ?? null;

          const idToken = body.id_token || body.idToken;
          if (idToken) {
            const verified = await verifyFirebaseIdToken(String(idToken));
            if (verified.valid) {
              email = verified.email || email;
              displayName = verified.name || displayName;
              firebaseUid = verified.uid || firebaseUid;
            }
          }

          const result = recordUserHeartbeat(db, {
            client_id: clientId,
            firebase_uid: firebaseUid,
            email,
            display_name: displayName,
            app_version: body.version || body.app_version,
            platform: body.platform,
            arch: body.arch,
            hostname: body.hostname,
            source: body.source || "daemon",
            ip_address: clientIp,
            clear_identity: body.clear_identity === true,
          });

          return Response.json(
            { ok: true, client_id: result.client_id, server_time: result.last_seen_at },
            { headers: corsHeaders }
          );
        } catch (err: any) {
          return Response.json({ ok: false, error: err.message }, { status: 400, headers: corsHeaders });
        }
      }

      // 3. Ghi nhận lượt tải Otter (từ Web / Installer / Auto-updater)
      if (url.pathname === "/api/downloads/track" && req.method === "POST") {
        try {
          const clientIp = getClientIp(req);
          if (!allowLicenseRequest(`download-track:${clientIp}`, 60)) {
            return Response.json({ ok: false, error: "Rate limited" }, { status: 429, headers: corsHeaders });
          }

          const body = (await req.json().catch(() => ({}))) as any;
          const result = recordDownloadEvent(db, {
            component: body.component || "daemon",
            platform: body.platform || "unknown",
            version: body.version || null,
            source: body.source || "web",
            ip_address: clientIp,
            user_agent: req.headers.get("user-agent") || "",
          });

          return Response.json(result, { status: 201, headers: corsHeaders });
        } catch (err: any) {
          return Response.json({ ok: false, error: err.message }, { status: 400, headers: corsHeaders });
        }
      }

      // 3.1 Redirect tải file có đếm lượt (chỉ cho phép host chính thức của Otter)
      if (url.pathname === "/api/downloads/go" && req.method === "GET") {
        const target = (url.searchParams.get("target") || "").trim();
        if (!isAllowedRedirectUrl(target)) {
          return Response.json({ ok: false, error: "Target URL không được phép" }, { status: 400, headers: corsHeaders });
        }

        const clientIp = getClientIp(req);
        if (allowLicenseRequest(`download-go:${clientIp}`, 60)) {
          recordDownloadEvent(db, {
            component: url.searchParams.get("component") || "daemon",
            platform: url.searchParams.get("platform") || "unknown",
            version: url.searchParams.get("version") || null,
            source: url.searchParams.get("source") || "redirect",
            ip_address: clientIp,
            user_agent: req.headers.get("user-agent") || "",
          });
        }

        return new Response(null, {
          status: 302,
          headers: { Location: target, ...corsHeaders },
        });
      }

      // 3.2 Thống kê tổng hợp công khai (không lộ IP / email)
      if (url.pathname === "/api/downloads/stats" && req.method === "GET") {
        const stats = getTelemetryStats(db);
        return Response.json(
          {
            ok: true,
            online_now: stats.onlineNow,
            active_today: stats.activeToday,
            total_users: stats.totalUsers,
            total_downloads: stats.totalDownloads,
            downloads_today: stats.downloadsToday,
            downloads_7d: stats.downloads7d,
            by_platform: stats.downloadsByPlatform,
            by_component: stats.downloadsByComponent,
          },
          { headers: corsHeaders }
        );
      }

      // 4. Kiểm tra phiên bản mới & cập nhật tự động (Public — dùng bởi daemon updater & web/)
      if ((url.pathname === "/api/version" || url.pathname === "/api/check-update") && req.method === "GET") {
        const component = url.searchParams.get("component") || "extension";
        const clientVersion = url.searchParams.get("client_version") || "";
        const reqPlatform = normalizePlatform(url.searchParams.get("platform"));
        const reqArch = (url.searchParams.get("arch") || "").trim().toLowerCase();

        // Ưu tiên bản ghi riêng theo nền tảng nếu admin có đăng ký (vd: daemon-linux-x64)
        let verRecord: any = null;
        if (component === "daemon" && reqPlatform !== "unknown") {
          const archKey = reqArch === "arm64" || reqArch === "aarch64" ? "arm64" : "x64";
          verRecord = db
            .query("SELECT * FROM app_versions WHERE component = ?")
            .get(`daemon-${reqPlatform}-${archKey}`);
        }
        if (!verRecord) {
          verRecord = db.query("SELECT * FROM app_versions WHERE component = ?").get(component) as any;
        }
        if (!verRecord) {
          return Response.json({ error: "Component not found" }, { status: 404, headers: corsHeaders });
        }

        // Nếu dùng bản ghi chung 'daemon', tự ánh xạ tên file binary theo hệ điều hành client
        let resolvedDownloadUrl = verRecord.download_url;
        let resolvedSha256 = verRecord.sha256 || null;
        if (component === "daemon" && verRecord.component === "daemon" && resolvedDownloadUrl) {
          const archKey = reqArch === "arm64" || reqArch === "aarch64" ? "arm64" : "x64";
          const targetBin =
            reqPlatform === "linux"
              ? `otter-linux-${archKey}`
              : reqPlatform === "macos"
                ? `otter-darwin-${archKey}`
                : null;
          if (targetBin && /\/(otter-windows-x64\.exe|otter\.exe)$/i.test(resolvedDownloadUrl)) {
            resolvedDownloadUrl = resolvedDownloadUrl.replace(/\/(otter-windows-x64\.exe|otter\.exe)$/i, `/${targetBin}`);
            // SHA256 của bản ghi chung thuộc file Windows -> không ép checksum sai sang Linux/macOS
            resolvedSha256 = null;
          }
        }

        const isUpdateAvailable = clientVersion ? compareSemver(verRecord.version, clientVersion) > 0 : false;
        const isMandatory =
          clientVersion && verRecord.min_supported_version
            ? compareSemver(verRecord.min_supported_version, clientVersion) > 0
            : false;

        return Response.json(
          {
            component: verRecord.component,
            version: verRecord.version,
            client_version: clientVersion || null,
            update_available: isUpdateAvailable,
            mandatory: isMandatory,
            min_supported_version: verRecord.min_supported_version,
            download_url: resolvedDownloadUrl,
            sha256: resolvedSha256,
            changelog: verRecord.changelog,
            release_date: verRecord.release_date,
          },
          { headers: corsHeaders }
        );
      }

      if (url.pathname === "/api/versions" && req.method === "GET") {
        const allVersions = db
          .query("SELECT * FROM app_versions WHERE component NOT LIKE 'daemon-%'")
          .all() as any[];
        return Response.json({ success: true, versions: allVersions }, { headers: corsHeaders });
      }

      // 5. API Quản trị viên (Admin Only)
      if (url.pathname === "/api/admin/stats" && req.method === "GET") {
        const auth = verifyAdminAuth(req);
        if (!auth.authorized) {
          return Response.json({ success: false, error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }
        return Response.json({ success: true, stats: getTelemetryStats(db) }, { headers: corsHeaders });
      }

      if (url.pathname === "/api/admin/users" && req.method === "GET") {
        const auth = verifyAdminAuth(req);
        if (!auth.authorized) {
          return Response.json({ success: false, error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }
        const filter = url.searchParams.get("filter") || "all";
        const q = url.searchParams.get("q") || "";
        const limit = Number(url.searchParams.get("limit") || 100);
        const users = listActiveUsers(db, { filter, q, limit });
        return Response.json({ success: true, users }, { headers: corsHeaders });
      }

      if (url.pathname === "/api/admin/users/delete" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as any;
        const auth = verifyAdminAuth(req, body);
        if (!auth.authorized) {
          return Response.json({ success: false, error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }
        const clientId = String(body.client_id || "").trim();
        if (!clientId) {
          return Response.json({ success: false, error: "Thiếu client_id" }, { status: 400, headers: corsHeaders });
        }
        db.run("DELETE FROM active_users WHERE client_id = ?", [clientId]);
        return Response.json({ success: true, message: `Đã xóa thiết bị ${clientId}` }, { headers: corsHeaders });
      }

      if (url.pathname === "/api/admin/downloads" && req.method === "GET") {
        const auth = verifyAdminAuth(req);
        if (!auth.authorized) {
          return Response.json({ success: false, error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }
        const limit = Number(url.searchParams.get("limit") || 50);
        const stats = getTelemetryStats(db);
        const downloads = listRecentDownloads(db, limit);
        return Response.json(
          {
            success: true,
            total: stats.totalDownloads,
            today: stats.downloadsToday,
            last7d: stats.downloads7d,
            by_platform: stats.downloadsByPlatform,
            by_component: stats.downloadsByComponent,
            daily_7d: stats.dailyDownloads7d,
            downloads,
          },
          { headers: corsHeaders }
        );
      }

      // 5.1 Cập nhật & phát hành phiên bản mới (Admin Only)
      if (url.pathname === "/api/admin/version/update" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => ({}))) as any;
          const auth = verifyAdminAuth(req, body);
          if (!auth.authorized) {
            return Response.json({ success: false, error: "Unauthorized" }, { status: 401, headers: corsHeaders });
          }

          const component = String(body.component || "daemon").trim();
          const version = String(body.version || "").trim();
          const downloadUrl = String(body.download_url || "").trim();
          const changelog = String(body.changelog || "").trim();
          const minSupportedVersion = String(body.min_supported_version || version).trim();
          const sha256 = String(body.sha256 || "").trim().toLowerCase();
          if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) {
            return Response.json(
              { success: false, error: "SHA256 không hợp lệ (cần 64 ký tự hex)" },
              { status: 400, headers: corsHeaders }
            );
          }
          if (!version) {
            return Response.json(
              { success: false, error: "Vui lòng nhập phiên bản (ví dụ: 2.1.0)" },
              { status: 400, headers: corsHeaders }
            );
          }

          const now = new Date().toISOString();
          db.run(
            `INSERT INTO app_versions (component, version, min_supported_version, download_url, changelog, release_date, updated_at, sha256)
             VALUES (?, ?, ?, ?, ?, date('now'), ?, ?)
             ON CONFLICT(component) DO UPDATE SET
               version = excluded.version,
               min_supported_version = excluded.min_supported_version,
               download_url = excluded.download_url,
               changelog = excluded.changelog,
               release_date = date('now'),
               updated_at = excluded.updated_at,
               sha256 = excluded.sha256`,
            [component, version, minSupportedVersion, downloadUrl, changelog, now, sha256 || null]
          );

          return Response.json(
            {
              success: true,
              message: `Đã phát hành phiên bản mới ${version} cho ${component}!`,
            },
            { headers: corsHeaders }
          );
        } catch (err: any) {
          return Response.json({ success: false, error: err.message }, { status: 500, headers: corsHeaders });
        }
      }

      // 6. Giao diện Web Admin Monitor tại GET / và /admin
      if ((url.pathname === "/" || url.pathname === "/admin") && (req.method === "GET" || req.method === "HEAD")) {
        const cspHeader =
          "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.gstatic.com https://apis.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com; frame-src 'self' https://*.firebaseapp.com; img-src 'self' data: https:;";

        const htmlHeaders = {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": cspHeader,
          ...corsHeaders,
        };

        if (req.method === "HEAD") {
          return new Response(null, { headers: htmlHeaders });
        }
        const adminAuth = verifyAdminAuth(req);
        if (!adminAuth.authorized) {
          return new Response(renderAdminLoginPage(), { status: 200, headers: htmlHeaders });
        }

        const finalHeaders: Record<string, string> = { ...htmlHeaders };
        if (adminAuth.user === "Query Master Key") {
          finalHeaders["Set-Cookie"] = createAdminSessionCookie(getAdminSecret());
        }

        return new Response(renderAdminDashboard(db, port, adminAuth.user || "Admin"), {
          status: 200,
          headers: finalHeaders,
        });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    },
  });

  console.log(`[Otter Server] Máy chủ theo dõi người dùng & lượt tải hoạt động tại: http://127.0.0.1:${port}`);
  return server;
}

export const startTelemetryServer = startLicenseServer;

if (import.meta.main) {
  startLicenseServer();
}
