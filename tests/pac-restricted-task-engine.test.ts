import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeRestrictedTask } from "../src/daemon/pac-restricted-task-engine";
import { registerAllowedWorkspace } from "../src/daemon/security";

describe("PAC read-only task engine", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pac-task-test-"));
  registerAllowedWorkspace(work);
  const textPath = path.join(work, "note.txt");
  fs.writeFileSync(textPath, "PAC read-only fixture", "utf8");

  it("lists entries without executing commands", async () => {
    const result = await executeRestrictedTask({ operation: "list_directory", directoryPath: work, maxEntries: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.stringify(result.result)).toContain("note.txt");
  });

  it("reads bounded text and inspects metadata", async () => {
    const r = await executeRestrictedTask({ operation: "read_text", filePath: textPath });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toEqual({ text: "PAC read-only fixture", bytesRead: 21 });
    const meta = await executeRestrictedTask({ operation: "inspect_file", filePath: textPath });
    expect(meta.ok).toBe(true);
  });

  it("rejects shell, unknown tools, injected arguments and extra fields", async () => {
    for (const task of [
      { operation: "execute_terminal_command", command: "echo unsafe" },
      { operation: "read_text", filePath: textPath, command: "rm -rf /" },
      { operation: "read_text", filePath: textPath, maxBytes: 500000 },
      { operation: "list_directory", directoryPath: work, maxEntries: 200000 },
      { operation: "read_text", filePath: textPath + "\0evil" },
      { operation: "read_text", filePath: textPath, maxBytes: -1 },
    ]) {
      const result = await executeRestrictedTask(task);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects files outside granted workspace", async () => {
    const result = await executeRestrictedTask({ operation: "read_text", filePath: path.join(os.tmpdir(), "unapproved-file.txt") });
    expect(result.ok).toBe(false);
  });

  it("rejects oversized files and binary UTF-8 errors", async () => {
    const large = path.join(work, "big.txt");
    const binary = path.join(work, "binary.bin");
    fs.writeFileSync(large, "a".repeat(16385));
    fs.writeFileSync(binary, Buffer.from([0xff, 0xfe]));
    expect((await executeRestrictedTask({ operation: "read_text", filePath: large })).ok).toBe(false);
    expect((await executeRestrictedTask({ operation: "read_text", filePath: binary })).ok).toBe(false);
  });

  it("rejects workspace junction and symlink escape", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pac-engine-outside-"));
    const link = path.join(work, "escape");
    try {
      fs.writeFileSync(path.join(outside, "private.txt"), "confidential");
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      expect((await executeRestrictedTask({ operation: "read_text", filePath: path.join(link, "private.txt") })).ok).toBe(false);
    } finally {
      try { fs.unlinkSync(link); } catch {}
      try { fs.rmSync(outside, { recursive: true, force: true }); } catch {}
    }
  });
});
