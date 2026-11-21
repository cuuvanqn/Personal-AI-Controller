import { describe, test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  initLicenseDatabase,
  recordUserHeartbeat,
  recordDownloadEvent,
  getTelemetryStats,
  listActiveUsers,
  startLicenseServer,
} from "../src/server/license-server";
import { getAdminSecret } from "../src/server/admin-auth";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-telemetry-test-"));
const unitDbPath = path.join(tmpDir, "unit.sqlite");
const httpDbPath = path.join(tmpDir, "http.sqlite");
const unitDb = initLicenseDatabase(unitDbPath);
const server = startLicenseServer(0, httpDbPath);
const baseUrl = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  try {
    server.stop(true);
  } catch {}
  try {
    unitDb.close();
  } catch {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("Otter Telemetry & Download Counter (DB Logic)", () => {
  test("tracks online, DAU, WAU, signed-in users and preserves Firebase identity", () => {
    const now = new Date("2026-11-21T10:00:00.000Z");
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    // 1. User A signs in via dashboard (online)
    recordUserHeartbeat(unitDb, {
      client_id: "DEV-ONLINE-1",
      firebase_uid: "uid-1",
      email: "Nam@Example.com",
      display_name: "Nam",
      app_version: "2.1.0",
      platform: "win32",
      arch: "x64",
      source: "dashboard",
      ip_address: "1.2.3.4",
      now: fiveMinAgo,
    });

    // Subsequent anonymous daemon heartbeat preserves email & increments count
    recordUserHeartbeat(unitDb, {
      client_id: "DEV-ONLINE-1",
      app_version: "2.1.0",
      platform: "win32",
      source: "daemon",
      now,
    });

    // 2. User B active today but offline (>10m ago)
    recordUserHeartbeat(unitDb, {
      client_id: "DEV-TODAY-2",
      app_version: "2.1.0",
      platform: "darwin",
      arch: "arm64",
      now: twoHoursAgo,
    });

    // 3. User C active 3 days ago (WAU only)
    recordUserHeartbeat(unitDb, {
      client_id: "DEV-WEEK-3",
      app_version: "2.0.0",
      platform: "linux",
      arch: "x64",
      now: threeDaysAgo,
    });

    const stats = getTelemetryStats(unitDb, now);
    expect(stats.onlineNow).toBe(1);
    expect(stats.activeToday).toBe(2);
    expect(stats.active7d).toBe(3);
    expect(stats.totalUsers).toBe(3);
    expect(stats.signedInUsers).toBe(1);

    const onlineOnly = listActiveUsers(unitDb, { filter: "online", now });
    expect(onlineOnly).toHaveLength(1);
    expect(onlineOnly[0].client_id).toBe("DEV-ONLINE-1");
    expect(onlineOnly[0].email).toBe("nam@example.com");
    expect(onlineOnly[0].heartbeat_count).toBe(2);
    expect(onlineOnly[0].is_online).toBe(true);

    const signedIn = listActiveUsers(unitDb, { filter: "signed_in", now });
    expect(signedIn).toHaveLength(1);

    // Logout clears identity
    recordUserHeartbeat(unitDb, {
      client_id: "DEV-ONLINE-1",
      clear_identity: true,
      now,
    });
    expect(getTelemetryStats(unitDb, now).signedInUsers).toBe(0);
  });

  test("aggregates Otter download events by platform, component and 7-day window", () => {
    const now = new Date("2026-11-21T10:00:00.000Z");
    recordDownloadEvent(unitDb, { component: "daemon", platform: "win32", version: "2.1.0", source: "setup-ps1", now });
    recordDownloadEvent(unitDb, { component: "daemon", platform: "darwin", version: "2.1.0", source: "setup-sh", now });
    recordDownloadEvent(unitDb, {
      component: "extension",
      platform: "chrome",
      version: "2.1.0",
      source: "web-home",
      now: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
    });

    const stats = getTelemetryStats(unitDb, now);
    expect(stats.totalDownloads).toBe(3);
    expect(stats.downloadsToday).toBe(2);
    expect(stats.downloads7d).toBe(3);
    expect(stats.dailyDownloads7d).toHaveLength(7);
    expect(stats.dailyDownloads7d[6].count).toBe(2);
  });
});

describe("Otter Telemetry & Downloads HTTP Server", () => {
  const adminHeaders = { "X-Admin-Key": getAdminSecret() };

  test("records heartbeat, download track, safe redirect, and exposes admin APIs & dashboard", async () => {
    // 1. Heartbeat
    const hbRes = await fetch(`${baseUrl}/api/telemetry/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: "OTTR-HTTP-01",
        email: "tester@otter.dev",
        display_name: "Tester",
        version: "2.1.0",
        platform: "win32",
        arch: "x64",
      }),
    });
    expect(hbRes.status).toBe(200);
    const hbJson = (await hbRes.json()) as any;
    expect(hbJson.ok).toBe(true);

    // 2. Download track
    const dlRes = await fetch(`${baseUrl}/api/downloads/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        component: "daemon",
        platform: "windows",
        version: "2.1.0",
        source: "setup-ps1",
      }),
    });
    expect(dlRes.status).toBe(201);

    // 3. Safe redirect vs blocked open redirect
    const badGo = await fetch(`${baseUrl}/api/downloads/go?target=${encodeURIComponent("https://evil.example/a.exe")}`, {
      redirect: "manual",
    });
    expect(badGo.status).toBe(400);

    const goodGo = await fetch(
      `${baseUrl}/api/downloads/go?target=${encodeURIComponent("https://otter.gpt.io.vn/otter-windows-x64.exe")}&component=daemon&platform=windows`,
      { redirect: "manual" }
    );
    expect(goodGo.status).toBe(302);
    expect(goodGo.headers.get("location")).toBe("https://otter.gpt.io.vn/otter-windows-x64.exe");

    // 4. Public stats & versions
    const pubStats = (await (await fetch(`${baseUrl}/api/downloads/stats`)).json()) as any;
    expect(pubStats.online_now).toBe(1);
    expect(pubStats.total_downloads).toBe(2);

    const verRes = (await (await fetch(`${baseUrl}/api/version?component=daemon&client_version=2.0.0`)).json()) as any;
    expect(verRes.update_available).toBe(true);

    // 5. Admin protection (401 without key)
    const unauth = await fetch(`${baseUrl}/api/admin/stats`);
    expect(unauth.status).toBe(401);

    // 6. Admin stats, users, downloads, HTML dashboard
    const admStats = (await (await fetch(`${baseUrl}/api/admin/stats`, { headers: adminHeaders })).json()) as any;
    expect(admStats.success).toBe(true);
    expect(admStats.stats.onlineNow).toBe(1);
    expect(admStats.stats.totalDownloads).toBe(2);

    const admUsers = (await (await fetch(`${baseUrl}/api/admin/users?filter=online`, { headers: adminHeaders })).json()) as any;
    expect(admUsers.users).toHaveLength(1);
    expect(admUsers.users[0].email).toBe("tester@otter.dev");

    const dashHtml = await (await fetch(`${baseUrl}/`, { headers: adminHeaders })).text();
    expect(dashHtml).toContain("Otter Monitor");
    expect(dashHtml).toContain("Danh sách người dùng hoạt động");
    expect(dashHtml).toContain("Tổng lượt tải Otter");
    expect(dashHtml).not.toContain("Cấp License");

    // 7. Admin delete user
    const delRes = await fetch(`${baseUrl}/api/admin/users/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders },
      body: JSON.stringify({ client_id: "OTTR-HTTP-01" }),
    });
    expect(delRes.status).toBe(200);
    const afterDel = (await (await fetch(`${baseUrl}/api/admin/users`, { headers: adminHeaders })).json()) as any;
    expect(afterDel.users).toHaveLength(0);
  });
});
