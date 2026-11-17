/**
 * Social Bot MCP Tools (Otter Social Task Mesh)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getSocialBotStatus,
  sendSocialMessage,
  startSocialBot,
  stopSocialBot,
  mxhFilesTree,
  mxhFilesRead,
  mxhFilesWrite,
  mxhFilesEdit,
} from "../social-bot";

export function registerSocialBotTools(
  mcp: McpServer,
  onActivity?: (act: any) => void
) {
  mcp.tool(
    "social_bot_status",
    "Xem trạng thái kết nối của Otter Social Bot tới Mạng Xã Hội (Socket.IO, URL, số task đã nhận).",
    {},
    async () => {
      const status = getSocialBotStatus();
      onActivity?.({ type: "social_bot_status", ...status });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
      };
    }
  );

  mcp.tool(
    "social_bot_send",
    "Gửi tin nhắn từ Otter Bot vào cuộc trò chuyện / nhóm chat trên Mạng Xã Hội.",
    {
      chatId: z.number().describe("ID cuộc trò chuyện (conversationId)"),
      text: z.string().describe("Nội dung tin nhắn muốn gửi"),
      replyToId: z.number().optional().describe("ID tin nhắn muốn trích dẫn / trả lời"),
    },
    async ({ chatId, text, replyToId }) => {
      const res = await sendSocialMessage(chatId, text, replyToId);
      onActivity?.({ type: "social_bot_send", chatId, text, replyToId, ok: !!res });
      return {
        content: [
          {
            type: "text" as const,
            text: res ? JSON.stringify(res, null, 2) : "Không thể gửi tin nhắn tới MXH.",
          },
        ],
      };
    }
  );

  mcp.tool(
    "social_bot_connect",
    "Kết nối hoặc kết nối lại Social Bot tới MXH Socket.IO server.",
    {
      serverUrl: z.string().optional().describe("URL server MXH (mặc định: http://192.168.1.3:4001)"),
      botToken: z.string().optional().describe("Bot Token"),
    },
    async ({ serverUrl, botToken }) => {
      startSocialBot({
        serverUrl,
        botToken,
        enabled: true,
      });
      const status = getSocialBotStatus();
      onActivity?.({ type: "social_bot_connect", ...status });
      return {
        content: [
          {
            type: "text" as const,
            text: `Đã kích hoạt kết nối Social Bot tới ${status.serverUrl}. Trạng thái: ${status.connected ? "ONLINE" : "CONNECTING..."}`,
          },
        ],
      };
    }
  );

  mcp.tool(
    "social_bot_disconnect",
    "Ngắt kết nối Social Bot khỏi MXH Socket.IO server.",
    {},
    async () => {
      stopSocialBot();
      onActivity?.({ type: "social_bot_disconnect" });
      return {
        content: [{ type: "text" as const, text: "Đã ngắt kết nối Social Bot." }],
      };
    }
  );

  mcp.tool(
    "mxh_files_tree",
    "Duyệt danh sách tệp và thư mục trên Kho Tệp Chung MXH (Shared AI Workspace / nhóm chat) để các AI trao đổi tài liệu và mã nguồn.",
    {
      scope: z.string().optional().describe("Phạm vi kho tệp: 'shared' (mặc định: muse-shared), 'user', hoặc 'conv:<id>'"),
      path: z.string().optional().describe("Đường dẫn thư mục con tương đối (để trống xem gốc)"),
      recursive: z.boolean().optional().describe("Duyệt đệ quy toàn bộ cây thư mục"),
    },
    async (args) => {
      try {
        const res = await mxhFilesTree(args);
        onActivity?.({ type: "mxh_files", action: "tree", scope: args.scope || "shared", path: args.path || "" });
        return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Lỗi mxh_files_tree: ${err.message}` }], isError: true };
      }
    }
  );

  mcp.tool(
    "mxh_files_read",
    "Đọc nội dung tệp tin trên Kho Tệp Chung MXH theo dòng (startLine..endLine) giống công cụ đọc code IDE.",
    {
      path: z.string().min(1).describe("Đường dẫn tệp tin tương đối trong kho"),
      scope: z.string().optional().describe("Phạm vi kho tệp ('shared', 'user', 'conv:<id>')"),
      startLine: z.number().int().optional().describe("Dòng bắt đầu đọc (1-indexed)"),
      endLine: z.number().int().optional().describe("Dòng kết thúc đọc (1-indexed)"),
      withLineNumbers: z.boolean().optional().describe("Hiển thị kèm số thứ tự dòng"),
    },
    async (args) => {
      try {
        const res = await mxhFilesRead(args);
        onActivity?.({ type: "mxh_files", action: "read", path: args.path });
        return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Lỗi mxh_files_read: ${err.message}` }], isError: true };
      }
    }
  );

  mcp.tool(
    "mxh_files_write",
    "Ghi mới hoặc cập nhật tệp tin trên Kho Tệp Chung MXH (tự động tạo bản sao lưu lịch sử phiên bản và phát sự kiện SSE).",
    {
      path: z.string().min(1).describe("Đường dẫn tệp tin tương đối"),
      content: z.string().describe("Nội dung cần ghi"),
      scope: z.string().optional().describe("Phạm vi kho tệp ('shared', 'user', 'conv:<id>')"),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Mã hóa nội dung ('utf8' hoặc 'base64')"),
      expectedSha256: z.string().optional().describe("SHA256 hiện tại để chống ghi đè xung đột giữa nhiều AI"),
    },
    async (args) => {
      try {
        const res = await mxhFilesWrite(args);
        onActivity?.({ type: "mxh_files", action: "write", path: args.path });
        return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Lỗi mxh_files_write: ${err.message}` }], isError: true };
      }
    }
  );

  mcp.tool(
    "mxh_files_edit",
    "Sửa từng đoạn mã / văn bản chính xác (search & replace patch) trên Kho Tệp Chung MXH mà không cần gửi lại toàn bộ tệp.",
    {
      path: z.string().min(1).describe("Đường dẫn tệp tin tương đối"),
      target: z.string().min(1).describe("Đoạn văn bản gốc cần tìm chính xác"),
      replacement: z.string().describe("Đoạn văn bản mới thay thế vào"),
      replaceAll: z.boolean().optional().describe("Thay thế toàn bộ các vị trí khớp (mặc định false)"),
      scope: z.string().optional().describe("Phạm vi kho tệp ('shared', 'user', 'conv:<id>')"),
      expectedSha256: z.string().optional().describe("SHA256 kỳ vọng để chống xung đột sửa đồng thời"),
    },
    async (args) => {
      try {
        const res = await mxhFilesEdit(args);
        onActivity?.({ type: "mxh_files", action: "edit", path: args.path });
        return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Lỗi mxh_files_edit: ${err.message}` }], isError: true };
      }
    }
  );
}
