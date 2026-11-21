import * as fs from "node:fs";
import * as path from "node:path";
import type { Database } from "bun:sqlite";
import { getTelemetryStats, listActiveUsers, listRecentDownloads } from "../license-server";
import { OTTER_VERSION } from "../../daemon/version";

let cachedLoginHtml: string | null = null;
let cachedDashboardHtml: string | null = null;

function getViewsDir(): string {
  return path.join(import.meta.dir);
}

/**
 * Mã hóa ký tự HTML an toàn chống XSS
 */
export function escapeHtml(str: any): string {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render trang Đăng nhập Quản trị viên (Google Firebase)
 */
export function renderAdminLoginPage(): string {
  if (!cachedLoginHtml || process.env.NODE_ENV !== "production") {
    const file = path.join(getViewsDir(), "login.html");
    cachedLoginHtml = fs.readFileSync(file, "utf-8");
  }
  return cachedLoginHtml;
}

function fmtRelative(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (Number.isNaN(diffSec)) return "—";
  if (diffSec < 60) return `${diffSec} giây trước`;
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.floor(h / 24);
  return `${d} ngày trước`;
}

/**
 * Render Bảng Điều Khiển Quản Lý Người Dùng Hoạt Động & Lượt Tải Otter
 */
export function renderAdminDashboard(db: Database, port: number, adminUser: string = "Admin"): string {
  if (!cachedDashboardHtml || process.env.NODE_ENV !== "production") {
    const file = path.join(getViewsDir(), "dashboard.html");
    cachedDashboardHtml = fs.readFileSync(file, "utf-8");
  }

  const stats = getTelemetryStats(db);
  const initialUsers = listActiveUsers(db, { filter: "all", limit: 100 });
  const initialDownloads = listRecentDownloads(db, 40);

  let versionsList: any[] = [];
  try {
    versionsList = db.query("SELECT * FROM app_versions").all() as any[];
  } catch {}
  const daemonVer = versionsList.find((v) => v.component === "daemon")?.version || OTTER_VERSION;
  const extVer = versionsList.find((v) => v.component === "extension")?.version || OTTER_VERSION;

  const initialPayload = JSON.stringify({
    stats,
    users: initialUsers,
    downloads: initialDownloads,
    versions: versionsList,
    serverTime: new Date().toISOString(),
  }).replace(/</g, "\\u003c");

  const userRows =
    initialUsers.length === 0
      ? '<tr><td colspan="7" class="empty-cell">Chưa có thiết bị hoặc người dùng nào gửi tín hiệu hoạt động.</td></tr>'
      : initialUsers
          .map(
            (u) => `
          <tr>
            <td><span class="pill ${u.is_online ? "pill-online" : "pill-offline"}">${u.is_online ? "Đang online" : "Ngoại tuyến"}</span></td>
            <td>
              <div class="cell-primary">${escapeHtml(u.email || u.display_name || "Người dùng ẩn danh")}</div>
              <div class="cell-sub mono">${escapeHtml(u.client_id)}${u.hostname ? " · " + escapeHtml(u.hostname) : ""}</div>
            </td>
            <td><span class="chip">${escapeHtml(u.platform)}${u.arch ? " / " + escapeHtml(u.arch) : ""}</span></td>
            <td><span class="mono">v${escapeHtml(u.app_version)}</span></td>
            <td><span class="mono">${u.heartbeat_count}</span></td>
            <td><span class="mono cell-sub">${escapeHtml(u.ip_address || "—")}</span></td>
            <td>
              <div class="cell-primary">${escapeHtml(fmtRelative(u.last_seen_at))}</div>
              <div class="cell-sub mono">${escapeHtml(new Date(u.last_seen_at).toLocaleString("vi-VN"))}</div>
            </td>
          </tr>`
          )
          .join("");

  return cachedDashboardHtml
    .replace(/\{\{PORT\}\}/g, escapeHtml(String(port)))
    .replace(/\{\{ADMIN_USER\}\}/g, escapeHtml(adminUser))
    .replace(/\{\{DAEMON_VERSION\}\}/g, escapeHtml(daemonVer))
    .replace(/\{\{EXT_VERSION\}\}/g, escapeHtml(extVer))
    .replace(/\{\{ONLINE_NOW\}\}/g, escapeHtml(String(stats.onlineNow)))
    .replace(/\{\{ACTIVE_TODAY\}\}/g, escapeHtml(String(stats.activeToday)))
    .replace(/\{\{ACTIVE_7D\}\}/g, escapeHtml(String(stats.active7d)))
    .replace(/\{\{TOTAL_USERS\}\}/g, escapeHtml(String(stats.totalUsers)))
    .replace(/\{\{SIGNED_IN_USERS\}\}/g, escapeHtml(String(stats.signedInUsers)))
    .replace(/\{\{TOTAL_DOWNLOADS\}\}/g, escapeHtml(String(stats.totalDownloads)))
    .replace(/\{\{DOWNLOADS_TODAY\}\}/g, escapeHtml(String(stats.downloadsToday)))
    .replace(/\{\{DOWNLOADS_7D\}\}/g, escapeHtml(String(stats.downloads7d)))
    .replace(/\{\{INITIAL_USER_ROWS\}\}/g, userRows)
    .replace(/\{\{INITIAL_DATA_JSON\}\}/g, initialPayload);
}
