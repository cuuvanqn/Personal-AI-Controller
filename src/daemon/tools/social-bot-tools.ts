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
}
