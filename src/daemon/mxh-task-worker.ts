/**
 * #20a — Autonomous A2A Task Worker (Phase #24e).
 *
 * Turns the Otter daemon into an autonomous arm on MXH: it listens to the
 * MXH SSE Hub (/api/v1/events/stream), auto-claims Kanban tasks assigned to
 * this daemon, executes their directives, and reports the result back to
 * the originating conversation.
 *
 * Flow (per task):
 *   SSE task.created/task.updated (status=todo, assignee in allowlist)
 *     -> A2A AcknowledgeTask (tasks/ack)
 *     -> PATCH task status "doing"
 *     -> execute directives from the description (RUN:/READ_FILE:/
 *        WRITE_FILE:/SCREENSHOT), one at a time, with a per-command timeout
 *     -> PATCH task status "done" (+ result log) or back to "todo" (+ error
 *        log) on failure — never leaves a task stuck in "doing"
 *     -> send a short summary message to the task's conversation
 *
 * Directives are parsed from the task description, one per line:
 *   RUN: <shell command>        -> executeCommand (PowerShell on Windows,
 *                                  $SHELL -c on Linux/macOS)
 *   READ_FILE: <hub path>       -> MXH Files Hub read (scope "shared")
 *   WRITE_FILE: <hub path>      -> MXH Files Hub write (scope "shared");
 *                                  the lines after the directive, up to the
 *                                  next directive or end of description,
 *                                  are the file content
 *   SCREENSHOT                  -> takeScreenshot (desktop capture)
 *
 * Safety (see notes/20a-sse-task-worker-2026-11-18.md for open questions):
 * - Only tasks whose assignee is in MXH_TASK_WORKER_ASSIGNEES
 *   (default: ai_otter, ai_muse002, ai_antigravity) and whose status is
 *   "todo" are claimed. Anything else is ignored.
 * - Every task is screened with the same isRiskyTask gate the Task Bridge
 *   uses; a risky task is refused and returned to "todo" with the reasons
 *   in its log. There is no allowlist yet — see the note file.
 * - Commands run with a timeout (default 5 min). A timed-out command is
 *   reported as failed; the underlying process is not killed (see note).
 * - Idempotency: a task key (conversationId:id) is remembered for
 *   MXH_TASK_WORKER_RETRY_MS (default 10 min) after it is handled, so the
 *   task.updated event our own status PATCH emits does not re-trigger the
 *   worker into a retry loop. After the window, a still-todo task can be
 *   claimed again.
 * - Tasks are processed strictly one at a time (serial queue).
 *
 * Activation: the daemon starts the worker only when MXH_BOT_TOKEN is set
 * and MXH_AUTONOMOUS_WORKER=true. No token is ever logged or stored.
 */

import { acknowledgeTask } from "./a2a-client";
import { executeCommand, type TerminalExecutionResult } from "./terminal";
import { takeScreenshot } from "./desktop";
import { isRiskyTask } from "./continuous-loop";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MxhTaskWorkerConfig {
  /** MXH backend base URL, e.g. http://100.111.68.103:4001 */
  serverUrl: string;
  /** Bot token (mxhbot_...) — env only, never logged. */
  botToken: string;
  /** Bot username this worker acts as, e.g. ai_muse002. */
  botUsername: string;
  /** Assignees the worker may auto-claim, lowercased. */
  assignees: string[];
  /** Master switch; the daemon only starts the worker when true. */
  enabled: boolean;
  /** Per-command timeout in ms (default 5 min). */
  commandTimeoutMs: number;
  /** How long a handled task key stays in the processed set (default 10 min). */
  retryAfterMs: number;
  /** Max entries kept in the processed set (oldest evicted first). */
  maxProcessedIds: number;
}

export const DEFAULT_ASSIGNEES = ["ai_otter", "ai_muse002", "ai_antigravity"] as const;
export const DEFAULT_SERVER_URL = "http://100.111.68.103:4001";
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_RETRY_AFTER_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_PROCESSED_IDS = 1000;

export function loadTaskWorkerConfig(env: NodeJS.ProcessEnv = process.env): MxhTaskWorkerConfig {
  const assignees = (env.MXH_TASK_WORKER_ASSIGNEES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    serverUrl: (env.MXH_SERVER_URL || DEFAULT_SERVER_URL).replace(/\/+$/, ""),
    botToken: (env.MXH_BOT_TOKEN || "").trim(),
    botUsername: (env.MXH_BOT_USERNAME || "ai_muse002").trim(),
    assignees: assignees.length > 0 ? assignees : [...DEFAULT_ASSIGNEES],
    enabled: env.MXH_AUTONOMOUS_WORKER === "true",
    commandTimeoutMs: parsePositiveInt(env.MXH_TASK_WORKER_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS),
    retryAfterMs: parsePositiveInt(env.MXH_TASK_WORKER_RETRY_MS, DEFAULT_RETRY_AFTER_MS),
    maxProcessedIds: parsePositiveInt(env.MXH_TASK_WORKER_MAX_PROCESSED, DEFAULT_MAX_PROCESSED_IDS),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Kanban task payload as published by the MXH SSE Hub (toProjectTask). */
export interface MxhProjectTask {
  id: number;
  conversationId: number;
  title: string;
  description: string | null;
  status: string;
  assignee: string | null;
  ackedAt: string | null;
  ackedBy: string | null;
  [key: string]: unknown;
}

export type TaskDirective =
  | { kind: "run"; command: string }
  | { kind: "read_file"; path: string }
  | { kind: "write_file"; path: string; content: string }
  | { kind: "screenshot" };

export interface DirectiveResult {
  directive: TaskDirective;
  ok: boolean;
  summary: string;
}

export interface TaskWorkerStatus {
  running: boolean;
  connected: boolean;
  serverUrl: string;
  botUsername: string;
  assignees: string[];
  processedCount: number;
  queueDepth: number;
  handledCount: number;
  failedCount: number;
  lastError: string | null;
  lastEventAt: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const DIRECTIVE_RE = /^(RUN|READ_FILE|WRITE_FILE|SCREENSHOT)\s*:?\s*(.*)$/i;

/**
 * Parse executable directives out of a task description. Plain prose lines
 * are ignored. WRITE_FILE takes the following lines as its content until
 * the next directive line or the end of the description.
 */
export function parseDirectives(description: string | null | undefined): TaskDirective[] {
  if (!description) return [];
  const lines = description.split(/\r?\n/);
  const out: TaskDirective[] = [];
  let pendingWrite: { path: string; contentLines: string[] } | null = null;

  const flushWrite = () => {
    if (pendingWrite) {
      out.push({
        kind: "write_file",
        path: pendingWrite.path,
        content: pendingWrite.contentLines.join("\n"),
      });
      pendingWrite = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const m = DIRECTIVE_RE.exec(line);
    if (m) {
      const keyword = m[1].toLowerCase();
      const arg = (m[2] || "").trim();
      flushWrite();
      if (keyword === "run") {
        if (arg) out.push({ kind: "run", command: arg });
      } else if (keyword === "read_file") {
        if (arg) out.push({ kind: "read_file", path: arg });
      } else if (keyword === "write_file") {
        if (arg) pendingWrite = { path: arg, contentLines: [] };
      } else if (keyword === "screenshot") {
        out.push({ kind: "screenshot" });
      }
    } else if (pendingWrite) {
      pendingWrite.contentLines.push(rawLine);
    }
    // Non-directive lines outside a WRITE_FILE block are prose: ignored.
  }
  flushWrite();
  return out;
}

/** SSE frame as published by the MXH hub: `event: <type>` + JSON envelope. */
export interface SseParsedEvent {
  type: string;
  data: unknown;
  id?: string;
}

/**
 * Parse complete SSE frames out of a byte buffer. Only frames terminated
 * by a blank line are returned; the remainder is kept for the next chunk.
 */
export function parseSseBuffer(buffer: string): { events: SseParsedEvent[]; rest: string } {
  const events: SseParsedEvent[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf("\n\n")) >= 0) {
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let type = "";
    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      const trimmed = line.replace(/\r$/, "");
      if (trimmed.startsWith("event:")) type = trimmed.slice(6).trim();
      else if (trimmed.startsWith("id:")) id = trimmed.slice(3).trim();
      else if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    let data: unknown = payload;
    try {
      data = JSON.parse(payload);
    } catch {
      // Keep raw text when the payload is not JSON.
    }
    events.push({ type, data, id });
  }
  return { events, rest };
}

/** Exponential backoff for SSE reconnects: 2s, 4s, 8s, ... capped at 30s. */
export function nextBackoffMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, attempt));
}

export function taskKey(task: { conversationId: number; id: number }): string {
  return `${task.conversationId}:${task.id}`;
}

/**
 * Whether this worker should claim the task: status "todo", assignee in
 * the allowlist, and not handled within the retry window.
 */
export function isClaimableTask(
  task: MxhProjectTask,
  assignees: string[],
  processed: ReadonlyMap<string, number>,
  nowMs: number,
  retryAfterMs: number,
): boolean {
  if (String(task.status || "").toLowerCase() !== "todo") return false;
  const assignee = String(task.assignee || "").trim().toLowerCase();
  if (!assignee || !assignees.includes(assignee)) return false;
  const seenAt = processed.get(taskKey(task));
  if (seenAt !== undefined && nowMs - seenAt < retryAfterMs) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface TaskWorkerDeps {
  fetchImpl?: typeof fetch;
  acknowledgeTaskFn?: typeof acknowledgeTask;
  runCommandFn?: (cmd: string) => Promise<TerminalExecutionResult>;
  takeScreenshotFn?: () => Promise<{ filePath: string; width: number; height: number }>;
  log?: (msg: string) => void;
}

const WORKER_LOG_PREFIX = "[TaskWorker]";

export class MxhTaskWorker {
  readonly config: MxhTaskWorkerConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly acknowledgeTaskFn: typeof acknowledgeTask;
  private readonly runCommandFn: (cmd: string) => Promise<TerminalExecutionResult>;
  private readonly takeScreenshotFn: () => Promise<{ filePath: string; width: number; height: number }>;
  private readonly log: (msg: string) => void;

  private readonly processed = new Map<string, number>();
  private queue: MxhProjectTask[] = [];
  private processing = false;
  private abort: AbortController | null = null;
  private reconnectAttempt = 0;
  private connected = false;
  private handledCount = 0;
  private failedCount = 0;
  private lastError: string | null = null;
  private lastEventAt: string | null = null;

  constructor(config: MxhTaskWorkerConfig, deps: TaskWorkerDeps = {}) {
    this.config = config;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.acknowledgeTaskFn = deps.acknowledgeTaskFn ?? acknowledgeTask;
    this.runCommandFn = deps.runCommandFn ?? ((cmd: string) => executeCommand(cmd));
    this.takeScreenshotFn = deps.takeScreenshotFn ?? (() => takeScreenshot());
    this.log = deps.log ?? ((msg: string) => console.log(`${WORKER_LOG_PREFIX} ${msg}`));
  }

  // -- lifecycle -----------------------------------------------------------

  /** Start the SSE loop (fire-and-forget; reconnects on its own). */
  start(): void {
    if (this.abort) return;
    this.abort = new AbortController();
    void this.sseLoop();
  }

  /** Stop the SSE loop and any in-flight reconnect wait. */
  stop(): void {
    this.abort?.abort();
    this.abort = null;
  }

  /** Resolve when the queue is empty and no task is processing (tests / shutdown). */
  async waitForIdle(): Promise<void> {
    for (;;) {
      if (this.queue.length === 0 && !this.processing) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  getStatus(): TaskWorkerStatus {
    return {
      running: this.abort !== null,
      connected: this.connected,
      serverUrl: this.config.serverUrl,
      botUsername: this.config.botUsername,
      assignees: [...this.config.assignees],
      processedCount: this.processed.size,
      queueDepth: this.queue.length,
      handledCount: this.handledCount,
      failedCount: this.failedCount,
      lastError: this.lastError,
      lastEventAt: this.lastEventAt,
    };
  }

  // -- SSE -----------------------------------------------------------------

  private async sseLoop(): Promise<void> {
    while (this.abort && !this.abort.signal.aborted) {
      try {
        await this.connectOnce(this.abort.signal);
        // Clean disconnect (server closed the stream): reconnect at once.
        this.reconnectAttempt = 0;
      } catch (err: any) {
        if (this.abort?.signal.aborted) break;
        this.lastError = err?.message || String(err);
        this.connected = false;
        const delay = nextBackoffMs(this.reconnectAttempt);
        this.reconnectAttempt += 1;
        this.log(`SSE mất kết nối (${this.lastError}); thử lại sau ${delay / 1000}s`);
        await this.sleep(delay);
      }
    }
  }

  private async connectOnce(signal: AbortSignal): Promise<void> {
    const url = `${this.config.serverUrl}/api/v1/events/stream`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        Accept: "text/event-stream",
      },
      signal,
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.includes("text/event-stream")) {
      const body = await res.text().catch(() => "");
      throw new Error(`SSE connect failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    if (!res.body) throw new Error("SSE connect failed: empty response body");
    this.connected = true;
    this.reconnectAttempt = 0;
    this.log(`SSE đã kết nối: ${url} (bot @${this.config.botUsername})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.rest;
        for (const evt of parsed.events) {
          await this.handleSseEvent(evt);
        }
      }
      buffer += decoder.decode();
      const tail = parseSseBuffer(buffer);
      for (const evt of tail.events) {
        await this.handleSseEvent(evt);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
      this.connected = false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort?.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Handle one parsed SSE event. Only task.created / task.updated for a
   * claimable task are queued; everything else is ignored.
   */
  async handleSseEvent(evt: SseParsedEvent): Promise<void> {
    this.lastEventAt = new Date().toISOString();
    if (evt.type !== "task.created" && evt.type !== "task.updated") return;
    const envelope = evt.data as { data?: unknown } | null;
    const task = (envelope && typeof envelope === "object" ? envelope.data : null) as MxhProjectTask | null;
    if (!task || typeof task !== "object" || typeof task.id !== "number") return;
    if (!isClaimableTask(task, this.config.assignees, this.processed, Date.now(), this.config.retryAfterMs)) {
      return;
    }
    this.queue.push(task);
    this.log(`Nhận task #${task.id} "${task.title}" (conv ${task.conversationId}, @${task.assignee}) — vào hàng đợi (${this.queue.length})`);
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;
        // Re-check at processing time: a duplicate event may have queued
        // the same task twice while the first copy was running.
        if (!isClaimableTask(task, this.config.assignees, this.processed, Date.now(), this.config.retryAfterMs)) {
          continue;
        }
        await this.processTask(task);
      }
    } finally {
      this.processing = false;
    }
  }

  // -- task pipeline ---------------------------------------------------------

  /**
   * Full pipeline for one task. Never throws: every failure path returns
   * the task to "todo" with an error log and reports to the conversation.
   */
  async processTask(task: MxhProjectTask): Promise<void> {
    const key = taskKey(task);
    this.markProcessed(key);
    const title = task.title || `task #${task.id}`;
    this.log(`Bắt đầu task #${task.id} "${title}" (conv ${task.conversationId})`);

    try {
      // Step 1 — ACK via A2A (tasks/ack).
      try {
        await this.acknowledgeTaskFn(this.config.serverUrl, `task-${task.id}`, this.config.botToken, this.config.botUsername);
        this.log(`Task #${task.id}: đã ACK`);
      } catch (err: any) {
        // TaskNotFound (-32001): the task was deleted; nothing to do.
        const code = (err as any)?.code;
        if (code === -32001) {
          this.log(`Task #${task.id}: đã bị xóa, bỏ qua`);
          return;
        }
        throw new Error(`ACK thất bại: ${err?.message || err}`);
      }

      // Step 2 — doing.
      const doingOk = await this.patchTask(task, { status: "doing" });
      if (!doingOk) throw new Error("Không chuyển được task sang doing");

      // Step 3 — parse + safety gate + execute.
      const directives = parseDirectives(task.description);
      let results: DirectiveResult[] = [];
      let failure: string | null = null;

      if (directives.length === 0) {
        failure = "Không tìm thấy chỉ thị thực thi nào (RUN:/READ_FILE:/WRITE_FILE:/SCREENSHOT) trong mô tả task.";
      } else {
        const risk = isRiskyTask({ goal: task.title, details: task.description ?? undefined });
        if (risk.risky) {
          failure = `Task bị từ chối vì dấu hiệu nguy hiểm: ${risk.reasons.join("; ")}`;
        } else {
          results = await this.executeDirectives(directives);
          const failed = results.filter((r) => !r.ok);
          if (failed.length > 0) {
            failure = failed.map((r) => r.summary).join("; ");
          }
        }
      }

      // Step 4+5 — report + close out.
      if (failure) {
        this.failedCount += 1;
        const logText = this.appendLog(task.description, `FAIL: ${failure}`);
        await this.patchTask(task, { status: "todo", description: logText });
        await this.sendReport(task, `⚠️ [Otter] Task #${task.id} "${title}" chưa xong: ${failure}\nĐã trả task về todo.`);
        this.log(`Task #${task.id}: thất bại — ${failure}`);
        return;
      }

      const summaryLines = results.map((r) => `• ${r.summary}`);
      const logText = this.appendLog(
        task.description,
        `DONE (${new Date().toISOString()}):\n${summaryLines.join("\n")}`,
      );
      await this.patchTask(task, { status: "done", description: logText });
      await this.sendReport(
        task,
        `✅ [Otter] Đã xong task #${task.id} "${title}":\n${summaryLines.join("\n")}`,
      );
      this.handledCount += 1;
      this.log(`Task #${task.id}: xong`);
    } catch (err: any) {
      // Last-resort guard: never leave the task stuck in "doing".
      this.failedCount += 1;
      const message = err?.message || String(err);
      this.lastError = message;
      try {
        const logText = this.appendLog(task.description, `FAIL: ${message}`);
        await this.patchTask(task, { status: "todo", description: logText });
      } catch {}
      try {
        await this.sendReport(task, `⚠️ [Otter] Task #${task.id} "${title}" lỗi: ${message}\nĐã trả task về todo.`);
      } catch {}
      this.log(`Task #${task.id}: lỗi — ${message}`);
    }
  }

  private markProcessed(key: string): void {
    this.processed.set(key, Date.now());
    while (this.processed.size > this.config.maxProcessedIds) {
      const oldest = this.processed.keys().next().value;
      if (oldest === undefined) break;
      this.processed.delete(oldest);
    }
  }

  private appendLog(description: string | null, entry: string): string {
    const base = (description || "").trimEnd();
    return `${base}\n\n[Otter #20a ${new Date().toISOString()}]\n${entry}`;
  }

  private async executeDirectives(directives: TaskDirective[]): Promise<DirectiveResult[]> {
    const results: DirectiveResult[] = [];
    for (const d of directives) {
      try {
        if (d.kind === "run") {
          const out = await this.runWithTimeout(d.command);
          const text = [
            out.stdout ? `[STDOUT]\n${out.stdout}` : "",
            out.stderr ? `[STDERR]\n${out.stderr}` : "",
            `Exit code: ${out.exitCode}`,
          ]
            .filter(Boolean)
            .join("\n");
          results.push({
            directive: d,
            ok: out.exitCode === 0,
            summary: out.exitCode === 0
              ? `RUN \`${d.command}\` OK (exit 0)${text ? `:\n${truncate(text, 1500)}` : ""}`
              : `RUN \`${d.command}\` thất bại (exit ${out.exitCode}):\n${truncate(text, 1500)}`,
          });
        } else if (d.kind === "read_file") {
          const body = await this.filesHubRead(d.path);
          results.push({
            directive: d,
            ok: true,
            summary: `READ_FILE ${d.path} OK:\n${truncate(typeof body === "string" ? body : JSON.stringify(body), 1500)}`,
          });
        } else if (d.kind === "write_file") {
          await this.filesHubWrite(d.path, d.content);
          results.push({
            directive: d,
            ok: true,
            summary: `WRITE_FILE ${d.path} OK (${d.content.length} bytes)`,
          });
        } else {
          const shot = await this.takeScreenshotFn();
          results.push({
            directive: d,
            ok: true,
            summary: `SCREENSHOT OK: ${shot.filePath} (${shot.width}x${shot.height})`,
          });
        }
      } catch (err: any) {
        const label =
          d.kind === "run" ? `RUN \`${d.command}\`` : d.kind === "read_file" ? `READ_FILE ${d.path}` : d.kind === "write_file" ? `WRITE_FILE ${d.path}` : "SCREENSHOT";
        results.push({ directive: d, ok: false, summary: `${label} lỗi: ${err?.message || err}` });
      }
    }
    return results;
  }

  /** Run a command with a timeout. Note: on timeout the underlying shell
   * process keeps running (executeCommand has no abort handle); the worker
   * reports failure and moves on. */
  private async runWithTimeout(command: string): Promise<TerminalExecutionResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`RUN timeout sau ${this.config.commandTimeoutMs / 1000}s: ${command}`)), this.config.commandTimeoutMs);
    });
    try {
      return await Promise.race([this.runCommandFn(command), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -- MXH REST helpers ------------------------------------------------------

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.botToken}` };
  }

  private async patchTask(task: MxhProjectTask, patch: { status?: string; description?: string }): Promise<boolean> {
    const url = `${this.config.serverUrl}/messenger/projects/${task.conversationId}/tasks/${task.id}`;
    try {
      const res = await this.fetchImpl(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        this.log(`PATCH task #${task.id} thất bại: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.log(`PATCH task #${task.id} lỗi: ${err?.message || err}`);
      return false;
    }
  }

  private async filesHubRead(path: string): Promise<unknown> {
    const q = new URLSearchParams({ scope: "shared", path });
    const url = `${this.config.serverUrl}/api/v1/files-hub/read?${q.toString()}`;
    const res = await this.fetchImpl(url, { headers: this.authHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Files Hub read ${path} thất bại: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const body: any = await res.json().catch(() => null);
    return body?.content ?? body;
  }

  private async filesHubWrite(path: string, content: string): Promise<void> {
    const url = `${this.config.serverUrl}/api/v1/files-hub/write`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ scope: "shared", path, content, encoding: "utf8" }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Files Hub write ${path} thất bại: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
  }

  private async sendReport(task: MxhProjectTask, text: string): Promise<void> {
    const url = `${this.config.serverUrl}/api/v1/bot/${this.config.botToken}/sendMessage`;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify({ chat_id: task.conversationId, text }),
      });
      if (!res.ok) {
        this.log(`Gửi báo cáo task #${task.id} thất bại: HTTP ${res.status}`);
      }
    } catch (err: any) {
      this.log(`Gửi báo cáo task #${task.id} lỗi: ${err?.message || err}`);
    }
  }
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n…(đã cắt ${text.length - maxLen} ký tự)` : text;
}

// ---------------------------------------------------------------------------
// Module-level starter (used by src/daemon/index.ts)
// ---------------------------------------------------------------------------

let singleton: MxhTaskWorker | null = null;

/**
 * Start the autonomous task worker if it is configured. Returns the worker,
 * or null when disabled / not configured (never throws).
 */
export function startTaskWorker(config?: MxhTaskWorkerConfig, deps?: TaskWorkerDeps): MxhTaskWorker | null {
  const cfg = config ?? loadTaskWorkerConfig();
  if (!cfg.enabled) return null;
  if (!cfg.botToken) {
    console.log(`${WORKER_LOG_PREFIX} chưa bật: thiếu MXH_BOT_TOKEN`);
    return null;
  }
  if (singleton) return singleton;
  const worker = new MxhTaskWorker(cfg, deps);
  singleton = worker;
  worker.start();
  return worker;
}

export function getTaskWorker(): MxhTaskWorker | null {
  return singleton;
}
