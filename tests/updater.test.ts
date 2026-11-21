import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// Dùng OTTER_HOME tạm để không đụng cấu hình thật của người dùng.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "otter-updater-"));
process.env.OTTER_HOME = tmpHome;

import {
  compareSemver,
  isCompiledBinary,
  checkForUpdate,
  sha256File,
  swapBinary,
  applyUpdate,
  cleanupAfterUpdate,
} from "../src/daemon/updater";
import { OTTER_VERSION } from "../src/daemon/version";

function mockFetch(versionPayload: any, binaryContent = "NEW-BINARY") {
  return async (url: string) => {
    if (url.includes("/api/version")) {
      return { ok: true, status: 200, json: async () => versionPayload };
    }
    // URL tải binary
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(binaryContent).buffer,
    };
  };
}

describe("updater", () => {
  test("compareSemver so sánh đúng", () => {
    expect(compareSemver("2.1.0", "2.0.0")).toBe(1);
    expect(compareSemver("2.0.0", "2.1.0")).toBe(-1);
    expect(compareSemver("2.1.0", "2.1.0")).toBe(0);
    expect(compareSemver("v2.1.0", "2.1.0")).toBe(0);
    expect(compareSemver("2.1", "2.1.0")).toBe(0);
  });

  test("isCompiledBinary phân biệt bun dev và exe đã biên dịch", () => {
    expect(isCompiledBinary("/usr/local/bin/bun")).toBe(false);
    expect(isCompiledBinary("C:\\tools\\bun.exe")).toBe(false);
    expect(isCompiledBinary("/usr/bin/node")).toBe(false);
    expect(isCompiledBinary("/opt/otter/otter.exe")).toBe(true);
    expect(isCompiledBinary("/opt/otter/otter")).toBe(true);
  });

  test("checkForUpdate đọc đúng phản hồi server", async () => {
    const info = await checkForUpdate(
      mockFetch({
        version: "9.9.9",
        update_available: true,
        mandatory: true,
        download_url: "https://example.com/otter.exe",
        sha256: "abc",
        changelog: "Bản mới",
      }) as any
    );
    expect(info.updateAvailable).toBe(true);
    expect(info.mandatory).toBe(true);
    expect(info.latestVersion).toBe("9.9.9");
    expect(info.currentVersion).toBe(OTTER_VERSION);
    expect(info.lastError).toBeNull();
  });

  test("checkForUpdate không ném lỗi khi server hỏng", async () => {
    const info = await checkForUpdate((async () => {
      throw new Error("network down");
    }) as any);
    expect(info.lastError).toContain("network down");
  });

  test("sha256File tính đúng hash", async () => {
    const file = path.join(tmpHome, "abc.txt");
    fs.writeFileSync(file, "abc");
    const hash = await sha256File(file);
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("swapBinary tráo binary và giữ bản cũ .old", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-swap-"));
    const exe = path.join(dir, "otter");
    const fresh = path.join(dir, "otter.new");
    fs.writeFileSync(exe, "OLD");
    fs.writeFileSync(fresh, "NEW");
    const backup = swapBinary(exe, fresh);
    expect(fs.readFileSync(exe, "utf-8")).toBe("NEW");
    expect(fs.readFileSync(backup, "utf-8")).toBe("OLD");
    expect(fs.existsSync(fresh)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("applyUpdate từ chối khi chạy bằng bun dev", async () => {
    await expect(
      applyUpdate({ exePath: "/usr/local/bin/bun", fetchImpl: mockFetch({}) as any })
    ).rejects.toThrow("chỉ áp dụng cho bản exe đã biên dịch");
  });

  test("applyUpdate tải, xác minh SHA256, tráo binary, ghi marker, chạy lại", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-apply-"));
    const exe = path.join(dir, "otter");
    fs.writeFileSync(exe, "OLD-BINARY");
    const newContent = "NEW-BINARY-V9";
    const sha = crypto.createHash("sha256").update(newContent).digest("hex");

    let restartedWith: string | null = null;
    const info = await applyUpdate({
      exePath: exe,
      fetchImpl: mockFetch(
        {
          version: "9.9.9",
          update_available: true,
          mandatory: false,
          download_url: "https://example.com/otter",
          sha256: sha,
          changelog: "test",
        },
        newContent
      ) as any,
      restartSelf: (p) => {
        restartedWith = p;
      },
    });

    expect(info.updateAvailable).toBe(true);
    expect(fs.readFileSync(exe, "utf-8")).toBe(newContent);
    expect(fs.readFileSync(`${exe}.old`, "utf-8")).toBe("OLD-BINARY");
    expect(restartedWith).toBe(exe);

    const marker = JSON.parse(fs.readFileSync(path.join(tmpHome, "update-pending.json"), "utf-8"));
    expect(marker.toVersion).toBe("9.9.9");
    expect(marker.fromVersion).toBe(OTTER_VERSION);

    // cleanupAfterUpdate với marker không khớp phiên bản hiện tại: giữ nguyên .old.
    cleanupAfterUpdate();
    expect(fs.existsSync(`${exe}.old`)).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("applyUpdate hủy khi SHA256 không khớp", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-badsha-"));
    const exe = path.join(dir, "otter");
    fs.writeFileSync(exe, "OLD-BINARY");
    await expect(
      applyUpdate({
        exePath: exe,
        fetchImpl: mockFetch({
          version: "9.9.9",
          update_available: true,
          mandatory: false,
          download_url: "https://example.com/otter",
          sha256: "0".repeat(64),
          changelog: "test",
        }) as any,
        restartSelf: () => {
          throw new Error("không được chạy lại khi checksum sai");
        },
      })
    ).rejects.toThrow("SHA256 không khớp");
    expect(fs.readFileSync(exe, "utf-8")).toBe("OLD-BINARY");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });
});
