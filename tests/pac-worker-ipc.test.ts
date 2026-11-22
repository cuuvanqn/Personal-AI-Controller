import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callLabWorker } from "../src/worker/pac-worker-launcher";

describe("PAC separate-process worker IPC (lab only)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pac-worker-ipc-"));
  fs.writeFileSync(path.join(root, "note.txt"), "hello from child", "utf8");

  test("worker reads text through a separate child process", async () => {
    const res = await callLabWorker(root, { operation: "read_text", relativePath: "note.txt" });
    expect(res).toEqual({ ok: true, result: { text: "hello from child", bytesRead: 16 } });
  });

  test("worker lists directory and inspects a file", async () => {
    const list = await callLabWorker(root, { operation: "list_directory", relativePath: "." });
    expect(list.ok).toBe(true);
    if (list.ok) expect(JSON.stringify(list.result)).toContain("note.txt");
    const meta = await callLabWorker(root, { operation: "inspect_file", relativePath: "note.txt" });
    expect(meta).toEqual({ ok: true, result: { kind: "file", size: 16 } });
  });

  test("worker rejects arbitrary execution and unexpected arguments", async () => {
    const bad = await callLabWorker(root, { operation: "execute_terminal_command", command: "whoami" });
    expect(bad.ok).toBe(false);
    const extra = await callLabWorker(root, { operation: "read_text", relativePath: "note.txt", command: "cmd.exe" });
    expect(extra).toEqual({ ok: false, error: "UNKNOWN_FIELD" });
  });

  test("worker rejects traversal, absolute paths and malformed limits", async () => {
    for (const file of ["../secret.txt", path.resolve(os.tmpdir(), "secret.txt")]) {
      expect((await callLabWorker(root, { operation: "read_text", relativePath: file })).ok).toBe(false);
    }
    expect((await callLabWorker(root, { operation: "read_text", relativePath: "note.txt", maxBytes: 0 })).ok).toBe(false);
  });

  test("worker refuses links escaping the root", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pac-worker-private-"));
    const link = path.join(root, "outside-link");
    try {
      fs.writeFileSync(path.join(outside, "private.txt"), "secret", "utf8");
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      const result = await callLabWorker(root, { operation: "read_text", relativePath: path.join("outside-link", "private.txt") });
      expect(result).toEqual({ ok: false, error: "ACCESS_DENIED" });
    } finally {
      try { fs.unlinkSync(link); } catch {}
      try { fs.rmSync(outside, { recursive: true, force: true }); } catch {}
    }
  });

  test("launcher rejects unbounded IPC frames or missing root", async () => {
    expect((await callLabWorker("relative-root", { operation: "list_directory", relativePath: "." })).ok).toBe(false);
    const big = await callLabWorker(root, { operation: "read_text", relativePath: "x".repeat(9000) });
    expect(big).toEqual({ ok: false, error: "REQUEST_TOO_LARGE" });
  });
});
