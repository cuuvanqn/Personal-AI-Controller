import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { OTTER_VERSION } from "./version";
import { getOtterDir } from "./db";
import { trackOtterDownload } from "./telemetry";

/**
 * Tự cập nhật Otter Daemon (bản exe đã biên dịch bằng bun build --compile).
 *
 * Luồng: kiểm tra /api/version trên license server -> tải binary mới ->
 * xác minh SHA256 (nếu server công bố) -> tráo binary (bản cũ giữ ở .old)
 * -> chạy lại tiến trình mới -> lần khởi động sau dọn marker + .old.
 *
 * Chính sách:
 * - Bản bắt buộc (mandatory, dưới min_supported_version): tự áp dụng ngay.
 * - OTTER_AUTO_UPDATE=1: tự áp dụng mọi bản mới.
 * - Mặc định: chỉ thông báo (Dashboard hiện nút "Cập nhật ngay").
 * - Chạy dev bằng `bun src/daemon/index.ts`: không tự tráo binary
 *   (process.execPath là bun) — chỉ thông báo.
 */

export interface UpdateInfo {
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

function getUpdateBaseUrl(): string {
  return (process.env.OTTER_UPDATE_URL || process.env.OTTER_LICENSE_URL || "https://license.gpt.io.vn").replace(/\/+$/, "");
}

let beforeRestartHook: (() => void) | null = null;

/** Đăng ký hook giải phóng cổng (vd: server.stop(true)) trước khi spawn bản mới để tránh EADDRINUSE. */
export function registerBeforeRestartHook(fn: () => void): void {
  beforeRestartHook = fn;
}

let lastInfo: UpdateInfo = {
  currentVersion: OTTER_VERSION,
  latestVersion: null,
  updateAvailable: false,
  mandatory: false,
  downloadUrl: null,
  sha256: null,
  changelog: null,
  lastCheckedAt: null,
  autoUpdateEnabled: process.env.OTTER_AUTO_UPDATE === "1",
  isCompiledBinary: isCompiledBinary(),
  lastError: null,
};

/** Đang chạy từ binary đã biên dịch (otter.exe) hay từ bun/node dev? */
export function isCompiledBinary(execPath: string = process.execPath): boolean {
  // Chuẩn hóa cả 2 loại dấu phân tách để đúng trên mọi hệ điều hành.
  const base = (execPath.split(/[/\\]/).pop() || "").toLowerCase();
  return !/^(bun|bunx|node|deno)(\.exe)?$/.test(base);
}

export function compareSemver(v1: string, v2: string): number {
  const parse = (v: string) => (v || "").replace(/^[^\d]*/, "").split(".").map((n) => parseInt(n, 10) || 0);
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

type FetchLike = (url: string, init?: any) => Promise<any>;

/** Kiểm tra phiên bản mới trên license server. Không ném lỗi ra ngoài. */
export async function checkForUpdate(fetchImpl: FetchLike = fetch as any): Promise<UpdateInfo> {
  try {
    const url = `${getUpdateBaseUrl()}/api/version?component=daemon&client_version=${encodeURIComponent(OTTER_VERSION)}&platform=${encodeURIComponent(process.platform)}&arch=${encodeURIComponent(process.arch)}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`License server trả HTTP ${res.status}`);
    const data = await res.json();
    lastInfo = {
      ...lastInfo,
      latestVersion: data.version || null,
      updateAvailable: Boolean(data.update_available),
      mandatory: Boolean(data.mandatory),
      downloadUrl: data.download_url || null,
      sha256: data.sha256 || null,
      changelog: data.changelog || null,
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
    };
  } catch (err: any) {
    lastInfo = { ...lastInfo, lastCheckedAt: new Date().toISOString(), lastError: err.message };
  }
  return lastInfo;
}

export function getUpdateStatus(): UpdateInfo {
  return { ...lastInfo, autoUpdateEnabled: process.env.OTTER_AUTO_UPDATE === "1" };
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function downloadFile(url: string, dest: string, fetchImpl: FetchLike = fetch as any): Promise<void> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`Tải bản cập nhật thất bại: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

/**
 * Tráo binary: exe hiện tại -> exe.old, binary mới -> exe.
 * Trả về đường dẫn bản cũ (.old) để rollback thủ công khi cần.
 */
export function swapBinary(exePath: string, newBinaryPath: string): string {
  const backupPath = `${exePath}.old`;
  if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
  fs.renameSync(exePath, backupPath);
  try {
    fs.renameSync(newBinaryPath, exePath);
  } catch (err) {
    // rename khác ổ đĩa có thể lỗi -> copy rồi xóa nguồn.
    fs.copyFileSync(newBinaryPath, exePath);
    fs.rmSync(newBinaryPath, { force: true });
  }
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(exePath, 0o755);
    } catch {}
  }
  return backupPath;
}

function markerPath(): string {
  return path.join(getOtterDir(), "update-pending.json");
}

/**
 * Dọn dẹp sau cập nhật: gọi khi daemon khởi động thành công.
 * Nếu marker khớp phiên bản hiện tại -> xóa marker + binary cũ.
 */
export function cleanupAfterUpdate(): void {
  try {
    const raw = fs.readFileSync(markerPath(), "utf-8");
    const marker = JSON.parse(raw);
    if (marker.toVersion === OTTER_VERSION) {
      console.log(`[Updater] ✅ Cập nhật thành công lên v${OTTER_VERSION} (từ v${marker.fromVersion}).`);
      if (marker.backupPath && fs.existsSync(marker.backupPath)) {
        try {
          fs.rmSync(marker.backupPath, { force: true });
        } catch {
          // Windows có thể giữ khóa tiến trình cũ thêm vài trăm ms khi vừa tắt -> thử xóa lại sau 1.5s
          setTimeout(() => {
            try { fs.rmSync(marker.backupPath, { force: true }); } catch {}
          }, 1500);
        }
      }
      fs.rmSync(markerPath(), { force: true });
    } else {
      console.warn(
        `[Updater] ⚠️ Marker cập nhật còn tồn tại (mong đợi v${marker.toVersion}, hiện tại v${OTTER_VERSION}). ` +
          `Bản cũ vẫn ở ${marker.backupPath} — đổi tên lại thành file exe để rollback nếu cần.`
      );
    }
  } catch {
    // Không có marker -> bình thường.
  }
}

export interface ApplyUpdateOptions {
  fetchImpl?: FetchLike;
  /** Hàm chạy lại tiến trình mới (mặc định spawn detached + exit). Test có thể thay thế. */
  restartSelf?: (exePath: string) => void;
  exePath?: string;
}

/**
 * Áp dụng bản cập nhật: tải -> xác minh SHA256 -> tráo binary -> chạy lại.
 * Chỉ dùng cho bản exe đã biên dịch.
 */
export async function applyUpdate(opts: ApplyUpdateOptions = {}): Promise<UpdateInfo> {
  const exePath = opts.exePath || process.execPath;
  if (!isCompiledBinary(exePath)) {
    throw new Error(
      "Tự cập nhật chỉ áp dụng cho bản exe đã biên dịch. Bản dev hãy dùng git pull / bun run build:exe."
    );
  }

  const info = await checkForUpdate(opts.fetchImpl);
  if (!info.updateAvailable || !info.downloadUrl || !info.latestVersion) {
    return info;
  }

  const exeDir = path.dirname(exePath);
  const newBinaryPath = path.join(exeDir, `.otter-update-${info.latestVersion}.tmp`);
  console.log(`[Updater] Đang tải Otter v${info.latestVersion} từ ${info.downloadUrl} ...`);
  await downloadFile(info.downloadUrl, newBinaryPath, opts.fetchImpl);
  void trackOtterDownload({
    component: "daemon",
    platform: process.platform,
    version: info.latestVersion,
    source: "updater",
    fetchImpl: opts.fetchImpl as any,
  });

  if (info.sha256) {
    const actual = await sha256File(newBinaryPath);
    if (actual.toLowerCase() !== info.sha256.toLowerCase()) {
      fs.rmSync(newBinaryPath, { force: true });
      throw new Error(`SHA256 không khớp (mong đợi ${info.sha256}, thực tế ${actual}). Đã hủy cập nhật.`);
    }
    console.log("[Updater] ✅ SHA256 khớp.");
  } else {
    console.warn("[Updater] ⚠️ Server chưa công bố SHA256 cho bản này — bỏ qua bước xác minh checksum.");
  }

  const backupPath = swapBinary(exePath, newBinaryPath);
  fs.writeFileSync(
    markerPath(),
    JSON.stringify(
      { fromVersion: OTTER_VERSION, toVersion: info.latestVersion, exePath, backupPath, at: new Date().toISOString() },
      null,
      2
    ),
    "utf-8"
  );
  console.log(`[Updater] Đã tráo binary. Bản cũ giữ ở ${backupPath}. Đang khởi động lại...`);

  const restart =
    opts.restartSelf ||
    ((p: string) => {
      // Giải phóng cổng HTTP (1993) trước khi khởi chạy bản mới để tránh lỗi EADDRINUSE
      try {
        beforeRestartHook?.();
      } catch {}
      const child = spawn(p, process.argv.slice(2), {
        detached: true,
        stdio: "inherit",
        env: { ...process.env, OTTER_UPDATED_FROM: OTTER_VERSION },
      });
      child.unref();
      setTimeout(() => process.exit(0), 50);
    });
  restart(exePath);
  return info;
}

/**
 * Lịch kiểm tra cập nhật: lần đầu sau 15 giây, sau đó mỗi 6 giờ.
 * Bản bắt buộc luôn tự áp dụng; bản thường chỉ tự áp dụng khi OTTER_AUTO_UPDATE=1.
 */
export function startUpdateScheduler(onActivity?: (event: any) => void): void {
  const run = async () => {
    const info = await checkForUpdate();
    if (!info.updateAvailable) return;
    onActivity?.({
      type: "update_available",
      version: info.latestVersion,
      mandatory: info.mandatory,
      changelog: info.changelog,
    });
    console.log(
      `\n🎉 [Otter Update] Đã có phiên bản daemon mới: v${info.latestVersion}${info.mandatory ? " (BẮT BUỘC)" : ""}!` +
        `\n👉 Tải tại: ${info.downloadUrl}\n`
    );
    if (info.mandatory || info.autoUpdateEnabled) {
      try {
        await applyUpdate();
      } catch (err: any) {
        console.warn(`[Updater] Tự cập nhật thất bại: ${err.message}`);
        onActivity?.({ type: "update_failed", error: err.message });
      }
    }
  };
  setTimeout(() => void run(), 15000);
  setInterval(() => void run(), 6 * 60 * 60 * 1000);
}
