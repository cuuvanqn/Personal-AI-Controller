import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initDatabase } from "../src/daemon/db";
import { handleSystemRoutes } from "../src/daemon/routes/system-routes";
import { handleMcpRoutes } from "../src/daemon/routes/mcp-routes";
import { handleActivityRoutes } from "../src/daemon/routes/activity-routes";
import { handleA2aRoutes } from "../src/daemon/routes/a2a-routes";
import { isRequestAuthorized, setAuthToken, setFullAccess } from "../src/daemon/security";
import { getAntigravityStatus } from "../src/daemon/tools/antigravity-cdp-tools";

describe("Otter v2.1 Core Upgrades", () => {
  test("GET /health returns 200 ok with version 2.1.0", async () => {
    const req = new Request("http://127.0.0.1:1993/health");
    const res = await handleSystemRoutes(req, new URL(req.url), 1993);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body: any = await res!.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe("2.1.0");
  });

  test("GET /api/mcp/servers exposes dynamic toolsCount matching otter_core tools including agy_* and mxh_files_*", async () => {
    const req = new Request("http://127.0.0.1:1993/api/mcp/servers");
    const res = await handleMcpRoutes(req, new URL(req.url), () => {});
    expect(res).not.toBeNull();
    const body: any = await res!.json();
    const core = body.servers.find((s: any) => s.name === "otter_core");
    expect(core).toBeDefined();
    expect(core.toolsCount).toBe(core.tools.length);
    expect(core.toolsCount).toBeGreaterThanOrEqual(34);
    const names = core.tools.map((t: any) => t.name);
    expect(names).toContain("agy_status");
    expect(names).toContain("agy_run_task");
    expect(names).toContain("agy_read_chat");
    expect(names).toContain("agy_control");
    expect(names).toContain("mxh_files_tree");
    expect(names).toContain("mxh_files_read");
    expect(names).toContain("mxh_files_write");
    expect(names).toContain("mxh_files_edit");

    const openApiRaw = await fs.readFile(path.resolve(import.meta.dir, "..", "openapi.json"), "utf8");
    const openApi = JSON.parse(openApiRaw);
    expect(openApi.paths["/api/activity/v1/social/files/tree"]).toBeDefined();
    expect(openApi.paths["/api/activity/v1/social/files/read"]).toBeDefined();
    expect(openApi.paths["/api/activity/v1/social/files/write"]).toBeDefined();
    expect(openApi.paths["/api/activity/v1/social/files/edit"]).toBeDefined();
  });

  test("POST /api/activity/v1/files/read preserves binary PNG bytes lossless via auto Base64", async () => {
    setFullAccess(true, false);
    const tmpPng = path.join(os.tmpdir(), `otter-bin-test-${Date.now()}.png`);
    // Real PNG magic header + NUL + high bytes that UTF-8 decoding would corrupt
    const originalBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
    await fs.writeFile(tmpPng, originalBytes);

    try {
      const req = new Request("http://127.0.0.1:1993/api/activity/v1/files/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: tmpPng }),
      });
      const res = await handleActivityRoutes(req, new URL(req.url), () => {});
      expect(res).not.toBeNull();
      const data: any = await res!.json();
      expect(data.encoding).toBe("base64");
      expect(data.byteLength).toBe(originalBytes.length);
      const roundTrip = Buffer.from(data.content, "base64");
      expect(roundTrip.equals(originalBytes)).toBe(true);
    } finally {
      await fs.unlink(tmpPng).catch(() => {});
      setFullAccess(false, false);
    }
  });

  test("A2A AcknowledgeTask (tasks/ack) sets metadata.ack idempotently", async () => {
    const db = initDatabase(":memory:");

    const prevKey = process.env.OTTER_API_KEY;
    setAuthToken("otter_test_secret_a2a");
    try {
      const sendReq = new Request("http://127.0.0.1:1993/a2a", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer otter_test_secret_a2a",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "SendMessage",
          params: {
            message: {
              messageId: "m1",
              role: "ROLE_USER",
              parts: [{ text: "Test A2A task with ACK" }],
            },
          },
        }),
      });
      const sendRes = await handleA2aRoutes(sendReq, new URL(sendReq.url), db as any);
      const sendJson: any = await sendRes!.json();
      const taskId = sendJson.result.task.id;
      expect(taskId).toStartWith("otter-");
      expect(sendJson.result.task.metadata?.ack).toBeUndefined();

      const ackReq = new Request("http://127.0.0.1:1993/a2a", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer otter_test_secret_a2a",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "2",
          method: "tasks/ack",
          params: { id: taskId, ackedBy: "ai_muse002" },
        }),
      });
      const ackRes = await handleA2aRoutes(ackReq, new URL(ackReq.url), db as any);
      const ackJson: any = await ackRes!.json();
      expect(ackJson.result.metadata?.ack?.ackedBy).toBe("ai_muse002");
      expect(typeof ackJson.result.metadata?.ack?.ackedAt).toBe("string");

      // Idempotent second call keeps original ackedBy
      const ackReq2 = new Request("http://127.0.0.1:1993/a2a", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer otter_test_secret_a2a",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "3",
          method: "AcknowledgeTask",
          params: { id: taskId, ackedBy: "someone_else" },
        }),
      });
      const ackRes2 = await handleA2aRoutes(ackReq2, new URL(ackReq2.url), db as any);
      const ackJson2: any = await ackRes2!.json();
      expect(ackJson2.result.metadata?.ack?.ackedBy).toBe("ai_muse002");
    } finally {
      setAuthToken(prevKey ?? null);
      db.close();
    }
  });

  test("Cloudflare Tunnel requests without Bearer token are rejected while valid Bearer succeeds", () => {
    const prevKey = process.env.OTTER_API_KEY;
    setAuthToken("otter_tunnel_secret_token");
    try {
      const unauthTunnelReq = new Request("https://demo-random.trycloudflare.com/api/activity/v1/terminal/exec", {
        method: "POST",
        headers: { Host: "demo-random.trycloudflare.com" },
      });
      expect(isRequestAuthorized(unauthTunnelReq, new URL(unauthTunnelReq.url), "127.0.0.1")).toBe(false);

      const authTunnelReq = new Request("https://demo-random.trycloudflare.com/api/activity/v1/terminal/exec", {
        method: "POST",
        headers: {
          Host: "demo-random.trycloudflare.com",
          Authorization: "Bearer otter_tunnel_secret_token",
        },
      });
      expect(isRequestAuthorized(authTunnelReq, new URL(authTunnelReq.url), "127.0.0.1")).toBe(true);
    } finally {
      setAuthToken(prevKey ?? null);
    }
  });

  test("getAntigravityStatus gracefully handles unreachable CDP port without throwing", async () => {
    const res = await getAntigravityStatus({ cdpPort: 59999, autoLaunch: false });
    expect(res.cdpAvailable).toBe(false);
    expect(res.state).toBeNull();
  });
});
