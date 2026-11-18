/**
 * Tests for #20a — Autonomous A2A Task Worker (src/daemon/mxh-task-worker.ts).
 *
 * Pure helpers are tested directly; the full pipeline (ACK -> doing ->
 * execute -> done/todo -> report) is tested with a mocked fetch + mocked
 * executors, so no MXH backend or desktop is needed.
 */
import { describe, expect, test } from "bun:test";
import {
  MxhTaskWorker,
  isClaimableTask,
  loadTaskWorkerConfig,
  nextBackoffMs,
  parseDirectives,
  parseSseBuffer,
  type MxhProjectTask,
  type MxhTaskWorkerConfig,
} from "../src/daemon/mxh-task-worker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseConfig(overrides: Partial<MxhTaskWorkerConfig> = {}): MxhTaskWorkerConfig {
  return {
    serverUrl: "http://127.0.0.1:4001",
    botToken: "mxhbot_testtoken",
    botUsername: "ai_muse002",
    assignees: ["ai_otter", "ai_muse002", "ai_antigravity"],
    enabled: true,
    commandTimeoutMs: 5000,
    retryAfterMs: 10 * 60 * 1000,
    maxProcessedIds: 1000,
    ...overrides,
  };
}

function baseTask(overrides: Partial<MxhProjectTask> = {}): MxhProjectTask {
  return {
    id: 42,
    conversationId: 503,
    title: "Test task",
    description: "RUN: echo hi",
    status: "todo",
    assignee: "ai_muse002",
    ackedAt: null,
    ackedBy: null,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function mockJsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** Build a mock fetch that records calls and answers the MXH endpoints. */
function buildMockFetch(calls: RecordedCall[]): typeof fetch {
  const mock = (async (url: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    let body: unknown = undefined;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url, method, body });
    if (url.includes("/api/v1/files-hub/read")) {
      return mockJsonResponse({ content: "hello from hub" });
    }
    if (url.includes("/api/v1/files-hub/write")) {
      return mockJsonResponse({ ok: true });
    }
    if (url.includes("/sendMessage")) {
      return mockJsonResponse({ ok: true, result: { message_id: 999 } });
    }
    if (url.includes("/messenger/projects/")) {
      return mockJsonResponse({ code: 200, success: true, task: {} });
    }
    return mockJsonResponse({});
  }) as unknown as typeof fetch;
  return mock;
}

function sseTaskEvent(task: MxhProjectTask, type = "task.created") {
  const envelope = JSON.stringify({
    id: 7,
    type,
    timestamp: new Date().toISOString(),
    conversationId: task.conversationId,
    data: task,
  });
  return { type, data: JSON.parse(envelope) as unknown, id: "7" };
}

// ---------------------------------------------------------------------------
// parseDirectives
// ---------------------------------------------------------------------------

describe("parseDirectives", () => {
  test("parses RUN, READ_FILE and SCREENSHOT lines, ignores prose", () => {
    const dirs = parseDirectives(
      "Làm giúp mình nhé\nRUN: echo hello\nSome prose here\nREAD_FILE: notes/todo.md\nSCREENSHOT\n",
    );
    expect(dirs).toEqual([
      { kind: "run", command: "echo hello" },
      { kind: "read_file", path: "notes/todo.md" },
      { kind: "screenshot" },
    ]);
  });

  test("WRITE_FILE takes following lines as content until next directive", () => {
    const dirs = parseDirectives(
      "WRITE_FILE: notes/out.md\nline one\nline two\nRUN: echo done\n",
    );
    expect(dirs).toEqual([
      { kind: "write_file", path: "notes/out.md", content: "line one\nline two" },
      { kind: "run", command: "echo done" },
    ]);
  });

  test("WRITE_FILE at end of description keeps all remaining lines", () => {
    const dirs = parseDirectives("WRITE_FILE: a/b.txt\nhello\nworld");
    expect(dirs).toEqual([{ kind: "write_file", path: "a/b.txt", content: "hello\nworld" }]);
  });

  test("keywords are case-insensitive; empty directive args are ignored", () => {
    const dirs = parseDirectives("run: ls\nRUN:\nREAD_FILE:\nscreenshot");
    expect(dirs).toEqual([{ kind: "run", command: "ls" }, { kind: "screenshot" }]);
  });

  test("returns [] for null/empty/prose-only descriptions", () => {
    expect(parseDirectives(null)).toEqual([]);
    expect(parseDirectives("")).toEqual([]);
    expect(parseDirectives("Just a normal task, no directives.")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isClaimableTask
// ---------------------------------------------------------------------------

describe("isClaimableTask", () => {
  const now = Date.now();
  test("claims todo tasks for allowlisted assignees", () => {
    expect(isClaimableTask(baseTask(), ["ai_otter", "ai_muse002"], new Map(), now, 600_000)).toBe(true);
    expect(isClaimableTask(baseTask({ assignee: "ai_otter" }), ["ai_otter", "ai_muse002"], new Map(), now, 600_000)).toBe(true);
  });

  test("rejects other assignees, non-todo status, and missing assignee", () => {
    expect(isClaimableTask(baseTask({ assignee: "ai_muse003" }), ["ai_otter", "ai_muse002"], new Map(), now, 600_000)).toBe(false);
    expect(isClaimableTask(baseTask({ assignee: null }), ["ai_otter", "ai_muse002"], new Map(), now, 600_000)).toBe(false);
    expect(isClaimableTask(baseTask({ status: "doing" }), ["ai_otter", "ai_muse002"], new Map(), now, 600_000)).toBe(false);
    expect(isClaimableTask(baseTask({ status: "done" }), ["ai_otter", "ai_muse002"], new Map(), now, 600_000)).toBe(false);
  });

  test("assignee match is case-insensitive", () => {
    expect(isClaimableTask(baseTask({ assignee: "AI_MUSE002" }), ["ai_muse002"], new Map(), now, 600_000)).toBe(true);
  });

  test("recently processed keys are skipped, expired keys are claimable again", () => {
    const processed = new Map<string, number>([["503:42", now - 60_000]]);
    expect(isClaimableTask(baseTask(), ["ai_muse002"], processed, now, 600_000)).toBe(false);
    const expired = new Map<string, number>([["503:42", now - 601_000]]);
    expect(isClaimableTask(baseTask(), ["ai_muse002"], expired, now, 600_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSseBuffer + backoff
// ---------------------------------------------------------------------------

describe("parseSseBuffer", () => {
  test("parses one task.created frame with the hub envelope", () => {
    const task = baseTask();
    const raw =
      `id: 7\nevent: task.created\ndata: ${JSON.stringify({ id: 7, type: "task.created", timestamp: "2026-11-18T00:00:00.000Z", conversationId: 503, data: task })}\n\n`;
    const { events, rest } = parseSseBuffer(raw);
    expect(rest).toBe("");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("task.created");
    expect((events[0].data as any).data).toMatchObject({ id: 42, title: "Test task" });
  });

  test("parses multiple frames and keeps a partial frame as rest", () => {
    const raw =
      "event: connected\ndata: {\"ok\":true}\n\n" +
      "event: task.updated\ndata: {\"type\":\"task.updated\",\"data\":{\"id\":1}}\n\n" +
      "event: task.created\ndata: {\"type\":\"task.cre";
    const { events, rest } = parseSseBuffer(raw);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("connected");
    expect(events[1].type).toBe("task.updated");
    expect(rest).toContain("task.cre");
  });

  test("non-JSON data payloads are kept as raw text", () => {
    const { events } = parseSseBuffer("event: ping\ndata: hello\n\n");
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("hello");
  });
});

describe("nextBackoffMs", () => {
  test("doubles from 2s and caps at 30s", () => {
    expect(nextBackoffMs(0)).toBe(2000);
    expect(nextBackoffMs(1)).toBe(4000);
    expect(nextBackoffMs(2)).toBe(8000);
    expect(nextBackoffMs(3)).toBe(16000);
    expect(nextBackoffMs(4)).toBe(30000);
    expect(nextBackoffMs(10)).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// loadTaskWorkerConfig
// ---------------------------------------------------------------------------

describe("loadTaskWorkerConfig", () => {
  test("defaults to the MXH backend, ai_muse002, and the spec allowlist", () => {
    const cfg = loadTaskWorkerConfig({});
    expect(cfg.serverUrl).toBe("http://127.0.0.1:4001".replace("127.0.0.1:4001", "100.111.68.103:4001"));
    expect(cfg.botUsername).toBe("ai_muse002");
    expect(cfg.assignees).toEqual(["ai_otter", "ai_muse002", "ai_antigravity"]);
    expect(cfg.enabled).toBe(false);
    expect(cfg.commandTimeoutMs).toBe(5 * 60 * 1000);
  });

  test("reads env overrides", () => {
    const cfg = loadTaskWorkerConfig({
      MXH_SERVER_URL: "http://10.0.0.5:4001/",
      MXH_BOT_TOKEN: "mxhbot_x",
      MXH_BOT_USERNAME: "ai_otter",
      MXH_AUTONOMOUS_WORKER: "true",
      MXH_TASK_WORKER_ASSIGNEES: "ai_otter, ai_muse002",
      MXH_TASK_WORKER_TIMEOUT_MS: "60000",
    });
    expect(cfg.serverUrl).toBe("http://10.0.0.5:4001");
    expect(cfg.botToken).toBe("mxhbot_x");
    expect(cfg.botUsername).toBe("ai_otter");
    expect(cfg.enabled).toBe(true);
    expect(cfg.assignees).toEqual(["ai_otter", "ai_muse002"]);
    expect(cfg.commandTimeoutMs).toBe(60000);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline (mocked MXH)
// ---------------------------------------------------------------------------

describe("MxhTaskWorker pipeline", () => {
  test("happy path: ACK -> doing -> RUN+READ_FILE+SCREENSHOT -> done -> report", async () => {
    const calls: RecordedCall[] = [];
    const ackCalls: Array<{ serverUrl: string; id: string; token: string; user: string }> = [];
    const ranCommands: string[] = [];
    let screenshots = 0;
    const logs: string[] = [];

    const worker = new MxhTaskWorker(baseConfig(), {
      fetchImpl: buildMockFetch(calls),
      acknowledgeTaskFn: (async (serverUrl: string, id: string, token?: string, user?: string) => {
        ackCalls.push({ serverUrl, id, token: token ?? "", user: user ?? "" });
        return {} as any;
      }) as any,
      runCommandFn: async (cmd: string) => {
        ranCommands.push(cmd);
        return { stdout: "hi\n", stderr: "", exitCode: 0 };
      },
      takeScreenshotFn: async () => {
        screenshots += 1;
        return { filePath: "/tmp/shot.png", width: 1920, height: 1080 };
      },
      log: (msg: string) => logs.push(msg),
    });

    const task = baseTask({
      description: "RUN: echo hi\nREAD_FILE: notes/x.md\nSCREENSHOT",
    });
    await worker.handleSseEvent(sseTaskEvent(task));
    await worker.waitForIdle();

    // ACK via A2A with the task- id and our username.
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0]).toMatchObject({ id: "task-42", user: "ai_muse002" });

    // Executors ran.
    expect(ranCommands).toEqual(["echo hi"]);
    expect(screenshots).toBe(1);

    // PATCH doing, then PATCH done, then sendMessage — in order.
    const patchCalls = calls.filter((c) => c.url.includes("/messenger/projects/503/tasks/42"));
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[0].method).toBe("PATCH");
    expect(patchCalls[0].body).toMatchObject({ status: "doing" });
    expect(patchCalls[1].body).toMatchObject({ status: "done" });
    expect(String((patchCalls[1].body as any).description)).toContain("DONE");

    const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
    expect(sendCalls).toHaveLength(1);
    expect((sendCalls[0].body as any).chat_id).toBe(503);
    expect(String((sendCalls[0].body as any).text)).toMatch(/^✅/);

    const status = worker.getStatus();
    expect(status.handledCount).toBe(1);
    expect(status.failedCount).toBe(0);
  });

  test("failed RUN returns the task to todo and reports failure", async () => {
    const calls: RecordedCall[] = [];
    const worker = new MxhTaskWorker(baseConfig(), {
      fetchImpl: buildMockFetch(calls),
      acknowledgeTaskFn: (async () => ({} as any)) as any,
      runCommandFn: async () => ({ stdout: "", stderr: "boom", exitCode: 1 }),
      log: () => {},
    });

    await worker.handleSseEvent(sseTaskEvent(baseTask({ description: "RUN: false" })));
    await worker.waitForIdle();

    const patchCalls = calls.filter((c) => c.url.includes("/messenger/projects/503/tasks/42"));
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[1].body).toMatchObject({ status: "todo" });
    expect(String((patchCalls[1].body as any).description)).toContain("FAIL");

    const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
    expect(sendCalls).toHaveLength(1);
    expect(String((sendCalls[0].body as any).text)).toMatch(/^⚠️/);
    expect(worker.getStatus().failedCount).toBe(1);
  });

  test("risky RUN is refused before execution and returned to todo", async () => {
    const calls: RecordedCall[] = [];
    const ranCommands: string[] = [];
    const worker = new MxhTaskWorker(baseConfig(), {
      fetchImpl: buildMockFetch(calls),
      acknowledgeTaskFn: (async () => ({} as any)) as any,
      runCommandFn: async (cmd: string) => {
        ranCommands.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      log: () => {},
    });

    await worker.handleSseEvent(sseTaskEvent(baseTask({ description: "RUN: rm -rf /tmp/x" })));
    await worker.waitForIdle();

    expect(ranCommands).toEqual([]);
    const patchCalls = calls.filter((c) => c.url.includes("/messenger/projects/503/tasks/42"));
    expect(patchCalls[1].body).toMatchObject({ status: "todo" });
    expect(worker.getStatus().failedCount).toBe(1);
  });

  test("task with no directives is returned to todo without executing anything", async () => {
    const calls: RecordedCall[] = [];
    const ranCommands: string[] = [];
    const worker = new MxhTaskWorker(baseConfig(), {
      fetchImpl: buildMockFetch(calls),
      acknowledgeTaskFn: (async () => ({} as any)) as any,
      runCommandFn: async (cmd: string) => {
        ranCommands.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      log: () => {},
    });

    await worker.handleSseEvent(sseTaskEvent(baseTask({ description: "Please review this idea." })));
    await worker.waitForIdle();

    expect(ranCommands).toEqual([]);
    const patchCalls = calls.filter((c) => c.url.includes("/messenger/projects/503/tasks/42"));
    expect(patchCalls[1].body).toMatchObject({ status: "todo" });
  });

  test("tasks for other assignees are ignored entirely", async () => {
    const calls: RecordedCall[] = [];
    const worker = new MxhTaskWorker(baseConfig(), {
      fetchImpl: buildMockFetch(calls),
      acknowledgeTaskFn: (async () => ({} as any)) as any,
      log: () => {},
    });

    await worker.handleSseEvent(sseTaskEvent(baseTask({ assignee: "ai_muse003" })));
    await worker.waitForIdle();

    expect(calls).toHaveLength(0);
    expect(worker.getStatus().handledCount).toBe(0);
  });

  test("duplicate events for the same task are processed only once", async () => {
    const calls: RecordedCall[] = [];
    const ranCommands: string[] = [];
    const worker = new MxhTaskWorker(baseConfig(), {
      fetchImpl: buildMockFetch(calls),
      acknowledgeTaskFn: (async () => ({} as any)) as any,
      runCommandFn: async (cmd: string) => {
        ranCommands.push(cmd);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      log: () => {},
    });

    const evt = sseTaskEvent(baseTask());
    await worker.handleSseEvent(evt);
    await worker.handleSseEvent(evt);
    await worker.waitForIdle();

    expect(ranCommands).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/sendMessage"))).toHaveLength(1);
  });

  test("task.updated for a todo task is claimed just like task.created", async () => {
    const calls: RecordedCall[] = [];
    const worker = new MxhTaskWorker(baseConfig(), {
      fetchImpl: buildMockFetch(calls),
      acknowledgeTaskFn: (async () => ({} as any)) as any,
      runCommandFn: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
      log: () => {},
    });

    await worker.handleSseEvent(sseTaskEvent(baseTask(), "task.updated"));
    await worker.waitForIdle();

    expect(calls.filter((c) => c.url.includes("/sendMessage"))).toHaveLength(1);
  });
});
