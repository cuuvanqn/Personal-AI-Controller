import * as crypto from "node:crypto";
import { getDatabase } from "./db";

/**
 * Lưu trữ OAuth client + token (bản sửa bảo mật 2026-11-21).
 *
 * Nguyên tắc:
 * - Access/refresh token sinh ngẫu nhiên RIÊNG cho từng client, KHÔNG dùng
 *   token chủ (~/.otter/auth.token). Chỉ lưu SHA-256 hash trong DB.
 * - Refresh token bắt buộc đối chiếu hash + xoay vòng mỗi lần dùng.
 * - Thu hồi được từng client mà không cần đổi token chủ.
 */

export const ACCESS_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 ngày (như hành vi cũ)
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 3600 * 1000; // 90 ngày

export interface OAuthClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

export interface IssuedOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // giây
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isLocalhostUri(u: URL): boolean {
  return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
}

/** Redirect URI hợp lệ: https bất kỳ, hoặc http chỉ cho localhost (RFC 8252). */
export function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:" && isLocalhostUri(u)) return true;
    return false;
  } catch {
    return false;
  }
}

export function registerOAuthClient(clientName: string, redirectUris: string[]): OAuthClientRecord {
  const clientId = "otter_client_" + crypto.randomBytes(12).toString("hex");
  const now = Date.now();
  const db = getDatabase();
  db.run(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)`,
    [clientId, clientName || "MCP Client", JSON.stringify(redirectUris), now]
  );
  return { clientId, clientName: clientName || "MCP Client", redirectUris, createdAt: now };
}

export function getOAuthClient(clientId: string): OAuthClientRecord | null {
  try {
    const db = getDatabase();
    const row = db.query(`SELECT * FROM oauth_clients WHERE client_id = ?`).get(clientId) as any;
    if (!row) return null;
    let uris: string[] = [];
    try {
      uris = JSON.parse(row.redirect_uris || "[]");
    } catch {}
    return { clientId: row.client_id, clientName: row.client_name, redirectUris: uris, createdAt: row.created_at };
  } catch {
    return null;
  }
}

/**
 * Kiểm tra redirect_uri có được phép cho client này không:
 * - Luôn phải là https hoặc http://localhost.
 * - Nếu client đã đăng ký danh sách redirect_uris: phải khớp một mục
 *   (localhost được khớp bất kể cổng theo RFC 8252).
 * - Client chưa đăng ký (ví dụ client_id mặc định "chatgpt" của luồng cũ):
 *   vẫn phải qua bước nhập Auth Token ở consent nên chỉ kiểm tra scheme.
 */
export function isRedirectUriAllowed(clientId: string, redirectUri: string): boolean {
  if (!isValidRedirectUri(redirectUri)) return false;
  const client = getOAuthClient(clientId);
  if (!client || client.redirectUris.length === 0) return true;
  let target: URL;
  try {
    target = new URL(redirectUri);
  } catch {
    return false;
  }
  return client.redirectUris.some((registered) => {
    try {
      const reg = new URL(registered);
      if (isLocalhostUri(reg) && isLocalhostUri(target)) {
        return reg.protocol === target.protocol && reg.pathname === target.pathname;
      }
      return registered === redirectUri;
    } catch {
      return false;
    }
  });
}

export function issueOAuthTokens(clientId: string, scope?: string): IssuedOAuthTokens {
  const accessToken = "otter_at_" + crypto.randomBytes(32).toString("hex");
  const refreshToken = "otter_rt_" + crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const db = getDatabase();
  db.run(
    `INSERT INTO oauth_tokens (id, client_id, access_token_hash, refresh_token_hash, scope, created_at, access_expires_at, refresh_expires_at, revoked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      crypto.randomUUID(),
      clientId,
      hashToken(accessToken),
      hashToken(refreshToken),
      scope || "all",
      now,
      now + ACCESS_TOKEN_TTL_MS,
      now + REFRESH_TOKEN_TTL_MS,
    ]
  );
  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) };
}

/** Access token OAuth còn hiệu lực không (chưa thu hồi, chưa hết hạn)? */
export function validateOAuthAccessToken(token: string): boolean {
  if (!token || !token.startsWith("otter_at_")) return false;
  try {
    const db = getDatabase();
    const row = db
      .query(`SELECT access_expires_at, revoked FROM oauth_tokens WHERE access_token_hash = ?`)
      .get(hashToken(token)) as any;
    if (!row || row.revoked) return false;
    return row.access_expires_at > Date.now();
  } catch {
    return false;
  }
}

/**
 * Đổi refresh token lấy cặp token mới (xoay vòng):
 * đối chiếu hash, thu hồi cặp cũ, cấp cặp mới cho cùng client.
 * Trả null nếu refresh token không hợp lệ/hết hạn/đã thu hồi.
 */
export function rotateOAuthRefreshToken(refreshToken: string): IssuedOAuthTokens | null {
  if (!refreshToken || !refreshToken.startsWith("otter_rt_")) return null;
  try {
    const db = getDatabase();
    const row = db
      .query(`SELECT id, client_id, scope, refresh_expires_at, revoked FROM oauth_tokens WHERE refresh_token_hash = ?`)
      .get(hashToken(refreshToken)) as any;
    if (!row || row.revoked) return null;
    if (row.refresh_expires_at && row.refresh_expires_at <= Date.now()) return null;
    db.run(`UPDATE oauth_tokens SET revoked = 1 WHERE id = ?`, [row.id]);
    return issueOAuthTokens(row.client_id, row.scope || "all");
  } catch {
    return null;
  }
}

/** Thu hồi toàn bộ token của một client. Trả số bản ghi đã thu hồi. */
export function revokeOAuthClient(clientId: string): number {
  const db = getDatabase();
  const res = db.run(`UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND revoked = 0`, [clientId]) as any;
  return Number(res?.changes ?? 0);
}

export interface OAuthClientSummary extends OAuthClientRecord {
  activeTokens: number;
  lastIssuedAt: number | null;
}

export function listOAuthClients(): OAuthClientSummary[] {
  const db = getDatabase();
  const rows = db
    .query(
      `SELECT c.client_id, c.client_name, c.redirect_uris, c.created_at,
              COUNT(t.id) AS active_tokens, MAX(t.created_at) AS last_issued
       FROM oauth_clients c
       LEFT JOIN oauth_tokens t ON t.client_id = c.client_id AND t.revoked = 0 AND t.access_expires_at > ?
       GROUP BY c.client_id
       ORDER BY c.created_at DESC`
    )
    .all(Date.now()) as any[];
  return rows.map((r) => {
    let uris: string[] = [];
    try {
      uris = JSON.parse(r.redirect_uris || "[]");
    } catch {}
    return {
      clientId: r.client_id,
      clientName: r.client_name,
      redirectUris: uris,
      createdAt: r.created_at,
      activeTokens: Number(r.active_tokens || 0),
      lastIssuedAt: r.last_issued ? Number(r.last_issued) : null,
    };
  });
}
