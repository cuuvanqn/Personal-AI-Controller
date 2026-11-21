import { describe, test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { startLicenseServer } from "../src/server/license-server";
import { getAdminSecret } from "../src/server/admin-auth";
import { OTTER_VERSION } from "../src/daemon/version";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-e2e-update-"));
const dbPath = path.join(tmpDir, "monitor.sqlite");
const otterHome = path.join(tmpDir, "otter-home");
fs.mkdirSync(otterHome, { recursive: true });

const monitorServer = startLicenseServer(0, dbPath);
const monitorUrl = `http://127.0.0.1:${monitorServer.port}`;
const adminHeaders = { "X-Admin-Key": getAdminSecret() };

let fileServer: ReturnType<typeof Bun.serve> | null = null;
let spawnedNewPid: number | null = null;

afterAll(() => {
  if (spawnedNewPid) {
    try {
      process.kill(spawnedNewPid);
    } catch {}
  }
  try {
    fileServer?.stop(true);
  } catch {}
  try {
    monitorServer.stop(true);
  } catch {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("Auto-update E2E (Compiled EXE + Real Otter Monitor Server)", () => {
  test("platform-aware /api/version maps Windows URL to Linux and macOS binaries", async () => {
    const linuxRes = (await (
      await fetch(`${monitorUrl}/api/version?component=daemon&client_version=2.0.0&platform=linux&arch=x64`)
    ).json()) as any;
    expect(linuxRes.download_url).toEndWith("/otter-linux-x64");

    const macRes = (await (
      await fetch(`${monitorUrl}/api/version?component=daemon&client_version=2.0.0&platform=darwin&arch=arm64`)
    ).json()) as any;
    expect(macRes.download_url).toEndWith("/otter-darwin-arm64");

    const winRes = (await (
      await fetch(`${monitorUrl}/api/version?component=daemon&client_version=2.0.0&platform=win32&arch=x64`)
    ).json()) as any;
    expect(winRes.download_url).toEndWith("/otter-windows-x64.exe");
  });

  test(
    "running compiled binary downloads update from server, verifies SHA-256, swaps itself, frees port, and boots new binary",
    async () => {
      const repoRoot = process.cwd();
      const updaterModulePath = path.join(repoRoot, "src", "daemon", "updater.ts").replace(/\\/g, "/");
      const ext = process.platform === "win32" ? ".exe" : "";

      // 1. Tạo source & compile bản mới v9.9.9
      const newSrc = path.join(tmpDir, "new-app.ts");
      const newExe = path.join(tmpDir, `otter-new${ext}`);
      fs.writeFileSync(
        newSrc,
        `
        import * as fs from "node:fs";
        import * as path from "node:path";
        const port = Number(process.env.TEST_DAEMON_PORT);
        const home = process.env.OTTER_HOME!;
        const markerPath = path.join(home, "update-pending.json");
        let cleanedOld = false;
        try {
          const m = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
          if (m.toVersion === "9.9.9") {
            if (m.backupPath && fs.existsSync(m.backupPath)) {
              for (let i = 0; i < 15; i++) {
                try { fs.rmSync(m.backupPath, { force: true }); cleanedOld = true; break; } catch { Bun.sleepSync(100); }
              }
            }
            fs.rmSync(markerPath, { force: true });
          }
        } catch {}
        const srv = Bun.serve({
          port,
          fetch(req) {
            const u = new URL(req.url);
            if (u.pathname === "/who") {
              return Response.json({
                version: "9.9.9",
                pid: process.pid,
                updatedFrom: process.env.OTTER_UPDATED_FROM || null,
                cleanedOld,
              });
            }
            if (u.pathname === "/shutdown") {
              setTimeout(() => process.exit(0), 20);
              return Response.json({ ok: true });
            }
            return new Response("not found", { status: 404 });
          },
        });
        console.log("NEW_READY:" + srv.port);
        `,
        "utf-8"
      );

      const buildNew = spawnSync("bun", ["build", "--compile", newSrc, "--outfile", newExe], {
        cwd: repoRoot,
        encoding: "utf-8",
      });
      expect(buildNew.status).toBe(0);

      // 2. Tính SHA-256 thật của bản mới và phục vụ qua HTTP cục bộ
      const newBytes = fs.readFileSync(newExe);
      const newSha256 = crypto.createHash("sha256").update(newBytes).digest("hex");

      fileServer = Bun.serve({
        port: 0,
        fetch() {
          return new Response(newBytes, { headers: { "Content-Type": "application/octet-stream" } });
        },
      });
      const downloadUrl = `http://127.0.0.1:${fileServer.port}/otter-release-9.9.9${ext}`;

      // 3. Công bố bản mới v9.9.9 lên Otter Monitor server qua API quản trị thật
      const pubRes = await fetch(`${monitorUrl}/api/admin/version/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders },
        body: JSON.stringify({
          component: "daemon",
          version: "9.9.9",
          min_supported_version: "2.0.0",
          download_url: downloadUrl,
          sha256: newSha256,
          changelog: "E2E auto-update test release",
        }),
      });
      expect(pubRes.status).toBe(200);

      // 4. Tạo source & compile bản cũ (sử dụng trực tiếp src/daemon/updater.ts thật)
      const oldSrc = path.join(tmpDir, "old-app.ts");
      const liveExe = path.join(tmpDir, `otter-live${ext}`);
      fs.writeFileSync(
        oldSrc,
        `
        import { applyUpdate, registerBeforeRestartHook } from "${updaterModulePath}";
        const port = Number(process.env.TEST_DAEMON_PORT);
        const srv = Bun.serve({
          port,
          fetch(req) {
            const u = new URL(req.url);
            if (u.pathname === "/who") {
              return Response.json({ version: "${OTTER_VERSION}", pid: process.pid });
            }
            if (u.pathname === "/trigger-update" && req.method === "POST") {
              setTimeout(() => {
                applyUpdate().catch((e) => {
                  console.error("APPLY_ERR:" + e.message);
                  process.exit(2);
                });
              }, 80);
              return Response.json({ ok: true });
            }
            return new Response("not found", { status: 404 });
          },
        });
        registerBeforeRestartHook(() => srv.stop(true));
        console.log("OLD_READY:" + srv.port);
        `,
        "utf-8"
      );

      const buildOld = spawnSync("bun", ["build", "--compile", oldSrc, "--outfile", liveExe], {
        cwd: repoRoot,
        encoding: "utf-8",
      });
      expect(buildOld.status).toBe(0);

      // 5. Chọn 1 port trống rồi chạy bản cũ đã biên dịch
      const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
      const testPort = probe.port;
      probe.stop(true);

      const child = spawn(liveExe, [], {
        env: {
          ...process.env,
          TEST_DAEMON_PORT: String(testPort),
          OTTER_HOME: otterHome,
          OTTER_UPDATE_URL: monitorUrl,
          OTTER_TELEMETRY_URL: monitorUrl,
        },
        stdio: "ignore",
      });

      // Chờ bản cũ sẵn sàng
      let oldInfo: any = null;
      for (let i = 0; i < 40; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${testPort}/who`);
          if (r.ok) {
            oldInfo = await r.json();
            break;
          }
        } catch {}
        await Bun.sleep(100);
      }
      expect(oldInfo?.version).toBe(OTTER_VERSION);

      // 6. Kích hoạt tự động cập nhật (giống nút "Cập nhật ngay" trên Dashboard)
      const trigRes = await fetch(`http://127.0.0.1:${testPort}/trigger-update`, { method: "POST" });
      expect(trigRes.status).toBe(200);

      // 7. Chờ bản mới v9.9.9 khởi động lại trên CÙNG CỔNG testPort
      let newInfo: any = null;
      for (let i = 0; i < 80; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${testPort}/who`);
          if (r.ok) {
            const j = (await r.json()) as any;
            if (j.version === "9.9.9") {
              newInfo = j;
              spawnedNewPid = j.pid;
              break;
            }
          }
        } catch {}
        await Bun.sleep(150);
      }

      expect(newInfo).not.toBeNull();
      expect(newInfo.version).toBe("9.9.9");
      expect(newInfo.pid).not.toBe(oldInfo.pid);
      expect(newInfo.updatedFrom).toBe(OTTER_VERSION);
      expect(newInfo.cleanedOld).toBe(true);

      // Tắt bản mới gọn gàng
      await fetch(`http://127.0.0.1:${testPort}/shutdown`).catch(() => {});
      try {
        child.kill();
      } catch {}

      // 8. Kiểm tra Otter Monitor đã tự ghi nhận lượt tải từ nguồn updater
      const dlStats = (await (await fetch(`${monitorUrl}/api/admin/downloads`, { headers: adminHeaders })).json()) as any;
      expect(dlStats.total).toBeGreaterThanOrEqual(1);
      expect(dlStats.downloads.some((d: any) => d.source === "updater" && d.version === "9.9.9")).toBe(true);
    },
    30000
  );
});
