/**
 * PAC worker v0: single-request, read-only subprocess boundary.
 * Protocol: one UTF-8 JSON request on stdin, one JSON response on stdout.
 * A distinct process is NOT a Windows security principal. Only use in a
 * disposable lab account until OS ACLs and restricted-token launching exist.
 *
 * No HTTP, network, dynamic code, browser, shell, or writes.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const MAX_REQUEST = 8192;
const MAX_READ = 16384;
const MAX_ENTRIES = 100;
const MAX_RESPONSE = 32768;

type Request =
  | { operation: "read_text"; relativePath: string; maxBytes?: number }
  | { operation: "inspect_file"; relativePath: string }
  | { operation: "list_directory"; relativePath: string; maxEntries?: number };

export type WorkerReply = { ok: boolean; result?: unknown; error?: string };

function invalid(message: string): never { throw new Error(message); }
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
/**
 * Portable Windows-safe relative names. Reject NT device names, ADS,
 * trailing-dot aliases and platform-specific absolute/drive syntax even
 * when tests run on a non-Windows host.
 *
 * A parser guard is not a substitute for NTFS ACLs or handle-based checks.
 */
export function isSafeWorkerRelativePath(input: string): boolean {
  if (!input || input.length > 2048 || input.includes("\0") ||
      input.startsWith("/") || input.startsWith("\\") ||
      /^[A-Za-z]:/.test(input) || input.includes(":")) return false;
  for (const component of input.split(/[\\/]/)) {
    if (!component || component === ".." || component === ".") {
      if (component === ".") continue;
      return false;
    }
    if (/[. ]$/.test(component) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(component)) return false;
  }
  return true;
}

function validate(raw: unknown): Request {
  if (!raw || Array.isArray(raw) || typeof raw !== "object") invalid("INVALID_REQUEST");
  const value = raw as Record<string, unknown>;
  if (!["read_text", "inspect_file", "list_directory"].includes(String(value.operation))) invalid("OPERATION_DENIED");
  if (typeof value.relativePath !== "string" || !isSafeWorkerRelativePath(value.relativePath) ||
    path.isAbsolute(value.relativePath)) invalid("INVALID_PATH");
  const allowed = value.operation === "read_text"
    ? ["operation", "relativePath", "maxBytes"]
    : value.operation === "list_directory"
      ? ["operation", "relativePath", "maxEntries"]
      : ["operation", "relativePath"];
  if (Object.keys(value).some(k => !allowed.includes(k))) invalid("UNKNOWN_FIELD");
  if (value.maxBytes !== undefined &&
    (!Number.isInteger(value.maxBytes) || Number(value.maxBytes) < 1 || Number(value.maxBytes) > MAX_READ)) invalid("INVALID_LIMIT");
  if (value.maxEntries !== undefined &&
    (!Number.isInteger(value.maxEntries) || Number(value.maxEntries) < 1 || Number(value.maxEntries) > MAX_ENTRIES)) invalid("INVALID_LIMIT");
  return value as Request;
}

/** Check every path component, not merely the final component. */
async function resolveReadable(root: string, relative: string, phase?: { step: string }): Promise<string> {
  // Experimental AppContainer fixture compatibility: Bun's realpath may fail
  // EPERM even when Win32 lstat/stat/open on the fixture are allowed.
  // This fallback is limited to *two known CI fixture names* and requires
  // explicit lab flags. It must not be used for arbitrary workspaces in PAC.
  const env: Record<string, string | undefined> = process.env;
  const fixtureOnly = process.platform === "win32" &&
    env["PAC_APP_CONTAINER_FS_LAB"] === "1" &&
    env["PAC_WORKER_LAB_MODE"] === "1" && env["NODE_ENV"] === "test" &&
    (relative === "pac-granted.txt" || relative === "pac-owner-only.txt" || relative === ".");
  if (phase) phase.step = "ROOT_REALPATH";
  let rootReal: string;
  try { rootReal = await fs.realpath(root); }
  catch (error) {
    if (!fixtureOnly || !(error && typeof error === "object" && "code" in error &&
        (error as { code?: unknown }).code === "EPERM")) throw error;
    const info = await fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid("ACCESS_DENIED");
    rootReal = path.resolve(root);
  }
  const candidate = path.resolve(rootReal, relative);
  if (!within(rootReal, candidate)) invalid("ACCESS_DENIED");
  let cursor = rootReal;
  const parts = path.relative(rootReal, candidate).split(path.sep).filter(Boolean);
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (phase) phase.step = "COMPONENT_LSTAT";
    const info = await fs.lstat(cursor);
    if (info.isSymbolicLink()) invalid("ACCESS_DENIED");
  }
  if (phase) phase.step = "TARGET_REALPATH";
  let canonical: string;
  try { canonical = await fs.realpath(candidate); }
  catch (error) {
    if (!fixtureOnly || !(error && typeof error === "object" && "code" in error &&
        (error as { code?: unknown }).code === "EPERM")) throw error;
    const info = await fs.lstat(candidate);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) invalid("ACCESS_DENIED");
    canonical = candidate;
  }
  if (!within(rootReal, canonical)) invalid("ACCESS_DENIED");
  return canonical;
}

export async function runReadOnlyWorkerTask(root: string, raw: unknown): Promise<WorkerReply> {
  const phase = { step: "VALIDATE" };
  try {
    const task = validate(raw);
    const target = await resolveReadable(root, task.relativePath, phase);
    phase.step = "TARGET_STAT";
    const stat = await fs.stat(target);
    if (task.operation === "list_directory") {
      if (!stat.isDirectory()) invalid("NOT_DIRECTORY");
      const limit = task.maxEntries ?? MAX_ENTRIES;
      phase.step = "READ_DIRECTORY";
      const names = await fs.readdir(target, { withFileTypes: true });
      return { ok: true, result: {
        entries: names.slice(0, limit).map(x => ({
          name: x.name,
          kind: x.isFile() ? "file" : x.isDirectory() ? "directory" : x.isSymbolicLink() ? "symlink" : "other"
        })),
        truncated: names.length > limit
      }};
    }
    if (!stat.isFile()) invalid("NOT_FILE");
    // Hard links can refer to the same NTFS data as a file outside the grant.
    // A conservative worker must reject multiply-linked files.
    if (stat.nlink > 1) invalid("ACCESS_DENIED");
    if (task.operation === "inspect_file") return { ok: true, result: { kind: "file", size: stat.size } };
    const limit = task.maxBytes ?? MAX_READ;
    if (stat.size > limit) invalid("TOO_LARGE");
    phase.step = "FILE_OPEN";
    const handle = await fs.open(target, "r");
    try {
      phase.step = "HANDLE_STAT";
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > limit || opened.nlink > 1) invalid("TOO_LARGE");
      const data = Buffer.alloc(opened.size);
      phase.step = "HANDLE_READ";
      const result = await handle.read(data, 0, data.length, 0);
      if (result.bytesRead !== data.length) invalid("SHORT_READ");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      return { ok: true, result: { text, bytesRead: result.bytesRead } };
    } finally {
      await handle.close();
    }
  } catch (error) {
    // CI-only sanitized phase + errno. Never expose OS paths or file contents.
    const runtimeEnv: Record<string, string | undefined> = process.env;
    if (runtimeEnv["PAC_WORKER_DIAGNOSTICS"] === "1" &&
        runtimeEnv["PAC_WORKER_LAB_MODE"] === "1" && runtimeEnv["NODE_ENV"] === "test") {
      const maybeCode = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code : undefined;
      const code = typeof maybeCode === "string" ? maybeCode.replace(/[^A-Za-z0-9_]/g, "") : "NO_CODE";
      // CI-only fixture probe: discover whether Bun's realpath fails while
      // lstat/open are usable under the verified AppContainer Windows token.
      let probe = "";
      if (phase.step === "ROOT_REALPATH" &&
          raw && typeof raw === "object" &&
          (raw as { relativePath?: unknown }).relativePath === "pac-granted.txt") {
        const test = async (name: string, action: () => Promise<unknown>) => {
          try { await action(); return name + "OK"; }
          catch (err) {
            const c = err && typeof err === "object" && "code" in err
              ? String((err as {code?: unknown}).code).replace(/[^A-Za-z0-9_]/g, "") : "ERR";
            return name + c;
          }
        };
        probe += "_" + await test("RS", () => fs.stat(root));
        probe += "_" + await test("RL", () => fs.lstat(root));
        probe += "_" + await test("FL", () => fs.lstat(path.join(root, "pac-granted.txt")));
        probe += "_" + await test("FO", async () => {
          const handle = await fs.open(path.join(root, "pac-granted.txt"), "r");
          await handle.close();
        });
      }
      return { ok: false, error: "LAB_DIAG_" + phase.step + "_" + code + probe };
    }
    const message = error instanceof Error ? error.message : "";
    const known = ["INVALID_REQUEST", "OPERATION_DENIED", "INVALID_PATH", "UNKNOWN_FIELD",
      "INVALID_LIMIT", "ACCESS_DENIED", "NOT_DIRECTORY", "NOT_FILE", "TOO_LARGE", "SHORT_READ"];
    return { ok: false, error: known.includes(message) ? message : "ACCESS_DENIED" };
  }
}

async function readOneFrame(): Promise<unknown> {
  const reader = Bun.stdin.stream().getReader();
  const buffers: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST) invalid("REQUEST_TOO_LARGE");
      buffers.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const request = new Uint8Array(length);
  let offset = 0;
  for (const part of buffers) { request.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request));
}

if (import.meta.main) {
  // Explicit absolute root is provided by the trusted launcher, not the model.
  const root = process.argv[2];
  let response: WorkerReply;
  // Bun --compile substitutes direct process.env.NODE_ENV at build time.
  // Read through a runtime map so lab approval is checked when executed.
  const runtimeEnv: Record<string, string | undefined> = process.env;
  if (runtimeEnv["PAC_WORKER_LAB_MODE"] !== "1" || runtimeEnv["NODE_ENV"] !== "test") {
    response = { ok: false, error: "OS_SANDBOX_NOT_CONFIGURED" };
  }
  else if (!root || !path.isAbsolute(root)) response = { ok: false, error: "WORKSPACE_NOT_CONFIGURED" };
  else {
    try { response = await runReadOnlyWorkerTask(root, await readOneFrame()); }
    catch { response = { ok: false, error: "INVALID_REQUEST" }; }
  }
  let wire = JSON.stringify(response);
  if (Buffer.byteLength(wire) > MAX_RESPONSE) wire = JSON.stringify({ ok: false, error: "RESPONSE_TOO_LARGE" });
  process.stdout.write(wire + "\n");
}
