/**
 * Antigravity IDE CDP Bridge — MCP Tools & Helper Actions
 *
 * Exposes high-level control over a local Antigravity IDE desktop instance
 * via Chrome DevTools Protocol (CDP): status discovery, full task execution,
 * conversation log reading, and discrete UI/session controls.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ANTIGRAVITY_DEFAULT_CDP_PORT,
  AntigravityCdpSession,
  AntigravityError,
  AntigravityHub,
  antigravityLauncher,
  connectAntigravity,
  discoverCdpPort,
  type AntigravityState,
  type AntigravityTaskOptions,
} from "../antigravity-cdp";

export interface AgyStatusResponse {
  ok: boolean;
  cdpAvailable: boolean;
  cdpPort: number | null;
  state: AntigravityState | null;
  error?: string;
}

export async function getAntigravityStatus(opts: {
  cdpPort?: number;
  autoLaunch?: boolean;
  executablePath?: string;
} = {}): Promise<AgyStatusResponse> {
  try {
    let port = opts.cdpPort ?? discoverCdpPort();
    if (port && !(await antigravityLauncher.isRunning(port))) {
      port = null;
    }
    if (!port && !opts.cdpPort && (await antigravityLauncher.isRunning(ANTIGRAVITY_DEFAULT_CDP_PORT))) {
      port = ANTIGRAVITY_DEFAULT_CDP_PORT;
    }
    if (!port && opts.autoLaunch) {
      port = await antigravityLauncher.ensureRunning({
        cdpPort: opts.cdpPort,
        binaryPath: opts.executablePath,
      });
    }
    if (!port) {
      return {
        ok: true,
        cdpAvailable: false,
        cdpPort: null,
        state: null,
        error:
          "Không tìm thấy cổng CDP của Antigravity đang mở (hãy khởi chạy Antigravity với --remote-debugging-port=9222 hoặc truyền autoLaunch=true).",
      };
    }

    const session = await AntigravityCdpSession.connect(port);
    try {
      const hub = new AntigravityHub(session);
      const state = await hub.getState();
      return {
        ok: true,
        cdpAvailable: true,
        cdpPort: port,
        state,
      };
    } finally {
      session.close();
    }
  } catch (err: any) {
    return {
      ok: false,
      cdpAvailable: false,
      cdpPort: null,
      state: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runAntigravityTask(
  prompt: string,
  opts: AntigravityTaskOptions & { cdpPort?: number; executablePath?: string } = {}
) {
  const { session, hub, cdpPort } = await connectAntigravity({
    cdpPort: opts.cdpPort,
    binaryPath: opts.executablePath,
  });
  try {
    const result = await hub.runTask(prompt, opts);
    return {
      ok: true,
      cdpPort,
      ...result,
    };
  } catch (err: any) {
    if (err instanceof AntigravityError) {
      return {
        ok: false,
        code: err.code,
        error: err.message,
        hasScreenshot: Boolean(err.screenshotBase64),
        screenshotBase64: err.screenshotBase64,
        pageText: err.pageText,
      };
    }
    throw err;
  } finally {
    session.close();
  }
}

export async function readAntigravityChat(opts: { cdpPort?: number } = {}) {
  const port = opts.cdpPort ?? discoverCdpPort() ?? ANTIGRAVITY_DEFAULT_CDP_PORT;
  if (!(await antigravityLauncher.isRunning(port))) {
    throw new AntigravityError(
      "NOT_RUNNING",
      "Không tìm thấy cổng CDP của Antigravity đang chạy."
    );
  }
  const session = await AntigravityCdpSession.connect(port);
  try {
    const hub = new AntigravityHub(session);
    const running = await hub.isRunning();
    const conv = await hub.readConversation();
    return {
      ok: true,
      cdpPort: port,
      running,
      url: conv.url,
      turnsCount: conv.turns.length,
      lastAnswer: conv.lastAnswer,
      turns: conv.turns,
    };
  } finally {
    session.close();
  }
}

export type AgyControlAction =
  | "new_chat"
  | "stop"
  | "select_project"
  | "select_model"
  | "set_permissions"
  | "approve_waiting"
  | "screenshot";

export async function controlAntigravity(opts: {
  action: AgyControlAction;
  value?: string;
  cdpPort?: number;
  autoLaunch?: boolean;
}) {
  let port = opts.cdpPort ?? discoverCdpPort();
  if (port && !(await antigravityLauncher.isRunning(port))) {
    port = null;
  }
  if (!port && !opts.cdpPort && (await antigravityLauncher.isRunning(ANTIGRAVITY_DEFAULT_CDP_PORT))) {
    port = ANTIGRAVITY_DEFAULT_CDP_PORT;
  }
  if (!port && opts.autoLaunch) {
    port = await antigravityLauncher.ensureRunning({ cdpPort: opts.cdpPort });
  }
  if (!port) {
    throw new AntigravityError(
      "NOT_RUNNING",
      "Không tìm thấy cổng CDP của Antigravity đang chạy."
    );
  }

  const session = await AntigravityCdpSession.connect(port);
  try {
    const hub = new AntigravityHub(session);
    switch (opts.action) {
      case "new_chat":
        await hub.newConversation();
        return { ok: true, action: opts.action, state: await hub.getState() };
      case "stop":
        await hub.stop();
        return { ok: true, action: opts.action, running: await hub.isRunning() };
      case "select_project":
        if (!opts.value) throw new Error("Thiếu tham số 'value' (tên project)");
        await hub.selectProject(opts.value);
        return { ok: true, action: opts.action, state: await hub.getState() };
      case "select_model":
        if (!opts.value) throw new Error("Thiếu tham số 'value' (tên model)");
        await hub.selectModel(opts.value);
        return { ok: true, action: opts.action, state: await hub.getState() };
      case "set_permissions": {
        const perm = opts.value === "Turbo" ? "Turbo" : "Request Review";
        await hub.setPermissions(perm);
        return { ok: true, action: opts.action, state: await hub.getState() };
      }
      case "approve_waiting": {
        const approved = await hub.approveIfWaiting();
        return { ok: true, action: opts.action, approved };
      }
      case "screenshot": {
        const screenshotBase64 = await hub.screenshot();
        return { ok: true, action: opts.action, mimeType: "image/png", screenshotBase64 };
      }
      default:
        throw new Error(`Action không hợp lệ: ${String(opts.action)}`);
    }
  } finally {
    session.close();
  }
}

export function registerAntigravityCdpTools(
  mcp: McpServer,
  onActivity?: (act: any) => void
) {
  mcp.tool(
    "agy_status",
    "Kiểm tra kết nối CDP tới ứng dụng Antigravity IDE trên máy (cổng CDP, trạng thái đăng nhập, project/model hiện tại, có đang chạy task không).",
    {
      cdpPort: z.number().int().optional().describe("Cổng CDP tùy chọn (mặc định tự dò DevToolsActivePort hoặc 9222)"),
      autoLaunch: z.boolean().optional().describe("Tự động khởi chạy Antigravity kèm --remote-debugging-port nếu chưa chạy"),
    },
    async ({ cdpPort, autoLaunch }) => {
      const res = await getAntigravityStatus({ cdpPort, autoLaunch });
      onActivity?.({ type: "agy_cdp", action: "status", cdpAvailable: res.cdpAvailable, cdpPort: res.cdpPort });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }],
      };
    }
  );

  mcp.tool(
    "agy_run_task",
    "Giao một nhiệm vụ trọn vẹn cho Antigravity IDE qua CDP (chọn project/model/quyền, gửi prompt, tự phê duyệt dialog nếu cần, chờ hoàn thành và trả câu trả lời cuối cùng).",
    {
      prompt: z.string().min(1).describe("Nội dung yêu cầu / nhiệm vụ gửi cho Antigravity"),
      project: z.string().optional().describe("Tên project muốn chọn trong Antigravity"),
      model: z.string().optional().describe("Tên model muốn chọn"),
      permissions: z.enum(["Request Review", "Turbo"]).optional().describe("Chế độ quyền thực thi"),
      conversationId: z.string().optional().describe("UUID cuộc trò chuyện muốn tiếp tục thay vì tạo mới"),
      newConversation: z.boolean().optional().describe("Tạo cuộc trò chuyện mới trước khi gửi (mặc định true)"),
      attachFiles: z.array(z.string()).optional().describe("Danh sách đường dẫn file đính kèm"),
      waitTimeoutMs: z.number().int().optional().describe("Thời gian chờ tối đa (ms, mặc định 300000 = 5 phút)"),
      cdpPort: z.number().int().optional().describe("Cổng CDP tùy chọn"),
    },
    async (args) => {
      try {
        onActivity?.({ type: "agy_cdp", action: "run_task_start", prompt: args.prompt.slice(0, 120) });
        const res = await runAntigravityTask(args.prompt, args);
        onActivity?.({ type: "agy_cdp", action: "run_task_done", ok: res.ok });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }],
          isError: !res.ok,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Lỗi agy_run_task: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  mcp.tool(
    "agy_read_chat",
    "Đọc lịch sử các lượt hội thoại (You said / Agent said) và câu trả lời mới nhất từ phiên Antigravity IDE đang mở qua CDP.",
    {
      cdpPort: z.number().int().optional().describe("Cổng CDP tùy chọn"),
    },
    async ({ cdpPort }) => {
      try {
        const res = await readAntigravityChat({ cdpPort });
        onActivity?.({ type: "agy_cdp", action: "read_chat", turnsCount: res.turnsCount, running: res.running });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Lỗi agy_read_chat: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  mcp.tool(
    "agy_control",
    "Điều khiển phiên Antigravity IDE qua CDP: tạo hội thoại mới (new_chat), dừng tác vụ (stop), chọn project/model, đổi quyền (Request Review / Turbo), duyệt dialog chờ (approve_waiting) hoặc chụp ảnh cửa sổ (screenshot).",
    {
      action: z
        .enum([
          "new_chat",
          "stop",
          "select_project",
          "select_model",
          "set_permissions",
          "approve_waiting",
          "screenshot",
        ])
        .describe("Thao tác điều khiển cần thực hiện"),
      value: z.string().optional().describe("Giá trị đi kèm cho select_project, select_model hoặc set_permissions"),
      cdpPort: z.number().int().optional().describe("Cổng CDP tùy chọn"),
      autoLaunch: z.boolean().optional().describe("Tự mở Antigravity nếu chưa chạy"),
    },
    async (args) => {
      try {
        const res = await controlAntigravity(args);
        onActivity?.({ type: "agy_cdp", action: args.action });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Lỗi agy_control (${args.action}): ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
