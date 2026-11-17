/**
 * Social Bot Client (Otter Social Task Mesh Integration)
 *
 * Connects Otter Daemon directly to the Social Network (MXH) Messenger via Socket.IO.
 * - Listens for incoming group chat messages mentioning @otter or starting with /task
 * - Parses natural language & structured instructions into Bridge Tasks
 * - Dispatches tasks directly into Otter's task bridge (dispatchBridgeTask)
 * - Reports immediate acknowledgment, live progress, and final completion back to the chat
 *   via the BotRouter REST API (POST /api/v1/bot/:token/sendMessage)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { io, Socket } from "socket.io-client";
import { dispatchBridgeTask, taskBridgeEvents } from "./tools/task-bridge";

export interface SocialBotConfig {
  /** MXH Backend Base URL (e.g. http://192.168.1.3:4001 or http://100.111.68.103:4001) */
  serverUrl: string;
  /** Bot Token issued by MXH (matches bot table or bot_tokens) */
  botToken: string;
  /** Bot Username to ignore self-messages and prevent loops */
  botUsername: string;
  /** Whether the bot client is enabled */
  enabled: boolean;
}

export interface ParsedTaskCommand {
  goal: string;
  details?: string;
  filesHint?: string[];
  verify?: {
    command: string;
    cwd?: string;
  };
}

function loadDefaultBotCredentials(): { token: string; username: string } {
  const tokenFile = path.join(os.homedir(), ".mxh-bot-tokens.txt");
  if (fs.existsSync(tokenFile)) {
    try {
      const content = fs.readFileSync(tokenFile, "utf8");
      for (const line of content.split("\n")) {
        const [k, v] = line.trim().split("=");
        if (k === "ai_antigravity" && v) {
          return { token: v.trim(), username: "ai_antigravity" };
        }
      }
    } catch {}
  }
  return {
    token: process.env.MXH_BOT_TOKEN || "mxhbot_1993otter00000000000000000000000000000000000000000000000000000000",
    username: process.env.MXH_BOT_USERNAME || "ai_antigravity",
  };
}

const defaultCreds = loadDefaultBotCredentials();

let socketInstance: Socket | null = null;
let currentConfig: SocialBotConfig = {
  serverUrl: process.env.MXH_SERVER_URL || "http://100.111.68.103:4001",
  botToken: defaultCreds.token,
  botUsername: defaultCreds.username,
  enabled: process.env.MXH_BOT_ENABLED !== "0",
};

let isConnected = false;
let lastError: string | null = null;
let lastHeartbeat: number | null = null;
let messagesReceivedCount = 0;
let tasksDispatchedCount = 0;

/** Mapping giữa Otter Task ID và Trello Card ID trên MXH */
const otterToMxhTask = new Map<string, { convId: number; cardId: number }>();

/**
 * Tạo một thẻ Task mới trên Trello Board của nhóm chat MXH.
 */
export async function createSocialTaskCard(
  convId: number,
  data: {
    title: string;
    status?: "todo" | "doing" | "done";
    assignee?: string;
    mxhMessageId?: number;
    otterTaskId?: string;
  }
): Promise<number | null> {
  const url = `${currentConfig.serverUrl.replace(/\/+$/, "")}/messenger/projects/${convId}/tasks`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${currentConfig.botToken}`,
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      console.warn(`[SocialBot] Failed to create Trello card on MXH (${res.status})`);
      return null;
    }
    const body: any = await res.json();
    return body?.task?.id ? Number(body.task.id) : null;
  } catch (err: any) {
    console.warn(`[SocialBot] Error creating Trello card on MXH:`, err.message);
    return null;
  }
}

/**
 * Cập nhật trạng thái thẻ Task trên Trello Board của nhóm chat MXH.
 */
export async function updateSocialTaskCard(
  convId: number,
  cardId: number,
  patch: { status?: "todo" | "doing" | "done"; assignee?: string }
): Promise<boolean> {
  const url = `${currentConfig.serverUrl.replace(/\/+$/, "")}/messenger/projects/${convId}/tasks/${cardId}`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${currentConfig.botToken}`,
      },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch (err: any) {
    console.warn(`[SocialBot] Error updating Trello card on MXH:`, err.message);
    return false;
  }
}

/**
 * Lấy danh sách task của conversation trên Trello Board.
 */
export async function fetchSocialTasks(convId: number): Promise<any[]> {
  const url = `${currentConfig.serverUrl.replace(/\/+$/, "")}/messenger/projects/${convId}/tasks`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${currentConfig.botToken}`,
      },
    });
    if (!res.ok) return [];
    const body: any = await res.json();
    return Array.isArray(body?.tasks) ? body.tasks : [];
  } catch (err: any) {
    console.warn(`[SocialBot] Error fetching tasks from MXH:`, err.message);
    return [];
  }
}

/**
 * Lấy thông tin chi tiết của conversation.
 */
export async function fetchConversationInfo(convId: number): Promise<any | null> {
  const url = `${currentConfig.serverUrl.replace(/\/+$/, "")}/messenger/conversations/${convId}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${currentConfig.botToken}`,
      },
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    return body?.conversation || null;
  } catch (err: any) {
    console.warn(`[SocialBot] Error fetching conversation info:`, err.message);
    return null;
  }
}

export interface RecentChatMessage {
  id: number | string;
  convId: number;
  sender: string;
  isBot: boolean;
  text: string;
  createdAt: string;
}

const recentChatMessages: RecentChatMessage[] = [];

export function getRecentChatMessages(limit: number = 20): RecentChatMessage[] {
  return recentChatMessages.slice(0, limit);
}

/**
 * Parse a chat message mentioning @otter or command into a task specification.
 */
export function parseSocialCommand(
  rawText: string,
  allowNatural: boolean = false
): ParsedTaskCommand | null {
  const trimmed = rawText.trim();

  // Kiểm tra tiền tố lệnh hoặc tag bot (@otter, @antigravity, @ai_antigravity)
  const isTagged = /@(otter|antigravity|ai_antigravity)\b/i.test(trimmed);
  const isCommand = /^[\/!]task\b/i.test(trimmed);
  const isPrefix = /^(otter|antigravity):\s*/i.test(trimmed);
  const isNaturalTask =
    allowNatural &&
    /^(?:nhờ|bảo|giao|yêu cầu|hãy|cần|làm giúp|triển khai|viết|code|fix|sửa|test|kiểm tra|tạo task)\s+/i.test(
      trimmed
    );

  if (!isTagged && !isCommand && !isPrefix && !isNaturalTask) {
    return null;
  }

  // Xóa tiền tố
  let cleaned = trimmed
    .replace(/@(otter|antigravity|ai_antigravity)\b/gi, "")
    .replace(/^[\/!]task\b/gi, "")
    .replace(/^(otter|antigravity):\s*/gi, "")
    .replace(/^(?:nhờ\s+(?:anti|otter)\s+|làm giúp\s+|tạo task\s+)/gi, "")
    .trim();

  if (!cleaned) {
    return {
      goal: "Hỗ trợ tác vụ chung theo yêu cầu của người dùng",
      details: trimmed,
    };
  }

  let verifyCommand: string | undefined;
  // Trích xuất verify="cmd" hoặc verify='cmd'
  const verifyMatch = cleaned.match(/verify=["']([^"']+)["']/i);
  if (verifyMatch) {
    verifyCommand = verifyMatch[1].trim();
    cleaned = cleaned.replace(verifyMatch[0], "").trim();
  }

  // Trích xuất goal="nội dung" và details="nội dung" nếu có
  let explicitGoal: string | undefined;
  const goalMatch = cleaned.match(/goal=["']([^"']+)["']/i);
  if (goalMatch) {
    explicitGoal = goalMatch[1].trim();
    cleaned = cleaned.replace(goalMatch[0], "").trim();
  }

  let explicitDetails: string | undefined;
  const detailsMatch = cleaned.match(/details=["']([^"']+)["']/i);
  if (detailsMatch) {
    explicitDetails = detailsMatch[1].trim();
    cleaned = cleaned.replace(detailsMatch[0], "").trim();
  }

  // Nếu chỉ là tag bot hoặc gọi tên mà không có lệnh /task, từ khóa hành động rõ ràng, hoặc cấu trúc task -> KHÔNG tạo task
  const hasActionVerb = /^(?:làm|tạo task|triển khai|viết|code|fix|sửa|test|kiểm tra|cài đặt|refactor|build|xây dựng)\b/i.test(cleaned);
  const hasTaskStructure = !!(verifyMatch || goalMatch || detailsMatch);
  if (!isCommand && !isNaturalTask && !hasActionVerb && !hasTaskStructure) {
    return null;
  }

  // Trích xuất file gợi ý (dựa trên đuôi file phổ biến)
  const fileRegex = /\b([\w\-.\/]+\.(?:ts|tsx|js|jsx|json|md|rs|py|css|html|sql|sh|yml|yaml))\b/gi;
  const fileMatches = cleaned.match(fileRegex);
  const filesHint = fileMatches ? Array.from(new Set(fileMatches)) : undefined;

  // Tách dòng đầu làm goal, các dòng sau làm details nếu không có explicit
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  const goal = explicitGoal || lines[0] || cleaned;
  const details = explicitDetails || (lines.length > 1 ? lines.slice(1).join("\n") : undefined);

  return {
    goal,
    details,
    filesHint,
    verify: verifyCommand ? { command: verifyCommand } : undefined,
  };
}

/**
 * Quản lý vòng lặp phát sự kiện "đang nhập" (typing indicator) qua Socket.IO.
 * - Server MXH auto-expire sau 5000ms nếu không re-emit.
 * - Cadence chuẩn: re-emit mỗi 2000ms.
 * - Gửi "stopTyping" khi gửi xong tin hoặc task hoàn tất/thất bại.
 */
const activeTypingLoops = new Map<number, NodeJS.Timeout>();
const typingSafetyTimeouts = new Map<number, NodeJS.Timeout>();

export function startTypingIndicator(convId: number | string) {
  const numConvId = Number(convId);
  if (isNaN(numConvId) || numConvId <= 0) return;
  if (!socketInstance || !isConnected) return;

  try {
    socketInstance.emit("joinConversationById", numConvId);
  } catch {}

  const existingInterval = activeTypingLoops.get(numConvId);
  if (existingInterval) {
    clearInterval(existingInterval);
  }
  const existingSafety = typingSafetyTimeouts.get(numConvId);
  if (existingSafety) {
    clearTimeout(existingSafety);
  }

  // Bắn typing event ngay lập tức
  socketInstance.emit("typing", { conversationId: numConvId });

  // Re-emit mỗi 2000ms
  const interval = setInterval(() => {
    if (socketInstance && isConnected) {
      socketInstance.emit("typing", { conversationId: numConvId });
    }
  }, 2000);
  activeTypingLoops.set(numConvId, interval);

  // Safety timeout tối đa 5 phút
  const safety = setTimeout(() => {
    stopTypingIndicator(numConvId);
  }, 5 * 60 * 1000);
  typingSafetyTimeouts.set(numConvId, safety);
}

export function stopTypingIndicator(convId: number | string) {
  const numConvId = Number(convId);
  if (isNaN(numConvId) || numConvId <= 0) return;

  const interval = activeTypingLoops.get(numConvId);
  if (interval) {
    clearInterval(interval);
    activeTypingLoops.delete(numConvId);
  }
  const safety = typingSafetyTimeouts.get(numConvId);
  if (safety) {
    clearTimeout(safety);
    typingSafetyTimeouts.delete(numConvId);
  }

  if (socketInstance && isConnected) {
    socketInstance.emit("stopTyping", { conversationId: numConvId });
  }
}

/**
 * Gửi tin nhắn qua BotRouter REST API của MXH.
 */
export async function sendSocialMessage(
  chatId: number | string,
  text: string,
  replyToId?: number | string
): Promise<any> {
  const convId = Number(chatId);
  // Dừng typing indicator khi tin nhắn được gửi đi
  stopTypingIndicator(convId);

  const url = `${currentConfig.serverUrl.replace(/\/+$/, "")}/api/v1/bot/${currentConfig.botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: Number(chatId),
        text,
        reply_to_id: replyToId ? Number(replyToId) : undefined,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[SocialBot] Failed to send message to MXH (${res.status}):`, errText);
      return null;
    }

    return await res.json();
  } catch (error: any) {
    console.warn(`[SocialBot] Error sending message to MXH:`, error.message);
    return null;
  }
}

/**
 * Xử lý tin nhắn đến từ MXH Socket.IO (Bao gồm lệnh người dùng và tag bot).
 */
async function handleIncomingMessage(payload: any) {
  if (!payload || typeof payload !== "object") return;

  messagesReceivedCount++;

  const rawText = (payload.message || payload.text || "").trim();
  const senderUsername = payload.user?.username || "";
  const isSenderBot = !!payload.user?.isBot;
  const convId = payload.conversation?.id || payload.chat?.id;

  if (!convId) return;

  // 1. Lưu tin nhắn vào bộ nhớ đệm gần đây (để kiểm chứng bot thấy cả tin nhắn thường)
  recentChatMessages.unshift({
    id: payload.id,
    convId: Number(convId),
    sender: senderUsername,
    isBot: isSenderBot,
    text: rawText,
    createdAt: new Date().toISOString(),
  });
  if (recentChatMessages.length > 50) recentChatMessages.pop();

  // 2. Chống echo: bỏ qua tin nhắn từ chính bot mình
  if (senderUsername === currentConfig.botUsername) {
    return;
  }

  const mentionsBot = /@(otter|antigravity|ai_antigravity)\b/i.test(rawText);
  const isSlashCommand = /^\/[a-zA-Z0-9_\-]+/i.test(rawText);

  // Nếu người gửi là BOT: CHỈ phản hồi khi bot khác tag thẳng tên bot mình (tránh bot-to-bot loop)
  if (isSenderBot && !mentionsBot) {
    return;
  }

  console.log(`[SocialBot] 📥 Nhận tương tác từ @${senderUsername} [${isSenderBot ? "BOT" : "USER"}] trong conv #${convId}: "${rawText}"`);

  // Bật typing indicator ngay khi tiếp nhận tương tác
  startTypingIndicator(Number(convId));

  // Chuẩn hóa nội dung lệnh: xóa tag bot nếu có ở đầu
  const commandText = rawText
    .replace(/@(otter|antigravity|ai_antigravity)\b/gi, "")
    .trim();

  // A. LỆNH /help HOẶC CÂU HỎI TRỢ GIÚP TỰ NHIÊN
  const isHelpQuery =
    /^(\/help|help\b)/i.test(commandText) ||
    /^(hướng dẫn|cách dùng|các lệnh|lệnh nào|giúp đỡ|hỗ trợ)\b/i.test(commandText);
  if (isHelpQuery) {
    const helpLines = [
      `🤖 [Otter Task Mesh — Bảng lệnh nhanh & Tự nhiên]`,
      `Anh @${senderUsername} có thể nhắn tin hoàn toàn tự nhiên hoặc dùng lệnh:`,
      `• Tạo task: "làm task X verify='bun test'" hoặc \`/task <mục tiêu>\``,
      `• Xem tiến độ: "tiến độ thế nào", "tình hình task" hoặc \`/tasks\``,
      `• Hoàn thành: "xong task 5 rồi nhé", "task 5 done" hoặc \`/done <id>\``,
      `• Thông tin nhóm: "thông tin nhóm", "check bot" hoặc \`/info\``,
      `• Trò chuyện: cứ nhắn tự nhiên, em và Nyx sẽ trả lời ngay!`,
    ];
    await sendSocialMessage(convId, helpLines.join("\n"), payload.id);
    return;
  }

  // B. LỆNH /tasks HOẶC CÂU HỎI XEM DANH SÁCH TASK / TIẾN ĐỘ TRELLO TỰ NHIÊN
  const isTaskQuery =
    /^(\/tasks|tasks\b)/i.test(commandText) ||
    /(tiến độ|tình hình|task nào|danh sách task|xem task|có task|đang làm gì|làm tới đâu|board|trello|làm xong chưa|xong chưa|tới đâu rồi)/i.test(commandText);
  if (isTaskQuery) {
    const tasks = await fetchSocialTasks(Number(convId));
    if (!tasks || tasks.length === 0) {
      await sendSocialMessage(
        convId,
        `Dạ nhóm #${convId} hiện chưa có task nào ạ. Anh @${senderUsername} cần làm gì cứ dặn em nhé!`,
        payload.id
      );
      return;
    }
    const todoCount = tasks.filter((t) => t.status === "todo").length;
    const doingCount = tasks.filter((t) => t.status === "doing").length;
    const doneCount = tasks.filter((t) => t.status === "done").length;

    // Trả lời tự nhiên cho câu hỏi tiến độ thường ngày
    const isExplicitBoard = /^(\/tasks|tasks\b|bảng trello|board\b)/i.test(commandText);
    if (!isExplicitBoard && /(làm xong chưa|xong chưa|tới đâu rồi|đang làm gì)/i.test(commandText)) {
      if (doingCount > 0) {
        const doingTasks = tasks.filter((t) => t.status === "doing");
        await sendSocialMessage(
          convId,
          `Dạ em đang xử lý task: ${doingTasks.map((t) => `"${t.title}"`).join(", ")} ạ. Xong em sẽ báo anh ngay!`,
          payload.id
        );
      } else {
        await sendSocialMessage(
          convId,
          `Dạ toàn bộ các task trước đó đều đã hoàn thành xong hết rồi anh @${senderUsername} nhé! 🎉 Anh cần em làm việc gì tiếp theo cứ nhắn em ạ.`,
          payload.id
        );
      }
      return;
    }

    const taskLines = [
      `📋 [Trello Board — Nhóm #${convId}] (${tasks.length} tasks: ${todoCount} Todo, ${doingCount} Doing, ${doneCount} Done)`,
      ...tasks.map((t) => {
        const badge = t.status === "done" ? "✅ DONE" : t.status === "doing" ? "⚡ DOING" : "⏳ TODO";
        const assignee = t.assignee && t.assignee !== "unassigned" ? `@${t.assignee}` : "chưa giao";
        return `• #${t.id} [${badge}]: ${t.title} (${assignee})`;
      }),
    ];
    await sendSocialMessage(convId, taskLines.join("\n"), payload.id);
    return;
  }

  // C. LỆNH /done <id> HOẶC CÂU BÁO HOÀN THÀNH TASK TỰ NHIÊN
  const doneMatch =
    commandText.match(/(?:xong|hoàn thành|done|xong xuôi|đã làm xong)\s+(?:task|thẻ|card|công việc)?\s*#?(\d+)/i) ||
    commandText.match(/(?:task|thẻ|card)\s*#?(\d+)\s+(?:xong|hoàn thành|done)/i) ||
    commandText.match(/^\/(?:done|complete)\s+(\d+)/i) ||
    commandText.match(/^(?:done|hoanthanh)\s+(\d+)/i);
  if (doneMatch) {
    const cardId = Number(doneMatch[1]);
    const ok = await updateSocialTaskCard(Number(convId), cardId, { status: "done" });
    if (ok) {
      await sendSocialMessage(
        convId,
        `Dạ em đã cập nhật Trello Card #${cardId} sang trạng thái hoàn thành [DONE] theo yêu cầu của anh @${senderUsername} rồi ạ!`,
        payload.id
      );
    } else {
      await sendSocialMessage(
        convId,
        `⚠️ Dạ em không tìm thấy hoặc chưa thể cập nhật Card #${cardId} ạ.`,
        payload.id
      );
    }
    return;
  }

  // D. LỆNH /info HOẶC CÂU HỎI THÔNG TIN NHÓM / BOT
  const isInfoQuery =
    /^(\/info|info\b)/i.test(commandText) ||
    /(thông tin nhóm|ai đang online|trạng thái bot|bot sống không|check bot|hệ thống thế nào)/i.test(commandText);
  if (isInfoQuery) {
    const convInfo = await fetchConversationInfo(Number(convId));
    const botStatus = getSocialBotStatus();
    const infoLines = [
      `ℹ️ [Thông tin nhóm #${convId}]`,
      convInfo?.name ? `• Tên nhóm: ${convInfo.name}` : `• Nhóm ID: #${convId}`,
      convInfo?.users ? `• Thành viên (${convInfo.users.length}): ${convInfo.users.map((u: any) => `@${u.username}${u.isBot ? " [BOT]" : ""}`).join(", ")}` : "",
      `• Bot Agent: @${botStatus.botUsername} (🟢 Online, Socket: ${botStatus.socketId})`,
      `• Trạng thái Daemon: Port 1993, PID ${process.pid}, Uptime ${Math.round(process.uptime())}s`,
      `• Thống kê: ${botStatus.messagesReceivedCount} tin nhắn đã nhận, ${botStatus.tasksDispatchedCount} task đã dispatch`,
    ].filter(Boolean);
    await sendSocialMessage(convId, infoLines.join("\n"), payload.id);
    return;
  }

  // E. CHÀO HỎI / XÃ GIAO / KIỂM TRA PHẢN HỒI (alo, xin chào, hello, hi, nghe thấy ko, phản hồi, ...)
  const isGreeting =
    /^(chào|hello|hi|ping|test|alo|hey|xin chào|chào buổi|buổi sáng|buổi trưa|buổi chiều|buổi tối|thời tiết|hôm nay|ơi|ê)\b/i.test(commandText) ||
    /(nghe thấy ko|nghe không|có nghe không|phản hồi|rep em|rep anh|check bot|bot ơi|bạn nghe trả lời|nghe trả lời|trả lời đi|nghe rõ không)\b/i.test(commandText);
  if (isGreeting && !commandText.includes("verify=") && !commandText.includes("goal=")) {
    let greetingReply = `Dạ em nghe rõ anh @${senderUsername} ơi! Em và Nyx vẫn đang trực chiến 24/7 trong nhóm #${convId}, anh cần hỗ trợ việc gì cứ dặn em nhé.`;
    if (/(nghe thấy ko|nghe không|phản hồi|bạn nghe trả lời|nghe trả lời|nghe rõ không)/i.test(commandText)) {
      greetingReply = `Dạ em nghe rất rõ anh @${senderUsername} ơi! Hệ thống kết nối thời gian thực đang hoạt động mượt mà, anh cần em làm gì cứ nhắn em ạ.`;
    } else if (/thời tiết/i.test(commandText)) {
      greetingReply = `☀️ Chào anh @${senderUsername}! Chúc anh một ngày tốt lành, em và Nyx luôn sẵn sàng hỗ trợ anh ạ!`;
    }
    await sendSocialMessage(convId, greetingReply, payload.id);
    return;
  }

  // F. LỆNH TẠO TASK: /task, hoặc câu giao việc có hành động cụ thể
  const parsed = parseSocialCommand(rawText, !isSenderBot);
  if (parsed) {
    try {
      // 1. Đưa task vào Otter Task Bridge
      const dispatchRes = await dispatchBridgeTask({
        goal: parsed.goal,
        details: parsed.details,
        filesHint: parsed.filesHint,
        chatId: String(convId),
        verify: parsed.verify ? [parsed.verify.command] : undefined,
      });

      tasksDispatchedCount++;

      // 2. Tạo hoặc đồng bộ card trên Trello Board của nhóm chat (âm thầm)
      const cardId = await createSocialTaskCard(Number(convId), {
        title: parsed.goal,
        status: "doing",
        assignee: "ai_antigravity",
        mxhMessageId: payload.id ? Number(payload.id) : undefined,
        otterTaskId: dispatchRes.taskId,
      });
      if (cardId) {
        otterToMxhTask.set(dispatchRes.taskId, { convId: Number(convId), cardId });
      }

      // 3. Phản hồi tự nhiên, ngắn gọn (Không dùng template cứng nhắc)
      const replyText = `Dạ em nhận việc: "${parsed.goal}". Em bắt tay vào làm ngay đây ạ!`;
      await sendSocialMessage(convId, replyText, payload.id);

      // Kích hoạt lại typing indicator trong lúc Worker đang thực thi task
      startTypingIndicator(Number(convId));
      return;
    } catch (err: any) {
      console.error(`[SocialBot] ❌ Lỗi dispatch task:`, err.message);
      await sendSocialMessage(
        convId,
        `⚠️ Dạ em chưa thể tạo task: ${err.message}`,
        payload.id
      );
      return;
    }
  }

  // G. HỘI THOẠI TỰ NHIÊN / PHẢN HỒI THÔNG MINH CHO NGƯỜI DÙNG (Chỉ áp dụng khi người gửi là USER)
  if (!isSenderBot) {
    const conversationalReply = `Dạ em nghe đây anh @${senderUsername}! Em vẫn đang trực chiến cùng Nyx trong nhóm #${convId}, anh cần em hỗ trợ việc gì cứ bảo em nhé.`;
    await sendSocialMessage(convId, conversationalReply, payload.id);
    return;
  }
}

/**
 * Đăng ký lắng nghe sự kiện hoàn thành & tiến độ từ Task Bridge
 * để tự động gửi thông báo ngược về MXH và cập nhật Trello Board.
 */
function registerTaskBridgeListeners() {
  taskBridgeEvents.on("task_completed", async (event: any) => {
    const { taskId, task, status, summary, filesTouched } = event;

    // Cập nhật card trên Trello Board
    let mapped = otterToMxhTask.get(taskId);
    if (!mapped && task?.chatId) {
      const convId = Number(task.chatId);
      const tasks = await fetchSocialTasks(convId);
      const found = tasks.find((t: any) => t.otterTaskId === taskId);
      if (found) {
        mapped = { convId, cardId: found.id };
      }
    }
    if (mapped) {
      const cardStatus = status === "success" ? "done" : "todo";
      await updateSocialTaskCard(mapped.convId, mapped.cardId, { status: cardStatus });
      otterToMxhTask.delete(taskId);
    }

    if (!task?.chatId) return;

    const convId = Number(task.chatId);
    if (isNaN(convId) || convId <= 0) return;

    // Dừng typing indicator khi task hoàn tất
    stopTypingIndicator(convId);

    const msg = status === "success"
      ? `Dạ em đã hoàn thành xong yêu cầu "${task.goal}" rồi anh nhé! 🎉${summary ? `\n• Kết quả: ${summary}` : ""}`
      : `⚠️ Dạ task "${task.goal}" chưa hoàn tất: ${summary || "cần kiểm tra lại"}.`;

    await sendSocialMessage(convId, msg);
  });

  taskBridgeEvents.on("task_progress", async (event: any) => {
    const { taskId, task, percent } = event;

    // Cập nhật trạng thái card trên Trello Board nếu cần
    const mapped = otterToMxhTask.get(taskId);
    if (mapped && percent && percent > 0) {
      await updateSocialTaskCard(mapped.convId, mapped.cardId, { status: "doing" });
    }

    if (!task?.chatId) return;

    const convId = Number(task.chatId);
    if (isNaN(convId) || convId <= 0) return;

    // Duy trì typing indicator trong suốt tiến trình (không spam tin nhắn % vào nhóm chat)
    startTypingIndicator(convId);
  });
}

/**
 * Khởi động kết nối Socket.IO tới MXH Backend.
 */
export function startSocialBot(config?: Partial<SocialBotConfig>): Socket | null {
  if (config) {
    currentConfig = { ...currentConfig, ...config };
  }

  if (!currentConfig.enabled) {
    console.log("[SocialBot] Social Bot is disabled in config.");
    return null;
  }

  if (socketInstance && isConnected) {
    return socketInstance;
  }

  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
  }

  console.log(`[SocialBot] Connecting to MXH server at ${currentConfig.serverUrl}...`);

  socketInstance = io(currentConfig.serverUrl, {
    auth: { token: currentConfig.botToken },
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 5000,
    timeout: 10000,
  });

  socketInstance.on("connect", () => {
    isConnected = true;
    lastError = null;
    lastHeartbeat = Date.now();
    console.log(`[SocialBot] ✅ Connected to MXH Socket.IO server (id=${socketInstance?.id})`);
  });

  socketInstance.on("connect_error", (err: any) => {
    isConnected = false;
    lastError = err?.message || String(err);
    console.warn(`[SocialBot] ⚠️ Connection error:`, lastError);
  });

  socketInstance.on("disconnect", (reason: string) => {
    isConnected = false;
    console.log(`[SocialBot] 🔌 Disconnected from MXH server: ${reason}`);
  });

  // Lắng nghe sự kiện tin nhắn mới từ toàn bộ cuộc trò chuyện mà bot tham gia
  socketInstance.on("newMessage", (payload: any) => {
    handleIncomingMessage(payload).catch((err) => {
      console.error("[SocialBot] Error handling incoming message:", err);
    });
  });

  return socketInstance;
}

/**
 * Dừng kết nối Social Bot.
 */
export function stopSocialBot() {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
    isConnected = false;
    console.log("[SocialBot] Social Bot stopped.");
  }
}

/**
 * Lấy trạng thái hiện tại của Social Bot.
 */
export function getSocialBotStatus() {
  return {
    enabled: currentConfig.enabled,
    connected: isConnected,
    serverUrl: currentConfig.serverUrl,
    botUsername: currentConfig.botUsername,
    socketId: socketInstance?.id || null,
    messagesReceivedCount,
    tasksDispatchedCount,
    lastHeartbeat,
    lastError,
  };
}

// Tự động đăng ký listener một lần khi module được nạp
registerTaskBridgeListeners();
