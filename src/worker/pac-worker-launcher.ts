/**
 * PAC lab-only worker launcher.
 * Invokes the fixed worker entrypoint directly, never through a shell.
 * This does not impersonate, create, or restrict a Windows user account.
 */
import { spawn } from "bun";
import * as path from "node:path";
import type { WorkerReply } from "./pac-windows-worker";

export async function callLabWorker(
  workspaceRoot: string,
  request: unknown,
  options: { timeoutMs?: number } = {}
): Promise<WorkerReply> {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
    return { ok: false, error: "WORKSPACE_NOT_CONFIGURED" };
  }
  const timeout = options.timeoutMs ?? 3000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 10000) {
    return { ok: false, error: "INVALID_TIMEOUT" };
  }
  let wire: string;
  try { wire = JSON.stringify(request); } catch { return { ok: false, error: "INVALID_REQUEST" }; }
  if (typeof wire !== "string" || Buffer.byteLength(wire) > 8192) {
    return { ok: false, error: "REQUEST_TOO_LARGE" };
  }
  // The path and argv layout are internal constants. Models cannot supply
  // shell commands, executable names, env vars, or operating-system flags.
  const entry = path.join(import.meta.dir, "pac-windows-worker.ts");
  const proc = spawn({
    cmd: [process.execPath, entry, workspaceRoot],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      WINDIR: process.env.WINDIR ?? "",
      TEMP: process.env.TEMP ?? "",
      TMP: process.env.TMP ?? "",
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeLimit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { proc.kill(); reject(new Error("TIMEOUT")); }, timeout);
    });
    proc.stdin.write(wire);
    proc.stdin.end();
    const output = await Promise.race([new Response(proc.stdout).text(), timeLimit]);
    if (Buffer.byteLength(output) > 32768) return { ok: false, error: "RESPONSE_TOO_LARGE" };
    let response: unknown;
    try { response = JSON.parse(output.trim()); }
    catch { return { ok: false, error: "INVALID_WORKER_RESPONSE" }; }
    if (!response || typeof response !== "object" || typeof (response as any).ok !== "boolean") {
      return { ok: false, error: "INVALID_WORKER_RESPONSE" };
    }
    return response as WorkerReply;
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.message === "TIMEOUT"
      ? "TIMEOUT" : "WORKER_FAILED" };
  } finally {
    if (timer) clearTimeout(timer);
    // Each task is one-shot; no session or background worker persists.
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
}
