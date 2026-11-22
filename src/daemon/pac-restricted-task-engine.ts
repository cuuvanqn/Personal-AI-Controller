/**
 * PAC Restricted Task Engine — phase 1 (read-only, in-process prototype).
 *
 * No shell, subprocess, browser, network, writes, or model-generated code.
 * This is NOT an OS sandbox. A dedicated low-privilege Windows worker with
 * ACLs, handle-based access and IPC must replace this prototype before release.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertSafePath } from "./security";

export type RestrictedTask =
  | { operation: "inspect_file"; filePath: string }
  | { operation: "read_text"; filePath: string; maxBytes?: number }
  | { operation: "list_directory"; directoryPath: string; maxEntries?: number };

export type RestrictedResult =
  | { ok: true; operation: RestrictedTask["operation"]; result: unknown }
  | { ok: false; operation: string; error: string };

const MAX_READ_BYTES = 16_384;
const MAX_ENTRIES = 100;
const MAX_PATH_CHARS = 4_096;
const VALID_OPERATIONS = new Set(["inspect_file", "read_text", "list_directory"]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function inputPath(candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_PATH_CHARS || candidate.includes("\0")) {
    throw new Error("Invalid path");
  }
  return candidate;
}

function permittedPath(input: unknown): string {
  const lexical = assertSafePath(inputPath(input));
  return lexical;
}

async function rejectSymlinkAtTarget(target: string): Promise<void> {
  const info = await fs.lstat(target);
  if (info.isSymbolicLink()) throw new Error("Symbolic link target refused");
}

/**
 * Validate only fixed operations and bounded primitive inputs.
 * Reject unknown fields to prevent future privilege confusion.
 */
function validate(input: unknown): RestrictedTask {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid task");
  const obj = input as Record<string, unknown>;
  if (typeof obj.operation !== "string" || !VALID_OPERATIONS.has(obj.operation)) throw new Error("Operation not allowed");
  const expected = obj.operation === "list_directory"
    ? ["operation", "directoryPath", "maxEntries"]
    : obj.operation === "read_text"
      ? ["operation", "filePath", "maxBytes"]
      : ["operation", "filePath"];
  if (Object.keys(obj).some(k => !expected.includes(k))) throw new Error("Unknown task field");
  if (obj.operation === "list_directory") {
    inputPath(obj.directoryPath);
    if (obj.maxEntries !== undefined && (!Number.isInteger(obj.maxEntries) || (obj.maxEntries as number) < 1 || (obj.maxEntries as number) > MAX_ENTRIES)) throw new Error("Invalid maxEntries");
    return obj as RestrictedTask;
  }
  inputPath(obj.filePath);
  if (obj.operation === "read_text" && obj.maxBytes !== undefined &&
    (!Number.isInteger(obj.maxBytes) || (obj.maxBytes as number) < 1 || (obj.maxBytes as number) > MAX_READ_BYTES)) {
    throw new Error("Invalid maxBytes");
  }
  return obj as RestrictedTask;
}

/**
 * No command evaluator. Fail-closed for unsupported tasks or invalid paths.
 * Neither exceptions nor successful results expose a full local file path.
 */
export async function executeRestrictedTask(input: unknown): Promise<RestrictedResult> {
  let operation = "unknown";
  try {
    const task = validate(input);
    operation = task.operation;

    if (task.operation === "list_directory") {
      const directoryPath = permittedPath(task.directoryPath);
      await rejectSymlinkAtTarget(directoryPath);
      const stat = await fs.stat(directoryPath);
      if (!stat.isDirectory()) throw new Error("Not a directory");
      const names = (await fs.readdir(directoryPath, { withFileTypes: true }))
        .slice(0, task.maxEntries ?? MAX_ENTRIES)
        .map(item => ({
          name: item.name,
          type: item.isDirectory() ? "directory" : item.isFile() ? "file" : item.isSymbolicLink() ? "symlink" : "other"
        }));
      return { ok: true, operation, result: { entries: names, truncated: names.length === (task.maxEntries ?? MAX_ENTRIES) } };
    }

    const filePath = permittedPath(task.filePath);
    await rejectSymlinkAtTarget(filePath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a regular file");

    if (task.operation === "inspect_file") {
      return { ok: true, operation, result: { size: stat.size, kind: "file" } };
    }

    const requested = task.maxBytes ?? MAX_READ_BYTES;
    const limit = Math.min(requested, MAX_READ_BYTES);
    if (stat.size > limit) throw new Error("File exceeds read limit");
    const handle = await fs.open(filePath, "r");
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.size > limit) throw new Error("File exceeds read limit or is not regular");
      const buffer = Buffer.alloc(current.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== buffer.length) throw new Error("Short read");
      const text = UTF8.decode(buffer);
      return { ok: true, operation, result: { text, bytesRead } };
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Do not echo filesystem exception messages; they may contain local paths.
    const message = error instanceof Error ? error.message : "Task rejected";
    const safe = /^(Invalid task|Invalid path|Operation not allowed|Unknown task field|Invalid maxEntries|Invalid maxBytes|Not a directory|Not a regular file|Symbolic link target refused|File exceeds read limit|File exceeds read limit or is not regular|Short read)$/.test(message)
      ? message : "Access denied or task failed";
    return { ok: false, operation, error: safe };
  }
}
