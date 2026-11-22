/**
 * PAC lab-only worker launcher.
 * Invokes the fixed worker entrypoint directly, never through a shell.
 * This does not impersonate, create, or restrict a Windows user account.
 */
import { spawn } from "bun";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { WorkerReply } from "./pac-windows-worker";

/** Explicit lab gate prevents accidental deployment under an ordinary owner account. */
export function isLabWorkerEnabled(env: Record<string, string | undefined>): boolean {
  return env.PAC_WORKER_LAB_MODE === "1" && env.NODE_ENV === "test";
}

export async function callLabWorker(
  workspaceRoot: string,
  request: unknown,
  options: { timeoutMs?: number } = {}
): Promise<WorkerReply> {
  if (!isLabWorkerEnabled(process.env)) {
    return { ok: false, error: "OS_SANDBOX_NOT_CONFIGURED" };
  }
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
  // Resolve the requested lab root before spawn; this remains a trusted-launcher decision.
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(workspaceRoot);
    if (!(await fs.stat(canonicalRoot)).isDirectory()) throw new Error("not directory");
  } catch { return { ok: false, error: "WORKSPACE_NOT_CONFIGURED" }; }
  // The path and argv layout are internal constants. Models cannot supply
  // shell commands, executable names, env vars, or operating-system flags.
  const entry = path.join(import.meta.dir, "pac-windows-worker.ts");
  const proc = spawn({
    cmd: [process.execPath, entry, canonicalRoot],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      WINDIR: process.env.WINDIR ?? "",
      TEMP: process.env.TEMP ?? "",
      TMP: process.env.TMP ?? "",
      PAC_WORKER_LAB_MODE: "1",
      NODE_ENV: "test",
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeLimit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { proc.kill(); reject(new Error("TIMEOUT")); }, timeout);
    });
    proc.stdin.write(wire);
    proc.stdin.end();
    // Stream with a hard byte limit. Collecting the whole stream and checking
    // afterwards allows a misbehaving child to exhaust broker memory.
    const readBounded = async (): Promise<string> => {
      const reader = proc.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 32768) throw new Error("RESPONSE_TOO_LARGE");
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder("utf-8", { fatal: true }).decode(joined);
    };
    const output = await Promise.race([readBounded(), timeLimit]);
    let response: unknown;
    try { response = JSON.parse(output.trim()); }
    catch { return { ok: false, error: "INVALID_WORKER_RESPONSE" }; }
    if (!response || typeof response !== "object" || typeof (response as any).ok !== "boolean") {
      return { ok: false, error: "INVALID_WORKER_RESPONSE" };
    }
    return response as WorkerReply;
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return { ok: false, error: code === "TIMEOUT" ? "TIMEOUT" :
      code === "RESPONSE_TOO_LARGE" ? "RESPONSE_TOO_LARGE" : "WORKER_FAILED" };
  } finally {
    if (timer) clearTimeout(timer);
    // Each task is one-shot; no session or background worker persists.
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
}
